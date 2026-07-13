#!/bin/bash
echo "Stopping any old instances first..."
pkill -f "ollama serve" 2>/dev/null
pkill -f "uvicorn server:app" 2>/dev/null
pkill -f "node bridge-server.js" 2>/dev/null
sleep 2

echo "Starting Ollama..."
ollama serve > /tmp/ollama.log 2>&1 &
OLLAMA_PID=$!

echo "Starting MOSS-TTS..."
cd ~/MOSS-TTS-Nano
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate moss-tts-nano
uvicorn server:app --host 0.0.0.0 --port 8080 > /tmp/moss-tts.log 2>&1 &
TTS_PID=$!

echo "Waiting for TTS/Ollama to warm up..."
sleep 5

echo "Starting Bridge server (this also auto-starts the MCP server)..."
cd ~/bridge-server
node bridge-server.js > /tmp/bridge.log 2>&1 &
BRIDGE_PID=$!

sleep 2

echo ""
echo "All running:"
echo "  Ollama       (PID $OLLAMA_PID)  - log: /tmp/ollama.log"
echo "  MOSS-TTS     (PID $TTS_PID)     - log: /tmp/moss-tts.log"
echo "  Bridge + MCP (PID $BRIDGE_PID)  - log: /tmp/bridge.log"
echo ""
echo "Check bridge health: curl http://localhost:3000/health"
