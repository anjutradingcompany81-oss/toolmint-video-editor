FROM python:3.11-slim

# espeak/ffmpeg are pulled in by f5-tts' audio handling; libsndfile backs
# soundfile. git is needed because f5-tts resolves some deps from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libsndfile1 git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch first: the default wheel carries ~2.5GB of CUDA that a
# VPS without a GPU cannot use, and it dominates the image size.
#
# torchaudio MUST be installed in the same command, from the same index.
# Installing torch alone left f5-tts to pull torchaudio from PyPI, which
# resolved to a build compiled against a different torch (2.11 against
# torch 2.14) - the versions look fine in `pip list` and the import fails
# at runtime with "Could not load this library: _torchaudio.abi3.so".
# Pinning them as a matched pair here means f5-tts finds the requirement
# already satisfied and leaves them alone.
RUN pip install --no-cache-dir torch torchaudio \
      --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY voices/ ./voices/

ENV INDIC_TTS_VOICES_DIR=/app/voices \
    HF_HOME=/app/.cache/huggingface

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
