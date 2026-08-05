#!/bin/bash
# Pre-INSTALL check: is everything this machine NEEDS actually here?
#   ./check_setup.sh
#
# Sibling of check_health.sh, and the two answer different questions:
#   check_setup.sh   is it installed?   <- run once on a new machine
#   check_health.sh  is it running?     <- run before every demo
#
# Exists because the install has silent prerequisites. `sox` in particular is
# used on every recording and every reply, is documented nowhere, and was only
# present on the original dev Mac via Homebrew — a fresh machine fails at the
# first customer with an error that names neither sox nor audio.

# Resolve the project root from THIS script's location, not ~/esp, so the check
# is honest about the tree it is actually run from.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

G=$'\033[32mOK\033[0m'; R=$'\033[31mMISSING\033[0m'; Y=$'\033[33mWARN\033[0m'
FAILED=0

ok()   { printf "  %-26s %s  %s\n" "$1" "$G" "$2"; }
bad()  { printf "  %-26s %s  %s\n" "$1" "$R" "$2"; FAILED=$((FAILED+1)); }
warn() { printf "  %-26s %s  %s\n" "$1" "$Y" "$2"; }

need_cmd() {  # name, command, fix-hint
  if command -v "$2" >/dev/null 2>&1; then ok "$1" "$(command -v "$2")"
  else bad "$1" "install: $3"; fi
}

need_file() {  # name, path, fix-hint
  if [ -e "$2" ]; then ok "$1" "${2#$ROOT/}"
  else bad "$1" "$3"; fi
}

echo "Voice assistant setup check:"
echo "  project root: $ROOT"
echo ""
echo "Commands:"
need_cmd "Node.js"   node   "https://nodejs.org (LTS)"
need_cmd "sox"       sox    "brew install sox   (Linux: apt install sox)"
need_cmd "python3"   python3 "https://python.org"
need_cmd "curl"      curl   "preinstalled on macOS/Linux"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null)
  [ "${NODE_MAJOR:-0}" -lt 18 ] 2>/dev/null \
    && warn "Node.js version" "v$(node -p process.versions.node) — needs 18+ for built-in fetch"
fi

echo ""
echo "Speech engines:"
# Only the configured engines are required. An all-hosted `speech` block needs
# neither whisper.cpp nor MOSS, so demanding them would send someone off to
# compile software their deployment never runs. Mirrors inferSpeechType() in
# mcp-core/config.js: explicit type wins, a token_env implies hosted, and an
# absent speech block means the legacy local pair.
read -r STT_TYPE TTS_TYPE <<<"$(python3 - "$ROOT/config.json" <<'PY' 2>/dev/null || echo "whisper_local moss_local"
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception:
    print("whisper_local moss_local"); raise SystemExit
sp = cfg.get("speech") or {}
def kind(side, hosted, local):
    sc = sp.get(side) or {}
    return sc.get("type") or (hosted if (sc.get("token_env") or sc.get("token")) else local)
print(kind("stt", "openai_whisper", "whisper_local"), kind("tts", "openai_tts", "moss_local"))
PY
)"
echo "  configured: stt=$STT_TYPE tts=$TTS_TYPE"

if [ "$STT_TYPE" = "whisper_local" ]; then
  WHISPER_DIR="${WHISPER_DIR:-$ROOT/whisper.cpp}"
  need_file "whisper-cli binary" "$WHISPER_DIR/build/bin/whisper-cli" \
            "compile whisper.cpp: cmake -B build && cmake --build build -j"
  # Any ggml model counts — config.json picks which one is actually used.
  if ls "$WHISPER_DIR"/models/ggml-*.bin >/dev/null 2>&1; then
    ok "whisper model" "$(ls "$WHISPER_DIR"/models/ggml-*.bin | xargs -n1 basename | tr '\n' ' ')"
  else
    bad "whisper model" "download one: $WHISPER_DIR/models/download-ggml-model.sh small"
  fi
else
  ok "STT ($STT_TYPE)" "hosted — nothing to install locally"
fi

if [ "$TTS_TYPE" = "moss_local" ]; then
  need_file "MOSS-TTS venv" "$ROOT/MOSS-TTS-Nano/.venv" \
            "create it in MOSS-TTS-Nano: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
else
  ok "TTS ($TTS_TYPE)" "hosted — nothing to install locally"
fi

echo ""
echo "Project files:"
need_file "config.json" "$ROOT/config.json" "cp config.example.json config.json"
if [ -f "$ROOT/config.json" ]; then
  if python3 -c "import json,sys;json.load(open('$ROOT/config.json'))" 2>/dev/null; then
    ok "config.json parses" "valid JSON"
  else
    bad "config.json parses" "invalid JSON — a stray comma or quote. Check it in a JSON linter."
  fi
fi
need_file "mcp-core deps"  "$ROOT/mcp-core/node_modules" "cd mcp-core && npm install"
# Only needed when a local engine is configured — an all-hosted config never
# spawns voice-mcp-server, so an unbuilt one is not a fault.
case "$STT_TYPE $TTS_TYPE" in
  *_local*) need_file "voice-mcp build" "$ROOT/voice-mcp-server/dist/index.js" \
                      "cd voice-mcp-server && npm install && npm run build" ;;
  *) if [ -e "$ROOT/voice-mcp-server/dist/index.js" ]; then
       ok "voice-mcp build" "present (unused by an all-hosted config)"
     else
       warn "voice-mcp build" "not built — fine, all-hosted config never starts it"
     fi ;;
esac

# Secrets are optional by design (absent = auth off), so this is a WARN, never
# a failure — but running a real deployment without them is worth flagging.
if [ -f "$ROOT/.env" ]; then
  PERMS=$(stat -f "%Lp" "$ROOT/.env" 2>/dev/null || stat -c "%a" "$ROOT/.env" 2>/dev/null)
  if [ "$PERMS" = "600" ]; then ok ".env (secrets)" "mode 600"
  else warn ".env (secrets)" "mode $PERMS — tighten it: chmod 600 .env"; fi
else
  warn ".env (secrets)" "absent — fleet/MCP auth will run OFF (see config.example.json)"
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "All prerequisites present. Start it: ./start_voice_assistant.sh"
else
  echo "$FAILED missing — fix the red lines above, then re-run ./check_setup.sh"
  exit 1
fi
