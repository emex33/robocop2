import dgram from "dgram";
import os from "os";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import logger from "../utils/logger.js";

/**
 * Audio Bridge
 * 
 * Bridges RTP audio between the SIP call (via rtpengine) and Deepgram Voice Agent API.
 * 
 * Flow:
 * 1. RTP from lead's phone -> rtpengine -> UDP socket here -> extract PCM -> send to Deepgram
 * 2. Deepgram AI audio (PCM) -> wrap in RTP -> UDP socket -> rtpengine -> lead's phone
 * 
 * Audio format: G.711 A-law (PCMA) 8kHz on SIP side, linear16 16kHz in / 24kHz out on Deepgram side
 * 
 * Call Recording: Stereo WAV at 16kHz — lead on left channel, AI on right channel
 */

const RTP_HEADER_SIZE = 12;
const SAMPLE_RATE = 8000;
const PTIME = 20; // 20ms packets
const SAMPLES_PER_PACKET = SAMPLE_RATE * PTIME / 1000; // 160 samples
const BYTES_PER_PACKET = SAMPLES_PER_PACKET; // 160 bytes (8-bit G.711)
const PAYLOAD_TYPE = 8; // PCMA (G.711 A-law)
const MAX_CATCHUP_FRAMES = 25; // 500 ms — max frames processed in one tick after a stall
const MAX_LEAD_QUEUE = 25;     // 500 ms — max buffered lead packets awaiting recording

// Port allocation for RTP (use range from env or default)
const RTP_PORT_MIN = parseInt(process.env.RTP_PORT_MIN || "20000");
const RTP_PORT_MAX = parseInt(process.env.RTP_PORT_MAX || "20100");
const activePorts = new Set();

function allocateRtpPort() {
  for (let port = RTP_PORT_MIN; port <= RTP_PORT_MAX; port++) {
    if (!activePorts.has(port)) {
      activePorts.add(port);
      return port;
    }
  }
  throw new Error("No available RTP ports");
}

function releaseRtpPort(port) {
  activePorts.delete(port);
}

// Recordings directory
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/data/recordings";

export class AudioBridge {
  constructor(callId, options = {}) {
    this.callId = callId;
    this.udpSocket = null;
    this.localPort = 0;
    this.remoteRtpHost = null;
    this.remoteRtpPort = null;
    this.negotiatedCodec = 8; // default PCMA, updated from incoming RTP

    // RTP sequence/timestamp tracking for outbound (AI -> lead)
    this.rtpSeq = 0;
    this.rtpTimestamp = 0;
    this.rtpSsrc = Math.floor(Math.random() * 0xFFFFFFFF);

    // Buffer for accumulating Deepgram audio into RTP-sized chunks
    this.audioOutBuffer = Buffer.alloc(0);

    // Callbacks
    this.onAudioFromLead = null; // (Buffer pcmData) => void — raw PCM from lead

    // Barge-in flag: when true, discard outbound AI audio
    this.isMuted = false;

    // Packetization interval for sending AI audio at real-time rate
    this.sendInterval = null;
    this.sendQueue = [];

    // Call recording — capture both sides at 8kHz native, mix in send loop
    this.recordingEnabled = options.enableRecording !== false;
    this.recordingPath = null;
    this.recRawPath = null;
    this.recStream = null;
    this.recLeadQueue = []; // queue of G.711 payloads from lead
    
    // Keepalive tracking
    this.lastRtpReceivedTime = null;
    this.keepaliveInterval = null;
  }

