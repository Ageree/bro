#!/bin/bash
# Sets up a Bro browser host on a stock ubuntu-22.04 VM: run once as root by bro-host-boot (cloud-init, see
# boot.py) from the unpacked bundle in /opt/bro/host. From Cloud.ru, GitHub and PyPI accept connections and
# send nothing and archive.ubuntu.com does not answer (30.09.2026): apt goes to the mirror boot.json names
# (mirror.yandex.ru), Caddy's binary and hostd's wheels come in the bundle (hash-pinned, see boot.py), and the
# sandbox rootfs from its presigned Object Storage URL. The runtime is runc (default) or a pinned runsc.
# Nothing here is per person. The host key is in /etc/bro/host.json (cloud-init, 0600); hostd reads it.
# Stages go to /srv/bro/stage. Caddy and hostd come up right after the packages, so from then on Bro reads
# the stage (and a `failed:<stage>:line N`) on https://<domain>/h/v1/health; the slow rootfs download comes
# after that. Only `ready` means the host takes sandboxes.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BOOT=/etc/bro/boot.json
ROOT=/srv/bro
HOST=/opt/bro/host
mkdir -p "$ROOT/rootfs" "$ROOT/sandboxes" "$ROOT/staging" /etc/bro
chmod 700 "$ROOT/sandboxes" "$ROOT/staging"
stage() {
  echo "$1" > "$ROOT/stage"
  echo "$(cut -d' ' -f1 /proc/uptime) $(date +%s) $1" >> "$ROOT/timeline"
}
retry() { for i in 1 2 3 4 5; do "$@" && return 0; sleep $((i * 5)); done; return 1; }
trap 'stage "failed:$(cat "$ROOT/stage"):line $LINENO"' ERR
field() { python3 -c 'import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value.get(key, "") if isinstance(value, dict) else ""
print(value)' "$BOOT" "$1"; }
stage start

RUNTIME=$(field runtime)
RUNTIME="${RUNTIME:-runc}"
if [ "$RUNTIME" != runc ] && [ "$RUNTIME" != runsc ]; then
  stage "failed:runtime is neither runc nor runsc"
  exit 1
fi
RUNSC_RELEASE=$(field runscRelease)
# A dated release, never the moving `release` suite: snapshots only restore under the runsc that made them.
if [ "$RUNTIME" = runsc ] && ! [[ "$RUNSC_RELEASE" =~ ^[0-9]{8}(\.[0-9]+)?$ ]]; then
  stage "failed:runscRelease is not a dated release"
  exit 1
fi
ROOTFS_VERSION=$(field rootfs.version)
if ! [[ "$ROOTFS_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  stage "failed:bad rootfs version"
  exit 1
fi
if [ ! -x "$HOST/vendor/caddy" ] || ! ls "$HOST"/wheels/*.whl >/dev/null 2>&1; then
  stage "failed:the bundle has no vendored Caddy or wheels (boot.py vendor)"
  exit 1
fi

stage packages
APT_MIRROR=$(field aptMirror)
if [ -n "$APT_MIRROR" ]; then
  # Every Ubuntu archive of the stock image (archive, security, the country mirrors) to the one that answers.
  sed -i -E "s#https?://([a-z]{2}\.)?(archive|security)\.ubuntu\.com/ubuntu/?#${APT_MIRROR%/}/#g" \
    /etc/apt/sources.list
fi
retry apt-get update -q
PACKAGES=(curl ca-certificates nftables zstd iproute2 python3-venv)
if [ "$RUNTIME" = runc ]; then PACKAGES+=(runc); else PACKAGES+=(gnupg); fi
retry apt-get install -yq "${PACKAGES[@]}"
if [ "$RUNTIME" = runsc ]; then
  retry curl -fsSL -o /tmp/gvisor.key https://gvisor.dev/archive.key
  gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg /tmp/gvisor.key
  rm -f /tmp/gvisor.key
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases ${RUNSC_RELEASE} main" \
    > /etc/apt/sources.list.d/gvisor.list
  retry apt-get update -q
  retry apt-get install -yq runsc
  if ! runsc --version | head -1 | grep -q "release-${RUNSC_RELEASE}"; then
    stage "failed:runsc is not release ${RUNSC_RELEASE}"
    exit 1
  fi
  apt-mark hold runsc >/dev/null
else
  runc --version | head -1
  # hostd never runs anything inside a sandbox (`runc exec` is where runc's escapes start), but create and
  # kill still go through runc: not older than the fix of CVE-2024-21626 (the security pocket has newer).
  if ! dpkg --compare-versions "$(dpkg-query -W -f='${Version}' runc)" ge 1.1.12; then
    stage "failed:runc is older than 1.1.12"
    exit 1
  fi
fi
# Ubuntu's nftables.service starts with `flush ruleset`: it stays off, hostd applies its own table.
systemctl disable --now nftables >/dev/null 2>&1 || true

stage venv
python3 -m venv /opt/bro/venv
# Offline and hash-checked: only the wheels the bundle carries, each the one requirements.txt pins.
/opt/bro/venv/bin/pip install -q --no-index --find-links "$HOST/wheels" --require-hashes -r "$HOST/requirements.txt"

stage caddy
install -m 755 "$HOST/vendor/caddy" /usr/bin/caddy
getent group caddy >/dev/null || groupadd --system caddy
id -u caddy >/dev/null 2>&1 || useradd --system --gid caddy --create-home --home-dir /var/lib/caddy \
  --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy
DOMAIN=$(field domain)
# The host's public address: the default domain, and a destination sandboxes are refused. It is Cloud.ru's
# floating IP, not a local one, so the host's own `input` refusal does not see it: a sandbox connecting to
# it timed out (stage 2) instead of being refused, and a provider that loops it back would hand the
# sandbox the host's Caddy.
IP=""
for i in 1 2 3 4 5 6 7 8 9; do
  # Yandex first: from Cloud.ru foreign services may accept and never answer.
  case $((i % 3)) in
    1) URL=https://ipv4-internet.yandex.net/api/v0/ip ;;
    2) URL=https://api.ipify.org ;;
    *) URL=https://ipv4.icanhazip.com ;;
  esac
  IP=$(curl -fsS -m 5 "$URL" | tr -d '"[:space:]' || true)
  [[ "$IP" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && break
  IP=""
  sleep 2
done
if [ -z "$DOMAIN" ]; then
  [[ "$IP" =~ ^[0-9]+(\.[0-9]+){3}$ ]]
  DOMAIN="${IP//./-}.sslip.io"
fi
python3 -c 'import json, sys
settings = {"domain": sys.argv[1], "runtime": sys.argv[2]}
if sys.argv[3]:
    settings["egress_blocked"] = [sys.argv[3] + "/32"]
json.dump(settings, open("/etc/bro/hostd.json", "w"))' "$DOMAIN" "$RUNTIME" "$IP"
# The unit Caddy's own packages ship, for the static binary. The admin API only on a unix socket that root
# (hostd) reaches: on localhost:2019 any local process could load a config that publishes a worker's CDP.
# hostd rewrites the Caddyfile and reloads over this socket.
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
# Ports 80 and 443 only. Not CAP_NET_ADMIN (upstream's unit gives it for QUIC buffers): with it, code run as
# caddy could delete hostd's nftables table, the one barrier between sandboxes and the VPC.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
RuntimeDirectory=caddy
RuntimeDirectoryMode=0750

[Install]
WantedBy=multi-user.target
UNIT
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
# Sandboxes outlive a hostd restart (their own cgroups too): only hostd itself is stopped. No PrivateMounts
# or ProtectSystem either: the overlays hostd mounts for runc sandboxes must be the host's own.
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now bro-hostd

stage network
# Sandboxes reach the internet through the host (network.py); nothing else is forwarded (hostd's table).
# Chrome's own sandbox makes a user namespace in a runc container: Ubuntu 22.04 allows unprivileged ones as
# it is (24.04 would need kernel.apparmor_restrict_unprivileged_userns = 0). Every sandbox's `bro` is the same
# host uid, and per-uid kernel limits are shared: inotify instances (128 by default) would run out for all
# of them with a few Chromes.
printf '%s\n' 'net.ipv4.ip_forward = 1' 'user.max_user_namespaces = 15000' \
  'fs.inotify.max_user_instances = 8192' 'fs.inotify.max_user_watches = 1048576' > /etc/sysctl.d/90-bro-host.conf
sysctl -q -e --system

stage rootfs
ROOTFS="$ROOT/rootfs/$ROOTFS_VERSION"
if [ ! -d "$ROOTFS" ]; then
  ARCHIVE="$ROOT/rootfs/.$ROOTFS_VERSION.tar.zst"
  PARTIAL="$ROOT/rootfs/.$ROOTFS_VERSION.partial"  # hidden: hostd lists only finished versions
  retry curl -fsS -m 900 -o "$ARCHIVE" "$(field rootfs.url)"
  echo "$(field rootfs.sha256)  $ARCHIVE" | sha256sum -c --quiet -
  rm -rf "$PARTIAL"
  mkdir -p "$PARTIAL"
  # The rootfs's own uids and gids, not the host's accounts of the same names.
  tar --numeric-owner -I zstd -xpf "$ARCHIVE" -C "$PARTIAL"
  rm -f "$ARCHIVE"
  mv "$PARTIAL" "$ROOTFS"
fi
stage ready
