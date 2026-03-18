/**
 * Call Simulation & Resource Monitor
 * 
 * Simulates the resource footprint of N concurrent calls:
 * - UDP socket per call (like AudioBridge)
 * - Audio buffer processing (G.711 decode/encode, downsampling)
 * - WebSocket-like buffers (like DeepgramAgent)
 * - RTP packet send loop at 20ms intervals
 * 
 * Measures CPU and RAM per call at each concurrency level.
 * 
 * Usage: node scripts/simulate-calls.js [maxCalls] [durationSec]
 * Example: node scripts/simulate-calls.js 10 15
 */

import dgram from 'dgram';
import os from 'os';

const MAX_CALLS = parseInt(process.argv[2]) || 10;
const CALL_DURATION_SEC = parseInt(process.argv[3]) || 15;
const RTP_INTERVAL_MS = 20;
const BYTES_PER_PACKET = 160; // 20ms of 8kHz G.711

// ====== Simulated Call ======
class SimulatedCall {
  constructor(id) {
    this.id = id;
    this.udpSocket = null;
    this.sendInterval = null;
    this.audioOutBuffer = Buffer.alloc(0);
    this.sendQueue = [];
    this.sequenceNumber = 0;
    this.timestamp = 0;
    this.packetsIn = 0;
    this.packetsOut = 0;
    // Simulate transcript buffer (like DeepgramAgent keeps)
    this.transcript = [];
    this.agentSettingsBuffer = Buffer.alloc(4096); // ~4KB config
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.udpSocket = dgram.createSocket('udp4');
      this.udpSocket.on('error', () => {}); // ignore
      this.udpSocket.on('message', (msg) => {
        this.packetsIn++;
        // Simulate G.711 decode: strip RTP header, process audio
        if (msg.length > 12) {
          const payload = msg.slice(12);
          // Simulate linear16 conversion (allocate buffer like real code)
          const pcm16 = Buffer.alloc(payload.length * 2);
          for (let i = 0; i < payload.length; i++) {
            // Simplified A-law decode simulation
            pcm16.writeInt16LE(payload[i] * 128, i * 2);
          }
        }
      });
      this.udpSocket.bind(0, '0.0.0.0', () => {
        this.localPort = this.udpSocket.address().port;
        this._startSendLoop();
        resolve(this.localPort);
      });
    });
  }

  _startSendLoop() {
    this.sendInterval = setInterval(() => {
      // Simulate generating AI audio (TTS output)
      const fakeAudio = Buffer.alloc(BYTES_PER_PACKET);
      // Simulate downsample 16kHz -> 8kHz
      const downsampled = Buffer.alloc(BYTES_PER_PACKET);
      for (let i = 0; i < BYTES_PER_PACKET; i++) {
        downsampled[i] = fakeAudio[i]; // simplified
      }
      this.sendQueue.push(downsampled);

      // Build RTP packet and "send" (to localhost, no real network)
      if (this.sendQueue.length > 0) {
        const payload = this.sendQueue.shift();
        const rtpHeader = Buffer.alloc(12);
        rtpHeader[0] = 0x80;
        rtpHeader[1] = 0x08; // PCMA
        rtpHeader.writeUInt16BE(this.sequenceNumber++ & 0xFFFF, 2);
        rtpHeader.writeUInt32BE(this.timestamp, 4);
        this.timestamp += BYTES_PER_PACKET;

        const packet = Buffer.concat([rtpHeader, payload]);
        // Send to self to simulate bidirectional RTP
        this.udpSocket.send(packet, this.localPort, '127.0.0.1');
        this.packetsOut++;
      }

      // Simulate transcript accumulation
      if (this.sequenceNumber % 50 === 0) {
        this.transcript.push({
          role: 'agent',
          text: `Simulated speech segment ${this.transcript.length}`,
          time: new Date().toISOString()
        });
      }
    }, RTP_INTERVAL_MS);
  }

  stop() {
    if (this.sendInterval) clearInterval(this.sendInterval);
    if (this.udpSocket) {
      try { this.udpSocket.close(); } catch {}
    }
  }
}

// ====== Resource Monitor ======
function getProcessUsage() {
  const mem = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers || 0,
    cpuUser: cpuUsage.user,
    cpuSystem: cpuUsage.system,
  };
}

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

function formatCPU(microseconds) {
  return (microseconds / 1000).toFixed(1);
}

