/**
 * Agent Audio Bridge
 * 
 * Bridges RTP audio between SIP calls and agent's browser via WebSocket.
 * Recording: Stereo WAV at 16kHz — remote party on left, agent on right.
 */

import dgram from "dgram";
import os from "os";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import logger from "../utils/logger.js";

const RTP_HEADER_SIZE = 12;
const SAMPLE_RATE = 8000;
const PTIME = 20;
const SAMPLES_PER_PACKET = SAMPLE_RATE * PTIME / 1000;
const BYTES_PER_PACKET = SAMPLES_PER_PACKET;

const RTP_PORT_MIN = parseInt(process.env.AGENT_RTP_PORT_MIN || "20200");
const RTP_PORT_MAX = parseInt(process.env.AGENT_RTP_PORT_MAX || "20300");
const activePorts = new Set();

function allocateRtpPort() {
  for (let port = RTP_PORT_MIN; port <= RTP_PORT_MAX; port++) {
    if (!activePorts.has(port)) {
      activePorts.add(port);
      return port;
    }
  }
  throw new Error("No available agent RTP ports");
}

function releaseRtpPort(port) {
  activePorts.delete(port);
}

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || "/app/data/recordings";

export class AgentAudioBridge {
  constructor(callId) {
    this.callId = callId;
    this.udpSocket = null;
    this.localPort = 0;
    this.remoteRtpHost = null;
    this.remoteRtpPort = null;
    this.negotiatedCodec = 8;

    this.rtpSeq = 0;
    this.rtpTimestamp = 0;
    this.rtpSsrc = Math.floor(Math.random() * 0xFFFFFFFF);

    this.audioOutBuffer = Buffer.alloc(0);
    this.sendInterval = null;
    this.sendQueue = [];

    // Callback for audio from remote party (to send to browser)
    this.onAudioFromRemote = null;

    // Recording — capture both sides at 8kHz, mix in send loop
    this.recordingEnabled = true;
    this.recordingPath = null;
    this.recRawPath = null;
    this.recStream = null;
    this.recRemoteQueue = [];
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.udpSocket = dgram.createSocket("udp4");

      this.udpSocket.on("message", (msg, rinfo) => {
        // Symmetric RTP
        if (!this.remoteRtpHost || this.remoteRtpHost !== rinfo.address || this.remoteRtpPort !== rinfo.port) {
          this.remoteRtpHost = rinfo.address;
          this.remoteRtpPort = rinfo.port;
          logger.info(`Agent RTP stream from ${rinfo.address}:${rinfo.port}`, { callId: this.callId });
        }

        if (msg.length > RTP_HEADER_SIZE) {
          const pt = msg[1] & 0x7F;
          if (this.negotiatedCodec !== pt && (pt === 0 || pt === 8)) {
            this.negotiatedCodec = pt;
          }
          const payload = msg.slice(RTP_HEADER_SIZE);
          if (this.recordingEnabled && this.recRemoteQueue) {
            this.recRemoteQueue.push(payload);
          }
          
          const pcm16 = pt === 0 ? mulawToLinear16(payload) : alawToLinear16(payload);
          if (this.onAudioFromRemote) {
            this.onAudioFromRemote(pcm16);
          }
        }
      });

      this.udpSocket.on("error", (err) => {
        logger.error(`Agent UDP socket error: ${err.message}`, { callId: this.callId });
        reject(err);
      });

      this.localPort = allocateRtpPort();
      this.udpSocket.bind(this.localPort, "0.0.0.0", () => {
        logger.info(`Agent audio bridge on UDP ${this.localPort}`, { callId: this.callId });
        this._startSendLoop();
        this._startRecording();
        resolve(this.localPort);
      });
    });
  }

  setRemoteEndpoint(host, port) {
    if (!this.remoteRtpHost) {
      this.remoteRtpHost = host;
      this.remoteRtpPort = port;
      logger.info(`Agent remote RTP: ${host}:${port}`, { callId: this.callId });
    }
  }

  /**
   * Send audio from agent's browser to the remote party
   */
  sendAudioToRemote(pcmBuffer) {
    // Downsample to 8kHz for G.711 RTP
    const downsampled = downsample16to8Browser(pcmBuffer);
    const encoded = this.negotiatedCodec === 0 ? linear16ToMulaw(downsampled) : linear16ToAlaw(downsampled);

    this.audioOutBuffer = Buffer.concat([this.audioOutBuffer, encoded]);

    while (this.audioOutBuffer.length >= BYTES_PER_PACKET) {
      const packet = this.audioOutBuffer.slice(0, BYTES_PER_PACKET);
      this.audioOutBuffer = this.audioOutBuffer.slice(BYTES_PER_PACKET);
      this.sendQueue.push(packet);
    }
  }

  _startSendLoop() {
    // Wall-clock paced (see src/audio/bridge.js): a bare 20 ms setInterval
    // drifts late under load, which starves the phone of RTP and desyncs the
    // recording. Process exactly as many 20 ms frames as are due each tick.
    this.loopStartMs = Date.now();
    this.framesDone = 0;
    this.sendInterval = setInterval(() => {
      let due = Math.floor((Date.now() - this.loopStartMs) / PTIME) - this.framesDone;
      if (due > 25) { this.framesDone += due - 25; due = 25; }
      for (let i = 0; i < due; i++) {
        this.framesDone++;
        this._processFrame();
      }
    }, PTIME / 2);
  }

  _processFrame() {
      // --- Recording: mix remote + agent at 8kHz ---
      if (this.recStream && !this.recStream.destroyed) {
        while (this.recRemoteQueue.length > 25) this.recRemoteQueue.shift();
        let remotePcm;
        if (this.recRemoteQueue.length > 0) {
          const remoteG711 = this.recRemoteQueue.shift();
          remotePcm = this.negotiatedCodec === 0
            ? mulawDecode8k(remoteG711)
            : alawDecode8k(remoteG711);
        } else {
          remotePcm = Buffer.alloc(SAMPLES_PER_PACKET * 2, 0);
        }

        let agentPcm;
        if (this.sendQueue.length > 0) {
          agentPcm = this.negotiatedCodec === 0
            ? mulawDecode8k(this.sendQueue[0])
            : alawDecode8k(this.sendQueue[0]);
        } else {
          agentPcm = Buffer.alloc(SAMPLES_PER_PACKET * 2, 0);
        }

        const mixed = Buffer.alloc(SAMPLES_PER_PACKET * 2);
        for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
          let m = remotePcm.readInt16LE(i * 2) + agentPcm.readInt16LE(i * 2);
          if (m > 32767) m = 32767;
          if (m < -32768) m = -32768;
          mixed.writeInt16LE(m, i * 2);
        }
        this.recStream.write(mixed);
      }

      // --- Send agent RTP ---
      if (this.sendQueue.length === 0) return;
      if (!this.remoteRtpHost || !this.remoteRtpPort) return;

      const payload = this.sendQueue.shift();
      const rtpPacket = this._createRtpPacket(payload);

      this.udpSocket.send(rtpPacket, this.remoteRtpPort, this.remoteRtpHost, (err) => {
        if (err) logger.error(`Agent RTP send error: ${err.message}`, { callId: this.callId });
      });
  }

  _createRtpPacket(payload) {
    const header = Buffer.alloc(RTP_HEADER_SIZE);
    header[0] = 0x80;
    header[1] = this.negotiatedCodec;
    header.writeUInt16BE(this.rtpSeq & 0xFFFF, 2);
    this.rtpSeq++;
    header.writeUInt32BE(this.rtpTimestamp & 0xFFFFFFFF, 4);
    this.rtpTimestamp += SAMPLES_PER_PACKET;
    header.writeUInt32BE(this.rtpSsrc, 8);
    return Buffer.concat([header, payload]);
  }

  generateLocalSdp() {
    const ip = process.env.EXTERNAL_RTP_IP || this._getLocalIp();
    return [
      "v=0",
      `o=robocop-agent 0 0 IN IP4 ${ip}`,
      "s=robocop-agent",
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

  _startRecording() {
    if (!this.recordingEnabled) return;
    try {
      if (!fs.existsSync(RECORDINGS_DIR)) {
        fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = path.join(RECORDINGS_DIR, `agent_${this.callId}_${timestamp}`);
      this.recordingPath = `${base}.wav`;
      this.recRawPath = `${base}.raw`;
      this.recStream = fs.createWriteStream(this.recRawPath);
      logger.info(`Agent recording: ${this.recordingPath}`, { callId: this.callId });
    } catch (err) {
      logger.error(`Failed to start agent recording: ${err.message}`, { callId: this.callId });
      this.recordingEnabled = false;
    }
  }

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

    execFile("ffmpeg", [
      "-y", "-f", "s16le", "-ar", "8000", "-ac", "1", "-i", rawFile,
      "-ar", "16000", "-c:a", "pcm_s16le", outFile
    ], { timeout: 30000 }, (err) => {
      try { fs.unlinkSync(rawFile); } catch (e) {}
      if (err) {
        logger.error(`ffmpeg agent recording failed: ${err.message}`, { callId });
        return;
      }
      logger.info(`Agent recording saved: ${outFile} (mono WAV)`, { callId });
    });

    return this.recordingPath;
  }

  stop() {
    // Isolated teardown steps so a failure (e.g. disk I/O while finalizing the
    // recording) can never block the RTP port release below. A leaked port would
    // permanently shrink the pool until calls fail with "No available RTP ports".
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
      if (this.udpSocket) {
        this.udpSocket.close();
        this.udpSocket = null;
      }
    } catch (e) { /* ignore */ }

    try {
      if (this.localPort) {
        releaseRtpPort(this.localPort);
        this.localPort = 0;
      }
      this.sendQueue = [];
      this.audioOutBuffer = Buffer.alloc(0);
    } finally {
      logger.info(`Agent audio bridge stopped`, { callId: this.callId });
    }

    return recordingPath;
  }
}

