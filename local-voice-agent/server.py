"""
Local Voice Agent Server — GPU-Optimized for 20+ Concurrent Calls

Architecture:
- Dedicated CUDA streams for STT and TTS (true GPU parallelism)
- Async job queues with priority scheduling
- Semaphore-based concurrency control (no global lock)
- torch.inference_mode() for all GPU ops (saves memory + speed)
- Pre-allocated silence buffers
- Connection tracking and stats

Protocol:
  Client -> Server:
    - JSON: Settings, KeepAlive, FunctionCallResponse
    - Binary: raw PCM audio (linear16, 16kHz)
  Server -> Client:
    - JSON: Welcome, SettingsApplied, ConversationText, UserStartedSpeaking,
            AgentStartedSpeaking, AgentAudioDone, AgentThinking, FunctionCallRequest, Error
    - Binary: raw PCM audio (linear16, 24kHz)
"""

import asyncio
import json
import logging
import os
os.environ["COQUI_TOS_AGREED"] = "1"
os.environ["TORCHAUDIO_USE_BACKEND_DISPATCHER"] = "1"
import re
import struct
import sys
import time
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor
from collections import deque
from io import BytesIO
from math import gcd

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
import torch
import torchaudio

def _sf_load(filepath, **kwargs):
    data, sr = sf.read(filepath, dtype="float32")
    if data.ndim == 1:
        data = data[np.newaxis, :]
    else:
        data = data.T
    return torch.from_numpy(data), sr

torchaudio.load = _sf_load

import websockets

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("voice-agent")

# ── Global state ────────────────────────────────────────────────────
_whisper_model = None
_tts_model = None
_speaker_latent = None
_gpt_cond_latent = None

_stt_stream: torch.cuda.Stream = None
_tts_stream: torch.cuda.Stream = None

_active_sessions: dict[str, "VoiceSession"] = {}

# ── Config ──────────────────────────────────────────────────────────
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")
TTS_MODEL_NAME = os.environ.get("TTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2")
TTS_SPEAKER_WAV = os.environ.get("TTS_SPEAKER_WAV", "")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
LLM_API_KEY = os.environ.get("LLM_API_KEY", os.environ.get("GEMINI_API_KEY", os.environ.get("OPENAI_API_KEY", "")))
LLM_MODEL = os.environ.get("LLM_MODEL", "gemini-2.5-flash")
SERVER_PORT = int(os.environ.get("VOICE_AGENT_PORT", "8765"))

STT_BEAM_SIZE = int(os.environ.get("STT_BEAM_SIZE", "5"))
STT_BEST_OF = int(os.environ.get("STT_BEST_OF", "1"))
STT_VAD_MIN_SILENCE_MS = int(os.environ.get("STT_VAD_MIN_SILENCE_MS", "300"))
STT_NO_SPEECH_THRESHOLD = float(os.environ.get("STT_NO_SPEECH_THRESHOLD", "0.6"))
STT_COMPRESSION_RATIO_THRESHOLD = float(os.environ.get("STT_COMPRESSION_RATIO_THRESHOLD", "2.4"))
STT_LOG_PROB_THRESHOLD = float(os.environ.get("STT_LOG_PROB_THRESHOLD", "-0.5"))

LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "180"))
LLM_TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", "0.2"))
MAX_HISTORY_MESSAGES = int(os.environ.get("MAX_HISTORY_MESSAGES", "16"))

VAD_THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.35"))
BARGE_IN_THRESHOLD = float(os.environ.get("BARGE_IN_THRESHOLD", "0.45"))
BARGE_IN_MIN_FRAMES = int(os.environ.get("BARGE_IN_MIN_FRAMES", "5"))
POST_TTS_IGNORE_MS = int(os.environ.get("POST_TTS_IGNORE_MS", "350"))
MAX_RESPONSE_SENTENCES = int(os.environ.get("MAX_RESPONSE_SENTENCES", "3"))
MAX_RESPONSE_CHARS = int(os.environ.get("MAX_RESPONSE_CHARS", "280"))
WS_PING_INTERVAL = int(os.environ.get("WS_PING_INTERVAL", "20"))
WS_PING_TIMEOUT = int(os.environ.get("WS_PING_TIMEOUT", "60"))

TTS_TEMPERATURE = float(os.environ.get("TTS_TEMPERATURE", "0.85"))
TTS_TOP_P = float(os.environ.get("TTS_TOP_P", "0.85"))
TTS_TOP_K = int(os.environ.get("TTS_TOP_K", "50"))
TTS_REPETITION_PENALTY = float(os.environ.get("TTS_REPETITION_PENALTY", "1.5"))
TTS_LENGTH_PENALTY = float(os.environ.get("TTS_LENGTH_PENALTY", "1.0"))
TTS_SPEED = float(os.environ.get("TTS_SPEED", "1.1"))
TTS_STREAM_CHUNK_MS = int(os.environ.get("TTS_STREAM_CHUNK_MS", "20"))
TTS_STREAM_SLEEP_MS = float(os.environ.get("TTS_STREAM_SLEEP_MS", "0.015"))