  /**
   * Start listening for RTP audio on a specific UDP port from the allocated range.
   * Returns the local port number to use in SDP negotiation.
   */
  _handleMessage(msg, rinfo) {
    this.lastRtpReceivedTime = Date.now();
    
    const incomingHost = rinfo.address;
    const incomingPort = rinfo.port;
    
    if (!this.remoteRtpHost || this.remoteRtpHost !== incomingHost || this.remoteRtpPort !== incomingPort) {
      if (this.remoteRtpHost && (this.remoteRtpHost !== incomingHost || this.remoteRtpPort !== incomingPort)) {
        logger.info(`RTP endpoint changed: ${this.remoteRtpHost}:${this.remoteRtpPort} -> ${incomingHost}:${incomingPort} (symmetric RTP)`, { callId: this.callId });
      } else {
        logger.info(`RTP stream started from ${incomingHost}:${incomingPort}`, { callId: this.callId });
      }
      this.remoteRtpHost = incomingHost;
      this.remoteRtpPort = incomingPort;
    }

    if (msg.length > RTP_HEADER_SIZE) {
      const pt = msg[1] & 0x7F;
      if (this.negotiatedCodec !== pt && (pt === 0 || pt === 8)) {
        this.negotiatedCodec = pt;
        logger.info(`Negotiated codec: ${pt === 0 ? 'PCMU' : 'PCMA'} (PT ${pt})`, { callId: this.callId });
      }
      const payload = msg.slice(RTP_HEADER_SIZE);
      
      if (this.recordingEnabled && this.recLeadQueue) {
        this.recLeadQueue.push(payload);
      }
      
      const pcm16 = pt === 0 ? mulawToLinear16(payload) : alawToLinear16(payload);
      if (this.onAudioFromLead) {
        this.onAudioFromLead(pcm16);
      }
    }
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.udpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });

      this.udpSocket.on("message", (msg, rinfo) => this._handleMessage(msg, rinfo));

      // Bind to a port from the allocated range, retrying if OS still holds it
      const tryBind = (attemptsLeft) => {
        this.localPort = allocateRtpPort();
        this.udpSocket.bind(this.localPort, "0.0.0.0", () => {
          logger.info(`Audio bridge listening on UDP port ${this.localPort}`, { callId: this.callId });
          this._startSendLoop();
          this._startRecording();
          this._startKeepalive();
          resolve(this.localPort);
        });
      };

      this.udpSocket.on("error", (err) => {
        if (err.code === "EADDRINUSE" && this.localPort) {
          logger.warn(`Port ${this.localPort} still in use by OS, trying next port`, { callId: this.callId });
          releaseRtpPort(this.localPort);
          // Recreate socket and try next port
          try { this.udpSocket.close(); } catch (e) {}
          this.udpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
          this.udpSocket.on("message", (msg, rinfo) => this._handleMessage(msg, rinfo));
          this.udpSocket.on("error", (e) => {
            if (e.code === "EADDRINUSE") {
              logger.warn(`Port ${this.localPort} also in use, giving up`, { callId: this.callId });
              releaseRtpPort(this.localPort);
            }
            logger.error(`UDP socket error: ${e.message}`, { callId: this.callId });
            reject(e);
          });
          try {
            this.localPort = allocateRtpPort();
            this.udpSocket.bind(this.localPort, "0.0.0.0", () => {
              logger.info(`Audio bridge listening on UDP port ${this.localPort}`, { callId: this.callId });
              this._startSendLoop();
              this._startRecording();
              this._startKeepalive();
              resolve(this.localPort);
            });
          } catch (allocErr) {
            reject(allocErr);
          }
          return;
        }
        logger.error(`UDP socket error: ${err.message}`, { callId: this.callId });
        reject(err);
      });

      tryBind();
    });
  }
  
  /**
   * Keepalive: Send periodic RTP packets if no audio received.
   * This helps maintain the NAT mapping and wake up unresponsive endpoints.
   */
  _startKeepalive() {
    this.keepaliveInterval = setInterval(() => {
      if (!this.remoteRtpHost || !this.remoteRtpPort || !this.udpSocket) return;
      
      const now = Date.now();
      const lastReceived = this.lastRtpReceivedTime || 0;
      const silenceMs = now - lastReceived;
      
      if (silenceMs > 3000 && this.sendQueue.length === 0) {
        const silencePayload = Buffer.alloc(BYTES_PER_PACKET, 0xD5);
        const header = Buffer.alloc(RTP_HEADER_SIZE);
        header[0] = 0x80;
        header[1] = this.negotiatedCodec;
        header.writeUInt16BE(this.rtpSeq & 0xFFFF, 2);
        this.rtpSeq++;
        header.writeUInt32BE(this.rtpTimestamp & 0xFFFFFFFF, 4);
        this.rtpTimestamp += SAMPLES_PER_PACKET;
        header.writeUInt32BE(this.rtpSsrc, 8);
        
        const rtpPacket = Buffer.concat([header, silencePayload]);
        this.udpSocket.send(rtpPacket, 0, rtpPacket.length, this.remoteRtpPort, this.remoteRtpHost);
      }
    }, 1000);
  }

  /**
   * Start recording — open raw PCM output file. Actual writing happens in send loop.
   */
  _startRecording() {
    if (!this.recordingEnabled) return;

    try {
      if (!fs.existsSync(RECORDINGS_DIR)) {
        fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = path.join(RECORDINGS_DIR, `${this.callId}_${timestamp}`);
      this.recordingPath = `${base}.wav`;
      this.recRawPath = `${base}.raw`;
      this.recStream = fs.createWriteStream(this.recRawPath);

      logger.info(`Recording started: ${this.recordingPath}`, { callId: this.callId });
    } catch (err) {
      logger.error(`Failed to start recording: ${err.message}`, { callId: this.callId });
      this.recordingEnabled = false;
    }
  }

  /**
   * Close raw file and convert to WAV via ffmpeg.
   */
  _finalizeRecording() {
    if (!this.recordingEnabled || !this.recordingPath) return null;

    if (this.recStream) { this.recStream.end(); this.recStream = null; }

    const rawFile = this.recRawPath;
    const outFile = this.recordingPath;
    const callId = this.callId;

    if (!rawFile || !fs.existsSync(rawFile) || fs.statSync(rawFile).size === 0) {
      try { if (rawFile) fs.unlinkSync(rawFile); } catch (e) {}
      return null;
    }

    const args = [
      "-y",
      "-f", "s16le", "-ar", "8000", "-ac", "1", "-i", rawFile,
      "-ar", "16000", "-c:a", "pcm_s16le",
      outFile
    ];

    execFile("ffmpeg", args, { timeout: 30000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(rawFile); } catch (e) {}
      if (err) {
        logger.error(`ffmpeg recording failed: ${err.message}`, { callId });
        return;
      }
      try {
        const stat = fs.statSync(outFile);
        const durationSecs = Math.round(stat.size / (16000 * 2));
        logger.info(`Recording saved: ${outFile} (${durationSecs}s mono WAV)`, { callId });
      } catch (e) {
        logger.info(`Recording saved: ${outFile}`, { callId });
      }
    });

    return this.recordingPath;
  }

  /**
   * Get the recording file path (available after call ends).
   */
  getRecordingPath() {
    return this.recordingPath;
  }

  /**
   * Set the remote RTP endpoint to send AI audio to.
   * Called after SDP negotiation when we know the rtpengine's receive port.
   */
  setRemoteEndpoint(host, port) {
    // Store SDP endpoint as fallback, but prefer symmetric RTP (actual packet source)
    this.sdpRemoteHost = host;
    this.sdpRemotePort = port;
    
    // Only use SDP endpoint if we haven't received any packets yet
    if (!this.remoteRtpHost) {
      this.remoteRtpHost = host;
      this.remoteRtpPort = port;
      logger.info(`Remote RTP endpoint set from SDP: ${host}:${port} (will be overridden by symmetric RTP)`, { callId: this.callId });
      
      // Send initial RTP packets to punch through NAT and wake up the remote side
      this._sendInitialRtpBurst();
    } else {
      logger.info(`SDP endpoint ${host}:${port} ignored - using symmetric RTP: ${this.remoteRtpHost}:${this.remoteRtpPort}`, { callId: this.callId });
    }
  }
  
  /**
   * Send initial RTP packets (comfort noise/silence) to establish the media path.
   * Some SIP providers won't send audio until they receive audio first.
   */
  _sendInitialRtpBurst() {
    if (!this.remoteRtpHost || !this.remoteRtpPort || !this.udpSocket) return;
    
    logger.info(`Sending initial RTP burst to ${this.remoteRtpHost}:${this.remoteRtpPort}`, { callId: this.callId });
    
    // Send 10 packets of silence (comfort noise) to establish the connection
    const sendSilencePacket = (count) => {
      if (count <= 0) return;
      
      const silencePayload = Buffer.alloc(BYTES_PER_PACKET, 0xD5); // 0xD5 is silence in A-law
      const header = Buffer.alloc(RTP_HEADER_SIZE);
      header[0] = 0x80;
      header[1] = this.negotiatedCodec;
      header.writeUInt16BE(this.rtpSeq & 0xFFFF, 2);
      this.rtpSeq++;
      header.writeUInt32BE(this.rtpTimestamp & 0xFFFFFFFF, 4);
      this.rtpTimestamp += SAMPLES_PER_PACKET;
      header.writeUInt32BE(this.rtpSsrc, 8);
      
      const rtpPacket = Buffer.concat([header, silencePayload]);
      
      this.udpSocket.send(rtpPacket, 0, rtpPacket.length, this.remoteRtpPort, this.remoteRtpHost, (err) => {
        if (err) logger.error(`Failed to send initial RTP: ${err.message}`, { callId: this.callId });
      });
      
      // Send next packet after 20ms (real-time pacing)
      setTimeout(() => sendSilencePacket(count - 1), PTIME);
    };
    
    sendSilencePacket(10);
  }

  /**
   * Queue AI audio (raw PCM from Deepgram) to be sent to the lead as RTP.
   * The audio is buffered and packetized at real-time rate.
   */
  sendAudioToLead(pcmBuffer) {
    if (this.isMuted) return;

    // Deepgram sends linear16 at 24kHz
    const downsampled = downsample24to8(pcmBuffer);
    
    const alawData = this.negotiatedCodec === 0 ? linear16ToMulaw(downsampled) : linear16ToAlaw(downsampled);

    // Accumulate into buffer
    this.audioOutBuffer = Buffer.concat([this.audioOutBuffer, alawData]);

    // Slice into RTP-sized packets and queue them
    while (this.audioOutBuffer.length >= BYTES_PER_PACKET) {
      const packet = this.audioOutBuffer.slice(0, BYTES_PER_PACKET);
      this.audioOutBuffer = this.audioOutBuffer.slice(BYTES_PER_PACKET);
      this.sendQueue.push(packet);
    }
  }

  /**
   * Stop sending AI audio (barge-in: lead is speaking).
   */
  mute() {
    this.isMuted = true;
    this.sendQueue = [];
    this.audioOutBuffer = Buffer.alloc(0);
    logger.info("Audio bridge muted (barge-in)", { callId: this.callId });
  }

  /**
   * Resume sending AI audio.
   */
  unmute() {
    this.isMuted = false;
    logger.info("Audio bridge unmuted", { callId: this.callId });
  }

  /**
   * Send queued RTP packets at real-time rate (every 20ms).
   * Also writes mixed recording frame each tick.
   */
  _startSendLoop() {
    // Wall-clock paced: a bare setInterval(20ms) fires LATE under load (Node
    // reschedules from when the callback ran, so lag accumulates and never
    // catches up). Measured on live calls: only 46-48 frames/s instead of 50,
    // i.e. 3-10% slow. Effects: (1) AI audio reached the phone slower than
    // real time -> jitter-buffer underruns -> choppy voice ("you're cutting
    // out"); (2) the recording ran short and the lead channel (consumed one
    // packet per tick) drifted seconds behind the AI channel, so the AI seemed
    // to answer before the lead spoke. Now every tick processes exactly as many
    // 20 ms frames as wall-clock time says are due.
    this.loopStartMs = Date.now();
    this.framesDone = 0;
    this.sendInterval = setInterval(() => {
      let due = Math.floor((Date.now() - this.loopStartMs) / PTIME) - this.framesDone;
      if (due > MAX_CATCHUP_FRAMES) {
        // Pathological stall (GC pause, blocked loop): don't burst-flood the
        // network; give up on the missed time instead.
        this.framesDone += due - MAX_CATCHUP_FRAMES;
        due = MAX_CATCHUP_FRAMES;
      }
      for (let i = 0; i < due; i++) {
        this.framesDone++;
        this._processFrame();
      }
    }, PTIME / 2);
  }

  /**
   * One 20 ms frame: write a mixed recording frame and send one AI RTP packet.
   */
  _processFrame() {
    // --- Recording: mix lead + AI at 8kHz every frame ---
    if (this.recStream && !this.recStream.destroyed) {
      // Safety valve: if the lead queue somehow runs ahead of wall-clock
      // (remote clock skew), drop the oldest packets rather than drifting.
      while (this.recLeadQueue.length > MAX_LEAD_QUEUE) this.recLeadQueue.shift();
      // Lead: shift one packet from the queue (or silence)
      let leadPcm;
      if (this.recLeadQueue.length > 0) {
        const leadG711 = this.recLeadQueue.shift();
        leadPcm = this.negotiatedCodec === 0
          ? mulawDecode8k(leadG711)
          : alawDecode8k(leadG711);
      } else {
        leadPcm = Buffer.alloc(SAMPLES_PER_PACKET * 2, 0);
      }

      // AI: peek at the front of the send queue (or silence)
      let aiPcm;
      if (this.sendQueue.length > 0) {
        const aiG711 = this.sendQueue[0];
        aiPcm = this.negotiatedCodec === 0
          ? mulawDecode8k(aiG711)
          : alawDecode8k(aiG711);
      } else {
        aiPcm = Buffer.alloc(SAMPLES_PER_PACKET * 2, 0);
      }

      // Mix: add samples, clamp to 16-bit
      const mixed = Buffer.alloc(SAMPLES_PER_PACKET * 2);
      for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
        let m = leadPcm.readInt16LE(i * 2) + aiPcm.readInt16LE(i * 2);
        if (m > 32767) m = 32767;
        if (m < -32768) m = -32768;
        mixed.writeInt16LE(m, i * 2);
      }
      this.recStream.write(mixed);
    }

    // --- Send AI RTP packet ---
    if (this.isMuted || this.sendQueue.length === 0) return;
    if (!this.remoteRtpHost || !this.remoteRtpPort) return;

    const pcmPayload = this.sendQueue.shift();
    const rtpPacket = this._createRtpPacket(pcmPayload);

    this.udpSocket.send(rtpPacket, this.remoteRtpPort, this.remoteRtpHost, (err) => {
      if (err) {
        logger.error(`RTP send error: ${err.message}`, { callId: this.callId });
      }
    });
  }

  /**
   * Create an RTP packet with header + PCM payload.
   */
  _createRtpPacket(pcmPayload) {
    const header = Buffer.alloc(RTP_HEADER_SIZE);

    // Version 2, no padding, no extension, no CSRC
    header[0] = 0x80;
    // Payload type — use negotiated codec
    header[1] = this.negotiatedCodec;
    // Sequence number (big-endian)
    header.writeUInt16BE(this.rtpSeq & 0xFFFF, 2);
    this.rtpSeq++;
    // Timestamp (big-endian)
    header.writeUInt32BE(this.rtpTimestamp & 0xFFFFFFFF, 4);
    this.rtpTimestamp += SAMPLES_PER_PACKET;
    // SSRC (big-endian)
    header.writeUInt32BE(this.rtpSsrc, 8);

    return Buffer.concat([header, pcmPayload]);
  }

  /**
   * Generate a minimal SDP for our local RTP endpoint.
   * Uses EXTERNAL_RTP_IP env var if set (for Docker/NAT scenarios),
   * otherwise falls back to local IP detection.
   */
  generateLocalSdp() {
    const ip = process.env.EXTERNAL_RTP_IP || this._getLocalIp();
    return [
      "v=0",
      `o=robocop 0 0 IN IP4 ${ip}`,
      "s=robocop",
      "t=0 0",
      `m=audio ${this.localPort} RTP/AVP 0 8`,
      `c=IN IP4 ${ip}`,
      `a=rtpmap:0 PCMU/${SAMPLE_RATE}`,
      `a=rtpmap:8 PCMA/${SAMPLE_RATE}`,
      "a=sendrecv",
      "a=ptime:20",
      "",
    ].join("\r\n");
  }

  /**
   * Get the local non-loopback IPv4 address.
   */
  _getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }
    return "127.0.0.1";
  }

  /**
   * Stop the audio bridge and clean up.
   * Returns the recording path if recording was enabled.
   */
  stop() {
    // Each teardown step is isolated so that a failure in one (e.g. a disk I/O
    // error while finalizing the recording) can NEVER prevent the RTP port from
    // being released. A leaked port would otherwise permanently shrink the pool
    // until the app runs out and every new call fails with "No available RTP
    // ports". The port release is in a `finally` to guarantee it always runs.
    let recordingPath = null;
    try {
      recordingPath = this._finalizeRecording();
    } catch (e) {
      logger.error(`Error finalizing recording: ${e.message}`, { callId: this.callId });
    }

    try {
      if (this.sendInterval) {
        clearInterval(this.sendInterval);
        this.sendInterval = null;
      }
    } catch (e) { /* ignore */ }

    try {
      if (this.keepaliveInterval) {
        clearInterval(this.keepaliveInterval);
        this.keepaliveInterval = null;
      }
    } catch (e) { /* ignore */ }

    try {
      if (this.udpSocket) {
        this.udpSocket.close();
        this.udpSocket = null;
      }
    } catch (e) { /* ignore */ }

    try {
      // Always release the RTP port; null it out so stop() is idempotent.
      if (this.localPort) {
        releaseRtpPort(this.localPort);
        this.localPort = 0;
      }
      this.sendQueue = [];
      this.audioOutBuffer = Buffer.alloc(0);
    } finally {
      logger.info("Audio bridge stopped", { callId: this.callId });
    }

    return recordingPath;
  }
}

