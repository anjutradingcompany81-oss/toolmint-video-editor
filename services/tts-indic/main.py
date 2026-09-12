"""Indic TTS sidecar — F5-based Hindi speech for the ProCut voice-over feature.

Exists because the editor's Node process cannot run these models. The
built-in voices go through transformers.js, which needs ONNX; F5 is a
PyTorch flow-matching model with a separate vocoder and has no realistic
ONNX path. Rather than drop the better Hindi voices, they run here and the
API talks to this over HTTP.

Two models, both usable commercially, unlike the CC-BY-NC MMS checkpoints
the built-in voices use:

  SPRINGLab/F5-Hindi-24KHz   CC-BY-4.0, Hindi only, 24kHz native
  ai4bharat/IndicF5          MIT, 11 Indian languages, gated download

F5 is reference-guided: every line needs a short clip of the target voice
plus a transcript of that clip. So "a voice" here is a pair of files in
voices/ — <name>.wav and <name>.txt — and adding a voice means dropping in
a recording, not retraining anything. That is also why this provider
reports voice cloning as supported: pointing it at your own recording is
the normal way to use it.

Audio is returned as raw float32 PCM rather than an encoded file, matching
what TtsProvider.synthesize expects on the Node side, so the mixer needs no
per-provider decode path.
"""

from __future__ import annotations

import logging
import os
import struct
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel

LOG = logging.getLogger("tts-indic")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

ROOT = Path(__file__).parent
VOICES_DIR = Path(os.environ.get("INDIC_TTS_VOICES_DIR", ROOT / "voices"))
MODEL_ID = os.environ.get("INDIC_TTS_MODEL", "SPRINGLab/F5-Hindi-24KHz")
# Which F5 architecture the checkpoint was trained against. F5-Hindi-24KHz
# is dim 768 / depth 18, which is F5TTS_Small, not the Base everything
# else defaults to - loading it as Base fails on a shape mismatch. Set
# INDIC_TTS_ARCH when pointing at a checkpoint built on a different one
# (IndicF5 is Base). Getting this wrong fails loudly rather than sounding
# subtly bad, which is the right failure mode.
ARCH = os.environ.get("INDIC_TTS_ARCH", "F5TTS_Small")
# Hindi-only models cannot honestly claim "multi"; the API groups the
# picker on this and warns when a line is in a script the voice can't read.
MODEL_LANGUAGE = os.environ.get("INDIC_TTS_LANGUAGE", "hi")

app = FastAPI(title="Indic TTS sidecar")

# One model, loaded once, guarded by a lock. F5 inference is not
# thread-safe and a second concurrent generation on the same weights
# produces garbage rather than an error, which would reach the export as
# plausible-sounding nonsense.
_model = None
_model_lock = threading.Lock()
_load_error: str | None = None


class SynthesiseRequest(BaseModel):
    text: str
    voice: str
    # Flow-matching steps. Higher is slower and slightly cleaner; 32 is the
    # upstream default and the point past which the difference stops being
    # audible in our testing.
    steps: int = 32
    speed: float = 1.0


def _load_model():
    """Import and construct the model on first use, not at import time.

    Loading takes tens of seconds and pulls ~1.5GB on a cold container.
    Doing it lazily means the health endpoint answers immediately and an
    operator can see the service is up while the weights are still coming
    down.
    """
    global _model, _load_error
    if _model is not None:
        return _model
    # A previous failure is reported but not treated as final. The first
    # cause of one here was a broken torchaudio build, which no retry
    # would fix - but a dropped connection mid-download is just as likely
    # and does fix itself, and caching that permanently would take the
    # feature down until someone restarted the container.
    if _load_error is not None:
        LOG.warning("retrying model load after earlier failure: %s", _load_error)
        _load_error = None
    try:
        from f5_tts.api import F5TTS
        from huggingface_hub import hf_hub_download, list_repo_files

        # F5TTS's `model` argument names an architecture config shipped
        # inside the package (F5TTS_Base and friends) - NOT a repo id.
        # A community checkpoint is loaded by handing it the weights and
        # vocab explicitly, so both are fetched here first.
        files = list_repo_files(MODEL_ID)

        ckpt_name = next(
            (f for f in files if f.endswith(".safetensors")),
            next((f for f in files if f.endswith(".pt")), None),
        )
        if ckpt_name is None:
            raise RuntimeError(f"{MODEL_ID} has no .safetensors or .pt checkpoint")

        # IndicF5 keeps its vocab under checkpoints/, F5-Hindi at the root.
        vocab_name = next((f for f in files if f.endswith("vocab.txt")), None)
        if vocab_name is None:
            raise RuntimeError(f"{MODEL_ID} has no vocab.txt")

        LOG.info("fetching %s from %s", ckpt_name, MODEL_ID)
        ckpt = hf_hub_download(MODEL_ID, ckpt_name)
        vocab = hf_hub_download(MODEL_ID, vocab_name)

        LOG.info("loading %s as %s", MODEL_ID, ARCH)
        _model = F5TTS(model=ARCH, ckpt_file=ckpt, vocab_file=vocab)
        LOG.info("model ready")
        return _model
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the operator
        _load_error = f"{type(exc).__name__}: {exc}"
        LOG.error("model load failed: %s", _load_error)
        raise RuntimeError(_load_error) from exc


