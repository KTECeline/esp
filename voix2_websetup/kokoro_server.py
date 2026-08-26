"""Persistent Kokoro TTS server (github.com/hexgrad/kokoro, real PyPI `kokoro`
package). Loads the model ONCE at process startup, then answers requests
already shaped exactly like mcp-core/speech.js's `ttsOpenAI()` expects: POST
JSON {input, voice, model, response_format} -> raw audio bytes on 200, short
plain-text body on non-2xx. Same contract piper-wrapper.js speaks, and the
same contract moss-wrapper.js used to translate into for MOSS-TTS-Nano's
non-conforming API.

Unlike MOSS-TTS-Nano, there is no separate translation layer here: FastAPI
can produce the openai_tts response shape directly (see synthesize() below),
so setup-server.js's /api/download/tts kokoro branch starts THIS process
directly on KOKORO_PORT — no Node wrapper in front of it.

Model choice: hexgrad/Kokoro-82M-v1.1-zh, not the base v1.0 checkpoint. This
is a real, deliberate choice, confirmed from the model's own Hugging Face
card and its samples/make_en.py + samples/make_zh.py (2026-08-19): v1.1-zh is
a single bilingual (English + Mandarin) checkpoint, so ONE `KModel` load
here serves both `en_pipeline` and `zh_pipeline` below (they share the same
`model=` instance — the network weights are loaded exactly once, matching
this file's whole reason for existing as a persistent server rather than a
per-request CLI call). The alternative, kokoro-onnx, would need this same
v1.1-zh weight set exported as a SEPARATE .onnx file from its English-only
v1.0 export, plus a community-maintained `misaki-fork[zh]` fork for Chinese
G2P instead of upstream `misaki[zh]` — two models and two G2P stacks in one
process for what should be a single bilingual voice. See the setup diff
summary for the fuller kokoro vs kokoro-onnx comparison.

Voice IDs (af_maple, zf_001) are real, confirmed voice IDs from this exact
checkpoint's own sample scripts on huggingface.co/hexgrad/Kokoro-82M-v1.1-zh
(2026-08-19) -- not guessed.
"""

import io
import logging
import os
from typing import Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Request
from fastapi.responses import Response
from kokoro import KModel, KPipeline

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("kokoro-server")

REPO_ID = "hexgrad/Kokoro-82M-v1.1-zh"
SAMPLE_RATE = 24000

# lang -> (KPipeline lang_code, default voice id). setup-server.js's own copy
# of this map (KOKORO_VOICE_MAP) only decides what "en"/"zh" get written as
# speech.tts.voice ("kokoro-<lang>") in config.json; THIS copy is what
# actually resolves a request's voice to a real Kokoro voice id, same split
# of responsibility moss-wrapper.js/setup-server.js used for MOSS_VOICE_MAP.
VOICE_MAP = {
    "en": ("a", "af_maple"),  # American English female (real voice id, see module docstring)
    "zh": ("z", "zf_001"),    # Mandarin Chinese female (real voice id, see module docstring)
}
DEFAULT_LANG = "en"

device = "cuda" if torch.cuda.is_available() else "cpu"
log.info("Loading %s on %s (first run downloads model weights from Hugging Face + an en_core_web_sm spacy "
          "pipeline via misaki -- can take several minutes) ...", REPO_ID, device)

# Loaded once, shared by both pipelines below -- the actual point of this
# being a persistent server instead of a per-request script.
model = KModel(repo_id=REPO_ID).to(device).eval()
pipelines = {
    lang: KPipeline(lang_code=code, repo_id=REPO_ID, model=model)
    for lang, (code, _voice_id) in VOICE_MAP.items()
}
log.info("Kokoro loaded on %s, ready to serve.", device)

app = FastAPI()


@app.get("/health")
def health():
    # Reachable at all only once the module-level load above has finished --
    # there is no separate warmup/ready state to poll the way MOSS-TTS-Nano
    # needed (app_onnx.py bound its port before its own weights finished
    # downloading; uvicorn.run() below does not start accepting connections
    # until every line above it, including the model load, has completed).
    return {"status": "ok", "device": device}


def resolve_lang_and_voice(requested_voice: Optional[str]):
    # mcp-core's openai_tts client falls back to voice "alloy" when
    # config.json doesn't specify one, which matches no Kokoro voice -- same
    # fallback shape as piper-wrapper.js/moss-wrapper.js: an
    # unrecognized/missing voice resolves to the default language's voice
    # rather than failing every request. This project always writes
    # "kokoro-<lang>" (see setSpeechTts in setup-server.js's
    # handleDownloadTtsKokoro), but a bare Kokoro voice id (e.g. "af_maple")
    # is also accepted directly.
    if requested_voice:
        for lang, (_code, voice_id) in VOICE_MAP.items():
            if requested_voice in (f"kokoro-{lang}", voice_id):
                return lang, voice_id
    return DEFAULT_LANG, VOICE_MAP[DEFAULT_LANG][1]


@app.post("/v1/audio/speech")
async def synthesize(request: Request):
    body = await request.json()
    text = str(body.get("input") or "").strip()
    if not text:
        return Response(content='Missing "input" text', status_code=400, media_type="text/plain")

    lang, voice = resolve_lang_and_voice(body.get("voice"))
    pipeline = pipelines[lang]

    try:
        # A generator, not one call: long input can come back as multiple
        # chunks (split_pattern defaults to splitting on blank lines) -- all
        # of them are concatenated into one clip rather than assuming the
        # first chunk is the whole reply.
        chunks = [result.audio.cpu().numpy() for result in pipeline(text, voice=voice) if result.audio is not None]
        if not chunks:
            return Response(content="Kokoro produced no audio for this input", status_code=502, media_type="text/plain")
        audio = np.concatenate(chunks)
    except Exception as e:
        log.exception("Synthesis failed (lang=%s voice=%s)", lang, voice)
        return Response(content=str(e)[:500], status_code=502, media_type="text/plain")

    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("KOKORO_PORT", "8880")))