// ============================================================
// G.711 A-law codec conversion functions
// ============================================================

const ALAW_COMPRESS_TABLE = [
  1,1,2,2,3,3,3,3,4,4,4,4,4,4,4,4,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
];

/**
 * Encode a single 16-bit linear PCM sample to 8-bit G.711 A-law.
 */
function linear16SampleToAlaw(sample) {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > 32767) sample = 32767;

  let exp, mant;
  if (sample >= 256) {
    exp = ALAW_COMPRESS_TABLE[(sample >> 8) & 0x7F];
    mant = (sample >> (exp + 3)) & 0x0F;
  } else {
    exp = 0;
    mant = sample >> 4;
  }

  return (sign | (exp << 4) | mant) ^ 0x55;
}

/**
 * Decode a single 8-bit G.711 A-law sample to 16-bit linear PCM.
 */
function alawSampleToLinear16(alaw) {
  alaw ^= 0x55;
  const sign = alaw & 0x80;
  const exp = (alaw >> 4) & 0x07;
  let mant = alaw & 0x0F;

  let sample;
  if (exp === 0) {
    sample = (mant * 2 + 1) * 8;
  } else {
    mant |= 0x10;
    sample = (mant * 2 + 1) * (1 << (exp + 2));
  }

  return sign ? -sample : sample;
}

