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

SKIP_ENV_CHECK=0
for arg in "$@"; do
  if [ "$arg" = "--skip-env-check" ]; then
    SKIP_ENV_CHECK=1
  fi
done

# Convex-side code (follow-through polling, wakeups) talks to Browser Use
# Cloud and back to eve directly from the Convex deployment, not from eve on
# Vercel — an env var set only on eve does nothing for it. This is the
# incident: BROWSERUSE_API_KEY was set on eve but not on Convex, so every
# follow-through poll threw "missing" and read as "unknown" for the full
# 20-minute give-up budget before anyone heard anything.
if [ "$SKIP_ENV_CHECK" != "1" ]; then
  echo "checking convex env"
  CONVEX_ENV="$(CI=1 npx convex env list)"
  missing=""
  has_var() {
    printf '%s\n' "$CONVEX_ENV" | grep -q "^$1="
  }
  if ! has_var BROWSERUSE_API_KEY && ! has_var BROWSER_USE_API_KEY; then
    missing="$missing BROWSERUSE_API_KEY"
  fi
  for name in EVE_URL BRO_INTERNAL_SECRET; do
    if ! has_var "$name"; then
      missing="$missing $name"
    fi
  done
  if [ -n "$missing" ]; then
    echo "convex deployment is missing:$missing" >&2
    echo "set each with: npx convex env set <NAME> <value> (e.g. npx convex env set BROWSERUSE_API_KEY <key>)" >&2
    echo "without BROWSERUSE_API_KEY, every browser follow-through run reads status \"unknown\" for the full 20-minute poll budget instead of reporting" >&2
    echo "pass --skip-env-check to bypass this check" >&2
    exit 1
  fi
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
