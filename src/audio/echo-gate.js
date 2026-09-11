/**
 * Echo gate — keeps the AI from hearing (and reacting to) its own voice.
 *
 * Some phones (speakerphone, car kits, cheap headsets) leak the audio we play
 * back into their microphone. That echo reaches Deepgram as "user speech":
 * the VAD fires UserStartedSpeaking (so the agent cuts itself off mid-sentence,
 * "you keep interrupting yourself"), and the transcript fills with the agent's
 * own words, which the LLM then answers. Seen verbatim on a live call:
 * assistant "I'll wait for you. Take your time." -> user "I'll wait for you.
 * Take your time."
 *
 * We know exactly what we sent, so echo is detectable without heavy DSP:
 * the loudness envelope (dB per 20 ms frame) of the echo is a delayed copy of
 * the envelope of what we transmitted. We correlate the recent inbound
 * envelope against the outbound envelope at every plausible lag (60 ms - 1.5 s).
 * A high correlation at a stable lag = echo path confirmed; we then also learn
 * how much quieter the echo is than our signal (echo return loss). From then
 * on, inbound frames that arrive while our audio was playing `lag` ago and are
 * not louder than the expected echo (+6 dB headroom) are replaced with silence
 * before reaching Deepgram. Genuine speech over the agent is louder than the
 * echo and has an uncorrelated envelope, so it still passes.
 *
 * Calls without an echo path never lock, so nothing changes for them.
 */
import logger from "../utils/logger.js";

const HIST = 125;            // outbound history: 2.5 s of 20 ms frames
const WIN = 40;              // correlation window: 800 ms
const MIN_LAG = 3;           // 60 ms
const MAX_LAG = 75;          // 1.5 s
const FLOOR_DB = -60;
const ACTIVE_DB = -45;       // above this a frame counts as "signal"
const LOCK_CORR = 0.8;
const LOCK_HITS = 4;         // independent votes (400 ms apart) for the same lag before we trust it
const HEADROOM_DB = 6;       // suppress inbound up to this much louder than the expected echo
const MIN_STD_DB = 4;        // envelopes flatter than this carry no information
const MIN_PAIRS = 8;         // active in/out frame pairs needed to estimate echo loss

export class EchoGate {
  constructor(callId) {
    this.callId = callId;
    this.out = new Float64Array(HIST).fill(FLOOR_DB);
    this.outCount = 0;
    this.inWin = new Float64Array(WIN).fill(FLOOR_DB);
    this.inCount = 0;
    this.lockedLag = -1;
    this.erlDb = 0;
    this.candidateLag = -1;
    this.hits = 0;
    this.lastVoteFrame = -1000;
    this.suppressed = 0;
    this.total = 0;
    this.lockedAt = null;
  }

  /** Level (dBFS) of the 20 ms frame we just transmitted; FLOOR_DB when nothing was sent. */
  pushOutbound(db) {
    this.out[this.outCount % HIST] = db < FLOOR_DB ? FLOOR_DB : db;
    this.outCount++;
  }

  _outAt(lag) {
    const i = this.outCount - 1 - lag;
    return i < 0 ? FLOOR_DB : this.out[i % HIST];
  }

  /**
   * Classify one inbound 20 ms frame given its level in dBFS.
   * Returns true when the frame should be replaced with silence.
   */
  isEcho(inDb) {
    if (inDb < FLOOR_DB) inDb = FLOOR_DB;
    this.inWin[this.inCount % WIN] = inDb;
    this.inCount++;
    this.total++;

    if (this.outCount < MIN_LAG + WIN || inDb < ACTIVE_DB) return false;

    // Any of our audio in the plausible echo window? Otherwise it cannot be echo.
    let anyOut = false;
    for (let l = MIN_LAG; l <= MAX_LAG && !anyOut; l++) if (this._outAt(l) > ACTIVE_DB) anyOut = true;
    if (!anyOut) return false;

    this._track();

    if (this.lockedLag < 0) return false;

    // Expected echo level from what we sent `lag` ago (Â±40 ms jitter tolerance)
    let outLvl = FLOOR_DB;
    for (let l = this.lockedLag - 2; l <= this.lockedLag + 2; l++) {
      const v = this._outAt(l);
      if (v > outLvl) outLvl = v;
    }
    if (outLvl <= ACTIVE_DB) return false;

    const expectedEcho = outLvl - this.erlDb;
    if (inDb <= expectedEcho + HEADROOM_DB) {
      this.suppressed++;
      return true;
    }
    return false;
  }

