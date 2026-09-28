#!/bin/bash
# Builds the Bro browser image on a fresh ubuntu-22.04 VM (run once by cloud-init as root, then the VM
# powers itself off and `build.py` turns its disk into an image). Nothing here is per person: the
# environment id and the worker key arrive later in each VM's own cloud-init, the proxy login and the
# model key over the worker's HTTPS endpoint, into memory.
# Stages go to /var/lib/bro/stage, so the builder can follow the install over /v1/health.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
IMAGE_VERSION="${IMAGE_VERSION:-unversioned}"
mkdir -p /var/lib/bro /opt/bro/worker /etc/bro
mkdir -p /var/lib/bro/status
stage() {
  echo "$1" > /var/lib/bro/stage
  echo "$(cut -d' ' -f1 /proc/uptime) $(date +%s) $1" >> /var/lib/bro/timeline
  cp /var/lib/bro/stage /var/lib/bro/timeline /var/lib/bro/status/ 2>/dev/null || true
}
retry() { for i in 1 2 3 4 5; do "$@" && return 0; sleep $((i * 5)); done; return 1; }
# A failed build stays up with its log readable at https://<ip>.sslip.io/log (the builder has no secrets).
trap 'stage "failed:$(cat /var/lib/bro/stage):line $LINENO"; tail -c 20000 /var/log/bro-provision.log > /var/lib/bro/status/log' ERR
stage start

id bro >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/bro --shell /bin/bash bro
mkdir -p /var/lib/bro/profile /var/lib/bro/runs /var/lib/bro/sessions /var/lib/bro/uploads
chown -R bro:bro /var/lib/bro /opt/bro/worker