# Concurrency: how many STT/TTS jobs can run at once.
# On 12GB VRAM, STT and TTS share the GPU. We use CUDA streams for overlap
# but limit concurrency so we don't OOM.
GPU_STT_CONCURRENCY = int(os.environ.get("GPU_STT_CONCURRENCY", "3"))
GPU_TTS_CONCURRENCY = int(os.environ.get("GPU_TTS_CONCURRENCY", "2"))

INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000
SILENCE_DURATION_MS = int(os.environ.get("SILENCE_DURATION_MS", "700"))

SPEAKER_WAVS_DIR = "/app/speaker_wavs"

# Pre-allocated silence buffer (avoids re-creating it every call)
_SILENCE_1500MS = None


def _get_silence_buffer():
    global _SILENCE_1500MS
    if _SILENCE_1500MS is None:
        num_samples = int(OUTPUT_SAMPLE_RATE * 1.5)
        _SILENCE_1500MS = np.zeros(num_samples, dtype=np.int16).tobytes()
    return _SILENCE_1500MS


# ── Thread pools — separate pools for STT and TTS GPU work ─────────
_stt_executor: ThreadPoolExecutor = None
_tts_executor: ThreadPoolExecutor = None
_stt_semaphore: asyncio.Semaphore = None
_tts_semaphore: asyncio.Semaphore = None


def _init_executors():
    global _stt_executor, _tts_executor, _stt_semaphore, _tts_semaphore
    _stt_executor = ThreadPoolExecutor(max_workers=GPU_STT_CONCURRENCY, thread_name_prefix="stt")
    _tts_executor = ThreadPoolExecutor(max_workers=GPU_TTS_CONCURRENCY, thread_name_prefix="tts")
    _stt_semaphore = asyncio.Semaphore(GPU_STT_CONCURRENCY)
    _tts_semaphore = asyncio.Semaphore(GPU_TTS_CONCURRENCY)
    log.info(f"Thread pools: STT workers={GPU_STT_CONCURRENCY}, TTS workers={GPU_TTS_CONCURRENCY}")


# ── Model loaders ───────────────────────────────────────────────────

def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        log.info(f"Loading Whisper model: {WHISPER_MODEL_SIZE} on {WHISPER_DEVICE} ({WHISPER_COMPUTE_TYPE})")
        _whisper_model = WhisperModel(
            WHISPER_MODEL_SIZE,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
        )
        log.info("Whisper model loaded")
    return _whisper_model


def get_tts():
    global _tts_model
    if _tts_model is None:
        from TTS.api import TTS
        log.info(f"Loading TTS model: {TTS_MODEL_NAME}")
        _tts_model = TTS(model_name=TTS_MODEL_NAME)
        if hasattr(_tts_model, "to") and WHISPER_DEVICE != "cpu":
            _tts_model.to(WHISPER_DEVICE)
        log.info("TTS model loaded")
    return _tts_model


def precompute_speaker_latents(speaker_wav_path: str):
    global _speaker_latent, _gpt_cond_latent
    tts = get_tts()
    if not hasattr(tts, "synthesizer") or not hasattr(tts.synthesizer, "tts_model"):
        log.warning("Cannot precompute speaker latents — model structure not as expected")
        return
    model = tts.synthesizer.tts_model
    if not hasattr(model, "get_conditioning_latents"):
        log.warning("XTTS model does not support get_conditioning_latents")
        return
    log.info(f"Pre-computing speaker latents from {speaker_wav_path}...")
    with torch.inference_mode():
        gpt_cond, speaker = model.get_conditioning_latents(audio_path=[speaker_wav_path])
    _gpt_cond_latent = gpt_cond
    _speaker_latent = speaker
    log.info("Speaker latents cached — voice identity locked in")


def _init_cuda_streams():
    global _stt_stream, _tts_stream
    if WHISPER_DEVICE != "cpu" and torch.cuda.is_available():
        _stt_stream = torch.cuda.Stream()
        _tts_stream = torch.cuda.Stream()
        log.info("CUDA streams created: STT and TTS can overlap on GPU")
    else:
        log.info("CPU mode — no CUDA streams")


# ── Audio utilities ─────────────────────────────────────────────────

def pcm_to_float(pcm_bytes: bytes) -> np.ndarray:
    return np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

def preprocess_for_stt(audio: np.ndarray) -> np.ndarray:
    """Minimal preprocessing — DC removal + normalize. No bandpass filter,
    because it was destroying speech on phone audio and Whisper handles
    noise natively with large-v3-turbo."""
    if audio.size == 0:
        return audio
    audio = audio - np.mean(audio)
    peak = np.max(np.abs(audio))
    if peak > 1e-6:
        audio = audio / peak * 0.95
    return np.clip(audio, -1.0, 1.0).astype(np.float32)


def high_quality_resample(audio: np.ndarray, source_sr: int, target_sr: int) -> np.ndarray:
    if source_sr == target_sr:
        return audio
    g = gcd(source_sr, target_sr)
    up = target_sr // g
    down = source_sr // g
    return resample_poly(audio, up, down).astype(np.float32)


