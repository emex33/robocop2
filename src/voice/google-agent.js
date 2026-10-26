import { AssemblyGoogleAgent } from "./assembly-google-agent.js";
import { GoogleSttStream } from "./google-stt-stream.js";

/**
 * Campaign voice path: Google streaming STT → LLM Gateway → Google Cloud TTS.
 * Same callbacks as DeepgramAgent / AssemblyGoogleAgent.
 */
export class GoogleAgent extends AssemblyGoogleAgent {
  constructor(callId, options = {}) {
    super(callId, { ...options, StreamClass: GoogleSttStream });
  }
}