// G.711 codec functions (same as main bridge)
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

function linear16SampleToAlaw(sample) {
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
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

function alawToLinear16(alawBuf) {
  const pcm = Buffer.alloc(alawBuf.length * 4);
  for (let i = 0; i < alawBuf.length; i++) {
    const sample = alawSampleToLinear16(alawBuf[i]);
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(sample, i * 4 + 2);
  }
  return pcm;
}

function linear16ToAlaw(pcmBuf) {
  const alaw = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < alaw.length; i++) {
    const sample = pcmBuf.readInt16LE(i * 2);
    alaw[i] = linear16SampleToAlaw(sample);
  }
  return alaw;
}

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

function alawDecode8k(alawBuf) {
  const pcm = Buffer.alloc(alawBuf.length * 2);
  for (let i = 0; i < alawBuf.length; i++) {
    pcm.writeInt16LE(alawSampleToLinear16(alawBuf[i]), i * 2);
  }
  return pcm;
}

function mulawDecode8k(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(mulawSampleToLinear16(mulawBuf[i]), i * 2);
  }
  return pcm;
}

function clampSample(sample) {
  if (sample > 32767) return 32767;
  if (sample < -32768) return -32768;
  return sample;
}

function downsample16to8(pcmBuf) {
  const numOutputSamples = Math.floor(pcmBuf.length / 4);
  const out = Buffer.alloc(numOutputSamples * 2);
  for (let i = 0, j = 0; i < numOutputSamples; i++, j += 4) {
    const s1 = pcmBuf.readInt16LE(j);
    const s2 = j + 2 < pcmBuf.length ? pcmBuf.readInt16LE(j + 2) : s1;
    const avg = Math.round((s1 + s2) / 2);
    out.writeInt16LE(clampSample(avg), i * 2);
  }
  return out;
}

// Browser sends at 16kHz already
function downsample16to8Browser(pcmBuf) {
  return downsample16to8(pcmBuf);
}

