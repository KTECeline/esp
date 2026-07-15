#!/bin/bash
# Usage: ./start_voice_assistant.sh [box_ip]
# box_ip defaults to 192.168.68.142 — check the box's own screen if it changed.
BOX_IP="${1:-192.168.68.142}"

echo "Stopping any old instances first..."
pkill -f "ollama serve" 2>/dev/null
pkill -f "uvicorn server:app" 2>/dev/null
pkill -f "node bridge-server.js" 2>/dev/null
pkill -f "assistant_via_bridge.py" 2>/dev/null
pkill -f "assistant_server.py" 2>/dev/null
sleep 2

# nohup everywhere: closing this terminal must not kill the services. (Learned
# the hard way — uvicorn exits on terminal hangup, so TTS silently died and the
# box stopped replying while everything else kept running.)
echo "Starting Ollama..."
nohup ollama serve > /tmp/ollama.log 2>&1 &
OLLAMA_PID=$!

echo "Starting MOSS-TTS..."
cd ~/MOSS-TTS-Nano
# no conda on this machine — MOSS lives in a plain venv
nohup .venv/bin/uvicorn server:app --host 0.0.0.0 --port 8080 > /tmp/moss-tts.log 2>&1 &
TTS_PID=$!

echo "Waiting for TTS/Ollama to warm up..."
sleep 5

echo "Starting Bridge server (this also auto-starts the MCP server)..."
cd ~/esp/bridge-server
# Multilingual "small" (not the .en build) so the box can understand Manglish /
# Malay, not just English. On the 100 English test recordings it scores ~66% vs
# small.en's 68% — a negligible ~2pt English tax to unlock other languages, at
# the same ~0.9s/clip latency. To roll back to English-only, swap the model line.
# WHISPER_PROMPT_FILE biases whisper toward mamak/kopitiam menu words (tapau, teh
# tarik, roti canai, ...) so they aren't mangled into English. Tune the word list
# in that file as the real menu firms up.
export WHISPER_MODEL="$HOME/esp/whisper.cpp/models/ggml-small.bin"
# export WHISPER_MODEL="$HOME/esp/whisper.cpp/models/ggml-small.en.bin"  # English-only fallback
export WHISPER_PROMPT_FILE="$HOME/esp/voice-mcp-server/manglish_prompt.txt"
nohup node bridge-server.js > /tmp/bridge.log 2>&1 &
BRIDGE_PID=$!

sleep 2

echo "Starting box adapter (box -> this bridge -> box)..."
cd ~/esp/listen_v2
# -u: unbuffered stdout so the log is readable live (Python block-buffers
# prints when stdout is a file, which made debugging look like silence).
nohup python3 -u assistant_via_bridge.py "$BOX_IP" > /tmp/box-adapter.log 2>&1 &
ADAPTER_PID=$!

sleep 1

echo ""
echo "All running:"
echo "  Ollama        (PID $OLLAMA_PID)  - log: /tmp/ollama.log"
echo "  MOSS-TTS      (PID $TTS_PID)     - log: /tmp/moss-tts.log"
echo "  Bridge + MCP  (PID $BRIDGE_PID)  - log: /tmp/bridge.log"
echo "  Box adapter   (PID $ADAPTER_PID) - log: /tmp/box-adapter.log  (box_ip=$BOX_IP)"
echo ""
echo "Check bridge health: curl http://localhost:3000/health"
echo "Then press BOOT on the box and ask it something."