/**
 * Convert a Buffer of G.711 A-law bytes to a Buffer of signed 16-bit LE PCM.
 * Upsamples 8kHz â†’ 16kHz by duplicating each sample (for Deepgram 16kHz input).
 */
function alawToLinear16(alawBuf) {
  // Each A-law byte becomes 2 PCM samples (upsample 8kâ†’16k), each sample is 2 bytes
  const pcm = Buffer.alloc(alawBuf.length * 4);
  for (let i = 0; i < alawBuf.length; i++) {
    const sample = alawSampleToLinear16(alawBuf[i]);
    // Duplicate sample for 8kHz â†’ 16kHz
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(sample, i * 4 + 2);
  }
  return pcm;
}

/**
 * Convert a Buffer of signed 16-bit LE PCM to a Buffer of G.711 A-law bytes.
 * Input should already be downsampled to 8kHz.
 */
function linear16ToAlaw(pcmBuf) {
  const alaw = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < alaw.length; i++) {
    const sample = pcmBuf.readInt16LE(i * 2);
    alaw[i] = linear16SampleToAlaw(sample);
  }
  return alaw;
}

// ============================================================
// G.711 Î¼-law (PCMU) codec conversion functions
// ============================================================

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_COMPRESS_TABLE = [
  0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3,
  4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
];