# Caddy: TLS for <ip>.sslip.io in front of the worker. The address is only known on the VM, and a VM
# recreated from a disk comes up on a new one, so a boot unit writes the Caddyfile every start.
retry apt-get update -q
retry apt-get install -yq debian-keyring debian-archive-keyring apt-transport-https curl gnupg ca-certificates \
  iptables jq
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
retry apt-get update -q
retry apt-get install -yq caddy
cat > /usr/local/sbin/bro-boot <<'SCRIPT'
#!/bin/bash
# Every boot: the VM's public address → the Caddyfile for <ip>.sslip.io (Let's Encrypt, http-01).
set -u
IP=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  IP=$(curl -fsS -m 5 https://api.ipify.org || true)
  [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break
  sleep 2
done
[ -n "$IP" ] && echo "$IP" > /var/lib/bro/public_ip
printf '%s.sslip.io {\n\treverse_proxy 127.0.0.1:8080\n}\n' "${IP//./-}" > /etc/caddy/Caddyfile
SCRIPT
chmod 755 /usr/local/sbin/bro-boot
# While the image builds, a read-only page of the stage stands where the worker will: build.py follows it.
/usr/local/sbin/bro-boot
systemctl restart caddy
(cd /var/lib/bro/status && nohup python3 -m http.server 8080 --bind 127.0.0.1 >/dev/null 2>&1 &)
cat > /etc/systemd/system/bro-boot.service <<'UNIT'
[Unit]
Description=Bro: Caddyfile for this boot's public address
After=network-online.target
Wants=network-online.target
Before=caddy.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/bro-boot
[Install]
WantedBy=multi-user.target
UNIT
stage caddy

# Chrome for the user `bro` may reach only loopback (the worker's proxy forwarder, CDP) and public
# addresses: never the cloud metadata service (which holds this VM's user data) or private networks.
cat > /usr/local/sbin/bro-firewall <<'SCRIPT'
#!/bin/bash
set -e
UID_BRO=$(id -u bro)
iptables -N BRO_EGRESS 2>/dev/null || iptables -F BRO_EGRESS
iptables -C OUTPUT -m owner --uid-owner "$UID_BRO" -j BRO_EGRESS 2>/dev/null || \
  iptables -I OUTPUT -m owner --uid-owner "$UID_BRO" -j BRO_EGRESS
iptables -A BRO_EGRESS -o lo -j RETURN
for net in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
  iptables -A BRO_EGRESS -d "$net" -j REJECT
done
SCRIPT
chmod 755 /usr/local/sbin/bro-firewall
cat > /etc/systemd/system/bro-firewall.service <<'UNIT'
[Unit]
Description=Bro: egress limits for the browser user
Before=bro-chrome.service bro-worker.service
After=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/bro-firewall
[Install]
WantedBy=multi-user.target
UNIT

# Headful Chrome on Xvfb (the pilot found headless worse on Avito) with a persistent profile; CDP only on
# loopback; every request through the worker's forwarder from the profile's very first launch.
retry curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
retry apt-get install -yq /tmp/chrome.deb xvfb fonts-noto-color-emoji fonts-liberation fonts-dejavu locales
locale-gen ru_RU.UTF-8 >/dev/null
rm -f /tmp/chrome.deb
# Chrome 154 ignores --force-webrtc-ip-handling-policy: without the policy WebRTC hands sites the VM's
# own address past the proxy. The profile keeps no passwords or cards of its own either.
mkdir -p /etc/opt/chrome/policies/managed
cat > /etc/opt/chrome/policies/managed/bro.json <<'JSON'
{
  "WebRtcIPHandling": "disable_non_proxied_udp",
  "PasswordManagerEnabled": false,
  "AutofillCreditCardEnabled": false,
  "BackgroundModeEnabled": false,
  "DefaultBrowserSettingEnabled": false,
  "MetricsReportingEnabled": false
}
JSON
cat > /etc/systemd/system/bro-xvfb.service <<'UNIT'
[Unit]
Description=Xvfb display :99 for the browser
[Service]
User=bro
ExecStart=/usr/bin/Xvfb :99 -screen 0 1366x900x24 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/bro-chrome.service <<'UNIT'
[Unit]
Description=Bro browser: Chrome, persistent profile, CDP on 127.0.0.1:9222, traffic via 127.0.0.1:3128
Requires=bro-xvfb.service
After=bro-xvfb.service bro-firewall.service network-online.target
[Service]
User=bro
# A Russian person's browser: Russian interface and Accept-Language, Moscow time. The pilot's Chrome
# answered sites in English with a UTC clock, which is neither the person nor what Russian sites expect.
Environment=DISPLAY=:99 TZ=Europe/Moscow LANG=ru_RU.UTF-8 LANGUAGE=ru_RU:ru
# A profile restored from a backup or moved to a re-created VM still carries the old host's lock, and
# Chrome refuses it as "in use by another computer": only this unit ever runs Chrome on this profile.
ExecStartPre=/bin/sh -c 'rm -f /var/lib/bro/profile/SingletonLock /var/lib/bro/profile/SingletonSocket /var/lib/bro/profile/SingletonCookie'
ExecStart=/usr/bin/google-chrome --user-data-dir=/var/lib/bro/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --proxy-server=http://127.0.0.1:3128 --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic --window-size=1366,900 --lang=ru-RU --accept-lang=ru-RU,ru,en-US,en about:blank
# SIGTERM lets Chrome write cookies and local storage to the profile before the VM powers off.
KillMode=mixed
TimeoutStopSec=30
Restart=always
RestartSec=1
[Install]
WantedBy=multi-user.target
UNIT
echo 'bro ALL=(root) NOPASSWD: /usr/bin/systemctl start bro-chrome, /usr/bin/systemctl stop bro-chrome, /usr/bin/systemctl restart bro-chrome' \
  > /etc/sudoers.d/bro-chrome
chmod 440 /etc/sudoers.d/bro-chrome
visudo -cf /etc/sudoers.d/bro-chrome
stage chrome

# Python: browser-use 0.13.10 (the agent), aiohttp (the worker); jev-ultrafast at the pinned commit for
# the jev-then-agent engine.
export UV_PYTHON_INSTALL_DIR=/opt/bro/python UV_CACHE_DIR=/opt/bro/uv-cache
retry sh -c 'curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh'
retry uv venv -q --python 3.12 /opt/bro/bu/.venv
retry uv pip install -q --python /opt/bro/bu/.venv/bin/python browser-use==0.13.10 aiohttp==3.14.3
retry apt-get install -yq git
retry git clone -q https://github.com/browser-use/jev-ultrafast.git /opt/bro/jev-ultrafast
git -C /opt/bro/jev-ultrafast checkout -q 1231850
(cd /opt/bro/jev-ultrafast && retry uv sync -q)
rm -rf /opt/bro/uv-cache
stage python

cat > /etc/systemd/system/bro-worker.service <<'UNIT'
[Unit]
Description=Bro browser worker (127.0.0.1:8080 behind Caddy; forwarder 127.0.0.1:3128)
After=network-online.target bro-firewall.service
Wants=network-online.target
[Service]
User=bro
Environment=ANONYMIZED_TELEMETRY=false BROWSER_USE_CLOUD_SYNC=false BH_UPDATE_CHECK=0
ExecStart=/opt/bro/bu/.venv/bin/python /opt/bro/worker/worker.py
Restart=always
RestartSec=1
TimeoutStopSec=10
[Install]
WantedBy=multi-user.target
UNIT
chown -R bro:bro /opt/bro
systemctl daemon-reload
systemctl enable bro-boot bro-firewall bro-xvfb bro-chrome bro-worker caddy
echo "$IMAGE_VERSION" > /etc/bro/image
stage installed

# The builder keeps the endpoint up for the first boot only (to report the stage); the image itself
# must carry no profile, certificate, key, log or machine identity of the builder VM.
if [ "${BRO_IMAGE_SEAL:-1}" = "1" ]; then
  stage sealing
  pkill -f "http.server 8080" || true
  systemctl stop bro-worker bro-chrome bro-xvfb caddy || true
  rm -rf /var/lib/bro/profile/* /var/lib/bro/runs/* /var/lib/bro/sessions/* /var/lib/bro/uploads/* \
    /var/lib/bro/generation /var/lib/bro/public_ip /var/lib/bro/status /var/lib/caddy/.local/share/caddy \
    /etc/bro/worker.json /var/log/bro-provision.log
  cloud-init clean --logs --seed || true
  truncate -s 0 /etc/machine-id
  rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*
  journalctl --rotate && journalctl --vacuum-time=1s || true
  echo sealed > /var/lib/bro/stage
  sync
  poweroff
fi
