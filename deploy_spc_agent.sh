#!/bin/bash
# Install spc-agent on an OrangePi and leave it running under systemd.
#
# The Pi is the one piece of this fleet that can't be provisioned from the
# laptop the way a box can. A box is reachable the moment it joins WiFi because
# its firmware brings up an HTTP server unprompted; a stock Linux board offers
# nothing but sshd, so the first deploy needs an interactive password.
#
# The remote half runs from a STAGED FILE rather than piped into `bash -s`,
# which looks like a detail and is not. `ssh -t ... bash -s <<EOF` cannot
# allocate a PTY, because stdin is the heredoc — so every sudo inside fails with
# "a terminal is required to read the password" and the install silently does
# nothing but copy a file. Staging the script means ssh's stdin stays free, the
# PTY is real, and sudo can prompt exactly once.
#
# Idempotent — safe to re-run after editing spc_agent.py, which is the normal
# way to push a change.
#
# Usage: ./deploy_spc_agent.sh [user@host]
#   Default target: orangepi@orangepi5max

set -u
TARGET="${1:-orangepi@orangepi5max}"
HOST="${TARGET#*@}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/spc-agent/spc_agent.py"
# The face page ships beside the agent. It is a separate file only so the HTTP
# service stays readable; both must land together, or /face serves an apology.
FACE_SRC="$HERE/spc-agent/spc_face.py"
PORT=8080

if [ ! -f "$SRC" ]; then
  echo "Cannot find $SRC"
  echo "Run this from the laptop that holds the repo — not from the Pi."
  exit 1
fi
if [ ! -f "$FACE_SRC" ]; then
  echo "Cannot find $FACE_SRC"
  echo "Run this from the laptop that holds the repo — not from the Pi."
  exit 1
fi

# The Pi must present the SAME X-Fleet-Token as the boxes: mcp-core sends one
# secret to all fleet hardware. Preferred source is the running mcp-core's own
# environment, because that is by definition the value it will send — reading
# .env instead would install a stale token if the daemon was started with a
# different one (and this project's .env has the line commented out anyway).
TOKEN="${ESP_FLEET_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  PID=$(pgrep -f "node .*mcp-core/server.js" | head -1)
  if [ -n "$PID" ]; then
    TOKEN=$(ps eww -p "$PID" | tr ' ' '\n' | grep -m1 '^ESP_FLEET_TOKEN=' | cut -d= -f2-)
    [ -n "$TOKEN" ] && echo "Using ESP_FLEET_TOKEN from the running mcp-core (pid $PID)."
  fi
fi
if [ -z "$TOKEN" ]; then
  echo "WARNING: no ESP_FLEET_TOKEN found. Installing with auth OFF —"
  echo "         anyone who can reach $HOST:$PORT could open the Pi's microphone."
  echo "         Export ESP_FLEET_TOKEN and re-run to fix. Continuing in 5s..."
  sleep 5
fi

