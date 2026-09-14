#!/usr/bin/env bash
# Production deploy: Convex functions/schema first, then the eve agent on Vercel.
# Both CLIs reject a token that carries a trailing newline ("invalid header
# value" / "Must not contain \n"), which is what a pasted secret in a hosted
# environment often has, so the keys are trimmed before use.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

trim() { printf '%s' "${1:-}" | tr -d '[:space:]'; }

CONVEX_DEPLOY_KEY="$(trim "${CONVEX_DEPLOY_KEY:-}")"
VERCEL_TOKEN="$(trim "${VERCEL_TOKEN:-}")"
export CONVEX_DEPLOY_KEY VERCEL_TOKEN

if [ -z "$CONVEX_DEPLOY_KEY" ]; then
  echo "CONVEX_DEPLOY_KEY missing" >&2
  exit 1
fi

echo "convex deploy"
CI=1 npx convex deploy --typecheck enable

if [ "${1:-}" = "--convex-only" ]; then
  exit 0
fi

if [ -z "$VERCEL_TOKEN" ]; then
  echo "VERCEL_TOKEN missing; skipping eve deploy" >&2
  exit 1
fi
if ! command -v vercel >/dev/null 2>&1; then
  echo "vercel CLI missing: npm i -g vercel@latest" >&2
  exit 1
fi

PROJECT="${VERCEL_PROJECT:-bro-agent}"
TEAM="${VERCEL_TEAM:-}"
echo "eve deploy -> $PROJECT"
CI=1 npx eve deploy --non-interactive --project "$PROJECT" ${TEAM:+--team "$TEAM"} -y