// ====== Main Simulation ======
async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║       ROBOCOP Call Resource Simulation                  ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Max concurrent calls: ${MAX_CALLS}`);
  console.log(`║  Call duration:        ${CALL_DURATION_SEC}s each`);
  console.log(`║  RTP interval:         ${RTP_INTERVAL_MS}ms`);
  console.log(`║  System RAM:           ${formatMB(os.totalmem())} MB`);
  console.log(`║  Free RAM:             ${formatMB(os.freemem())} MB`);
  console.log(`║  CPUs:                 ${os.cpus().length} cores`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const baseline = getProcessUsage();
  const activeCalls = [];
  const results = [];

  console.log("Calls | RSS (MB) | Heap (MB) | Ext (MB) | CPU user (ms) | CPU sys (ms) | Per-call RAM (MB)");
  console.log("------+----------+-----------+----------+---------------+--------------+------------------");

  for (let n = 1; n <= MAX_CALLS; n++) {
    // Start a new call
    const call = new SimulatedCall(n);
    await call.start();
    activeCalls.push(call);

    // Let it run for a moment to stabilize
    await sleep(1500);

    // Force GC if available
    if (global.gc) global.gc();

    // Measure
    const usage = getProcessUsage();
    const deltaRss = usage.rss - baseline.rss;
    const perCallRam = deltaRss / n;

    const row = {
      calls: n,
      rss: usage.rss,
      heap: usage.heapUsed,
      external: usage.external,
      cpuUser: usage.cpuUser - baseline.cpuUser,
      cpuSys: usage.cpuSystem - baseline.cpuSystem,
      perCallRam,
    };
    results.push(row);

    console.log(
      `  ${String(n).padStart(3)}  | ` +
      `${formatMB(usage.rss).padStart(8)} | ` +
      `${formatMB(usage.heapUsed).padStart(9)} | ` +
      `${formatMB(usage.external).padStart(8)} | ` +
      `${formatCPU(row.cpuUser).padStart(13)} | ` +
      `${formatCPU(row.cpuSys).padStart(12)} | ` +
      `${formatMB(perCallRam).padStart(16)}`
    );
  }

  // Let all calls run at peak for the full duration
  console.log(`\n⏳ Running ${MAX_CALLS} concurrent calls for ${CALL_DURATION_SEC}s at peak...`);

  const peakSamples = [];
  const peakStart = Date.now();
  const sampleInterval = setInterval(() => {
    const u = getProcessUsage();
    peakSamples.push({
      time: Date.now() - peakStart,
      rss: u.rss,
      heapUsed: u.heapUsed,
      cpuUser: u.cpuUser,
      cpuSystem: u.cpuSystem,
    });
  }, 1000);

  await sleep(CALL_DURATION_SEC * 1000);
  clearInterval(sampleInterval);

  // Aggregate packet stats
  let totalIn = 0, totalOut = 0;
  for (const c of activeCalls) {
    totalIn += c.packetsIn;
    totalOut += c.packetsOut;
  }

  // Stop all calls
  for (const call of activeCalls) call.stop();
  await sleep(500);

  // Final measurement
  const final = getProcessUsage();

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    RESULTS SUMMARY                      ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Peak concurrent calls:  ${MAX_CALLS}`);
  console.log(`║  Peak RSS:               ${formatMB(Math.max(...peakSamples.map(s => s.rss)))} MB`);
  console.log(`║  Peak Heap:              ${formatMB(Math.max(...peakSamples.map(s => s.heapUsed)))} MB`);
  console.log(`║  Avg RSS:                ${formatMB(peakSamples.reduce((a, s) => a + s.rss, 0) / peakSamples.length)} MB`);
  console.log(`║  Baseline RSS:           ${formatMB(baseline.rss)} MB`);
  console.log(`║  Total delta RSS:        ${formatMB(Math.max(...peakSamples.map(s => s.rss)) - baseline.rss)} MB`);
  console.log(`║  RAM per call (avg):     ${formatMB((Math.max(...peakSamples.map(s => s.rss)) - baseline.rss) / MAX_CALLS)} MB`);
  console.log(`║  Total CPU user:         ${formatCPU(final.cpuUser - baseline.cpuUser)} ms`);
  console.log(`║  Total CPU system:       ${formatCPU(final.cpuSystem - baseline.cpuSystem)} ms`);
  console.log(`║  Total RTP packets in:   ${totalIn}`);
  console.log(`║  Total RTP packets out:  ${totalOut}`);
  console.log(`║  Packets per call/sec:   ${(totalOut / MAX_CALLS / CALL_DURATION_SEC).toFixed(1)}`);
  console.log("╠══════════════════════════════════════════════════════════╣");

  // Estimate max calls for this machine
  const perCallMB = (Math.max(...peakSamples.map(s => s.rss)) - baseline.rss) / MAX_CALLS / 1024 / 1024;
  const availableMB = os.freemem() / 1024 / 1024;
  const estimatedMax = Math.floor(availableMB / Math.max(perCallMB, 1));

  console.log(`║  ESTIMATE: ~${perCallMB.toFixed(2)} MB per call`);
  console.log(`║  Available RAM: ${availableMB.toFixed(0)} MB`);
  console.log(`║  Estimated max calls:    ~${Math.min(estimatedMax, 10000)}`);
  console.log("║");
  console.log("║  NOTE: Real calls also use Deepgram WebSocket (~2-5 MB)");
  console.log("║  and SIP dialog memory. Multiply estimate by ~0.5x for");
  console.log("║  real-world capacity with full AI agent pipeline.");
  console.log("╚══════════════════════════════════════════════════════════╝");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
