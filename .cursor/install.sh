#!/usr/bin/env bash
# Cloud Agent install for Bro (eve + Convex iMessage concierge).
# Idempotent: safe to run repeatedly and against cached/partial state.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Node 24 (repo pins it via .nvmrc / package.json engines) through nvm.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
NODE_VERSION="$(cat .nvmrc 2>/dev/null || echo 24)"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use "$NODE_VERSION"

# pnpm (matches pnpm-lock.yaml); corepack ships with Node 24.
corepack enable
corepack prepare pnpm@10.33.3 --activate

# Make Node 24 the effective default for every shell.
#
# The Cloud Agent runtime runs commands with a non-login, non-interactive
# `bash -c` and prepends `/exec-daemon` (which ships Node 22) to PATH, ahead of
# nvm. That means `nvm use 24` reports success but `node -v` still resolves to
# Node 22, and the `eve` CLI (which requires Node >= 24) fails. `.nvmrc` and
# scripts/dev-local.sh both expect Node 24.
#
# `/usr/local/cargo/bin` is the only writable directory that appears *before*
# `/exec-daemon` in PATH, so linking the Node 24 binaries there wins without
# depending on shell rc files or manual PATH exports.
NODE_BIN_DIR="$(dirname "$(nvm which "$NODE_VERSION")")"
EARLY_BIN="/usr/local/cargo/bin"
if [ -d "$EARLY_BIN" ] && [ -w "$EARLY_BIN" ]; then
  for bin in node npm npx corepack pnpm; do
    if [ -x "$NODE_BIN_DIR/$bin" ]; then
      ln -sf "$NODE_BIN_DIR/$bin" "$EARLY_BIN/$bin"
    fi
  done
fi

# Install workspace dependencies from the committed lockfile.
pnpm install --frozen-lockfile

# OptMem long-term memory is a vendored Python CLI; confirm Python 3 is present.
python3 --version

echo "install ok: node $(node -v), pnpm $(pnpm -v), $(python3 --version)"