const MULAW_DECOMPRESS_TABLE = [
  -32124,-31100,-30076,-29052,-28028,-27004,-25980,-24956,
  -23932,-22908,-21884,-20860,-19836,-18812,-17788,-16764,
  -15996,-15484,-14972,-14460,-13948,-13436,-12924,-12412,
  -11900,-11388,-10876,-10364,-9852,-9340,-8828,-8316,
  -7932,-7676,-7420,-7164,-6908,-6652,-6396,-6140,
  -5884,-5628,-5372,-5116,-4860,-4604,-4348,-4092,
  -3900,-3772,-3644,-3516,-3388,-3260,-3132,-3004,
  -2876,-2748,-2620,-2492,-2364,-2236,-2108,-1980,
  -1884,-1820,-1756,-1692,-1628,-1564,-1500,-1436,
  -1372,-1308,-1244,-1180,-1116,-1052,-988,-924,
  -876,-844,-812,-780,-748,-716,-684,-652,
  -620,-588,-556,-524,-492,-460,-428,-396,
  -372,-356,-340,-324,-308,-292,-276,-260,
  -244,-228,-212,-196,-180,-164,-148,-132,
  -120,-112,-104,-96,-88,-80,-72,-64,
  -56,-48,-40,-32,-24,-16,-8,0,
  32124,31100,30076,29052,28028,27004,25980,24956,
  23932,22908,21884,20860,19836,18812,17788,16764,
  15996,15484,14972,14460,13948,13436,12924,12412,
  11900,11388,10876,10364,9852,9340,8828,8316,
  7932,7676,7420,7164,6908,6652,6396,6140,
  5884,5628,5372,5116,4860,4604,4348,4092,
  3900,3772,3644,3516,3388,3260,3132,3004,
  2876,2748,2620,2492,2364,2236,2108,1980,
  1884,1820,1756,1692,1628,1564,1500,1436,
  1372,1308,1244,1180,1116,1052,988,924,
  876,844,812,780,748,716,684,652,
  620,588,556,524,492,460,428,396,
  372,356,340,324,308,292,276,260,
  244,228,212,196,180,164,148,132,
  120,112,104,96,88,80,72,64,
  56,48,40,32,24,16,8,0,
];

