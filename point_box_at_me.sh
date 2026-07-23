#!/bin/bash
# Repoint every ESP box on this LAN at THIS machine's mcp-core — no QR, no
# re-provision, no button.
#
# The box's server address is stored on the box. When this Mac moves networks
# or gets a new IP, that stored address goes stale and the box sits on
# "NO SERVER" forever. Previously the only fix was a full re-provision through
# the QR portal (and mDNS/mcp-core.local is blocked on some managed networks,
# so the hostname trick doesn't always save you). The firmware now brings its
# HTTP server up BEFORE it waits for the server, so a stuck box is still
# reachable — and this script just tells it where to look.
#
# Usage: ./point_box_at_me.sh [box_ip ...]
#   With no arguments, scans the LAN for Espressif MACs and fixes every box.

set -u
PORT=8000
MAC_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
if [ -z "$MAC_IP" ]; then echo "Could not determine this machine's LAN IP."; exit 1; fi
URL="http://$MAC_IP:$PORT/upload"

if ! curl -s -o /dev/null --max-time 2 "http://$MAC_IP:$PORT/health"; then
  echo "WARNING: mcp-core is not answering on $MAC_IP:$PORT — start it first (./start_voice_assistant.sh),"
  echo "         otherwise the box will just go back to waiting."
fi

# macOS ships bash 3.2 — no mapfile, and "${arr[@]}" on an empty array trips
# `set -u`. Keep this POSIX-ish so it runs on a stock Mac.
boxes=""
if [ "$#" -gt 0 ]; then
  boxes="$*"
else
  BASE=$(echo "$MAC_IP" | cut -d. -f1-3)
  echo "Scanning $BASE.0/24 for boxes..."
  for i in $(seq 1 254); do ping -c1 -W1 -t1 "$BASE.$i" >/dev/null 2>&1 & done
  wait 2>/dev/null
  # Espressif OUIs seen on these boards. arp prints MACs without leading zeros.
  boxes=$(arp -an 2>/dev/null | grep -iE "e8:f6:|7c:df:|a0:76:|30:ae:|8c:4b:" \
          | sed -E 's/.*\(([0-9.]+)\).*/\1/' | sort -u | tr '\n' ' ')
  if [ -z "$(echo "$boxes" | tr -d ' ')" ]; then
    echo "No boxes found. Is the box powered on and joined to this WiFi?"
    echo "(If it's on a different network, it needs re-provisioning via the QR portal.)"
    exit 1
  fi
fi

echo "Pointing boxes at $URL"
ok=0
for ip in $boxes; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 -X POST "http://$ip/server" --data "$URL")
  if [ "$code" = "200" ]; then
    echo "  $ip  OK"
    ok=$((ok+1))
  else
    echo "  $ip  FAILED (HTTP ${code:-timeout}) — old firmware without /server, or not a box"
  fi
done
echo
if [ "$ok" -gt 0 ]; then
  echo "$ok box(es) repointed. They pick it up on the next retry (within ~30s)."
else
  echo "Nothing repointed. If the box predates the /server endpoint, flash it once:"
  echo "  cd ~/esp/listen_v2 && source idfenv.sh && idf.py flash"
fi
