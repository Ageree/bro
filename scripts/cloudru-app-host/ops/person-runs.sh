#!/bin/bash
# What Bro's browser errands of one person did and why they stopped — read only, for finding out a bug a person
# reported (the owner allowed reading production data for it, 26.10):
#
#   host.py ops NAME person-runs.sh TELEGRAM_USERNAME [SINCE [LIMIT]]
#
# The person is found by the Telegram username of their channel identity (no @). SINCE is a date or time
# PostgreSQL reads (Moscow unless it carries an offset), default seven days ago; LIMIT is how many of their latest
# runs to print, default 5, at most 20. For each run: when, status, the site and the page the browser ended on
# (host and path, no query), and the task, outcome, worker result and error, each cut to a length that fits a job
# log. This holds what the person and pages wrote: run it for one report, never on a schedule.
source "$(dirname "$0")/db-lib.sh"
{ [ "$#" -ge 1 ] && [ "$#" -le 3 ]; } || die "usage: person-runs.sh TELEGRAM_USERNAME [SINCE [LIMIT]]"
NAME=${1#@}
[[ "$NAME" =~ ^[A-Za-z0-9_]{3,64}$ ]] || die "not a Telegram username: $1"
SINCE=${2:-$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)}
LIMIT=${3:-5}
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?$ ]] || die "not a date or time: $SINCE"
[[ "$LIMIT" =~ ^[0-9]{1,2}$ ]] && [ "$LIMIT" -ge 1 ] && [ "$LIMIT" -le 20 ] || die "LIMIT is 1 to 20: $LIMIT"
db_lock
connection SRC app
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120s -c TimeZone=Europe/Moscow"
psql_on SRC -v name="$NAME" -v since="$SINCE" -v lim="$LIMIT" <<'SQL'
\pset tuples_only on
\pset format unaligned
SELECT 'workspaces of that username: ' || count(DISTINCT workspace_id)
FROM channel_identities WHERE channel = 'telegram' AND lower(username) = lower(:'name');
SELECT E'\n=== ' || to_char(r.created_at, 'YYYY-MM-DD HH24:MI:SS') || ' status=' || r.status
       || ' site=' || coalesce(r.site, '-')
       || ' ended_on=' || coalesce(substring(v.final_url FROM '^[A-Za-z][A-Za-z0-9+.-]*://[^?#]*'), '-')
       || E'\nTASK: ' || left(regexp_replace(r.task, '\s+', ' ', 'g'), 1500)
       || E'\nOUTCOME: ' || left(coalesce(r.outcome, '-'), 3500)
       || E'\nWORKER RESULT: ' || left(coalesce(v.result, '-'), 2500)
       || E'\nERROR: ' || left(coalesce(v.error, '-'), 600)
FROM browser_runs r
LEFT JOIN browser_vm_runs v ON v.id = r.id
WHERE r.workspace_id IN (SELECT workspace_id FROM channel_identities
                         WHERE channel = 'telegram' AND lower(username) = lower(:'name'))
  AND r.created_at >= :'since'::timestamptz
ORDER BY r.created_at DESC
LIMIT :lim;
SQL
