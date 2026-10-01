#!/bin/bash
# Builds the root filesystem of Bro's code sandboxes (sandbox/README.md): Ubuntu 22.04 with Python 3.10 and
# the office libraries in a venv at /opt/py, LibreOffice, poppler, fonts and the `tools` CLI. The result,
# rootfs-<version>.tar.zst, is unpacked on a code host into /srv/sandboxd/rootfs/<version>
# (sandbox/host/provision.sh) and shared read-only by every sandbox there.
#
#   build_rootfs.sh build TOOLS_BINARY [OUT_DIR]   rootfs-<version>.tar.zst, its .sha256 and a manifest
#                                                  (default OUT_DIR: sandbox/image/out)
#   build_rootfs.sh lock                           resolve requirements.in into requirements.txt (sha256 pins)
#
# Runs as root on x86_64 Linux (a cloud session does): it unpacks ubuntu-base (sha256 pinned below and
# checked against Ubuntu's SHA256SUMS), chroots into it in a mount namespace of its own and installs there.
# apt goes to $APT_MIRROR over HTTPS (mirror.yandex.ru: archive.ubuntu.com does not answer Cloud.ru), through
# $HTTPS_PROXY when it is set, trusting $PROXY_CA (default $SSL_CERT_FILE) for it; pip installs only the
# wheels requirements.txt pins by sha256. Nothing of the proxy stays in the image.
#
# The version is the UTC date and the first 8 hex of the SHA-256 of the inputs (this script, verify.py, the
# requirements, the tools binary). apt packages are whatever the mirror has that day: two builds of one day
# from the same inputs share a version, so upload a version once.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BASE_URL=https://cdimage.ubuntu.com/ubuntu-base/releases/22.04/release
BASE_NAME=ubuntu-base-22.04.5-base-amd64.tar.gz
BASE_SHA256=242cd8898b33ea806ef5f13b1076ed7c76f9f989d18384452f7166692438ff1a
APT_MIRROR=${APT_MIRROR:-https://mirror.yandex.ru/ubuntu}
PROXY_CA=${PROXY_CA:-${SSL_CERT_FILE:-}}
CACHE=${CACHE:-$HOME/.cache/bro-sandbox-image}
ZSTD_LEVEL=${ZSTD_LEVEL:-15}
# What the sandbox has besides Python: LibreOffice for office formats and PDF export, poppler for PDFs,
# fonts with Cyrillic (DejaVu, Liberation — metric twins of Arial/Times/Courier — and Noto), and the small
# tools a model reaches for. curl stays for a clear "no network" answer: sandboxes run with --network=none.
PACKAGES=(
  bash coreutils ca-certificates tzdata procps curl file jq zip unzip xz-utils
  python3 python3-venv
  fonts-dejavu-core fonts-liberation fonts-noto-core fontconfig
  poppler-utils imagemagick
  libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress
)
SANDBOX_UID=1000

die() { echo "build_rootfs: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (chroot and mounts)"
[ "$(uname -m)" = x86_64 ] || die "builds the amd64 rootfs on x86_64 only"

# Mounts made for the chroot vanish with this namespace, whatever way the script ends.
if [ -z "${BRO_ROOTFS_NS:-}" ]; then
  exec env BRO_ROOTFS_NS=1 unshare --mount --propagation private "$0" "$@"
fi

fetch_base() {
  mkdir -p "$CACHE"
  local tarball="$CACHE/$BASE_NAME"
  if [ ! -f "$tarball" ] || ! echo "$BASE_SHA256  $tarball" | sha256sum -c --quiet - 2>/dev/null; then
    curl -fsSL --retry 5 -o "$tarball.part" "$BASE_URL/$BASE_NAME"
    mv "$tarball.part" "$tarball"
  fi
  # The pin and Ubuntu's own list must agree, and the file must be what both say.
  curl -fsSL --retry 5 "$BASE_URL/SHA256SUMS" | grep -qx "$BASE_SHA256 \*$BASE_NAME" \
    || die "$BASE_NAME is not listed with the pinned sha256 in Ubuntu's SHA256SUMS"
  echo "$BASE_SHA256  $tarball" | sha256sum -c --quiet - || die "$BASE_NAME does not match its pin"
  BASE_TARBALL=$tarball
}

mount_chroot() {
  mount -t proc proc "$ROOT/proc"
  mount -t sysfs -o ro sysfs "$ROOT/sys"
  # A /dev of its own: the build never needs the machine's devices.
  mount -t tmpfs -o mode=755,nosuid tmpfs "$ROOT/dev"
  for node in "null c 1 3" "zero c 1 5" "full c 1 7" "random c 1 8" "urandom c 1 9" "tty c 5 0"; do
    set -- $node
    mknod -m 666 "$ROOT/dev/$1" "$2" "$3" "$4"
  done
  mkdir -p "$ROOT/dev/pts" "$ROOT/dev/shm"
  mount -t devpts -o newinstance,ptmxmode=0666 devpts "$ROOT/dev/pts"
  ln -s pts/ptmx "$ROOT/dev/ptmx"
  mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$ROOT/dev/shm"
  ln -s /proc/self/fd "$ROOT/dev/fd"
  # Name resolution for the build only (pip may go direct); the image ships the empty file it came with.
  cp /etc/resolv.conf "$ROOT/etc/resolv.conf"
}

umount_chroot() {
  for target in dev/shm dev/pts dev sys proc; do
    mountpoint -q "$ROOT/$target" && umount "$ROOT/$target"
  done
  : > "$ROOT/etc/resolv.conf"
}

# A command in the chroot with a clean environment (and the proxy, when there is one).
in_chroot() {
  local env=(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8
             DEBIAN_FRONTEND=noninteractive)
  if [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]; then
    env+=("HTTPS_PROXY=${HTTPS_PROXY:-${https_proxy:-}}" "NO_PROXY=${NO_PROXY:-${no_proxy:-}}")
  fi
  [ -f "$ROOT/tmp/build-ca.crt" ] && env+=(PIP_CERT=/tmp/build-ca.crt)
  chroot "$ROOT" /usr/bin/env -i "${env[@]}" "$@"
}

as_sandbox() {
  chroot --userspec=$SANDBOX_UID:$SANDBOX_UID "$ROOT" /usr/bin/env -i HOME=/home/sandbox USER=sandbox \
    LOGNAME=sandbox SHELL=/bin/bash LANG=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /bin/bash -lc "$1"
}

unpack_base() {
  rm -rf "$ROOT"
  mkdir -p "$ROOT"
  tar --numeric-owner -xpzf "$BASE_TARBALL" -C "$ROOT"
}

setup_apt() {
  cat > "$ROOT/etc/apt/sources.list" <<EOF
deb $APT_MIRROR jammy main restricted universe
deb $APT_MIRROR jammy-updates main restricted universe
deb $APT_MIRROR jammy-security main restricted universe
EOF
  {
    echo 'Acquire::Retries "5";'
    echo 'APT::Install-Recommends "false";'
    echo 'APT::Install-Suggests "false";'
    if [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]; then
      echo "Acquire::https::Proxy \"${HTTPS_PROXY:-${https_proxy:-}}\";"
    fi
    if [ -n "$PROXY_CA" ]; then
      echo 'Acquire::https::CaInfo "/tmp/build-ca.crt";'
    fi
  } > "$ROOT/etc/apt/apt.conf.d/99bro-build"
  if [ -n "$PROXY_CA" ]; then
    install -m 644 "$PROXY_CA" "$ROOT/tmp/build-ca.crt"
  fi
  # No service starts in a chroot.
  printf '#!/bin/sh\nexit 101\n' > "$ROOT/usr/sbin/policy-rc.d"
  chmod 755 "$ROOT/usr/sbin/policy-rc.d"
  in_chroot apt-get update -q
}

lock() {
  ROOT=$(mktemp -d "${TMPDIR:-/tmp}/bro-rootfs-lock.XXXXXX")
  fetch_base
  unpack_base
  mount_chroot
  setup_apt
  in_chroot apt-get install -yq python3 python3-venv
  in_chroot python3 -m venv /tmp/lock
  cp "$HERE/requirements.in" "$ROOT/tmp/requirements.in"
  in_chroot /tmp/lock/bin/pip install -q --only-binary=:all: -r /tmp/requirements.in
  in_chroot /tmp/lock/bin/pip freeze --all --exclude pip --exclude setuptools > "$ROOT/tmp/frozen.txt"
  # The very files pip picks for this Python and platform, hashed: --require-hashes then accepts only them.
  in_chroot /tmp/lock/bin/pip download -q --no-deps --only-binary=:all: -d /tmp/wheels -r /tmp/frozen.txt
  python3 - "$ROOT/tmp/frozen.txt" "$ROOT/tmp/wheels" > "$HERE/requirements.txt" <<'PY'
import hashlib, pathlib, re, sys
frozen = [line.strip() for line in open(sys.argv[1]) if "==" in line]
wheels = {}
for path in pathlib.Path(sys.argv[2]).glob("*.whl"):
    name = re.sub(r"[-_.]+", "-", path.name.split("-")[0]).lower()
    wheels[name] = hashlib.sha256(path.read_bytes()).hexdigest()
print("# Generated by `build_rootfs.sh lock` from requirements.in for CPython 3.10 on x86_64 (Ubuntu 22.04):")
print("# every wheel of /opt/py, pinned by sha256. Do not edit by hand.")
for line in sorted(frozen, key=str.lower):
    name = re.sub(r"[-_.]+", "-", line.split("==")[0]).lower()
    print(f"{line} \\\n    --hash=sha256:{wheels[name]}")
PY
  umount_chroot
  rm -rf "$ROOT"
  echo "wrote $HERE/requirements.txt"
}

build() {
  local tools=${1:?build needs the tools binary (sandbox/tools, x86_64 musl)}
  local out=${2:-$HERE/out}
  [ -x "$tools" ] || die "$tools is not an executable"
  file -b "$tools" | grep -q "static" || die "$tools is not a static binary"
  [ -s "$HERE/requirements.txt" ] || die "no requirements.txt: run lock first"
  local digest
  digest=$( (sha256sum "$HERE/build_rootfs.sh" "$HERE/verify.py" "$HERE/requirements.txt" | cut -d' ' -f1
             sha256sum "$tools" | cut -d' ' -f1) | sha256sum | cut -c1-8)
  VERSION="$(date -u +%Y%m%d)-$digest"
  mkdir -p "$out"
  out=$(cd "$out" && pwd)
  ROOT="$out/work-$VERSION"
  local started=$SECONDS
  echo "version $VERSION"

  fetch_base
  unpack_base
  mount_chroot
  setup_apt
  in_chroot apt-get -yq upgrade
  in_chroot apt-get install -yq "${PACKAGES[@]}"

  # Locale, time zone and the account every command runs as (uid 1000, no sudo: there is none).
  ln -sf /usr/share/zoneinfo/Europe/Moscow "$ROOT/etc/localtime"
  echo Europe/Moscow > "$ROOT/etc/timezone"
  echo LANG=C.UTF-8 > "$ROOT/etc/default/locale"
  if in_chroot getent passwd $SANDBOX_UID >/dev/null; then die "uid $SANDBOX_UID is taken in the base"; fi
  in_chroot groupadd --gid $SANDBOX_UID sandbox
  in_chroot useradd --uid $SANDBOX_UID --gid $SANDBOX_UID --create-home --home-dir /home/sandbox \
    --shell /bin/bash sandbox
  install -d -m 755 -o $SANDBOX_UID -g $SANDBOX_UID "$ROOT/workspace"
  # The broker's socket directory: sandboxd bind-mounts the host side here, read-only.
  install -d -m 755 "$ROOT/run/bro"
  install -m 755 "$tools" "$ROOT/usr/local/bin/tools"

  # Python: a venv first on PATH, only hash-pinned wheels.
  in_chroot python3 -m venv /opt/py
  cp "$HERE/requirements.txt" "$ROOT/tmp/requirements.txt"
  in_chroot /opt/py/bin/pip install -q --no-cache-dir --disable-pip-version-check --require-hashes \
    --only-binary=:all: -r /tmp/requirements.txt
  # sandboxd runs every command as `bash -lc`: a login shell reads this.
  cat > "$ROOT/etc/profile.d/10-bro-sandbox.sh" <<'EOF'
# Bro sandbox: the venv's Python first, Moscow time, matplotlib without a display.
case ":$PATH:" in
  *:/opt/py/bin:*) ;;
  *) PATH="/opt/py/bin:$PATH" ;;
esac
export PATH
export LANG="${LANG:-C.UTF-8}"
export TZ="${TZ:-Europe/Moscow}"
export MPLBACKEND="${MPLBACKEND:-Agg}"
export PIP_DISABLE_PIP_VERSION_CHECK=1
EOF
  printf 'VERSION=%s\nBASE=%s\n' "$VERSION" "$BASE_NAME" > "$ROOT/etc/bro-sandbox-release"

  # Leave nothing of the build behind: package lists and caches, logs, the proxy settings and its CA.
  in_chroot fc-cache -f >/dev/null
  in_chroot apt-get clean
  rm -rf "$ROOT"/var/lib/apt/lists/* "$ROOT"/var/cache/apt/*.bin "$ROOT"/var/cache/debconf/*-old \
    "$ROOT"/var/lib/dpkg/*-old "$ROOT"/root/.cache "$ROOT/etc/apt/apt.conf.d/99bro-build" \
    "$ROOT/usr/sbin/policy-rc.d"
  find "$ROOT/var/log" -type f -delete
  rm -rf "$ROOT"/tmp/* "$ROOT"/var/tmp/*

  # The smoke test runs on the image as it ships. As a side effect the sandbox user's matplotlib font cache
  # and LibreOffice profile exist: both ship, so the first chart and the first conversion are not slower.
  cp "$HERE/verify.py" "$ROOT/tmp/verify.py"
  as_sandbox 'python3 /tmp/verify.py /tmp/verify' | tee "$out/rootfs-$VERSION.verify.json"
  rm -rf "$ROOT"/tmp/* "$ROOT"/tmp/.[!.]* "$ROOT/home/sandbox/.config/libreoffice/4/.lock"

  {
    echo "# rootfs $VERSION"
    in_chroot dpkg-query -W -f '${Package} ${Version}\n'
    echo "# /opt/py"
    in_chroot /opt/py/bin/pip freeze --all
  } > "$out/rootfs-$VERSION.manifest.txt"
  umount_chroot

  local archive="$out/rootfs-$VERSION.tar.zst"
  tar --numeric-owner --sort=name -C "$ROOT" -cpf - . | zstd -q -T0 "-$ZSTD_LEVEL" -o "$archive" -f
  (cd "$out" && sha256sum "rootfs-$VERSION.tar.zst" > "rootfs-$VERSION.tar.zst.sha256")
  echo "unpacked $(du -sh "$ROOT" | cut -f1), archive $(du -h "$archive" | cut -f1), $((SECONDS - started)) s"
  cat "$archive.sha256"
  [ -n "${KEEP_ROOT:-}" ] || rm -rf "$ROOT"
}

case "${1:-}" in
  build) shift; build "$@" ;;
  lock) lock ;;
  *) sed -n '2,20p' "$0" >&2; exit 2 ;;
esac