def float_to_pcm(audio: np.ndarray, target_sr: int, source_sr: int) -> bytes:
    audio = high_quality_resample(audio, source_sr, target_sr)
    audio = np.clip(audio * 32768.0, -32768, 32767).astype(np.int16)
    return audio.tobytes()


# ── Text processing ─────────────────────────────────────────────────

def clean_text_for_tts(text: str) -> str:
    text = re.sub(r'\*([^*]+)\*', r'\1', text)
    text = re.sub(r'#+\s*', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text)
    text = re.sub(r'`[^`]*`', '', text)
    text = re.sub(r'[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF\U00002702-\U000027B0\U000024C2-\U0001F251]+', '', text)
    text = re.sub(r'\n+', '. ', text)
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r'\.{4,}', '...', text)
    return text.strip()


def split_into_sentences(text: str) -> list[str]:
    parts = re.split(r'(?<=[.!?])\s+', text)
    sentences = [p.strip() for p in parts if p.strip()]
    return sentences if sentences else [text]


def find_speaker_wav() -> str | None:
    if TTS_SPEAKER_WAV and os.path.exists(TTS_SPEAKER_WAV):
        return TTS_SPEAKER_WAV
    if os.path.isdir(SPEAKER_WAVS_DIR):
        for f in sorted(os.listdir(SPEAKER_WAVS_DIR)):
            if f.lower().endswith((".wav", ".mp3", ".flac", ".ogg")):
                path = os.path.join(SPEAKER_WAVS_DIR, f)
                log.info(f"Using speaker reference: {path}")
                return path
    return None


# ── GPU job runners (with CUDA stream isolation) ────────────────────

_HALLUCINATION_PATTERNS = re.compile(
    r'(?i)(thank you|thanks for watching|subscribe|like and subscribe|'
    r'gracias por ver|suscribete|subtitles by|translated by|'
    r'please leave|leave (a |your )?message|after the (tone|beep)|'
    r'unable to take|cannot take|not available|'
    r'para (dejar|grabar)|deje su mensaje|después del tono|'
    r'no puede (atender|tomar)|persona que (está )?llamando)',
)

def _run_stt(pcm_float, language, beam_size, best_of, vad_min_silence,
             no_speech_thr, compression_thr, log_prob_thr):
    """Run Whisper transcription with VAD on + per-segment hallucination filter."""
    transcribe_kwargs = dict(
        language=language,
        beam_size=beam_size,
        best_of=best_of,
        condition_on_previous_text=False,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": vad_min_silence},
        no_speech_threshold=no_speech_thr,
        compression_ratio_threshold=compression_thr,
        log_prob_threshold=log_prob_thr,
    )
    stream = _stt_stream
    if stream is not None:
        with torch.cuda.stream(stream), torch.inference_mode():
            segments, info = get_whisper().transcribe(pcm_float, **transcribe_kwargs)
            good = []
            for s in segments:
                t = s.text.strip()
                if t and s.no_speech_prob < 0.7 and not _HALLUCINATION_PATTERNS.search(t):
                    good.append(t)
            text = " ".join(good).strip()
        stream.synchronize()
    else:
        with torch.inference_mode():
            segments, info = get_whisper().transcribe(pcm_float, **transcribe_kwargs)
            good = []
            for s in segments:
                t = s.text.strip()
                if t and s.no_speech_prob < 0.7 and not _HALLUCINATION_PATTERNS.search(t):
                    good.append(t)
            text = " ".join(good).strip()
    return text, info


def _run_tts(text: str, language: str, speaker_wav: str | None) -> np.ndarray:
    """Run XTTS synthesis on the TTS CUDA stream."""
    tts = get_tts()

    if not hasattr(tts, "synthesizer") or not hasattr(tts.synthesizer, "tts_model"):
        return np.array(tts.tts(text=text, language=language, speaker_wav=speaker_wav))

    model = tts.synthesizer.tts_model

    if _gpt_cond_latent is not None and _speaker_latent is not None:
        gpt_cond = _gpt_cond_latent
        speaker = _speaker_latent
    elif speaker_wav:
        with torch.inference_mode():
            gpt_cond, speaker = model.get_conditioning_latents(audio_path=[speaker_wav])
    else:
        return np.array(tts.tts(text=text, language=language))

    stream = _tts_stream
    if stream is not None:
        with torch.cuda.stream(stream), torch.inference_mode():
            out = model.inference(
                text, language, gpt_cond, speaker,
                temperature=TTS_TEMPERATURE,
                top_p=TTS_TOP_P,
                top_k=TTS_TOP_K,
                repetition_penalty=TTS_REPETITION_PENALTY,
                length_penalty=TTS_LENGTH_PENALTY,
                speed=TTS_SPEED,
                enable_text_splitting=False,
            )
        stream.synchronize()
    else:
        with torch.inference_mode():
            out = model.inference(
                text, language, gpt_cond, speaker,
                temperature=TTS_TEMPERATURE,
                top_p=TTS_TOP_P,
                top_k=TTS_TOP_K,
                repetition_penalty=TTS_REPETITION_PENALTY,
                length_penalty=TTS_LENGTH_PENALTY,
                speed=TTS_SPEED,
                enable_text_splitting=False,
            )

    wav = out.get("wav", None)
    if wav is None:
        return np.array(tts.tts(text=text, language=language, speaker_wav=speaker_wav))

    if isinstance(wav, torch.Tensor):
        wav = wav.squeeze().cpu().numpy()
    return np.asarray(wav, dtype=np.float32)


