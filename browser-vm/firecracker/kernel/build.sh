#!/usr/bin/env bash
# Reproducible build of the Firecracker guest kernel (uncompressed vmlinux ELF, x86_64).
#
#   build.sh [build]          download, verify, configure, check, compile; prints the artifact name
#   build.sh check <config>   only check that a .config has every required option built in
#
# Environment: WORK (default ./work next to this script), JOBS (default nproc),
#              UPDATE_CONFIG=1 to overwrite the committed kernel/config with the final .config.
# Build dependencies (Ubuntu): apt-get install -y build-essential flex bison bc libelf-dev libssl-dev xz-utils curl
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- pins: change them together, see README.md ---
KERNEL_VERSION="6.1.189"
# From https://cdn.kernel.org/pub/linux/kernel/v6.x/sha256sums.asc (checked again at download time).
KERNEL_SHA256="3ec834a2fefc9a08aac62f993525d7acd10163db6f01d63b4549cbff3f5c9439"
FIRECRACKER_TAG="v1.17.0"
BASE_CONFIG_PATH="resources/guest_configs/microvm-kernel-ci-x86_64-6.1.config"
BASE_CONFIG_SHA256="153ca1b40f3312bfb40b7587b471ea548a915f98f480f0d0892a1537957a2147"

KERNEL_BASE_URL="https://cdn.kernel.org/pub/linux/kernel/v6.x"
BASE_CONFIG_URL="https://raw.githubusercontent.com/firecracker-microvm/firecracker/${FIRECRACKER_TAG}/${BASE_CONFIG_PATH}"

# Options that must be =y in the final .config (not m, not unset). Names are without the CONFIG_ prefix.
REQUIRED_BUILTIN=(
  # virtio over MMIO, serial console, entropy
  VIRTIO_MMIO VIRTIO_BLK VIRTIO_NET HW_RANDOM_VIRTIO SERIAL_8250_CONSOLE
  # filesystems and device nodes
  EXT4_FS OVERLAY_FS TMPFS TMPFS_POSIX_ACL SHMEM DEVTMPFS DEVTMPFS_MOUNT PROC_FS SYSFS UNIX98_PTYS
  # network
  UNIX INET IP_PNP
  # namespaces, cgroups, seccomp: the Chrome sandbox
  NAMESPACES USER_NS PID_NS NET_NS IPC_NS UTS_NS CGROUPS SECCOMP SECCOMP_FILTER
  # Chrome, Xvfb, worker
  SYSVIPC POSIX_MQUEUE MEMFD_CREATE INOTIFY_USER FHANDLE EPOLL FUTEX AIO
  # paravirtual clock and PTP clock from the host
  KVM_GUEST PARAVIRT PTP_1588_CLOCK PTP_1588_CLOCK_KVM
  # snapshot restore: VMGenID reseeds the CSPRNG, it is an ACPI device (ACPI needs PCI code even with pci=off)
  VMGENID ACPI PCI
)
# Options that must be absent.
REQUIRED_ABSENT=(MODULES X86_MPPARSE)

