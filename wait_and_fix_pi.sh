#!/usr/bin/env bash
# Wait for the OrangePi to reappear on the tailnet, then set it up in one shot.
#
# The Pi's wifi on the phone hotspot drops constantly, so an interactive ssh
# session is a coin flip. This polls until port 22 answers and then runs
# everything non-interactively — if it dies halfway, just run the script again.
set -uo pipefail

PI_HOST="${PI_HOST:-100.64.142.58}"
PI_USER="${PI_USER:-orangepi}"
AGENT_SRC="$(dirname "$0")/spc-agent/spc_agent.py"

SSH_OPTS=(-o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=3
          -o StrictHostKeyChecking=accept-new -o BatchMode=no)

echo "waiting for $PI_USER@$PI_HOST to answer on :22 (ctrl-c to stop)..."
until nc -z -G 5 "$PI_HOST" 22 2>/dev/null; do
  printf '.'
  sleep 5
done
echo
echo "port 22 is open — connecting"

# Copy the agent up first; harmless if it's already there and identical.
if [ -f "$AGENT_SRC" ]; then
  scp "${SSH_OPTS[@]}" "$AGENT_SRC" "$PI_USER@$PI_HOST:~/spc_agent.py" \
    && echo "agent copied" || echo "scp failed — carrying on, may already be present"
fi

# Everything below runs on the Pi. Kept as one command so a dropped session
# can't leave it half-done — rerun the script and it just redoes it.
ssh "${SSH_OPTS[@]}" "$PI_USER@$PI_HOST" 'bash -s' <<'REMOTE'
set -x

# 1. Make tailscale survive reboots and drops.
sudo systemctl enable --now tailscaled

# 2. Unpin the wifi profile from a single BSSID. iOS uses a different BSSID for
#    its 2.4GHz radio than its 5GHz one, so a pinned profile refuses to
#    associate after a band change even though the SSID is identical.
for c in $(nmcli -g NAME connection show 2>/dev/null); do
  sudo nmcli connection modify "$c" 802-11-wireless.bssid "" 2>/dev/null
  sudo nmcli connection modify "$c" connection.autoconnect yes 2>/dev/null
  sudo nmcli connection modify "$c" connection.autoconnect-retries 0 2>/dev/null
done

# 3. Run the agent under systemd so it comes back on its own after a reboot
#    or a crash — this box sat dead for two days without anyone noticing.
sudo tee /etc/systemd/system/spc-agent.service >/dev/null <<UNIT
[Unit]
Description=spc-agent (fleet device agent)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/python3 %h/spc_agent.py
Restart=always
RestartSec=5
User=$(whoami)

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now spc-agent

sleep 2
systemctl --no-pager --lines=15 status spc-agent || true
curl -s -m 3 http://127.0.0.1:8080/health || echo "agent not answering locally yet"
REMOTE

echo
echo "done — verifying from this end:"
curl -s -m 5 "http://orangepi5max:8080/health" && echo || echo "not reachable from here yet"
