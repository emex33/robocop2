/**
 * Answering-machine / voicemail detection from the callee's transcribed speech.
 *
 * The agent prompt already tells the model to hang up on voicemail, but the
 * model frequently delivered the whole pitch to an answering machine instead,
 * burning carrier minutes and AI tokens on every one. Detection therefore has
 * to be deterministic and happen in code, before the model gets a turn.
 *
 * The phrase lists below are derived from real call transcripts rather than
 * guesswork; see the canonicalise() note for the spelling trap that silently
 * disabled several of them.
 */

/**
 * Phrases only a machine produces. Acted on at any point in the call.
 * Written lowercase, accent-free and apostrophe-free to match normalize(),
 * and using the canonical spellings produced by canonicalise().
 */
const MACHINE_PHRASES = [
  // English — record/leave instructions
  "leave a message",
  "leave your message",
  "leave a detailed message",
  "leave a brief message",
  "leave me a message",
  "leave me a brief message",
  "leave me a short message",
  "leave us a message",
  "leave your name and number",
  "leave your name number",
  "leave your phone number",
  "and a brief message",
  "if you leave your name",
  "if you leave me",
  "if you leave us",
  "please leave your name",
  "record your message",
  "start recording",
  "begin recording",
  "when you have finished recording",
  "when you are finished recording",
  "after leaving a message",
  "to leave a callback number",
  "your message will be transcribed",
  // English — tone/beep
  "after the tone",
  "after the beep",
  "at the tone",
  "at the beep",
  "following the tone",
  "when you hear the beep",
  "when you hear the tone",
  // English — voicemail box
  "you have reached the voicemail",
  "reached the voicemail of",
  "voicemail box",
  "mailbox number",
  "mailbox is full",
  "voicemail system",
  "voicemail service",
  "enter your mailbox number",
  "message pickup",
  // English — unavailability announcements
  "not available to take your call",
  "unable to take your call",
  "unavailable to take your call",
  "cant take your call",
  "cannot take your call",
  "no one is available to take your call",
  "the person you are trying to reach",
  "the person youre trying to reach",
  "the party you are trying to reach",
  "the customer you are calling",
  "the person you have called",
  "the person you called",
  "cant come to the phone",
  "cannot come to the phone",
  // English — forwarding / automated systems
  "has been forwarded to voicemail",
  "forwarded to voicemail",
  "your call has been forwarded",
  "call has been forwarded",
  "forwarded to an automated voice",
  "forwarded to an automatic voice",
  "automated voice messaging system",
  "automated voice message system",
  "automatic voice messaging system",
  "automatic voice message system",
  "voice messaging system",
  "voice message system",
  "has not been initialized",
  // English — keypad prompts
  "press 1 to leave",
  "press one to leave",
  "press the pound key",
  "press pound when",
  "press pound for more options",
  "or press pound",
  "to get through please press",
  // French (Canada)
  "laissez un message",
  "laissez votre message",
  "veuillez laisser un message",
  "enregistrez votre message",
  "apres le signal",
  "apres la tonalite",
  "boite vocale",
  "messagerie vocale",
  "service de messagerie",
  "nest pas disponible",
  "le numero que vous avez compose",
];

/**
 * Phrases that are machine-like only in the opening seconds. A live lead can
 * legitimately say some of these later on, so they are time-boxed.
 *
 * "you have reached" and the self-introduction patterns belong here rather than
 * above: a human occasionally says "you've reached the wrong number", and the
 * greeting variants ("I'm busy right now", "I'll call you back") are things a
 * real person might say once a conversation is under way — but not before our
 * agent has said anything.
 */
const EARLY_PHRASES = [
  "you have reached",
  "youve reached",
  "not available right now",
  "not available at this time",
  "not available at the moment",
  "im not available",
  "im unavailable",
  "im busy right now",
  "im not able to answer",
  "im sorry im not able to",
  "ill call you back",
  "ill get back to you as soon as",
  "get back to you as soon as possible",
  "thank you for calling",
  "your call is important",
  "we are currently closed",
  "our office is closed",
  "office hours are",
];

/**
 * Call screening (Google Voice and similar): the caller is asked to state a
 * name, and the person being called may still pick up afterwards. Measured
 * against real transcripts, screened calls do convert to appointments, so
 * these are reported separately and are NOT hung up on by default.
 */
const SCREENING_PHRASES = [
  "record your name",
  "say your name after",
  "state your name",
  "this call is being screened",
  "see if this person is available",
];

const EARLY_WINDOW_MS = 30_000;

/**
 * Fold spelling variants the transcriber uses interchangeably.
 *
 * Deepgram writes "voice mail" about as often as "voicemail", and because
 * normalize() reduces punctuation to spaces the two are different strings. That
 * made phrases like "has been forwarded to voicemail" silently miss every
 * transcript that happened to be spelled the other way. Folding here means each
 * phrase only has to be written once.
 */
function canonicalise(text) {
  return text
    .replace(/\bvoice\s+mails?\b/g, "voicemail")
    .replace(/\bvoice\s*mail\s*box\b/g, "voicemail box")
    .replace(/\bmail\s+box\b/g, "mailbox")
    .replace(/\banswering\s+machine\b/g, "voicemail");
}

/** Lowercase, strip accents/apostrophes, collapse punctuation to spaces. */
function normalize(text) {
  const flattened = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return canonicalise(flattened);
}

/**
 * @param {string} text - One transcribed utterance from the callee.
 * @param {object} [options]
 * @param {number} [options.elapsedMs] - Time since the call was answered.
 * @param {boolean} [options.includeScreening] - Also flag call-screening prompts.
 * @returns {{phrase: string, kind: "voicemail"|"screening", confidence: "high"|"early"}|null}
 */
export function detectVoicemail(text, options = {}) {
  const { elapsedMs = 0, includeScreening = false } = options;
  const normalized = normalize(text);
  if (normalized.length < 6) return null;

  for (const phrase of MACHINE_PHRASES) {
    if (normalized.includes(phrase)) return { phrase, kind: "voicemail", confidence: "high" };
  }

  if (elapsedMs <= EARLY_WINDOW_MS) {
    for (const phrase of EARLY_PHRASES) {
      if (normalized.includes(phrase)) return { phrase, kind: "voicemail", confidence: "early" };
    }
  }

  if (includeScreening) {
    for (const phrase of SCREENING_PHRASES) {
      if (normalized.includes(phrase)) return { phrase, kind: "screening", confidence: "high" };
    }
  }

  return null;
}
