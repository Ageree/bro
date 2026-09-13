#!/usr/bin/env bash
# Per-boot: start tgrep serve if it is not already answering.
set -euo pipefail
export PATH="/usr/local/bin:${HOME}/.local/bin:${PATH}"

ROOT="${TGREP_ROOT:-/workspace}"
LOG="${HOME}/.cache/tgrep/serve.log"

mkdir -p "$(dirname "${LOG}")"

server_pid() {
  tgrep status "${ROOT}" 2>/dev/null \
    | awk '/^  PID:/{print $2; exit}'
}

if [ -n "$(server_pid)" ]; then
  echo "tgrep serve already running"
  tgrep status "${ROOT}"
  exit 0
fi

if ! command -v tgrep >/dev/null 2>&1; then
  echo "tgrep is not installed; run the environment install script first" >&2
  exit 1
fi

# serve stays attached; keep it in the background and wait until status reports a PID.
nohup tgrep serve "${ROOT}" \
  --exclude node_modules \
  --exclude .git \
  --exclude .eve \
  --exclude .convex \
  > "${LOG}" 2>&1 &

for _ in $(seq 1 40); do
  if [ -n "$(server_pid)" ]; then
    echo "tgrep serve ready"
    tgrep status "${ROOT}"
    exit 0
  fi
  sleep 0.25
done

echo "tgrep serve failed to become ready" >&2
if [ -f "${LOG}" ]; then
  tail -n 80 "${LOG}" >&2
fi
exit 1