# ── Silero VAD — neural speech detection ────────────────────────────

_silero_init_lock = threading.Lock()
_silero_loaded = False

def _ensure_silero_cached():
    """Download Silero VAD weights once at startup (thread-safe).
    Each session gets its own model instance for independent hidden states."""
    global _silero_loaded
    if not _silero_loaded:
        with _silero_init_lock:
            if not _silero_loaded:
                log.info("Downloading Silero VAD model...")
                torch.hub.load(
                    repo_or_dir='snakers4/silero-vad',
                    model='silero_vad',
                    force_reload=False,
                    onnx=False,
                    trust_repo=True,
                )
                _silero_loaded = True
                log.info("Silero VAD cached")


def _create_silero_instance():
    """Create a fresh Silero VAD model instance — each session gets its own
    so hidden states don't bleed between calls."""
    _ensure_silero_cached()
    model, _ = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
        force_reload=False,
        onnx=False,
        trust_repo=True,
    )
    model.eval()
    return model


class SileroVAD:
    """Neural VAD using Silero — detects actual speech, not just loud noise.
    Each instance has its own model for independent hidden state.
    Silero expects 16kHz mono, 512-sample chunks (32ms)."""

    def __init__(self, threshold=0.35, min_speech_frames=2):
        self.threshold = threshold
        self.speaking = False
        self.silence_start = None
        self._speech_frames = 0
        self._min_speech_frames = min_speech_frames
        self._model = _create_silero_instance()
        self._buffer = np.array([], dtype=np.float32)
        self._CHUNK = 512  # Silero expects 512 samples at 16kHz
        self._barge_model = _create_silero_instance()

    def process(self, pcm_float: np.ndarray) -> str:
        self._buffer = np.concatenate([self._buffer, pcm_float])

        result = "silence"
        while len(self._buffer) >= self._CHUNK:
            chunk = self._buffer[:self._CHUNK]
            self._buffer = self._buffer[self._CHUNK:]

            tensor = torch.from_numpy(chunk).unsqueeze(0)
            with torch.inference_mode():
                prob = self._model(tensor, INPUT_SAMPLE_RATE).item()

            if prob > self.threshold:
                self._speech_frames += 1
                was_silent = not self.speaking and self._speech_frames >= self._min_speech_frames
                if self._speech_frames >= self._min_speech_frames:
                    self.speaking = True
                self.silence_start = None
                if was_silent:
                    result = "speech_start"
                else:
                    result = "speech"
            else:
                self._speech_frames = 0
                if self.speaking:
                    if self.silence_start is None:
                        self.silence_start = time.time()
                    elif (time.time() - self.silence_start) * 1000 > SILENCE_DURATION_MS:
                        self.speaking = False
                        self.silence_start = None
                        result = "speech_end"

        return result

    def check_speech_probability(self, pcm_float: np.ndarray) -> float:
        """Get raw speech probability for a chunk — used for barge-in.
        Uses a separate model instance so barge-in checks don't corrupt
        the main VAD hidden state."""
        if len(pcm_float) < self._CHUNK:
            padded = np.zeros(self._CHUNK, dtype=np.float32)
            padded[:len(pcm_float)] = pcm_float
            pcm_float = padded
        else:
            pcm_float = pcm_float[:self._CHUNK]
        tensor = torch.from_numpy(pcm_float).unsqueeze(0)
        with torch.inference_mode():
            return self._barge_model(tensor, INPUT_SAMPLE_RATE).item()

    def reset(self):
        self.speaking = False
        self.silence_start = None
        self._speech_frames = 0
        self._buffer = np.array([], dtype=np.float32)
        self._model.reset_states()
        self._barge_model.reset_states()


# ── Voice session ───────────────────────────────────────────────────

