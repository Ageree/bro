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
  # Optional, warn-only: without it the Convex deployment still sends every
  # progress note and «готово» report, just in the canned wording from
  # convex/lib/browserProgressPolicy.ts instead of phrasing each one
  # (convex/lib/broPhrasing.ts). Never a hard requirement.
  if ! has_var OPENROUTER_API_KEY; then
    echo "note: convex has no OPENROUTER_API_KEY — browser progress notes and the done report will use their canned wording" >&2
    echo "      set it with: npx convex env set OPENROUTER_API_KEY <key>" >&2
  fi
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

# The Convex gate above says nothing about the Vercel side, and that is where
# the agent itself runs. `agent/lib/composio.ts` throws out of `assertKey()`
# when COMPOSIO_API_KEY is missing or still a placeholder, which kills every
# Composio tool at once — no app search, no Connect Link, so «подключи мне
# почту» dies with an exception the human never hears about. Nothing catches
# that before a real turn does, so check it here. Reading the project's env
# list over the API rather than `vercel env ls` on purpose: deploy.sh drives
# a project by name and never assumes this checkout is `vercel link`ed.
if [ "$SKIP_ENV_CHECK" != "1" ]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "note: curl missing — cannot verify COMPOSIO_API_KEY on $PROJECT" >&2
  else
    echo "checking vercel env"
    ENV_URL="https://api.vercel.com/v9/projects/$PROJECT/env?decrypt=false"
    if [ -n "$TEAM" ]; then
      ENV_URL="$ENV_URL&slug=$TEAM"
    fi
    VERCEL_ENV_JSON="$(curl -sS -f -H "Authorization: Bearer $VERCEL_TOKEN" "$ENV_URL" 2>/dev/null || true)"
    if [ -z "$VERCEL_ENV_JSON" ]; then
      # An API hiccup or a token without project-read scope must not block a
      # deploy — it tells us nothing about the key either way.
      echo "note: could not read $PROJECT env from Vercel — COMPOSIO_API_KEY unverified" >&2
    elif ! printf '%s' "$VERCEL_ENV_JSON" | grep -q '"key":"COMPOSIO_API_KEY"'; then
      echo "vercel project $PROJECT has no COMPOSIO_API_KEY" >&2
      echo "set it with: vercel env add COMPOSIO_API_KEY production --token \$VERCEL_TOKEN" >&2
      echo "without it every Composio tool throws on first use: no app search, and «подключи мне почту» never produces a Connect Link" >&2
      echo "pass --skip-env-check to bypass this check" >&2
      exit 1
    fi
  fi
fi

echo "eve deploy -> $PROJECT"
CI=1 npx eve deploy --non-interactive --project "$PROJECT" ${TEAM:+--team "$TEAM"} -y
