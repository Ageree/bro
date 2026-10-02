#!/bin/bash
# The queue jobs a stopped eve still holds, back to its queue: bro-eve.service runs this before every start
# (release, rollback, restart, crash, reboot). eve exits at once on SIGTERM (its sandbox shutdown plugin calls
# process.exit) before graphile-worker hands its jobs back; a locked job waits out graphile's 4-hour sweep,
# and the step it ran the workflow core's inline-ownership lease (860 s): a turn cut by a restart resumed
# 14 minutes later. Here eve is stopped, and the world database has one eve: any other session of its role
# there is one the old process left behind (ended first), and every lock belongs to a worker that is gone.
# Host code, not the release's: a rollback to an older release keeps it. Runs as bro with /etc/bro/env.
set -euo pipefail
[ -n "${WORKFLOW_POSTGRES_URL:-}" ] || {
  echo "world unlock: no WORKFLOW_POSTGRES_URL"
  exit 0
}
PG_BIN=${PG_BIN:-/usr/lib/postgresql/18/bin}
if [ -d "$PG_BIN" ]; then PATH="$PG_BIN:$PATH"; fi
# The URL's parts as libpq's PG* variables: the password never reaches a command line.
eval "$(python3 -c '
import os, shlex, urllib.parse as u
p = u.urlparse(os.environ["WORKFLOW_POSTGRES_URL"])
q = dict(u.parse_qsl(p.query))
parts = {"PGHOST": q.get("host") or p.hostname or "", "PGPORT": str(p.port or 5432),
         "PGUSER": u.unquote(p.username or ""), "PGPASSWORD": u.unquote(p.password or ""),
         "PGDATABASE": u.unquote(p.path.lstrip("/")), "PGSSLMODE": q.get("sslmode", "prefer")}
print("\n".join(f"export {k}={shlex.quote(v)}" for k, v in parts.items()))
')"
export PGCONNECT_TIMEOUT=10 PGAPPNAME=bro-world-unlock
psql -qAtX -v ON_ERROR_STOP=1 <<'SQL'
SET statement_timeout = '15s';
SET lock_timeout = '5s';
DO $unlock$
DECLARE
  ended int;
  workers text[];
BEGIN
  IF to_regprocedure('graphile_worker.force_unlock_workers(text[])') IS NULL THEN
    RAISE NOTICE 'world unlock: no queue yet';
    RETURN;
  END IF;
  SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) INTO ended FROM pg_catalog.pg_stat_activity
   WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid();
  SELECT array_agg(DISTINCT locked_by) INTO workers FROM (
    SELECT locked_by FROM graphile_worker._private_jobs WHERE locked_by IS NOT NULL
    UNION SELECT locked_by FROM graphile_worker._private_job_queues WHERE locked_by IS NOT NULL) locks;
  IF workers IS NOT NULL THEN
    PERFORM graphile_worker.force_unlock_workers(workers);
  END IF;
  RAISE NOTICE 'world unlock: % sessions of the stopped eve ended, the jobs of % workers released',
    ended, coalesce(array_length(workers, 1), 0);
END
$unlock$;
SQL