class VoiceSession:
    def __init__(self, ws):
        self.ws = ws
        self.session_id = str(uuid.uuid4())[:8]
        self.settings = None
        self.prompt = ""
        self.functions = []
        self.greeting = ""
        self.language = "en"
        self.conversation = []
        self.audio_buffer = bytearray()
        self.vad = SileroVAD(threshold=VAD_THRESHOLD)
        self.is_speaking = False
        self.agent_speaking = False
        self.closed = False
        self._cancel_speech = False
        self._speaker_wav = find_speaker_wav()
        self._barge_in_frames = 0
        self._ignore_user_audio_until = 0.0
        self._tts_sr = None
        self._lang_code = "en"
        # Pre-buffer: keeps last ~300ms of audio so we don't lose the
        # beginning of words while Silero VAD ramps up detection
        self._pre_buffer = deque(maxlen=10)

    def _resolve_tts_params(self):
        if self._tts_sr is None:
            tts = get_tts()
            self._tts_sr = tts.synthesizer.output_sample_rate if hasattr(tts, "synthesizer") else 24000
            lang_code = self.language[:2] if self.language else "en"
            supported_langs = getattr(tts, "languages", []) or []
            if supported_langs and lang_code not in supported_langs:
                lang_code = "en"
            self._lang_code = lang_code

    async def send_json(self, data: dict):
        if not self.closed:
            try:
                await self.ws.send(json.dumps(data))
            except Exception:
                pass

    async def send_binary(self, data: bytes):
        if not self.closed:
            try:
                await self.ws.send(data)
            except Exception:
                pass

    async def handle_message(self, message):
        if isinstance(message, bytes):
            await self._handle_audio(message)
        else:
            await self._handle_json(json.loads(message))

    async def _handle_json(self, msg):
        msg_type = msg.get("type", "")
        if msg_type == "Settings":
            await self._apply_settings(msg)
        elif msg_type == "KeepAlive":
            pass
        elif msg_type == "FunctionCallResponse":
            fn_content = msg.get("content", "")
            fn_name = msg.get("name", "")
            log.info(f"[{self.session_id}] FunctionCallResponse: {fn_name} -> {fn_content}")
            self.conversation.append({"role": "function", "name": fn_name, "content": fn_content})
            await self._generate_response()
        else:
            log.debug(f"[{self.session_id}] Unknown JSON type: {msg_type}")

    async def _apply_settings(self, msg):
        self.settings = msg
        agent = msg.get("agent", {})
        self.prompt = agent.get("think", {}).get("prompt", "")
        self.functions = agent.get("think", {}).get("functions", [])
        self.greeting = agent.get("greeting", "")
        self.language = agent.get("language", "en")
        self._tts_sr = None

        log.info(f"[{self.session_id}] Settings applied - lang={self.language}, greeting={bool(self.greeting)}, speaker_wav={bool(self._speaker_wav)}, active_sessions={len(_active_sessions)}")

        await self.send_json({"type": "Welcome"})
        await self.send_json({"type": "SettingsApplied"})

        if self.greeting:
            self.conversation.append({"role": "assistant", "content": self.greeting})
            await self.send_json({
                "type": "ConversationText",
                "role": "assistant",
                "content": self.greeting,
            })
            await self._synthesize_and_send(self.greeting)

    async def _handle_audio(self, audio_data: bytes):
        now = time.time()
        if now < self._ignore_user_audio_until:
            return

        pcm_float = pcm_to_float(audio_data)

        # ── Barge-in: use Silero neural probability, not energy ──
        if self.agent_speaking:
            self._pre_buffer.append(audio_data)
            speech_prob = self.vad.check_speech_probability(pcm_float)
            if speech_prob > BARGE_IN_THRESHOLD:
                self._barge_in_frames += 1
                if self._barge_in_frames >= BARGE_IN_MIN_FRAMES:
                    log.info(f"[{self.session_id}] Barge-in detected (prob={speech_prob:.2f}, frames={self._barge_in_frames}) — cancelling agent")
                    self._cancel_speech = True
                    self.agent_speaking = False
                    self._barge_in_frames = 0
                    await self.send_json({"type": "UserStartedSpeaking"})
                    await self.send_json({"type": "AgentAudioDone"})
                    self.is_speaking = True
                    self.audio_buffer.clear()
                    self.vad.reset()
                    for buf in self._pre_buffer:
                        self.audio_buffer.extend(buf)
                    self._pre_buffer.clear()
            else:
                self._barge_in_frames = max(0, self._barge_in_frames - 1)
            return

        # ── Normal listening: detect speech start/end with Silero ──
        vad_result = self.vad.process(pcm_float)

        if vad_result == "speech_start":
            if not self.is_speaking:
                self.is_speaking = True
                # Prepend only last 3 frames (~100ms) to catch word onset
                # without feeding long silence that causes Whisper hallucination
                recent = list(self._pre_buffer)[-3:]
                for buf in recent:
                    self.audio_buffer.extend(buf)
                self._pre_buffer.clear()
                self.audio_buffer.extend(audio_data)
                await self.send_json({"type": "UserStartedSpeaking"})
                log.info(f"[{self.session_id}] User started speaking")
            else:
                self.audio_buffer.extend(audio_data)
        elif vad_result == "speech_end":
            self.audio_buffer.extend(audio_data)
            if self.is_speaking:
                self.is_speaking = False
                log.info(f"[{self.session_id}] User stopped speaking, transcribing...")
                audio_to_transcribe = bytes(self.audio_buffer)
                self.audio_buffer.clear()
                self._pre_buffer.clear()
                await self._transcribe_and_respond(audio_to_transcribe)
        elif self.is_speaking:
            self.audio_buffer.extend(audio_data)
        else:
            # Not speaking — just keep rolling pre-buffer
            self._pre_buffer.append(audio_data)

    async def _transcribe_and_respond(self, audio_bytes: bytes):
        min_samples = int(INPUT_SAMPLE_RATE * 2 * 0.5)
        if len(audio_bytes) < min_samples:
            log.debug(f"[{self.session_id}] Audio too short ({len(audio_bytes)} < {min_samples}), skipping STT")
            return
        pcm_float = preprocess_for_stt(pcm_to_float(audio_bytes))
        audio_dur_ms = int(len(pcm_float) / INPUT_SAMPLE_RATE * 1000)
        loop = asyncio.get_event_loop()
        stt_lang = self.language if self.language not in ("multi", "") else None
        t0 = time.time()

        async with _stt_semaphore:
            try:
                text, info = await loop.run_in_executor(
                    _stt_executor,
                    lambda: _run_stt(
                        pcm_float, stt_lang, STT_BEAM_SIZE, STT_BEST_OF,
                        STT_VAD_MIN_SILENCE_MS, STT_NO_SPEECH_THRESHOLD,
                        STT_COMPRESSION_RATIO_THRESHOLD, STT_LOG_PROB_THRESHOLD,
                    ),
                )
            except Exception as e:
                log.error(f"[{self.session_id}] STT error: {e}")
                return

        stt_ms = int((time.time() - t0) * 1000)
        detected_lang = getattr(info, "language", stt_lang)
        lang_prob = getattr(info, "language_probability", 0.0)
        log.info(f"[{self.session_id}] STT: {stt_ms}ms for {audio_dur_ms}ms audio | lang={detected_lang} prob={lang_prob:.2f} | \"{text}\"")

        if not text or len(text.strip()) < 2:
            return
        log.info(f"[{self.session_id}] User: {text}")
        self.conversation.append({"role": "user", "content": text})
        await self.send_json({"type": "ConversationText", "role": "user", "content": text})
        await self._generate_response()

    # ── LLM streaming → TTS pipeline ────────────────────────────────

    def _build_messages(self):
        messages = [{"role": "system", "content": self.prompt}]
        for msg in self.conversation[-MAX_HISTORY_MESSAGES:]:
            if msg["role"] == "function":
                messages.append({
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_" + str(uuid.uuid4())[:8],
                        "type": "function",
                        "function": {"name": msg["name"], "arguments": "{}"},
                    }],
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": messages[-1]["tool_calls"][0]["id"],
                    "content": msg["content"],
                })
            else:
                messages.append({"role": msg["role"], "content": msg["content"]})
        return messages

    def _build_tools(self):
        if not self.functions:
            return []
        return [{
            "type": "function",
            "function": {
                "name": fn["name"],
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters", {"type": "object", "properties": {}}),
            },
        } for fn in self.functions]

    async def _generate_response(self):
        await self.send_json({"type": "AgentThinking"})
        messages = self._build_messages()
        tools = self._build_tools()

        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
            kwargs = {
                "model": LLM_MODEL,
                "messages": messages,
                "max_tokens": LLM_MAX_TOKENS,
                "temperature": LLM_TEMPERATURE,
                "stream": True,
            }
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"
            stream = await client.chat.completions.create(**kwargs)
        except Exception as e:
            log.error(f"[{self.session_id}] LLM error: {e}")
            await self.send_json({"type": "Error", "message": f"LLM error: {str(e)}"})
            return

        full_text = ""
        pending = ""
        speaking_started = False
        sentences_spoken = 0
        tool_calls_acc = []

        try:
            async for chunk in stream:
                if self.closed or self._cancel_speech:
                    break

                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                if choice is None:
                    continue
                delta = getattr(choice, "delta", None)
                if delta is None:
                    continue
                finish = getattr(choice, "finish_reason", None)
                if finish is not None:
                    break

                if getattr(delta, "tool_calls", None):
                    for tc_d in delta.tool_calls:
                        idx = tc_d.index
                        while len(tool_calls_acc) <= idx:
                            tool_calls_acc.append({"id": "", "name": "", "arguments": ""})
                        if tc_d.id:
                            tool_calls_acc[idx]["id"] = tc_d.id
                        if tc_d.function:
                            if tc_d.function.name:
                                tool_calls_acc[idx]["name"] = tc_d.function.name
                            if tc_d.function.arguments:
                                tool_calls_acc[idx]["arguments"] += tc_d.function.arguments
                    continue

                content = getattr(delta, "content", None)
                if not content:
                    continue

                pending += content

                while sentences_spoken < MAX_RESPONSE_SENTENCES:
                    parts = re.split(r'(?<=[.!?])\s+', pending, maxsplit=1)
                    if len(parts) < 2:
                        break

                    sentence = clean_text_for_tts(parts[0].strip())
                    pending = parts[1]

                    if not sentence:
                        continue
                    if len(full_text) + len(sentence) > MAX_RESPONSE_CHARS:
                        pending = ""
                        break

                    if not speaking_started:
                        self.agent_speaking = True
                        self._cancel_speech = False
                        self._barge_in_frames = 0
                        self.audio_buffer.clear()
                        self.vad.reset()
                        await self.send_json({"type": "AgentStartedSpeaking"})
                        speaking_started = True
                        t0 = time.time()

                    await self._speak_sentence(sentence)
                    full_text += sentence + " "
                    sentences_spoken += 1

                    if sentences_spoken == 1 and speaking_started:
                        latency_ms = int((time.time() - t0) * 1000)
                        log.info(f"[{self.session_id}] First sentence spoken in {latency_ms}ms")

                if sentences_spoken >= MAX_RESPONSE_SENTENCES:
                    break
                if len(full_text) >= MAX_RESPONSE_CHARS:
                    break

        except Exception as e:
            log.error(f"[{self.session_id}] LLM stream error: {e}")
            if not full_text and not tool_calls_acc:
                await self._generate_response_fallback(messages, tools)
                return

        if tool_calls_acc:
            for tc in tool_calls_acc:
                await self.send_json({
                    "type": "FunctionCallRequest",
                    "functions": [{
                        "id": tc["id"],
                        "name": tc["name"],
                        "arguments": tc["arguments"],
                        "client_side": True,
                    }],
                })
                log.info(f"[{self.session_id}] Function call: {tc['name']}")
            return

        remaining = clean_text_for_tts(pending.strip())
        if remaining and not self._cancel_speech and not self.closed and sentences_spoken < MAX_RESPONSE_SENTENCES:
            if len(full_text) + len(remaining) <= MAX_RESPONSE_CHARS:
                if not speaking_started:
                    self.agent_speaking = True
                    self._cancel_speech = False
                    self._barge_in_frames = 0
                    self.audio_buffer.clear()
                    self.vad.reset()
                    await self.send_json({"type": "AgentStartedSpeaking"})
                    speaking_started = True
                await self._speak_sentence(remaining)
                full_text += remaining

        full_text = full_text.strip()
        if full_text:
            log.info(f"[{self.session_id}] AI: {full_text}")
            self.conversation.append({"role": "assistant", "content": full_text})
            await self.send_json({"type": "ConversationText", "role": "assistant", "content": full_text})

        if speaking_started:
            self.agent_speaking = False
            self._cancel_speech = False
            self._ignore_user_audio_until = time.time() + (POST_TTS_IGNORE_MS / 1000.0)
            await self.send_json({"type": "AgentAudioDone"})

    async def _generate_response_fallback(self, messages, tools):
        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
            kwargs = {
                "model": LLM_MODEL,
                "messages": messages,
                "max_tokens": LLM_MAX_TOKENS,
                "temperature": LLM_TEMPERATURE,
            }
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"
            response = await client.chat.completions.create(**kwargs)
            choice = response.choices[0]
        except Exception as e:
            log.error(f"[{self.session_id}] LLM fallback error: {e}")
            await self.send_json({"type": "Error", "message": f"LLM error: {str(e)}"})
            return

        if choice.message.tool_calls:
            for tc in choice.message.tool_calls:
                await self.send_json({
                    "type": "FunctionCallRequest",
                    "functions": [{
                        "id": tc.id,
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                        "client_side": True,
                    }],
                })
                log.info(f"[{self.session_id}] Function call: {tc.function.name}")
            return

        ai_text = choice.message.content or ""
        if not ai_text.strip():
            return
        ai_text = clean_text_for_tts(ai_text)
        sentences = split_into_sentences(ai_text)
        ai_text = " ".join(sentences[:MAX_RESPONSE_SENTENCES])
        if len(ai_text) > MAX_RESPONSE_CHARS:
            ai_text = ai_text[:MAX_RESPONSE_CHARS].rsplit(" ", 1)[0].strip()
            if not ai_text.endswith((".", "!", "?")):
                ai_text += "."

        log.info(f"[{self.session_id}] AI (fallback): {ai_text}")
        self.conversation.append({"role": "assistant", "content": ai_text})
        await self.send_json({"type": "ConversationText", "role": "assistant", "content": ai_text})
        await self._synthesize_and_send(ai_text)

    # ── TTS synthesis ───────────────────────────────────────────────

    async def _send_silence(self, duration_ms: int = 1500):
        silence = _get_silence_buffer()
        chunk_size = OUTPUT_SAMPLE_RATE * 2 * TTS_STREAM_CHUNK_MS // 1000
        total = min(len(silence), int(OUTPUT_SAMPLE_RATE * 2 * duration_ms / 1000))
        for i in range(0, total, chunk_size):
            if self.closed or self._cancel_speech:
                break
            await self.send_binary(silence[i:i + chunk_size])
            await asyncio.sleep(TTS_STREAM_SLEEP_MS)

    async def _speak_sentence(self, sentence: str):
        if self.closed or self._cancel_speech or not sentence.strip():
            return

        self._resolve_tts_params()
        loop = asyncio.get_event_loop()

        silence_task = asyncio.create_task(self._send_silence(1500))

        async with _tts_semaphore:
            audio_np = await loop.run_in_executor(
                _tts_executor,
                lambda: _run_tts(sentence, self._lang_code, self._speaker_wav),
            )

        silence_task.cancel()
        try:
            await silence_task
        except asyncio.CancelledError:
            pass

        if audio_np.size == 0:
            return

        pcm_bytes = float_to_pcm(audio_np, OUTPUT_SAMPLE_RATE, self._tts_sr)
        chunk_size = OUTPUT_SAMPLE_RATE * 2 * TTS_STREAM_CHUNK_MS // 1000
        for i in range(0, len(pcm_bytes), chunk_size):
            if self.closed or self._cancel_speech:
                break
            await self.send_binary(pcm_bytes[i:i + chunk_size])
            await asyncio.sleep(TTS_STREAM_SLEEP_MS)

    async def _synthesize_and_send(self, text: str):
        self.agent_speaking = True
        self._cancel_speech = False
        self._barge_in_frames = 0
        self.audio_buffer.clear()
        self.vad.reset()
        await self.send_json({"type": "AgentStartedSpeaking"})

        try:
            cleaned = clean_text_for_tts(text)
            sentences = split_into_sentences(cleaned)
            for sentence in sentences:
                if self.closed or self._cancel_speech:
                    break
                if sentence.strip():
                    await self._speak_sentence(sentence)
        except Exception as e:
            log.error(f"[{self.session_id}] TTS error: {e}")
            await self.send_json({"type": "Error", "message": f"TTS error: {str(e)}"})

        self.agent_speaking = False
        self._cancel_speech = False
        self._ignore_user_audio_until = time.time() + (POST_TTS_IGNORE_MS / 1000.0)
        await self.send_json({"type": "AgentAudioDone"})


