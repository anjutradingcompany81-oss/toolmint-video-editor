#!/usr/bin/env python3
"""Speaker diarization sidecar for the AI Repetitive Voice Remover.

Spawned once per scan job by apps/api/src/voice/audio-analysis/diarization.service.ts
(child_process, not a persistent service) — invoked as:

    python3 diarize.py <path-to-wav>

Prints one JSON object to stdout on success:

    {"segments": [{"startMs": 0, "endMs": 1230, "speaker": "SPEAKER_00"}, ...]}

Or, on any failure (missing dependencies, no HUGGINGFACE_TOKEN, model
couldn't load, etc.), prints {"error": "<message>"} to stdout and exits 0
(not a nonzero code) — the caller treats a missing/failed diarization as
"speaker unknown for every segment", which the repetition detector already
handles safely (it never uses an unknown speaker to rule two segments out),
rather than failing the whole scan over an optional signal.
"""
import json
import sys


def main() -> None:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: diarize.py <path-to-wav>"}))
        return

    audio_path = sys.argv[1]

    try:
        import torch  # noqa: F401  (imported for its side effect of confirming availability)
        from pyannote.audio import Pipeline
    except ImportError as exc:
        print(json.dumps({"error": f"diarization dependencies not installed: {exc}"}))
        return

    import os

    token = os.environ.get("HUGGINGFACE_TOKEN")
    if not token:
        print(json.dumps({"error": "HUGGINGFACE_TOKEN is not set — speaker diarization is disabled"}))
        return

    try:
        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=token)
    except Exception as exc:  # noqa: BLE001 - any load failure should degrade gracefully, not crash the scan
        print(json.dumps({"error": f"couldn't load the diarization model: {exc}"}))
        return

    try:
        diarization = pipeline(audio_path)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"diarization failed: {exc}"}))
        return

    segments = [
        {"startMs": round(turn.start * 1000), "endMs": round(turn.end * 1000), "speaker": speaker}
        for turn, _, speaker in diarization.itertracks(yield_label=True)
    ]
    print(json.dumps({"segments": segments}))


if __name__ == "__main__":
    main()
