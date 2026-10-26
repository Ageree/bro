#!/bin/bash
# What Bro's phone calls of one person did and why they ended as they did — read only, for finding out a bug a
# person reported (the owner allowed reading production data for it, 26.10):
#
#   host.py ops NAME person-calls.sh TELEGRAM_USERNAME [SINCE [LIMIT]]
#
# The person is found by the Telegram username of their channel identity (no @). SINCE is a date or time
# PostgreSQL reads (Moscow unless it carries an offset), default seven days ago; LIMIT is how many of their latest
# calls to print, default 10, at most 30. For each call: when, direction, state, outcome, length, whether the task
# succeeded, whether the report reached the person, the number called, the task and the summary or transcript
# (cut to a length that fits a job log). This holds what the person and the other side said: run it for one
# report, never on a schedule.
source "$(dirname "$0")/db-lib.sh"
{ [ "$#" -ge 1 ] && [ "$#" -le 3 ]; } || die "usage: person-calls.sh TELEGRAM_USERNAME [SINCE [LIMIT]]"
NAME=${1#@}
[[ "$NAME" =~ ^[A-Za-z0-9_]{3,64}$ ]] || die "not a Telegram username: $1"
SINCE=${2:-$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)}
LIMIT=${3:-10}
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?$ ]] || die "not a date or time: $SINCE"
[[ "$LIMIT" =~ ^[0-9]{1,2}$ ]] && [ "$LIMIT" -ge 1 ] && [ "$LIMIT" -le 30 ] || die "LIMIT is 1 to 30: $LIMIT"
db_lock
connection SRC app
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120s -c TimeZone=Europe/Moscow"
psql_on SRC -v name="$NAME" -v since="$SINCE" -v lim="$LIMIT" <<'SQL'
\pset tuples_only on
\pset format unaligned
SELECT 'workspaces of that username: ' || count(DISTINCT workspace_id)
FROM channel_identities WHERE channel = 'telegram' AND lower(username) = lower(:'name');
SELECT E'\n=== ' || to_char(c.created_at, 'YYYY-MM-DD HH24:MI:SS') || ' ' || c.direction || ' state=' || c.state
       || ' outcome=' || coalesce(c.outcome, '-')
       || ' seconds=' || coalesce(c.duration_seconds::text, '-')
       || ' succeeded=' || coalesce(c.task_succeeded::text, '-')
       || ' reported=' || (c.report_delivered_at IS NOT NULL)::text
       || ' via=' || CASE WHEN c.provider_conversation_id LIKE 'live\_%' THEN 'gpt-live'
                          WHEN c.provider_conversation_id IS NULL THEN '-' ELSE 'elevenlabs' END
       || E'\nNUMBER: ' || coalesce(c.target, '-')
       || E'\nTASK: ' || left(regexp_replace(coalesce(c.task, '-'), '\s+', ' ', 'g'), 1000)
       || E'\nSUMMARY: ' || left(coalesce(c.summary, '-'), 3000)
FROM phone_calls c
WHERE c.workspace_id IN (SELECT workspace_id FROM channel_identities
                         WHERE channel = 'telegram' AND lower(username) = lower(:'name'))
  AND c.created_at >= :'since'::timestamptz
ORDER BY c.created_at DESC
LIMIT :lim;
SQL