# Build the remote installer locally. The token is carried base64-encoded so a
# token containing quotes or shell metacharacters cannot break the script it is
# being written into.
TOKEN_B64=$(printf '%s' "$TOKEN" | base64 | tr -d '\n')
INSTALLER=$(mktemp "${TMPDIR:-/tmp}/spc_install.XXXXXX")
trap 'rm -f "$INSTALLER"' EXIT
{
  echo '#!/bin/bash'
  echo "REMOTE_TOKEN=\$(printf '%s' '$TOKEN_B64' | base64 -d)"
  echo "SKIP_APT='${SPC_SKIP_APT:-0}'"
  # Empty means "work it out from /dev/dri and /dev/fb0". Deploy with
  # SPC_SCREEN=1 to force the screen capability on before a panel is plugged in
  # — the face can then be driven and watched from a browser on any machine.
  echo "SCREEN='${SPC_SCREEN:-}'"
  # Quoted heredoc: everything below is expanded ON THE PI, not here.
  cat <<'BODY'
set -u
# A previous run's apt can still be holding the lock — most often because it was
# interrupted from the laptop side, which kills ssh but leaves the remote apt
# running. Waiting on that lock is the single most common way this deploy
# appears to hang forever, so say what is happening rather than sitting mute.
if pgrep -x apt-get >/dev/null || pgrep -x apt >/dev/null; then
  echo "--> NOTE: an apt process is already running (probably a previous interrupted run)."
  echo "    Clear it with:  sudo pkill -9 apt-get; sudo rm -f /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend"
  echo "    Or re-run this deploy with SPC_SKIP_APT=1 to bypass packages entirely."
fi

echo "--> Placing /opt/spc-agent/spc_agent.py"
sudo mkdir -p /opt/spc-agent
sudo mv /tmp/spc_agent.py /opt/spc-agent/spc_agent.py
sudo chmod 755 /opt/spc-agent/spc_agent.py

# Must sit in the same directory: spc_agent.py imports it by module name, and
# Python looks beside the script it is running.
echo "--> Placing /opt/spc-agent/spc_face.py"
sudo mv /tmp/spc_face.py /opt/spc-agent/spc_face.py
sudo chmod 644 /opt/spc-agent/spc_face.py

echo "--> Packages"
if [ "${SKIP_APT}" = "1" ]; then
  echo "    SKIPPED (SPC_SKIP_APT=1). Capabilities below reflect what is already installed."
else
# Install only what is actually missing, and NEVER let apt block the deploy.
#
# `apt-get update` is the slow step — this image's sources point at a remote
# mirror (aliyun), and with -qq there is no progress output, so a slow index
# refresh is indistinguishable from a hang. It is also usually unnecessary:
# these are base-repo packages and an OrangePi image normally ships alsa-utils
# already. So: check first, install only the gap, refresh the index only if the
# install actually fails, and put a timeout on both. Missing packages are not
# fatal — they just show up as capabilities the Pi doesn't report, which is
# exactly what /health is for.
need=""
for pair in "arecord alsa-utils" "aplay alsa-utils" "sox sox" "espeak-ng espeak-ng" "ffmpeg ffmpeg"; do
  set -- $pair
  command -v "$1" >/dev/null 2>&1 || need="$need $2"
done
need=$(printf '%s\n' $need | sort -u | tr '\n' ' ')
if [ -z "${need// /}" ]; then
  echo "    all present — nothing to install"
else
  echo "    missing:$need"
  export DEBIAN_FRONTEND=noninteractive
  # Output goes to a log, not a pipe: `apt | tail` would report TAIL's exit
  # status, so a failed install would look like a success and the retry would
  # never fire.
  APTLOG=/tmp/spc_apt.log
  if sudo timeout 150 apt-get install -y -qq $need >"$APTLOG" 2>&1; then
    echo "    installed:$need"
  else
    echo "    not in the local index; refreshing it (up to 3 min on a slow mirror)..."
    sudo timeout 180 apt-get update >"$APTLOG" 2>&1
    if sudo timeout 180 apt-get install -y -qq $need >"$APTLOG" 2>&1; then
      echo "    installed:$need"
    else
      echo "    WARNING: apt could not install$need — continuing without them."
      grep -viE '^(W:|Get:|Hit:|Reading|Building|Selecting)' "$APTLOG" | tail -3
    fi
  fi
  # A held dpkg lock is the other classic stall, and it says so plainly.
  pgrep -x unattended-upgr >/dev/null && \
    echo "    NOTE: unattended-upgrades is running and holds the apt lock; re-run later to finish."
fi
fi

echo "--> Hardware access for $USER"
# Without these groups arecord and the camera fail with permission errors that
# look exactly like absent hardware.
sudo usermod -aG audio,video "$USER"

echo "--> Detected hardware:"
python3 /opt/spc-agent/spc_agent.py --help | tail -14

echo "--> systemd unit"
sudo tee /etc/systemd/system/spc-agent.service >/dev/null <<UNIT
[Unit]
Description=spc-agent (OrangePi fleet device)
After=network-online.target sound.target

[Service]
ExecStart=/usr/bin/python3 /opt/spc-agent/spc_agent.py
Environment=SPC_ID=SPC-1
Environment=SPC_FLEET_TOKEN=${REMOTE_TOKEN}
Environment=SPC_SCREEN=${SCREEN}
Restart=always
RestartSec=5
User=${USER}

[Install]
WantedBy=multi-user.target
UNIT
sudo chmod 600 /etc/systemd/system/spc-agent.service

sudo systemctl daemon-reload
sudo systemctl enable spc-agent >/dev/null 2>&1
sudo systemctl restart spc-agent
sleep 2
if systemctl is-active --quiet spc-agent; then
  echo "--> spc-agent is RUNNING"
  echo "--> localhost check:"
  curl -s -m 5 "http://127.0.0.1:8080/health" || echo "    (no answer on localhost)"
  echo
  if curl -s -m 5 "http://127.0.0.1:8080/health" | grep -q '"screen"'; then
    echo "--> face page: http://$(hostname):8080/face  (open it anywhere to watch this Pi)"
  fi
else
  echo "--> FAILED to start:"
  sudo journalctl -u spc-agent -n 20 --no-pager
fi
# The token was written into this file; don't leave it in /tmp.
rm -f "$0"
BODY
} > "$INSTALLER"

