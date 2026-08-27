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

# Install workspace dependencies from the committed lockfile.
pnpm install --frozen-lockfile

# OptMem long-term memory is a vendored Python CLI; confirm Python 3 is present.
python3 --version

echo "install ok: node $(node -v), pnpm $(pnpm -v), $(python3 --version)"