function linear16SampleToMulaw(sample) {
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  const exp = MULAW_COMPRESS_TABLE[(sample >> 7) & 0xFF];
  const mant = (sample >> (exp + 3)) & 0x0F;
  return ~(sign | (exp << 4) | mant) & 0xFF;
}

function mulawSampleToLinear16(mulaw) {
  return MULAW_DECOMPRESS_TABLE[mulaw];
}

function mulawToLinear16(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 4);
  for (let i = 0; i < mulawBuf.length; i++) {
    const sample = mulawSampleToLinear16(mulawBuf[i]);
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(sample, i * 4 + 2);
  }
  return pcm;
}

function linear16ToMulaw(pcmBuf) {
  const mulaw = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = pcmBuf.readInt16LE(i * 2);
    mulaw[i] = linear16SampleToMulaw(sample);
  }
  return mulaw;
}

/**
 * Decode G.711 A-law to 8kHz linear16 (no upsampling). For recording.
 */
function alawDecode8k(alawBuf) {
  const pcm = Buffer.alloc(alawBuf.length * 2);
  for (let i = 0; i < alawBuf.length; i++) {
    pcm.writeInt16LE(alawSampleToLinear16(alawBuf[i]), i * 2);
  }
  return pcm;
}

/**
 * Decode G.711 Î¼-law to 8kHz linear16 (no upsampling). For recording.
 */