  /** Correlate the inbound envelope window with the outbound envelope at each lag. */
  _track() {
    if (this.inCount < WIN) return;
    // Inbound window oldest -> newest
    const x = new Float64Array(WIN);
    let mx = 0;
    for (let k = 0; k < WIN; k++) {
      x[k] = this.inWin[(this.inCount - WIN + k) % WIN];
      mx += x[k];
    }
    mx /= WIN;
    let vx = 0;
    for (let k = 0; k < WIN; k++) vx += (x[k] - mx) ** 2;
    if (Math.sqrt(vx / WIN) < MIN_STD_DB) return;

    let bestR = 0, bestLag = -1;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let my = 0;
      for (let k = 0; k < WIN; k++) my += this._outAt(lag + (WIN - 1 - k));
      my /= WIN;
      let sxy = 0, vy = 0;
      for (let k = 0; k < WIN; k++) {
        const dy = this._outAt(lag + (WIN - 1 - k)) - my;
        sxy += (x[k] - mx) * dy;
        vy += dy * dy;
      }
      if (Math.sqrt(vy / WIN) < MIN_STD_DB) continue;
      const r = sxy / Math.sqrt(vx * vy);
      if (r > bestR) { bestR = r; bestLag = lag; }
    }

    if (bestR < LOCK_CORR) { this.hits = 0; return; }

    // Echo loss: median of (sent level - received level) over frames where both were active
    const diffs = [];
    for (let k = 0; k < WIN; k++) {
      const o = this._outAt(bestLag + (WIN - 1 - k));
      if (o > ACTIVE_DB && x[k] > ACTIVE_DB) diffs.push(o - x[k]);
    }
    if (diffs.length < MIN_PAIRS) { this.hits = 0; return; }
    diffs.sort((a, b) => a - b);
    const erl = diffs[diffs.length >> 1];
    // Echo must not be louder than what we sent (allow a little for gain quirks)
    if (erl < -3) { this.hits = 0; return; }

    // Consecutive frames share almost the whole window, so they are not
    // independent evidence. Count one vote per half-window (400 ms) and demand
    // the SAME lag every time: chance correlations wander, real echo does not.
    if (this.inCount - this.lastVoteFrame < WIN / 4) return;
    this.lastVoteFrame = this.inCount;
    if (this.candidateLag >= 0 && Math.abs(bestLag - this.candidateLag) <= 1) this.hits++;
    else { this.candidateLag = bestLag; this.hits = 1; }

    if (this.hits >= LOCK_HITS) {
      const first = this.lockedLag < 0;
      this.lockedLag = bestLag;
      // Track the loudest echo we have seen (smallest loss) so the gate stays conservative
      this.erlDb = first ? erl : Math.min(this.erlDb, erl);
      if (first) {
        this.lockedAt = Date.now();
        logger.info(`Echo detected: our audio returns after ~${bestLag * 20} ms, ~${erl.toFixed(0)} dB quieter — suppressing it toward Deepgram`, { callId: this.callId });
      }
    }
  }

  summary() {
    if (this.lockedLag < 0) return null;
    return `lag ${this.lockedLag * 20} ms, ERL ${this.erlDb.toFixed(0)} dB, suppressed ${this.suppressed}/${this.total} inbound frames`;
  }
}

/** RMS level in dBFS of a 16-bit LE PCM buffer. */
export function pcmDb(pcm) {
  const n = pcm.length >> 1;
  if (n === 0) return FLOOR_DB;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    acc += s * s;
  }
  const rms = Math.sqrt(acc / n);
  return rms > 0 ? 20 * Math.log10(rms / 32768) : FLOOR_DB;
}
