#!/bin/bash
# Sets up a Bro browser host on a stock ubuntu-22.04 VM: run as root by bro-host-boot (cloud-init, see
# boot.py) from the unpacked bundle in /opt/bro/host. From Cloud.ru, GitHub and PyPI accept connections and
# send nothing and archive.ubuntu.com does not answer (30.09.2026): apt goes to the mirror boot.json names
# (mirror.yandex.ru), Caddy's binary and hostd's wheels come in the bundle (hash-pinned, see boot.py), and the
# sandbox rootfs from its presigned Object Storage URL. The runtime is runc (default), a pinned runsc, or
# firecracker (microVMs: the binaries and the guest kernel come in the bundle, vendor/firecracker/).
# Nothing here is per person. The host key is in /etc/bro/host.json (cloud-init, 0600); hostd reads it.
# Stages go to /srv/bro/stage. Caddy and hostd come up right after the packages, so from then on Bro reads
# the stage (and a `failed:<stage>:line N`) on https://<domain>/h/v1/health; the slow rootfs download comes
# after that. Only `ready` means the host takes sandboxes. Until then bro-host-boot runs this at every boot:
# a reboot (a hard reset on Cloud.ru) may cut a run short anywhere, so every step is safe to repeat, once
# bro-host-boot has thrown away the apt lists and cache and the venv a torn run may have left.
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
if [ "$RUNTIME" != runc ] && [ "$RUNTIME" != runsc ] && [ "$RUNTIME" != firecracker ]; then
  stage "failed:runtime is neither runc, runsc nor firecracker"
  exit 1
fi
. "$HOST/units.sh"
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
echo "kernel $(uname -r), runtime $RUNTIME"
APT_MIRROR=$(field aptMirror)
if [ -n "$APT_MIRROR" ]; then
  # Every Ubuntu archive of the stock image (archive, security, the country mirrors) to the one that answers.
  sed -i -E "s#https?://([a-z]{2}\.)?(archive|security)\.ubuntu\.com/ubuntu/?#${APT_MIRROR%/}/#g" \
    /etc/apt/sources.list
fi
retry apt-get update -q
PACKAGES=(curl ca-certificates nftables zstd iproute2 python3-venv)
case "$RUNTIME" in
  runc) PACKAGES+=(runc) ;;
  runsc) PACKAGES+=(gnupg) ;;
  # mkfs.ext4 -d needs e2fsprogs 1.43 (22.04 has 1.46); debugfs injects the guest init into the rootfs image.
  firecracker) PACKAGES+=(e2fsprogs) ;;
esac
retry apt-get install -yq "${PACKAGES[@]}"
if [ "$RUNTIME" = runsc ]; then
  retry curl -fsSL -o /tmp/gvisor.key https://gvisor.dev/archive.key
  gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg /tmp/gvisor.key
  rm -f /tmp/gvisor.key
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases ${RUNSC_RELEASE} main" \
    > /etc/apt/sources.list.d/gvisor.list
  retry apt-get update -q
  retry apt-get install -yq runsc
  # `sed -n 1p`, not `head -1`: head leaves before the rest of the output, and a Go binary writes it line by
  # line, so it may die of SIGPIPE, which pipefail turns into a failure (runc on a host, 02.10.2026).
  if ! runsc --version | sed -n 1p | grep -q "release-${RUNSC_RELEASE}"; then
    stage "failed:runsc is not release ${RUNSC_RELEASE}"
    exit 1
  fi
  apt-mark hold runsc >/dev/null
elif [ "$RUNTIME" = firecracker ]; then
  # Firecracker needs KVM (a bare-metal host or nested virtualization), and says so here rather than at the
  # first sandbox. Ubuntu 22.04's 5.15 kernel is not on Firecracker's tested host list: the first start on a
  # new host is the test.
  [ -c /dev/kvm ] || modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
  if [ ! -c /dev/kvm ]; then
    stage "failed:/dev/kvm is missing (kernel $(uname -r)): firecracker needs hardware virtualization"
    exit 1
  fi
  for FILE in firecracker jailer vmlinux; do
    if [ ! -f "$HOST/vendor/firecracker/$FILE" ]; then
      stage "failed:the bundle has no vendor/firecracker/$FILE (boot.py vendor --firecracker-url …)"
      exit 1
    fi
  done
  install -d -m 755 /opt/bro/firecracker
  install -m 755 "$HOST/vendor/firecracker/firecracker" "$HOST/vendor/firecracker/jailer" /opt/bro/firecracker/
  install -m 644 "$HOST/vendor/firecracker/vmlinux" /opt/bro/firecracker/vmlinux
  /opt/bro/firecracker/firecracker --version | sed -n 1p
  /opt/bro/firecracker/jailer --version | sed -n 1p
  echo "firecracker on kernel $(uname -r), $(stat -c %s /opt/bro/firecracker/vmlinux) byte guest kernel"
else
  runc --version | sed -n 1p
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
# update.sh (hostd's self-update) installs the wheels again only when this changes.
sha256sum "$HOST/requirements.txt" | cut -d' ' -f1 > /opt/bro/venv/.requirements.sha256

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
# A server shared with the code sandbox host: browser sandboxes take only their share of its memory.
if sys.argv[4] not in ("", "0"):
    settings["memory_limit_mb"] = int(sys.argv[4])
json.dump(settings, open("/etc/bro/hostd.json", "w"))' "$DOMAIN" "$RUNTIME" "$IP" "$(field memoryLimitMb)"
# The unit Caddy's own packages ship, for the static binary. The admin API only on a unix socket that root
# (hostd) reaches: on localhost:2019 any local process could load a config that publishes a worker's CDP.
# hostd rewrites the Caddyfile and reloads over this socket.
write_caddy_unit || true
# Other services of the same server add their sites as files in sites/ (caddy.py).
mkdir -p /etc/caddy/sites
printf '{\n\tadmin unix//run/caddy/admin.sock\n}\nimport sites/*\n%s {\n\thandle_path /h/* {\n\t\treverse_proxy 127.0.0.1:8090\n\t}\n\thandle {\n\t\trespond 404\n\t}\n}\n' \
  "$DOMAIN" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable caddy >/dev/null
systemctl restart caddy

stage hostd
write_hostd_unit || true
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
  # On disk before it takes its name (and with it everything set up so far): a hard reset right after must
  # not leave a torn root under it, which nothing would set up again. The name is on disk before `ready` too:
  # a ready host whose root's rename was lost would never set it up again either.
  sync
  mv "$PARTIAL" "$ROOTFS"
  sync
fi
if [ "$RUNTIME" = firecracker ]; then
  # The rootfs as the one read-only ext4 image every VM boots from (a no-op when it is current; hostd builds
  # it again by itself when the guest scripts in it change).
  stage image
  /opt/bro/venv/bin/python "$HOST/firecracker.py" build-image --rootfs "$ROOTFS" --out "$ROOT/rootfs/$ROOTFS_VERSION.ext4"
  sync
fi
stage ready