function mulawDecode8k(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(mulawSampleToLinear16(mulawBuf[i]), i * 2);
  }
  return pcm;
}

/**
 * Clamp a sample to 16-bit signed range.
 */
function clampSample(sample) {
  if (sample > 32767) return 32767;
  if (sample < -32768) return -32768;
  return sample;
}

/**
 * Downsample 24kHz linear16 PCM to 8kHz with simple averaging (anti-aliasing).
 * Takes average of every 3 samples instead of just dropping samples.
 */
function downsample24to8(pcmBuf) {
  // 24kHz / 8kHz = 3, each sample is 2 bytes
  const numOutputSamples = Math.floor(pcmBuf.length / 6);
  const out = Buffer.alloc(numOutputSamples * 2);
  for (let i = 0, j = 0; i < numOutputSamples; i++, j += 6) {
    // Average 3 consecutive samples to reduce aliasing
    const s1 = pcmBuf.readInt16LE(j);
    const s2 = j + 2 < pcmBuf.length ? pcmBuf.readInt16LE(j + 2) : s1;
    const s3 = j + 4 < pcmBuf.length ? pcmBuf.readInt16LE(j + 4) : s2;
    const avg = Math.round((s1 + s2 + s3) / 3);
    out.writeInt16LE(clampSample(avg), i * 2);
  }
  return out;
}