def _voices() -> dict[str, dict]:
    """A voice is a <name>.wav with a matching <name>.txt transcript.

    The transcript is not optional: F5 conditions on what the reference
    clip says as well as how it sounds, and a wrong or missing transcript
    degrades the output badly rather than failing loudly. A .wav with no
    .txt is therefore skipped and logged, never guessed at.
    """
    found: dict[str, dict] = {}
    if not VOICES_DIR.exists():
        return found
    for wav in sorted(VOICES_DIR.glob("*.wav")):
        txt = wav.with_suffix(".txt")
        if not txt.exists():
            LOG.warning("skipping %s - no matching %s transcript", wav.name, txt.name)
            continue
        transcript = txt.read_text(encoding="utf-8").strip()
        if not transcript:
            LOG.warning("skipping %s - transcript is empty", wav.name)
            continue
        meta = wav.stem.split("__")          # name__female -> gender hint
        found[wav.stem] = {
            "id": wav.stem,
            "label": meta[0].replace("-", " ").replace("_", " ").title(),
            "language": MODEL_LANGUAGE,
            "gender": meta[1] if len(meta) > 1 and meta[1] in ("male", "female") else "neutral",
            "ref_audio": str(wav),
            "ref_text": transcript,
        }
    return found


@app.get("/health")
def health():
    """Up-ness and model state, without triggering a load."""
    return {
        "ok": True,
        "model": MODEL_ID,
        "model_loaded": _model is not None,
        "load_error": _load_error,
        "voices": len(_voices()),
    }


@app.get("/voices")
def list_voices():
    vs = _voices()
    if not vs:
        # An empty list is a real answer, but the operator needs to know
        # why: the directory is empty or the transcripts are missing.
        LOG.warning("no usable voices in %s", VOICES_DIR)
    return {
        "voices": [
            {k: v[k] for k in ("id", "label", "language", "gender")}
            for v in vs.values()
        ]
    }


@app.post("/synthesise")
def synthesise(req: SynthesiseRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")

    voices = _voices()
    voice = voices.get(req.voice)
    if voice is None:
        raise HTTPException(404, f"unknown voice {req.voice!r}; have: {', '.join(voices) or 'none'}")

    try:
        model = _load_model()
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc

    with _model_lock:
        try:
            wav, sample_rate, _ = model.infer(
                ref_file=voice["ref_audio"],
                ref_text=voice["ref_text"],
                gen_text=text,
                nfe_step=req.steps,
                speed=req.speed,
                remove_silence=False,
            )
        except Exception as exc:  # noqa: BLE001
            LOG.exception("synthesis failed")
            raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc

    samples = np.asarray(wav, dtype=np.float32).reshape(-1)

    # A model can return an all-zero buffer without raising. Letting that
    # through would put silence in the export while every status upstream
    # still said "completed" - the same failure the built-in provider
    # guards against.
    if samples.size == 0 or not np.any(samples):
        raise HTTPException(500, f"model produced no audio for {text[:40]!r}")

    return Response(
        content=samples.tobytes(),
        media_type="application/octet-stream",
        headers={
            "X-Sample-Rate": str(int(sample_rate)),
            "X-Sample-Count": str(samples.size),
        },
    )
