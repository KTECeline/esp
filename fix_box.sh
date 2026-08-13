#!/bin/bash
# One command to bring a box back after the Mac changed networks.
#
#   ./fix_box.sh [box_ip]
#
# The box stores the Mac's address in NVS as a literal IP, and nothing on the
# box re-checks it — so every new WiFi (or DHCP renew) leaves it dialling an
# address that no longer exists, stuck on "NO SERVER". This wraps the three
# steps that fix it: load the fleet token, repoint the box, verify.
#
# The box screen shows its own IP on the NO SERVER screen — that's the argument
# to pass. With no argument we try the last-known IP from config.json, which is
# right whenever only the *Mac* moved.
#
# See also: point_box_at_me.sh (does the repoint), check_health.sh (verifies).
set -u
cd "$(dirname "$0")" || exit 1

# point_box_at_me.sh reads fleet_token_env from config.json but never loads
# .env itself — only start_voice_assistant.sh does. Without this the box

# answers 401 and the whole thing looks like an auth problem instead of a
# missing shell variable.
if [ -f .env ]; then
  set -a; . ./.env; set +a
else
  echo "WARNING: no ~/esp/.env — an adopted box will reject this with 401."
fi

BOX_IP="${1:-$(python3 -c "import json;print(json.load(open('config.json'))['boxes'][0]['ip'])" 2>/dev/null)}"
if [ -z "$BOX_IP" ]; then
  echo "No box IP given and none in config.json."
  echo "Read the IP off the box screen and pass it: ./fix_box.sh <ip>"
  exit 1
fi
BOX_IP="${BOX_IP%%:*}"   # config may carry an explicit :port; the repoint wants the host

echo "==> Pointing $BOX_IP at this Mac"
./point_box_at_me.sh "$BOX_IP" || exit 1

# The firmware's retry loop backs off to 30s, so a box that was already sitting
# on NO SERVER can take that long to notice. Poll instead of sleeping a flat 30s
# so the common case (box waiting on a short backoff) returns in a few seconds.
echo
echo "==> Waiting for the box to pick it up (up to 40s)"
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://$BOX_IP/caption" 2>/dev/null)
  # 405 = alive (that route is POST-only); 401 = alive and holding a token.
  case "$code" in
    200|401|405) echo "    box responding after ~$((i * 2))s"; break ;;
  esac
  sleep 2
done

echo
./check_health.sh "$BOX_IP"
