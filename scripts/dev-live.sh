#!/usr/bin/env bash
# eve + Inkbox tunnel for the *live QA* Bro identity.
# Do not point this at the production agent handle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 24 >/dev/null
fi

export INKBOX_AGENT_HANDLE="${BRO_LIVE_BRO_HANDLE:-bro-live-bro}"

if ! lsof -nP -iTCP:2000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "starting eve on 127.0.0.1:2000 as ${INKBOX_AGENT_HANDLE}"
  npx eve dev --no-ui --host 127.0.0.1 --port 2000 &
  for _ in $(seq 1 40); do
    if curl -sf http://127.0.0.1:2000/eve/v1/health >/dev/null; then
      break
    fi
    sleep 0.4
  done
  curl -sf http://127.0.0.1:2000/eve/v1/health >/dev/null
  echo "eve ready"
else
  echo "eve already on :2000"
fi

echo "inkbox tunnel ${INKBOX_AGENT_HANDLE} -> http://127.0.0.1:2000"
exec node --experimental-strip-types scripts/inkbox-tunnel.ts
