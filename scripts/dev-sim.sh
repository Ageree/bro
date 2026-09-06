#!/usr/bin/env bash
# eve only — no Inkbox tunnel. Cloud/AI testers talk via /internal/sim.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 24 >/dev/null
fi

if lsof -nP -iTCP:2000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "eve already on :2000"
  exit 0
fi

echo "starting eve on 127.0.0.1:2000 (sim, no tunnel)"
exec npx eve dev --no-ui --host 127.0.0.1 --port 2000
