#!/bin/bash
# Switch which SPC board is the fleet BRAIN (the mcp-core the ESP box dials into).
#
# Only ONE core may run at a time. If both the Radxa's and the OrangePi's
# mcp-core are up, they both push /server to the box every 60s and it flaps
# between them. This script makes one the brain and stops the other.
#
# The box follows automatically: whichever core is running has the box in its
# boxes[] list and repoints it (http://<that board>:8000/upload) within ~60s.
# Tap RST on the box to skip the wait.
#
# Usage:
#   ./set-brain.sh              show the current brain and each core's state
#   ./set-brain.sh SPC-2        make the Radxa (rock-5b-plus) the brain
#   ./set-brain.sh SPC-1        make the OrangePi (orangepi5max) the brain
#
# SPC-2 / Radxa  : voix-mcp-core is a SYSTEM unit -> needs sudo on that board.
#                  If sudo isn't passwordless there, the script prints the one
#                  line for you to run by hand.
# SPC-1 / OrangePi: mcp-core is a --user unit -> no sudo.

set -u

RADXA_SSH="radxa@rock-5b-plus"
RADXA_CFG='~/esp/config.json'
RADXA_UNIT="voix-mcp-core"            # system unit

OPI_SSH="orangepi@orangepi5max"
OPI_CFG='~/esp-fleet/config.json'
OPI_UNIT="mcp-core.service"           # --user unit

SSH_OPTS="-o ConnectTimeout=6 -o BatchMode=yes"

# --- set the fleet_brain key in a config.json (surgical, keeps comments) ------
set_brain_key() { # $1=ssh target  $2=quoted remote path  $3=brain id
  ssh $SSH_OPTS "$1" "python3 - '$3' <<'PY'
import sys, re, json, os
p = os.path.expanduser($2)
s = open(p).read()
want = sys.argv[1]
if '\"fleet_brain\"' in s:
    s = re.sub(r'\"fleet_brain\"\s*:\s*\"[^\"]*\"', '\"fleet_brain\": \"%s\"' % want, s, count=1)
else:
    s = re.sub(r'^\{\s*\\n', '{\\n  \"fleet_brain\": \"%s\",\\n' % want, s, count=1)
open(p, 'w').write(s)
json.load(open(p))
print('  fleet_brain =', json.load(open(p))['fleet_brain'], 'in', p)
PY"
}

show() {
  echo "== SPC-2  Radxa  ($RADXA_SSH) =="
  ssh $SSH_OPTS "$RADXA_SSH" "
    python3 -c \"import json,os;print('  fleet_brain:', json.load(open(os.path.expanduser('~/esp/config.json'))).get('fleet_brain','(unset)'))\" 2>/dev/null || echo '  config unreadable'
    printf '  voix-mcp-core: '; systemctl is-active $RADXA_UNIT 2>/dev/null || true
  " 2>&1 | sed 's/^/  /' || echo "  unreachable"
  echo
  echo "== SPC-1  OrangePi ($OPI_SSH) =="
  ssh $SSH_OPTS "$OPI_SSH" "
    python3 -c \"import json,os;print('  fleet_brain:', json.load(open(os.path.expanduser('~/esp-fleet/config.json'))).get('fleet_brain','(unset)'))\" 2>/dev/null || echo '  config unreadable'
    printf '  mcp-core (user): '; systemctl --user is-active mcp-core 2>/dev/null || true
  " 2>&1 | sed 's/^/  /' || echo "  unreachable"
}

start_radxa() {
  echo "SPC-2 Radxa -> BRAIN"
  set_brain_key "$RADXA_SSH" "$RADXA_CFG" "SPC-2" || { echo "  ! could not reach the Radxa"; return 1; }
  if ssh $SSH_OPTS "$RADXA_SSH" "sudo -n systemctl enable --now $RADXA_UNIT && sudo -n systemctl restart $RADXA_UNIT" 2>/dev/null; then
    echo "  voix-mcp-core enabled + restarted"
  else
    echo "  ! sudo needs a password on the Radxa. Run this yourself:"
    echo "      ssh $RADXA_SSH 'sudo systemctl enable --now $RADXA_UNIT && sudo systemctl restart $RADXA_UNIT'"
  fi
}
stop_radxa() {
  echo "SPC-2 Radxa -> standby"
  if ssh $SSH_OPTS "$RADXA_SSH" "sudo -n systemctl disable --now $RADXA_UNIT" 2>/dev/null; then
    echo "  voix-mcp-core stopped + disabled"
  else
    echo "  ! sudo needs a password on the Radxa. Run this yourself:"
    echo "      ssh $RADXA_SSH 'sudo systemctl disable --now $RADXA_UNIT'"
  fi
}
start_opi() {
  echo "SPC-1 OrangePi -> BRAIN"
  set_brain_key "$OPI_SSH" "$OPI_CFG" "SPC-1" || { echo "  ! OrangePi unreachable — rerun this script when it is back online"; return 1; }
  ssh $SSH_OPTS "$OPI_SSH" "systemctl --user enable --now mcp-core && systemctl --user restart mcp-core" \
    && echo "  mcp-core (user) enabled + restarted" \
    || echo "  ! could not start mcp-core on the OrangePi"
}
stop_opi() {
  echo "SPC-1 OrangePi -> standby"
  if ssh $SSH_OPTS "$OPI_SSH" "systemctl --user disable --now mcp-core.service" 2>/dev/null; then
    echo "  mcp-core (user) stopped + disabled"
  else
    echo "  OrangePi unreachable (already off, or not on the tailnet) — nothing to stop."
    echo "  It also carries fleet_brain=SPC-2 now; rerun this script when it is back so it"
    echo "  reads the new value and stays in standby."
  fi
}

case "${1:-}" in
  "" ) show ;;
  SPC-2|spc-2|radxa|RADXA )
      stop_opi; echo; start_radxa
      echo; echo "Done. The box repoints to the Radxa within ~60s; tap RST to hurry." ;;
  SPC-1|spc-1|orangepi|OPI )
      stop_radxa; echo; start_opi
      echo; echo "Done. The box repoints to the OrangePi within ~60s; tap RST to hurry."
      echo "Note: the Radxa's own face panel is driven by its local mcp-core; with SPC-1"
      echo "as brain you must also point SPC-1's config devices[] SPC-2 entry at"
      echo "http://rock-5b-plus:8080 (not 127.0.0.1) for the panel to keep updating." ;;
  * ) echo "usage: $0 [SPC-1|SPC-2]"; exit 2 ;;
esac
