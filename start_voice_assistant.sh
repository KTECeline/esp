#!/bin/bash
# Usage: ./start_voice_assistant.sh [box_ip]
# box_ip (optional) overwrites the FIRST box's IP in config.json — check the
# box's own screen if it changed. All other settings live in ~/esp/config.json.

if [ -n "$1" ]; then
  python3 - "$1" <<'EOF'
import json, os, sys
p = os.path.expanduser("~/esp/config.json")
cfg = json.load(open(p))
cfg["boxes"][0]["ip"] = sys.argv[1]
json.dump(cfg, open(p, "w"), indent=2)
print(f"config.json: box1 ip set to {sys.argv[1]}")
EOF
fi

echo "Stopping any old instances first..."
pkill -f "ollama serve" 2>/dev/null
pkill -f "uvicorn server:app" 2>/dev/null
pkill -f "node bridge-server.js" 2>/dev/null          # legacy
pkill -f "assistant_via_bridge.py" 2>/dev/null         # legacy
pkill -f "assistant_server.py" 2>/dev/null             # legacy
pkill -f "mcp-core/server.js" 2>/dev/null
sleep 2

# nohup everywhere: closing this terminal must not kill the services. (Learned
# the hard way — uvicorn exits on terminal hangup, so TTS silently died and the
# box stopped replying while everything else kept running.)
echo "Starting Ollama..."
nohup ollama serve > /tmp/ollama.log 2>&1 &
OLLAMA_PID=$!

echo "Starting MOSS-TTS..."
cd ~/esp/MOSS-TTS-Nano
# no conda on this machine — MOSS lives in a plain venv
nohup .venv/bin/uvicorn server:app --host 0.0.0.0 --port 8080 > /tmp/moss-tts.log 2>&1 &
TTS_PID=$!

echo "Waiting for TTS/Ollama to warm up..."
sleep 5

# The demo mamak restaurant agent that used to run here on :4000 is gone —
# the real ordering agent (OpenClaw + menu-importer/supabase-ordering, backed
# by the live menu in local-db-server) runs on whichever board is the fleet's
# brain (Radxa/OrangePi), not on this Mac. mcp-core's "agent" backend below
# will fail over to local_llm (plain chat) if nothing answers :4000 locally —
# that's expected for Mac-side dev/testing, not a bug.

# Secrets (fleet + /mcp tokens) live in ~/esp/.env, which is gitignored — they
# must never sit in config.json, which is committed-adjacent and gets pasted
# into issues. Absent = auth simply stays off, and mcp-core says so at startup.
if [ -f ~/esp/.env ]; then
  set -a; . ~/esp/.env; set +a
  echo "Loaded secrets from ~/esp/.env"
else
  echo "No ~/esp/.env — running WITHOUT fleet/MCP auth (see config.example.json)."
fi

echo "Starting mcp-core (router; auto-starts voice-mcp-server over stdio)..."
# Whisper model + Manglish bias prompt are set in config.json (stt section),
# not here — mcp-core passes them to voice-mcp-server itself.
nohup node ~/esp/mcp-core/server.js > /tmp/mcp-core.log 2>&1 &
CORE_PID=$!

sleep 2

echo ""
echo "All running:"
echo "  Ollama            (PID $OLLAMA_PID)  - log: /tmp/ollama.log"
echo "  MOSS-TTS          (PID $TTS_PID)     - log: /tmp/moss-tts.log"
echo "  MCP core + STT    (PID $CORE_PID)    - log: /tmp/mcp-core.log"
echo ""
echo "Check health: ./check_health.sh"
echo "Then press BOOT on the box and ask it something."