# ── Connection handler ──────────────────────────────────────────────

async def handle_connection(ws):
    session = VoiceSession(ws)
    _active_sessions[session.session_id] = session
    log.info(f"[{session.session_id}] New connection ({len(_active_sessions)} active)")

    try:
        async for message in ws:
            await session.handle_message(message)
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        log.error(f"[{session.session_id}] Error: {e}")
    finally:
        session.closed = True
        _active_sessions.pop(session.session_id, None)
        log.info(f"[{session.session_id}] Connection closed ({len(_active_sessions)} active)")


# ── Stats logging ───────────────────────────────────────────────────

async def _log_stats_periodically():
    while True:
        await asyncio.sleep(30)
        n = len(_active_sessions)
        if n > 0:
            gpu_mem = ""
            if torch.cuda.is_available():
                alloc = torch.cuda.memory_allocated() / 1024**2
                total = torch.cuda.get_device_properties(0).total_memory / 1024**2
                gpu_mem = f" | GPU: {alloc:.0f}/{total:.0f} MB"
            log.info(f"[stats] {n} active sessions{gpu_mem}")


# ── Main ────────────────────────────────────────────────────────────

async def main():
    log.info("=" * 60)
    log.info("Local Voice Agent Server — GPU-Optimized (20+ calls)")
    log.info(f"  VAD: Silero neural VAD (threshold={VAD_THRESHOLD}, barge_in={BARGE_IN_THRESHOLD}, silence={SILENCE_DURATION_MS}ms)")
    log.info(f"  STT: faster-whisper ({WHISPER_MODEL_SIZE}) x{GPU_STT_CONCURRENCY} workers")
    log.info(f"  TTS: XTTS v2 direct — temp={TTS_TEMPERATURE} rep_pen={TTS_REPETITION_PENALTY} speed={TTS_SPEED} x{GPU_TTS_CONCURRENCY} workers")
    log.info(f"  LLM: {LLM_MODEL} (streaming → TTS pipeline)")
    log.info(f"  Port: {SERVER_PORT}")

    speaker = find_speaker_wav()
    if speaker:
        log.info(f"  Voice clone: {speaker}")
    else:
        log.info("  Voice clone: none")

    log.info("=" * 60)

    _init_executors()
    _init_cuda_streams()
    _get_silence_buffer()

    log.info("Pre-loading models...")
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _ensure_silero_cached)
    await loop.run_in_executor(None, get_whisper)
    await loop.run_in_executor(None, get_tts)

    if speaker:
        await loop.run_in_executor(None, precompute_speaker_latents, speaker)

    if torch.cuda.is_available():
        alloc = torch.cuda.memory_allocated() / 1024**2
        total = torch.cuda.get_device_properties(0).total_memory / 1024**2
        log.info(f"GPU memory after model load: {alloc:.0f}/{total:.0f} MB ({total - alloc:.0f} MB free)")

    log.info("Models loaded. Starting WebSocket server...")

    asyncio.create_task(_log_stats_periodically())

    async with websockets.serve(
        handle_connection,
        "0.0.0.0",
        SERVER_PORT,
        max_size=10 * 1024 * 1024,
        ping_interval=WS_PING_INTERVAL,
        ping_timeout=WS_PING_TIMEOUT,
    ):
        log.info(f"Voice Agent server listening on ws://0.0.0.0:{SERVER_PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
