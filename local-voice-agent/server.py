"""
Local Voice Agent Server

Drop-in replacement for Deepgram Voice Agent API using:
- faster-whisper for STT (speech-to-text)
- Coqui TTS (XTTSv2) for TTS (text-to-speech)
- OpenAI-compatible API for LLM

Implements the same WebSocket protocol so the Node.js DeepgramAgent class
connects to ws://localhost:8765 with zero code changes.

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

from collections import deque
from io import BytesIO
from math import gcd

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
import torch
import torchaudio

def _sf_load(filepath, **kwargs):
    """Load audio using soundfile, bypassing torchcodec entirely."""
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

_whisper_model = None
_tts_model = None
_tts_lock = asyncio.Lock()

WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")
TTS_MODEL_NAME = os.environ.get("TTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2")
TTS_SPEAKER_WAV = os.environ.get("TTS_SPEAKER_WAV", "")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
LLM_API_KEY = os.environ.get("LLM_API_KEY", os.environ.get("GEMINI_API_KEY", os.environ.get("OPENAI_API_KEY", "")))
LLM_MODEL = os.environ.get("LLM_MODEL", "gemini-2.5-flash")
SERVER_PORT = int(os.environ.get("VOICE_AGENT_PORT", "8765"))

INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000
SILENCE_DURATION_MS = 500

SPEAKER_WAVS_DIR = "/app/speaker_wavs"


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


def pcm_to_float(pcm_bytes: bytes) -> np.ndarray:
    return np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0


def high_quality_resample(audio: np.ndarray, source_sr: int, target_sr: int) -> np.ndarray:
    """Resample using polyphase filtering (scipy) for clean, artifact-free audio."""
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


def clean_text_for_tts(text: str) -> str:
    """Strip markdown, emojis, and formatting that makes TTS sound robotic."""
    text = re.sub(r'\*+', '', text)
    text = re.sub(r'#+\s*', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^\)]+\)', r'\1', text)
    text = re.sub(r'`[^`]*`', '', text)
    text = re.sub(r'[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF\U00002702-\U000027B0\U000024C2-\U0001F251]+', '', text)
    text = re.sub(r'\n+', '. ', text)
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r'\.{2,}', '.', text)
    return text.strip()


def split_into_sentences(text: str) -> list[str]:
    """Split text into natural sentence chunks for streaming TTS."""
    parts = re.split(r'(?<=[.!?])\s+', text)
    sentences = []
    current = ""
    for part in parts:
        if len(current) + len(part) < 120:
            current = (current + " " + part).strip()
        else:
            if current:
                sentences.append(current)
            current = part
    if current:
        sentences.append(current)
    return sentences if sentences else [text]


def find_speaker_wav() -> str | None:
    """Find a speaker WAV file from env var or the speaker_wavs directory."""
    if TTS_SPEAKER_WAV and os.path.exists(TTS_SPEAKER_WAV):
        return TTS_SPEAKER_WAV
    if os.path.isdir(SPEAKER_WAVS_DIR):
        for f in sorted(os.listdir(SPEAKER_WAVS_DIR)):
            if f.lower().endswith((".wav", ".mp3", ".flac", ".ogg")):
                path = os.path.join(SPEAKER_WAVS_DIR, f)
                log.info(f"Using speaker reference: {path}")
                return path
    return None


class SimpleVAD:
    """Energy-based voice activity detection."""

    def __init__(self, threshold=0.02, frame_ms=30):
        self.threshold = threshold
        self.frame_ms = frame_ms
        self.speaking = False
        self.silence_start = None

    def process(self, pcm_float: np.ndarray) -> str:
        energy = np.sqrt(np.mean(pcm_float ** 2))
        if energy > self.threshold:
            was_silent = not self.speaking
            self.speaking = True
            self.silence_start = None
            return "speech_start" if was_silent else "speech"
        else:
            if self.speaking:
                if self.silence_start is None:
                    self.silence_start = time.time()
                elif (time.time() - self.silence_start) * 1000 > SILENCE_DURATION_MS:
                    self.speaking = False
                    self.silence_start = None
                    return "speech_end"
            return "silence"


class VoiceSession:
    """Manages one voice agent conversation over WebSocket."""

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
        self.vad = SimpleVAD()
        self.is_speaking = False
        self.agent_speaking = False
        self.closed = False
        self._cancel_speech = False
        self._speaker_wav = find_speaker_wav()

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
            self.conversation.append({
                "role": "function",
                "name": fn_name,
                "content": fn_content,
            })
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

        log.info(f"[{self.session_id}] Settings applied - lang={self.language}, greeting={bool(self.greeting)}, speaker_wav={bool(self._speaker_wav)}")

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
        if self.agent_speaking:
            pcm_float = pcm_to_float(audio_data)
            energy = np.sqrt(np.mean(pcm_float ** 2))
            if energy > 0.04:
                log.info(f"[{self.session_id}] Barge-in detected — cancelling agent speech")
                self._cancel_speech = True
                self.agent_speaking = False
                await self.send_json({"type": "UserStartedSpeaking"})
                self.is_speaking = True
                self.audio_buffer.clear()
                self.audio_buffer.extend(audio_data)
            return

        self.audio_buffer.extend(audio_data)

        pcm_float = pcm_to_float(audio_data)
        vad_result = self.vad.process(pcm_float)

        if vad_result == "speech_start":
            if not self.is_speaking:
                self.is_speaking = True
                await self.send_json({"type": "UserStartedSpeaking"})
                log.info(f"[{self.session_id}] User started speaking")

        elif vad_result == "speech_end":
            if self.is_speaking:
                self.is_speaking = False
                log.info(f"[{self.session_id}] User stopped speaking, transcribing...")
                audio_to_transcribe = bytes(self.audio_buffer)
                self.audio_buffer.clear()
                await self._transcribe_and_respond(audio_to_transcribe)

    async def _transcribe_and_respond(self, audio_bytes: bytes):
        if len(audio_bytes) < INPUT_SAMPLE_RATE * 2 * 0.3:
            return

        pcm_float = pcm_to_float(audio_bytes)
        loop = asyncio.get_event_loop()
        try:
            segments, _ = await loop.run_in_executor(
                None,
                lambda: get_whisper().transcribe(
                    pcm_float,
                    language=self.language if self.language != "multi" else None,
                    beam_size=5,
                    vad_filter=True,
                ),
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        except Exception as e:
            log.error(f"[{self.session_id}] STT error: {e}")
            return

        if not text or len(text) < 2:
            return

        log.info(f"[{self.session_id}] User: {text}")
        self.conversation.append({"role": "user", "content": text})
        await self.send_json({
            "type": "ConversationText",
            "role": "user",
            "content": text,
        })

        await self._generate_response()

    async def _generate_response(self):
        await self.send_json({"type": "AgentThinking"})

        messages = [{"role": "system", "content": self.prompt}]
        for msg in self.conversation:
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

        tools = []
        if self.functions:
            tools = [{
                "type": "function",
                "function": {
                    "name": fn["name"],
                    "description": fn.get("description", ""),
                    "parameters": fn.get("parameters", {"type": "object", "properties": {}}),
                },
            } for fn in self.functions]

        try:
            from openai import AsyncOpenAI
            client = AsyncOpenAI(
                api_key=LLM_API_KEY,
                base_url=LLM_BASE_URL,
            )

            kwargs = {"model": LLM_MODEL, "messages": messages, "max_tokens": 300}
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"

            response = await client.chat.completions.create(**kwargs)
            choice = response.choices[0]
        except Exception as e:
            log.error(f"[{self.session_id}] LLM error: {e}")
            await self.send_json({
                "type": "Error",
                "message": f"LLM error: {str(e)}",
            })
            return

        if choice.message.tool_calls:
            for tc in choice.message.tool_calls:
                fn_call = {
                    "type": "FunctionCallRequest",
                    "functions": [{
                        "id": tc.id,
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                        "client_side": True,
                    }],
                }
                log.info(f"[{self.session_id}] Function call: {tc.function.name}")
                await self.send_json(fn_call)
            return

        ai_text = choice.message.content or ""
        if not ai_text.strip():
            return

        log.info(f"[{self.session_id}] AI: {ai_text}")
        self.conversation.append({"role": "assistant", "content": ai_text})
        await self.send_json({
            "type": "ConversationText",
            "role": "assistant",
            "content": ai_text,
        })

        await self._synthesize_and_send(ai_text)

    async def _synthesize_and_send(self, text: str):
        self.agent_speaking = True
        self._cancel_speech = False
        await self.send_json({"type": "AgentStartedSpeaking"})

        try:
            cleaned = clean_text_for_tts(text)
            sentences = split_into_sentences(cleaned)
            loop = asyncio.get_event_loop()
            tts = get_tts()

            lang_code = self.language[:2] if self.language else "en"
            supported_langs = getattr(tts, "languages", []) or []
            if supported_langs and lang_code not in supported_langs:
                lang_code = "en"

            tts_sr = tts.synthesizer.output_sample_rate if hasattr(tts, "synthesizer") else 22050

            for sentence in sentences:
                if self.closed or self._cancel_speech:
                    break

                if not sentence.strip():
                    continue

                kwargs = {"text": sentence, "language": lang_code}
                if self._speaker_wav:
                    kwargs["speaker_wav"] = self._speaker_wav
                elif hasattr(tts.synthesizer, "tts_model") and hasattr(tts.synthesizer.tts_model, "speaker_manager"):
                    speakers = tts.synthesizer.tts_model.speaker_manager
                    if speakers and hasattr(speakers, "speaker_names") and speakers.speaker_names:
                        kwargs["speaker"] = speakers.speaker_names[0]

                async with _tts_lock:
                    audio_np = await loop.run_in_executor(None, lambda: np.array(tts.tts(**kwargs)))

                pcm_bytes = float_to_pcm(audio_np, OUTPUT_SAMPLE_RATE, tts_sr)

                chunk_size = OUTPUT_SAMPLE_RATE * 2 * 20 // 1000  # 20ms chunks
                for i in range(0, len(pcm_bytes), chunk_size):
                    if self.closed or self._cancel_speech:
                        break
                    chunk = pcm_bytes[i:i + chunk_size]
                    await self.send_binary(chunk)
                    await asyncio.sleep(0.018)

        except Exception as e:
            log.error(f"[{self.session_id}] TTS error: {e}")
            await self.send_json({"type": "Error", "message": f"TTS error: {str(e)}"})

        self.agent_speaking = False
        self._cancel_speech = False
        await self.send_json({"type": "AgentAudioDone"})


async def handle_connection(ws):
    session = VoiceSession(ws)
    log.info(f"[{session.session_id}] New connection from {ws.remote_address}")

    try:
        async for message in ws:
            await session.handle_message(message)
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        log.error(f"[{session.session_id}] Error: {e}")
    finally:
        session.closed = True
        log.info(f"[{session.session_id}] Connection closed")


async def main():
    log.info("=" * 50)
    log.info("Local Voice Agent Server")
    log.info(f"  STT: faster-whisper ({WHISPER_MODEL_SIZE})")
    log.info(f"  TTS: Coqui ({TTS_MODEL_NAME})")
    log.info(f"  LLM: {LLM_MODEL} via {LLM_BASE_URL}")
    log.info(f"  Port: {SERVER_PORT}")

    speaker = find_speaker_wav()
    if speaker:
        log.info(f"  Voice clone: {speaker}")
    else:
        log.info("  Voice clone: none (add a WAV to /app/speaker_wavs/ or set TTS_SPEAKER_WAV)")

    log.info("=" * 50)

    log.info("Pre-loading models...")
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, get_whisper)
    await loop.run_in_executor(None, get_tts)
    log.info("Models loaded. Starting WebSocket server...")

    async with websockets.serve(
        handle_connection,
        "0.0.0.0",
        SERVER_PORT,
        max_size=10 * 1024 * 1024,
        ping_interval=30,
        ping_timeout=10,
    ):
        log.info(f"Voice Agent server listening on ws://0.0.0.0:{SERVER_PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