# One SSH connection, reused for all three steps, so the password is typed once
# instead of once per scp/ssh.
CTL="${TMPDIR:-/tmp}/spc-ssh-$$"
cleanup() { ssh -S "$CTL" -O exit "$TARGET" 2>/dev/null; rm -f "$INSTALLER"; }
trap cleanup EXIT

echo "==> Connecting to $TARGET (password prompt follows)"
ssh -M -S "$CTL" -o ControlPersist=180 -o StrictHostKeyChecking=accept-new -fN "$TARGET" || {
  echo "Could not connect to $TARGET."
  exit 1
}

echo "==> Copying files"
scp -o ControlPath="$CTL" -q "$SRC" "$TARGET:/tmp/spc_agent.py" || exit 1
scp -o ControlPath="$CTL" -q "$FACE_SRC" "$TARGET:/tmp/spc_face.py" || exit 1
scp -o ControlPath="$CTL" -q "$INSTALLER" "$TARGET:/tmp/spc_install.sh" || exit 1

echo "==> Installing (sudo password prompt follows)"
# -t gives a real PTY, and stdin is left alone, which is the whole point.
ssh -S "$CTL" -t "$TARGET" 'bash /tmp/spc_install.sh'

echo
echo "==> Verifying from THIS machine (the check that actually matters)"
# Reachable-from-the-Pi and reachable-from-the-laptop are different questions,
# and only the second one makes the spc_* tools work.
if curl -s -m 8 "http://$HOST:$PORT/health" | tee /dev/stderr | grep -q '"ok"'; then
  echo
  echo "spc-agent is up and reachable at http://$HOST:$PORT"
  # No restart needed: the spc tools are registered from config (static), and
  # `online` is probed live on every call. A restart only refreshes the startup
  # log line — the tools work immediately.
  echo "The spc_* tools work now — no mcp-core restart needed (online is probed per call)."
  echo "Restart only if you CHANGED devices[].capabilities in config.json."
else
  echo
  echo "This machine cannot reach $HOST:$PORT. Check, in order:"
  echo "  1. ssh $TARGET 'curl -s localhost:$PORT/health'    (is the service itself up?)"
  echo "  2. ssh $TARGET 'sudo journalctl -u spc-agent -n 30 --no-pager'"
  echo "  3. a firewall on the Pi: ssh $TARGET 'sudo ufw allow $PORT'"
fi