/**
 * Downsample 24kHz linear16 PCM to 16kHz with linear interpolation.
 * Ratio 24000/16000 = 3/2: for every 3 input samples, output 2 samples.
 */
function downsample24to16(pcmBuf) {
  const inSamples = pcmBuf.length / 2;
  const outSamples = Math.floor(inSamples * 2 / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    // Fractional source position
    const srcPos = i * 1.5;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;
    const s0 = srcIdx < inSamples ? pcmBuf.readInt16LE(srcIdx * 2) : 0;
    const s1 = (srcIdx + 1) < inSamples ? pcmBuf.readInt16LE((srcIdx + 1) * 2) : s0;
    const interp = Math.round(s0 + frac * (s1 - s0));
    out.writeInt16LE(clampSample(interp), i * 2);
  }
  return out;
}

/**
 * Downsample 16kHz linear16 PCM to 8kHz with averaging (anti-aliasing).
 */
function downsample16to8(pcmBuf) {
  // 16kHz / 8kHz = 2, each sample is 2 bytes
  const numOutputSamples = Math.floor(pcmBuf.length / 4);
  const out = Buffer.alloc(numOutputSamples * 2);
  for (let i = 0, j = 0; i < numOutputSamples; i++, j += 4) {
    // Average 2 consecutive samples to reduce aliasing
    const s1 = pcmBuf.readInt16LE(j);
    const s2 = j + 2 < pcmBuf.length ? pcmBuf.readInt16LE(j + 2) : s1;
    const avg = Math.round((s1 + s2) / 2);
    out.writeInt16LE(clampSample(avg), i * 2);
  }
  return out;
}

/**
 * Create a WAV file buffer from raw PCM data.
 * @param {Buffer} pcmData - Raw PCM audio data
 * @param {number} sampleRate - Sample rate (e.g., 8000)
 * @param {number} numChannels - Number of channels (1 = mono, 2 = stereo)
 * @param {number} bitsPerSample - Bits per sample (16)
 * @returns {Buffer} Complete WAV file buffer
 */
function createWavFile(pcmData, sampleRate, numChannels, bitsPerSample) {
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmData.length;
  const headerSize = 44;
  
  const buffer = Buffer.alloc(headerSize + dataSize);
  
  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4); // File size - 8
  buffer.write('WAVE', 8);
  
  // fmt subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1 size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // Audio format (1 = PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  
  // data subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  
  // Copy PCM data
  pcmData.copy(buffer, 44);
  
  return buffer;
}
