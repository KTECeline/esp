# Voice Assistant — Setup Guide for New Machine

This package contains the code (not the large AI models — those come separately, see below). Follow these steps in order on your Mac.

---

## Part A — Things you install/build fresh (don't copy these, rebuild them)

### 1. Whisper (speech-to-text engine)
```bash
git clone https://github.com/ggerganov/whisper.cpp ~/whisper.cpp
cd ~/whisper.cpp
cmake -B build -DWHISPER_SDL2=ON
cmake --build build --config Release

to see log: whisper.cpp % tail -f /tmp/assistant.log
import sys
import json

for line in sys.stdin:
    r = json.loads(line)

    print(f"\n[{r['timestamp']}]")
    print(f"  you said : {r.get('transcript', '?')}")
    print(f"  assistant: {r.get('reply', '?')}")

    lat = r.get("latency_ms", {})
    if lat:
        print(
            f"  latency  : "
            f"STT={lat.get('bridge_stt-ms','?')}ms  "
            f"LLM={lat.get('bridge_llm-ms','?')}ms  "
            f"TTS={lat.get('bridge_tts-ms','?')}ms  "
            f"end-to-end={lat.get('end_to_end','?')}ms"
        )
```

### 2. Ollama (local LLM, used by talk.sh for casual testing)
```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.2:3b
```

### 3. sox and jq (small command-line audio/JSON tools)
```bash
brew install sox jq
```

### 4. Node.js
Check if you already have it: `node --version` (need v18+). If not:
```bash
brew install node
```

---

## Part B — Files you'll receive separately (too large for this package)

Ask Night Owl to upload these to a shared cloud drive (Google Drive, etc.) and send you the link:

1. **Whisper model file** — `ggml-base.bin` (~148MB) → place it at `~/whisper.cpp/models/ggml-base.bin`
2. **MOSS-TTS-Nano folder** — the whole project folder, including the `onnx_model`, `onnx_tokenizer`, and `assets/audio` folders → place at `~/MOSS-TTS-Nano`

Once you have MOSS-TTS-Nano, set up its Python environment:
```bash
cd ~/MOSS-TTS-Nano
conda create -n moss-tts-nano python=3.12 -y
conda activate moss-tts-nano
pip install -r requirements.txt --break-system-packages
```
(If there's no `requirements.txt`, ask Night Owl what packages are needed — likely `fastapi`, `uvicorn`, `onnxruntime`, `torchaudio`.)

---

## Part C — Code in this package (just copy these folders into your home directory)

Copy this package's contents so your home folder (`~`) contains:
```
~/voice-mcp-server/
~/bridge-server/
~/talk.sh
~/start_voice_assistant.sh
```

Then build the two Node projects:
```bash
cd ~/voice-mcp-server
npm install
npm run build

cd ~/bridge-server
npm install
```

Make the scripts runnable:
```bash
chmod +x ~/talk.sh ~/start_voice_assistant.sh
```

---

## Part D — Start everything and test

```bash
~/start_voice_assistant.sh
```

Then check it's healthy:
```bash
curl http://localhost:3000/health
```
Should show: `{"status":"ok","mcpConnected":true}`

Try the standalone assistant:
```bash
~/talk.sh
```

---

## If something goes wrong

Check these log files for the actual error:
```bash
cat /tmp/ollama.log
cat /tmp/moss-tts.log
cat /tmp/bridge.log
```

If whisper-cli or MOSS-TTS live at a different path on your machine than the defaults above, you can override with environment variables before starting — ask Night Owl for details if needed.
