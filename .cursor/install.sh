#!/usr/bin/env bash
# Idempotent Cloud Agent install: Microsoft tgrep + workspace index.
set -euo pipefail
export PATH="/usr/local/bin:${HOME}/.local/bin:${PATH}"

TGREP_VERSION="${TGREP_VERSION:-}"
RULE_PATH="${HOME}/.cursor/rules/tgrep.mdc"

install_tgrep() {
  if command -v tgrep >/dev/null 2>&1; then
    echo "tgrep already present: $(tgrep --version)"
  else
    echo "Installing tgrep from https://github.com/microsoft/tgrep"
    mkdir -p "${HOME}/.local/bin"
    curl -fsSL https://raw.githubusercontent.com/microsoft/tgrep/main/scripts/install.sh \
      | env TGREP_INSTALL_DIR="${HOME}/.local/bin" TGREP_VERSION="${TGREP_VERSION}" bash
  fi

  local src
  src="$(command -v tgrep)"
  if [ ! -x /usr/local/bin/tgrep ] || ! cmp -s "${src}" /usr/local/bin/tgrep; then
    sudo -n cp "${src}" /usr/local/bin/tgrep
    sudo -n chmod 755 /usr/local/bin/tgrep
  fi
}

write_agent_rule() {
  mkdir -p "$(dirname "${RULE_PATH}")"
  if [ -f /workspace/.cursor/rules/tgrep.mdc ]; then
    cp /workspace/.cursor/rules/tgrep.mdc "${RULE_PATH}"
  fi
}

index_workspace() {
  tgrep index /workspace \
    --exclude node_modules \
    --exclude .git \
    --exclude .eve \
    --exclude .convex
}

install_tgrep
write_agent_rule
index_workspace
echo "tgrep $(tgrep --version) ready"
tgrep status /workspace
