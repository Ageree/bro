#!/bin/bash
# Root filesystem of a browser sandbox (docs/browser-pool.md): the browser VM image — Chrome in Xvfb with its
# policies, browser-use, jev, the worker — installed by the same provision.sh (BRO_SANDBOX=1: no Caddy, no
# firewall, no systemd) into a directory, plus bro-sandbox-init as PID 1 and the systemctl shim.
#   build_rootfs.sh [ROOT=/srv/bro/rootfs] [IMAGE_VERSION=sandbox-<date>] [ARCHIVE=path.tar.zst]
# ARCHIVE: the root also as the tar.zst a pool host unpacks (browser-vm/host/provision.sh: the archive's top is
# the root itself, numeric owners), with its sha256 for boot.json.
# Run as root on an Ubuntu 22.04 host with internet (≈ 10 minutes on 2 vCPU). The sandbox mounts ROOT
# read-only with an in-memory overlay; per-sandbox files are bind mounts over the placeholders left here:
# /var/lib/bro/profile (the profile directory on the host), /etc/bro/worker.json, /etc/resolv.conf.
# Nothing per person or secret goes in: like the VM image, keys arrive at run time.
# BRO_PYTHON_SETUP=script [BRO_PYTHON_WHEELS=dir]: where GitHub and PyPI are out of reach (Cloud.ru, 30.09.2026),
# the script makes /opt/bro/bu/.venv in the chroot (wheels in /opt/bro/wheels) instead of provision.sh's uv step.
set -euo pipefail
ROOT="${1:-/srv/bro/rootfs}"
VERSION="${2:-sandbox-$(date +%F)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="$(dirname "$HERE")"
WORKER="$(dirname "$IMAGE")/worker"
export DEBIAN_FRONTEND=noninteractive
command -v debootstrap >/dev/null || apt-get install -yq debootstrap
# The host's own mirror (the cloud's, close and fast), else the main archive.
MIRROR=$(awk '$1 == "deb" && $2 ~ /^http/ {print $2; exit}' /etc/apt/sources.list 2>/dev/null)
MIRROR="${MIRROR:-http://archive.ubuntu.com/ubuntu}"

cleanup() {
  for m in dev/pts dev sys proc; do umount -l "$ROOT/$m" 2>/dev/null || true; done
}
trap cleanup EXIT
rm -rf "$ROOT"
mkdir -p "$(dirname "$ROOT")"
debootstrap --variant=minbase --include=ca-certificates,curl,gnupg jammy "$ROOT" "$MIRROR"
cat > "$ROOT/etc/apt/sources.list" <<LIST
deb $MIRROR jammy main restricted universe
deb $MIRROR jammy-updates main restricted universe
deb $MIRROR jammy-security main restricted universe
LIST
# Only what packages need: recommends pulled a terminal emulator and systemd in with Chrome.
printf 'APT::Install-Recommends "0";\nAPT::Install-Suggests "0";\n' > "$ROOT/etc/apt/apt.conf.d/90bro-no-recommends"
# A chroot must not start daemons that packages ship (there is no init here anyway).
printf '#!/bin/sh\nexit 101\n' > "$ROOT/usr/sbin/policy-rc.d"
chmod 755 "$ROOT/usr/sbin/policy-rc.d"
# systemd-resolved's stub (127.0.0.53) is not reachable from a sandbox's own network: the real upstreams.
cp -L /run/systemd/resolve/resolv.conf "$ROOT/etc/resolv.conf" 2>/dev/null || cp -L /etc/resolv.conf "$ROOT/etc/resolv.conf"
mount -t proc proc "$ROOT/proc"
mount -t sysfs sys "$ROOT/sys"
mount --bind /dev "$ROOT/dev"
mount --bind /dev/pts "$ROOT/dev/pts"

mkdir -p "$ROOT/opt/bro/worker" "$ROOT/opt/bro/image"
install -m 644 "$WORKER/worker.py" "$WORKER/jev_segment.py" "$ROOT/opt/bro/worker/"
install -m 755 "$IMAGE/provision.sh" "$ROOT/opt/bro/image/provision.sh"
PREINSTALLED=0
if [ -n "${BRO_PYTHON_SETUP:-}" ]; then
  install -m 755 "$BRO_PYTHON_SETUP" "$ROOT/opt/bro/image/python-setup.sh"
  [ -n "${BRO_PYTHON_WHEELS:-}" ] && cp -r "$BRO_PYTHON_WHEELS" "$ROOT/opt/bro/wheels"
  chroot "$ROOT" env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
    bash /opt/bro/image/python-setup.sh > "$(dirname "$ROOT")/python-setup.log" 2>&1
  rm -rf "$ROOT/opt/bro/wheels"
  PREINSTALLED=1
fi
chroot "$ROOT" env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
  BRO_SANDBOX=1 BRO_IMAGE_SEAL=0 BRO_PYTHON_PREINSTALLED="$PREINSTALLED" IMAGE_VERSION="$VERSION" \
  bash /opt/bro/image/provision.sh > "$(dirname "$ROOT")/provision.log" 2>&1

install -m 755 "$HERE/bro-sandbox-init" "$ROOT/usr/local/sbin/bro-sandbox-init"
if [ -e "$ROOT/usr/bin/systemctl" ] && ! chroot "$ROOT" dpkg-divert --list /usr/bin/systemctl | grep -q .; then
  chroot "$ROOT" dpkg-divert --quiet --local --rename --add /usr/bin/systemctl
fi
install -m 755 "$HERE/systemctl" "$ROOT/usr/bin/systemctl"

# Like the VM image's sealing: nothing of the build stays in the root.
chroot "$ROOT" apt-get clean
rm -rf "$ROOT"/var/lib/apt/lists/* "$ROOT"/tmp/* "$ROOT"/var/tmp/* "$ROOT/usr/sbin/policy-rc.d" \
  "$ROOT"/var/lib/bro/profile/* "$ROOT"/var/lib/bro/runs/* "$ROOT"/var/lib/bro/sessions/* \
  "$ROOT"/var/lib/bro/uploads/* "$ROOT/var/lib/bro/status" "$ROOT/var/lib/bro/timeline" \
  "$ROOT/var/lib/bro/stage" "$ROOT/opt/bro/image"
: > "$ROOT/etc/machine-id"
# Mount points of the per-sandbox bind mounts.
: > "$ROOT/etc/resolv.conf"
mkdir -p "$ROOT/etc/bro" "$ROOT/var/lib/bro/profile"
: > "$ROOT/etc/bro/worker.json"
chroot "$ROOT" chown bro:bro /var/lib/bro/profile
echo "rootfs $ROOT: $(du -sh --exclude=proc --exclude=sys --exclude=dev "$ROOT" | cut -f1), bro uid $(chroot "$ROOT" id -u bro)"
if [ -n "${3:-}" ]; then
  tar -C "$ROOT" --numeric-owner -I "zstd -3 -T0" -cpf "$3" .
  echo "archive $3: $(du -h "$3" | cut -f1), sha256 $(sha256sum "$3" | cut -d' ' -f1)"
fi
