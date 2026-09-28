#!/bin/bash
# First-boot provisioning of the pilot VM (run by cloud-init as root).
# Stages go to /var/lib/bro/stage and /var/lib/bro/timeline (uptime seconds), so /health shows progress.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
mkdir -p /var/lib/bro /opt/bro /etc/bro
stage() { echo "$1" > /var/lib/bro/stage; echo "$(cut -d' ' -f1 /proc/uptime) $(date +%s) $1" >> /var/lib/bro/timeline; }
retry() { for i in 1 2 3 4 5; do "$@" && return 0; sleep $((i * 5)); done; return 1; }
stage start

id bro >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/bro --shell /bin/bash bro
mkdir -p /var/lib/bro/profile /var/lib/bro/results /opt/bro/runners
chown -R bro:bro /var/lib/bro /opt/bro

# 1. Control endpoint first, so the rest of provisioning is observable over HTTPS.
cat > /etc/systemd/system/bro-control.service <<'UNIT'
[Unit]
Description=Bro pilot control endpoint (127.0.0.1:8080)
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 /opt/bro/control.py
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now bro-control
stage control

retry apt-get update -q
retry apt-get install -yq debian-keyring debian-archive-keyring apt-transport-https curl gnupg ca-certificates
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
retry apt-get update -q
retry apt-get install -yq caddy
IP=$(retry curl -fsS -m 10 https://api.ipify.org)
echo "$IP" > /var/lib/bro/public_ip
cat > /etc/caddy/Caddyfile <<CADDY
${IP//./-}.sslip.io {
	reverse_proxy 127.0.0.1:8080
}
CADDY
systemctl restart caddy
stage caddy

# 2. Headful Chrome on Xvfb with a persistent profile; CDP only on loopback.
retry curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
retry apt-get install -yq /tmp/chrome.deb xvfb git fonts-noto-color-emoji fonts-liberation jq
rm -f /tmp/chrome.deb
cat > /etc/systemd/system/bro-xvfb.service <<'UNIT'
[Unit]
Description=Xvfb display :99 for the pilot Chrome
[Service]
User=bro
ExecStart=/usr/bin/Xvfb :99 -screen 0 1366x900x24 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/bro-chrome.service <<'UNIT'
[Unit]
Description=Pilot Chrome, persistent profile, CDP on 127.0.0.1:9222
Requires=bro-xvfb.service
After=bro-xvfb.service network-online.target
[Service]
User=bro
Environment=DISPLAY=:99
ExecStart=/usr/bin/google-chrome --user-data-dir=/var/lib/bro/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic --window-size=1366,900 about:blank
# SIGTERM lets Chrome flush cookies and localStorage to the profile before power-off.
KillMode=mixed
TimeoutStopSec=30
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now bro-xvfb bro-chrome
stage chrome

# 3. uv, jev-ultrafast at the pinned commit, browser-use 0.13.10 in its own venv.
export UV_PYTHON_INSTALL_DIR=/opt/bro/python UV_CACHE_DIR=/opt/bro/uv-cache
retry sh -c 'curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh'
retry git clone -q https://github.com/browser-use/jev-ultrafast.git /opt/bro/jev-ultrafast
git -C /opt/bro/jev-ultrafast checkout -q 1231850
(cd /opt/bro/jev-ultrafast && retry uv sync -q)
stage jev
retry uv venv -q --python 3.12 /opt/bro/bu/.venv
retry uv pip install -q --python /opt/bro/bu/.venv/bin/python browser-use==0.13.10
chown -R bro:bro /opt/bro
stage ready
