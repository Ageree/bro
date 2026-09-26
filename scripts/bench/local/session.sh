#!/usr/bin/env bash
# Usage: scripts/bench/local/session.sh <worktree> <name> <script.sh>
#
# Runs benchmark cases against a branch before it is merged: brings up Bro from
# <worktree> on http://localhost:3000 with the real OpenRouter, Browser Use and
# Composio keys from the environment, signs the driver in as the tester, runs
# <script.sh> with `bench` and `tick` shell functions, then stops Bro. One
# session at a time per machine (flock): one Bro needs about 2.7 GB.
#
# Needs Postgres on 127.0.0.1:5432 (user and password `postgres`),
# OPENROUTER_API_KEY, and for Google cases COMPOSIO_API_KEY with the tester's
# active connection. BENCH_TESTER_ID overrides the tester's Bro user id, which
# is otherwise read from that Composio connection.
set -euo pipefail
WT=$(realpath "$1"); NAME="$2"; SCRIPT=$(realpath "$3")
HERE=$(dirname "$(realpath "$0")")
# A number that does not exist: a site's sign-in code must not text a stranger.
TESTER_PHONE=+70000000001
DB="bro_$(echo "$NAME" | tr -c 'a-z0-9\n' '_')"
PGURL="postgresql://postgres:postgres@127.0.0.1:5432/$DB"
LOG="/tmp/bro-dev-$NAME.log"
COOKIE="$HOME/.bro-bench/$NAME.cookies"
export PGPASSWORD=postgres

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(($1)(JSON.parse(s)))}catch{console.log('')}})"; }

OR_LEFT=$(curl -s -m 20 https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  | json 'j=>(j.data.total_credits-j.data.total_usage).toFixed(2)')
echo "[session] OpenRouter credits left: \$${OR_LEFT:-unknown}"
if [ -n "$OR_LEFT" ] && node -e "process.exit(Number('$OR_LEFT') < 0.5 ? 0 : 1)"; then
  echo "[session] OpenRouter credits are exhausted: every model call would fail."
  exit 3
fi

TESTER_ID="${BENCH_TESTER_ID:-}"
if [ -z "$TESTER_ID" ] && [ -n "${COMPOSIO_API_KEY:-}" ]; then
  TESTER_ID=$(curl -s -m 20 "https://backend.composio.dev/api/v3/connected_accounts?limit=50&statuses=ACTIVE&toolkit_slugs=googlesuper" \
    -H "x-api-key: $COMPOSIO_API_KEY" | json 'j=>(j.items?.[0]?.user_id??"").replace(/^better-auth:/,"")')
fi
TESTER_ID="${TESTER_ID:-local-tester}"
WORKSPACE=$(node -e "console.log('personal:'+require('crypto').createHash('sha256').update('better-auth:$TESTER_ID').digest('hex').slice(0,32))")

exec 9>/tmp/bro-run.lock
echo "[session] $(date +%T) waiting for the run lock (holder: $(cat /tmp/bro-run.holder 2>/dev/null || echo none))"
flock 9
echo "$NAME $(date +%T)" > /tmp/bro-run.holder

psql -h 127.0.0.1 -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
  || psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE $DB" >/dev/null
cat > "$WT/.env.local" <<EOF
DATABASE_URL=$PGURL
DATABASE_URL_UNPOOLED=$PGURL
BETTER_AUTH_URL=http://localhost:3000
NODE_ENV=development
BENCH_TIMEZONE=Europe/Moscow
EOF
(cd "$WT" && pnpm -s db:migrate >/dev/null)
# On prod the tester was introduced long ago; without the workspace row every
# fresh database opens its first case with Bro's first-contact greeting.
psql -h 127.0.0.1 -U postgres "$DB" >/dev/null <<SQL
INSERT INTO "user"(id, name, email, "emailVerified", "phoneNumber", "phoneNumberVerified")
  VALUES ('$TESTER_ID', 'Тестировщик', 'bench-local@bro.invalid', false, '$TESTER_PHONE', true)
  ON CONFLICT (id) DO UPDATE SET "phoneNumber" = '$TESTER_PHONE';
INSERT INTO workspaces(id, introduced_at) VALUES ('$WORKSPACE', now())
  ON CONFLICT (id) DO UPDATE SET introduced_at = COALESCE(workspaces.introduced_at, now());
INSERT INTO workspace_memberships(workspace_id, user_id, role)
  VALUES ('$WORKSPACE', 'better-auth:$TESTER_ID', 'owner') ON CONFLICT DO NOTHING;
SQL

cleanup() {
  [ -n "${TICKER:-}" ] && kill "$TICKER" 2>/dev/null || true
  [ -n "${DEV:-}" ] && kill -- "-$DEV" 2>/dev/null || true
  sleep 3
  [ -n "${DEV:-}" ] && kill -9 -- "-$DEV" 2>/dev/null || true
  rm -f /tmp/bro-run.holder
  echo "[session] $(date +%T) Bro stopped, lock released"
}
trap cleanup EXIT

: > "$LOG"
cd "$WT"
# Messenger credentials stay out: the local Bro must not answer or post in
# the real Telegram or iMessage.
setsid env -u TELEGRAM_BOT_TOKEN -u TELEGRAM_BOT_USERNAME -u TELEGRAM_WEBHOOK_SECRET \
  -u IMESSAGE_PROJECT_ID -u IMESSAGE_PROJECT_SECRET -u IMESSAGE_WEBHOOK_SECRET \
  -u SPECTRUM_PROJECT_ID -u SPECTRUM_PROJECT_SECRET -u SPECTRUM_WEBHOOK_SECRET \
  -u VERCEL_TOKEN pnpm dev:app >"$LOG" 2>&1 &
DEV=$!
for _ in $(seq 1 120); do
  grep -q 'eve:dev\] server listening' "$LOG" && curl -s -o /dev/null http://localhost:3000/sign-in && break
  sleep 2
done
grep -q 'eve:dev\] server listening' "$LOG" || { echo "[session] Bro did not start, see $LOG"; exit 1; }
LOG="$LOG" bash "$HERE/ticker.sh" >"/tmp/bro-ticker-$NAME.log" 2>&1 &
TICKER=$!

mkdir -p "$HOME/.bro-bench"
pnpm -s bench otp --phone "$TESTER_PHONE" --host http://localhost:3000 >/dev/null
echo 000000 | pnpm -s bench verify --phone "$TESTER_PHONE" --host http://localhost:3000 --cookie-file "$COOKIE"
echo "[session] $(date +%T) Bro is up from $WT (db $DB, log $LOG)"

bench() {
  local sub="$1"; shift
  (cd "$WT" && pnpm -s bench "$sub" "$@" --host http://localhost:3000 --cookie-file "$COOKIE")
}
tick() {
  local port
  port=$(grep -o 'eve:dev\] server listening at http://127.0.0.1:[0-9]*' "$LOG" | tail -1 | grep -o '[0-9]*$')
  curl -s -m 170 -X POST "http://127.0.0.1:${port}/eve/v1/dev/schedules/$1"; echo
}
export -f bench tick
export WT NAME COOKIE LOG

set +e
source "$SCRIPT"
STATUS=$?
set -e
echo "[session] $(date +%T) script finished with $STATUS"
exit "$STATUS"
