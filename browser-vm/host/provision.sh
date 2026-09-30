#!/bin/bash
# Sets up a Bro browser host on a stock ubuntu-22.04 VM: run once as root by bro-host-boot (cloud-init, see
# boot.py) from the unpacked bundle in /opt/bro/host. Installs runsc of the release boot.json pins, Caddy,
# nftables, zstd, the hostd venv and unit, and the sandbox rootfs from its presigned URL.
# Nothing here is per person. The host key is in /etc/bro/host.json (cloud-init, 0600); hostd reads it.
# Stages go to /srv/bro/stage: hostd's /v1/health shows it once Caddy is up.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BOOT=/etc/bro/boot.json
ROOT=/srv/bro
mkdir -p "$ROOT/rootfs" "$ROOT/sandboxes" /etc/bro
chmod 700 "$ROOT/sandboxes"
stage() {
  echo "$1" > "$ROOT/stage"
  echo "$(cut -d' ' -f1 /proc/uptime) $(date +%s) $1" >> "$ROOT/timeline"
}
retry() { for i in 1 2 3 4 5; do "$@" && return 0; sleep $((i * 5)); done; return 1; }
trap 'stage "failed:$(cat "$ROOT/stage"):line $LINENO"' ERR
field() { python3 -c 'import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value[key]
print(value)' "$BOOT" "$1"; }
stage start

RUNSC_RELEASE=$(field runscRelease)
# A dated release, never the moving `release` suite: snapshots only restore under the runsc that made them.
if ! [[ "$RUNSC_RELEASE" =~ ^[0-9]{8}(\.[0-9]+)?$ ]]; then
  stage "failed:runscRelease is not a dated release"
  exit 1
fi
ROOTFS_VERSION=$(field rootfs.version)
if ! [[ "$ROOTFS_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  stage "failed:bad rootfs version"
  exit 1
fi

stage packages
retry apt-get update -q
retry apt-get install -yq curl gnupg ca-certificates debian-keyring debian-archive-keyring apt-transport-https \
  nftables zstd iproute2 python3-venv
retry curl -fsSL -o /tmp/gvisor.key https://gvisor.dev/archive.key
gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg /tmp/gvisor.key
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases ${RUNSC_RELEASE} main" \
  > /etc/apt/sources.list.d/gvisor.list
retry curl -1sLf -o /tmp/caddy.gpg.key https://dl.cloudsmith.io/public/caddy/stable/gpg.key
gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /tmp/caddy.gpg.key
retry curl -1sLf -o /etc/apt/sources.list.d/caddy-stable.list https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt
rm -f /tmp/gvisor.key /tmp/caddy.gpg.key
retry apt-get update -q
retry apt-get install -yq runsc caddy
if ! runsc --version | head -1 | grep -q "release-${RUNSC_RELEASE}"; then
  stage "failed:runsc is not release ${RUNSC_RELEASE}"
  exit 1
fi
apt-mark hold runsc >/dev/null
# Ubuntu's nftables.service starts with `flush ruleset`: it stays off, hostd applies its own table.
systemctl disable --now nftables >/dev/null 2>&1 || true

stage venv
python3 -m venv /opt/bro/venv
retry /opt/bro/venv/bin/pip install -q "aiohttp==3.12.15" "cryptography==45.0.7"

stage network
# Sandboxes reach the internet through the host (network.py); nothing else is forwarded (hostd's table).
echo "net.ipv4.ip_forward = 1" > /etc/sysctl.d/90-bro-host.conf
sysctl -q --system

stage rootfs
ROOTFS="$ROOT/rootfs/$ROOTFS_VERSION"
if [ ! -d "$ROOTFS" ]; then
  ARCHIVE="$ROOT/rootfs/.$ROOTFS_VERSION.tar.zst"
  retry curl -fsS -m 900 -o "$ARCHIVE" "$(field rootfs.url)"
  echo "$(field rootfs.sha256)  $ARCHIVE" | sha256sum -c --quiet -
  rm -rf "$ROOTFS.partial"
  mkdir -p "$ROOTFS.partial"
  tar -I zstd -xf "$ARCHIVE" -C "$ROOTFS.partial"
  rm -f "$ARCHIVE"
  mv "$ROOTFS.partial" "$ROOTFS"
fi

stage caddy
DOMAIN=$(field domain)
if [ -z "$DOMAIN" ]; then
  IP=""
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [ $((i % 2)) = 1 ] && URL=https://api.ipify.org || URL=https://ipv4.icanhazip.com
    IP=$(curl -fsS -m 5 "$URL" || true)
    [[ "$IP" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && break
    sleep 2
  done
  [[ "$IP" =~ ^[0-9]+(\.[0-9]+){3}$ ]]
  DOMAIN="${IP//./-}.sslip.io"
fi
python3 -c 'import json, sys; json.dump({"domain": sys.argv[1]}, open("/etc/bro/hostd.json", "w"))' "$DOMAIN"
# The admin API only on a unix socket that root (hostd) reaches: on localhost:2019 any local process could
# load a config that publishes a worker's CDP. hostd rewrites the Caddyfile and reloads over this socket.
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nRuntimeDirectory=caddy\nRuntimeDirectoryMode=0750\n' > /etc/systemd/system/caddy.service.d/bro.conf
printf '{\n\tadmin unix//run/caddy/admin.sock\n}\n%s {\n\thandle_path /h/* {\n\t\treverse_proxy 127.0.0.1:8090\n\t}\n\thandle {\n\t\trespond 404\n\t}\n}\n' \
  "$DOMAIN" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable caddy >/dev/null
systemctl restart caddy

stage hostd
cat > /etc/systemd/system/bro-hostd.service <<'UNIT'
[Unit]
Description=Bro browser host daemon
After=network-online.target caddy.service
Wants=network-online.target

[Service]
ExecStart=/opt/bro/venv/bin/python /opt/bro/host/hostd.py
Environment=PYTHONUNBUFFERED=1
Restart=always
RestartSec=2
# Sandboxes outlive a hostd restart (their own cgroups too): only hostd itself is stopped.
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now bro-hostd
stage ready
