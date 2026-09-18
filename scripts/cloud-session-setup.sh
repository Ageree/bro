#!/usr/bin/env bash
# Bring a Claude Code on the web container up to what this repo actually needs.
#
# Registered as a SessionStart hook (see README "Облачные сессии"). It lives in
# scripts/ rather than inside .claude/ so it is an ordinary repository script:
# reviewable in a diff, runnable by hand, and testable without a session.
#
# Two gaps, and the first one has already cost a production deploy:
#
#   node          `package.json` pins `engines.node: 24.x` and `.nvmrc` says
#                 24, but the container ships 22. `eve deploy` refuses outright
#                 on anything older — and it refuses AFTER `convex deploy` has
#                 already landed, because `scripts/deploy.sh` runs Convex
#                 first. That leaves the worst possible split: schema forward,
#                 agent behind, with the instinct cron live on a deployment the
#                 old agent does not understand.
#   dependencies  this is a pnpm workspace; the lockfile is pnpm's. The vercel
#                 binary counts as one too — `scripts/deploy.sh` checks for it
#                 on PATH before it will run the eve half.
#
# Secrets are deliberately NOT handled here: nothing below reads, writes or
# moves a credential. `npm run e2e` and `npm run composio:check` do need real
# values, but the place for those is the environment's own variable list, so
# they arrive the same way VERCEL_TOKEN and CONVEX_DEPLOY_KEY already do — one
# place, set once, visible to every session. Fetching them into the container
# at startup would put the same secrets in a second place for no gain.
set -euo pipefail

# The container is the whole point. On a laptop the developer's own node and
# pnpm are already right, and this must not touch them. Pass --force to run it
# anywhere (what the check below uses).
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && [ "${1:-}" != "--force" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

# Where a SessionStart hook persists environment for the rest of the session.
# Harmless when unset: the exports simply go nowhere and PATH still holds for
# this process.
ENV_FILE="${CLAUDE_ENV_FILE:-/dev/null}"

# --- node ---------------------------------------------------------------
# Pinned rather than "latest 24.x" so two sessions a month apart build the
# same way. Bump this line when the repo moves.
NODE_VERSION="24.9.0"
NODE_DIR="$HOME/.local/share/node-v${NODE_VERSION}-linux-x64"

node_major() {
  node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'
}

have_node_24() {
  local major
  major="$(node_major)"
  [ -n "$major" ] && [ "$major" -ge 24 ] 2>/dev/null
}

if have_node_24; then
  echo "cloud-setup: node $(node -v) already satisfies engines.node"
else
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    echo "cloud-setup: fetching node $NODE_VERSION (container has $(node -v 2>/dev/null || echo none))"
    mkdir -p "$HOME/.local/share"
    curl -fsSL -o /tmp/node-cloud-setup.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
    tar -xf /tmp/node-cloud-setup.tar.xz -C "$HOME/.local/share"
    rm -f /tmp/node-cloud-setup.tar.xz
  fi
  export PATH="$NODE_DIR/bin:$PATH"
  printf 'export PATH="%s/bin:$PATH"\n' "$NODE_DIR" >> "$ENV_FILE"
  echo "cloud-setup: node $(node -v)"
fi

# --- dependencies -------------------------------------------------------
# `install`, not `--frozen-lockfile`: the container image is cached after the
# hook completes, so a warm store is worth more here than a hard lockfile
# assertion — which CI makes anyway, where it actually gates something.
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --silent || echo "cloud-setup: pnpm install failed — run it by hand" >&2
else
  npm install --no-audit --no-fund --silent || echo "cloud-setup: npm install failed" >&2
fi

if command -v vercel >/dev/null 2>&1; then
  echo "cloud-setup: vercel $(vercel --version 2>/dev/null | tail -1)"
else
  npm i -g --silent vercel@latest \
    && echo "cloud-setup: vercel $(vercel --version 2>/dev/null | tail -1)" \
    || echo "cloud-setup: vercel CLI install failed — npm run deploy will stop before the eve half" >&2
fi

echo "cloud-setup: ready"