check_config() {
  local config="$1" missing=0 name
  [[ -f "$config" ]] || { echo "check: no such file: $config" >&2; return 1; }
  for name in "${REQUIRED_BUILTIN[@]}"; do
    if ! grep -qx "CONFIG_${name}=y" "$config"; then
      echo "check: CONFIG_${name} is not =y ($(grep -E "^(# )?CONFIG_${name}( |=)" "$config" || echo 'absent'))" >&2
      missing=1
    fi
  done
  for name in "${REQUIRED_ABSENT[@]}"; do
    if grep -qE "^CONFIG_${name}=" "$config"; then
      echo "check: CONFIG_${name} must not be set ($(grep -E "^CONFIG_${name}=" "$config"))" >&2
      missing=1
    fi
  done
  # With modules off nothing may be left as =m.
  if grep -qE '^CONFIG_[A-Z0-9_]+=m$' "$config"; then
    echo "check: modules remain in the config: $(grep -cE '^CONFIG_[A-Z0-9_]+=m$' "$config")" >&2
    missing=1
  fi
  [[ "$missing" -eq 0 ]] && echo "check: ok (${#REQUIRED_BUILTIN[@]} options =y, modules off)"
  return "$missing"
}

fetch() { # fetch <url> <file>
  curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"
}

verify_sha256() { # verify_sha256 <expected> <file>
  local actual
  actual="$(sha256sum "$2" | cut -d' ' -f1)"
  if [[ "$actual" != "$1" ]]; then
    echo "sha256 mismatch for $2: expected $1, got $actual" >&2
    return 1
  fi
}

build() {
  local work="${WORK:-$HERE/work}" jobs="${JOBS:-$(nproc)}"
  local tarball="linux-${KERNEL_VERSION}.tar.xz" src="$work/linux-${KERNEL_VERSION}" out="$work/out"
  mkdir -p "$work" "$out"

  # Kernel tarball: the pinned hash must equal the one kernel.org currently lists, and the file must match it.
  if [[ ! -f "$work/sha256sums.asc" ]]; then fetch "$KERNEL_BASE_URL/sha256sums.asc" "$work/sha256sums.asc"; fi
  local listed
  listed="$(awk -v f="$tarball" '$2 == f { print $1 }' "$work/sha256sums.asc")"
  if [[ "$listed" != "$KERNEL_SHA256" ]]; then
    echo "kernel.org lists '$listed' for $tarball, the pin is $KERNEL_SHA256" >&2
    exit 1
  fi
  # The list itself is PGP-signed by kernel developers; verify it when their keys are in the local keyring.
  if command -v gpg >/dev/null && gpg --verify "$work/sha256sums.asc" >/dev/null 2>&1; then
    echo "sha256sums.asc: PGP signature ok"
  else
    echo "sha256sums.asc: PGP signature not checked (no kernel.org keys in the keyring); the pin above stands in" >&2
  fi
  if [[ ! -f "$work/$tarball" ]]; then fetch "$KERNEL_BASE_URL/$tarball" "$work/$tarball"; fi
  verify_sha256 "$KERNEL_SHA256" "$work/$tarball"

  # Base config: Firecracker's own, at the pinned release tag.
  if [[ ! -f "$work/base.config" ]]; then fetch "$BASE_CONFIG_URL" "$work/base.config"; fi
  verify_sha256 "$BASE_CONFIG_SHA256" "$work/base.config"

  rm -rf "$src"
  tar -C "$work" -xf "$work/$tarball"

  cd "$src"
  cp "$work/base.config" .config
  scripts/kconfig/merge_config.sh -m -O . .config "$HERE/config-fragment" >/dev/null
  make olddefconfig
  check_config .config

  # Same inputs, same bytes: fixed build stamp instead of date, user and host.
  export KBUILD_BUILD_TIMESTAMP="Thu Jan  1 00:00:00 UTC 1970"
  export KBUILD_BUILD_USER="bro" KBUILD_BUILD_HOST="bro-fc"
  make -j"$jobs" vmlinux

  cp vmlinux "$out/vmlinux"
  cp .config "$out/config"
  local sha name
  sha="$(sha256sum "$out/vmlinux" | cut -d' ' -f1)"
  name="vmlinux-${KERNEL_VERSION}-${sha:0:16}"

  if [[ "${UPDATE_CONFIG:-0}" == 1 ]]; then
    cp .config "$HERE/config"
  elif [[ -f "$HERE/config" ]] && ! cmp -s .config "$HERE/config"; then
    echo "the final .config differs from the committed kernel/config; review the diff, then rerun with UPDATE_CONFIG=1" >&2
    diff "$HERE/config" .config | head -40 >&2 || true
    exit 1
  fi

  echo "vmlinux:  $out/vmlinux"
  echo "sha256:   $sha"
  echo "s3 name:  $name"
}

case "${1:-build}" in
  build) build ;;
  check) check_config "${2:?usage: build.sh check <config>}" ;;
  *) echo "usage: build.sh [build|check <config>]" >&2; exit 2 ;;
esac
