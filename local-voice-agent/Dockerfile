FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3.11-dev \
    build-essential ffmpeg libsndfile1 curl git \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && curl -sS https://bootstrap.pypa.io/get-pip.py | python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt && \
    pip install "transformers>=4.46.0,<4.52.0"

COPY server.py .

# Pre-download Silero VAD so first call doesn't stall
RUN python -c "import torch; torch.hub.load('snakers4/silero-vad', 'silero_vad', force_reload=False, onnx=False, trust_repo=True)"

EXPOSE 8765

CMD ["python", "server.py"]
