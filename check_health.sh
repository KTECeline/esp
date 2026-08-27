#!/bin/bash
# Pre-demo health check: one green/red line per service. Run before every demo.
#   ./check_health.sh [box_ip]     (box_ip defaults to the first box in config.json)
BOX_IP="${1:-$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/esp/config.json')))['boxes'][0]['ip'])" 2>/dev/null)}"
G=$'\033[32mOK\033[0m'; R=$'\033[31mDOWN\033[0m'

check() {  # name, url, expected-ish
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$2" 2>/dev/null)
  if [[ "$code" =~ ^(200|404|405|501)$ ]]; then printf "  %-22s %s  (%s)\n" "$1" "$G" "$2"
  else printf "  %-22s %s  (%s -> %s)\n" "$1" "$R" "$2" "${code:-no response}"; fi
}

# mcp-core binds *:8000 but an unrelated app (agentos) squats localhost:8000,
# so it must be probed via the Mac's LAN IP — same route the box uses.
MAC_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)

echo "Voice assistant health:"
check "Ollama (LLM)"        "http://localhost:11434/api/tags"
check "MOSS-TTS"            "http://localhost:8080/docs"
check "MCP core"            "http://${MAC_IP:-localhost}:8000/health"
check "Box (on WiFi)"       "http://$BOX_IP/caption"              # 405 = alive (POST-only route)

# Core health body includes mcpConnected + backend priority — surface it.
core=$(curl -s --max-time 3 "http://${MAC_IP:-localhost}:8000/health" 2>/dev/null)
[ -n "$core" ] && echo "  mcp-core says: $core"
echo "(if the box line is DOWN: check the IP on its screen and pass it: ./check_health.sh <ip>)"
