#!/usr/bin/env bash
# Install vphone-cli on the Apple Silicon Mac that will host the iOS VM.
# Cloud Linux cannot boot a PV=3 guest. Run this on the MacBook.
set -euo pipefail

host="$(uname -s)"
arch="$(uname -m)"
if [[ "$host" != "Darwin" || "$arch" != "arm64" ]]; then
  echo "vphone-cli needs an Apple Silicon Mac (macOS 15+). This host is ${host}/${arch}." >&2
  echo "Cloud Linux cannot boot a PV=3 iPhone VM. Run this on the MacBook, then start a Cursor worker there." >&2
  exit 2
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required: https://brew.sh" >&2
  exit 2
fi

if [[ "$(sw_vers -productVersion | cut -d. -f1)" -lt 15 ]]; then
  echo "macOS 15+ (Sequoia) is required. This host is $(sw_vers -productVersion)." >&2
  exit 2
fi

echo "Installing vphone-cli from zqxwce/tap…"
brew install zqxwce/tap/vphone-cli

if ! command -v vphone-cli >/dev/null 2>&1; then
  echo "vphone-cli is not on PATH after brew install." >&2
  exit 2
fi

vphone-cli --help >/dev/null

vm_name="${VPHONE_VM:-bro}"
echo
echo "vphone-cli is on PATH."
echo "One-time host (Recovery, then reboot):"
echo "  csrutil disable"
echo "  csrutil allow-research-guests enable"
echo "  sudo nvram boot-args=\"amfi_get_out_of_my_way=1 -v\""
echo "Or keep SIP on: csrutil enable --without debug && vphone-amfidont"
echo
echo "Create + boot the Bro VM (downloads IPSWs, needs the SIP/AMFI step first):"
echo "  vphone-cli vm create ${vm_name} -V jb"
echo "  vphone-cli vm launch ${vm_name}"
echo
echo "Then from this repo:"
echo "  export VPHONE_VM=${vm_name}"
echo "  npm run vphone:e2e"
echo
echo "Agent MCP (optional): https://github.com/pluginslab/vphone-mcp"
echo "  VPHONE_SOCK=~/.vphone/VMs/${vm_name}/vphone.sock"
echo
echo "iMessage on a VM is not guaranteed (Apple device attestation)."
echo "Use the VM for iOS Safari / cabinet / vault. Blue-bubble chat still needs a real iPhone unless the VM activates iMessage."

if [[ "${1:-}" == "--create" ]]; then
  echo
  echo "Creating VM ${vm_name} (jb)…"
  vphone-cli vm create "$vm_name" -V jb
fi
