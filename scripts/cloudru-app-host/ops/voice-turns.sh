#!/bin/bash
# What people ask Bro aloud on /talk, by the tools his turn took — read only, no text:
#
#   host.py ops NAME voice-turns.sh [SINCE]
#
# A voice turn is a person's turn whose opening message starts with «[голосом]» (`voiceTalkMarker`,
# shared/voice/marker.ts); its words live in turn_log_entries only with OWNER_TRANSCRIPTS, and this prints none of
# them. SINCE is a date or time PostgreSQL reads (Moscow unless it carries an offset), default seven days ago. For
# the window: how many voice turns and workspaces, how they ended; then each tool by the voice turns that called it,
# with their median and 90th-percentile length; turns that only replied (send_message, react_to_message) are «(none)». What the quick answer of
# the voice handled itself never reaches Bro: those are the `[voice] quick` lines of bro-eve's journal.
source "$(dirname "$0")/db-lib.sh"
[ "$#" -le 1 ] || die "usage: voice-turns.sh [SINCE]"
SINCE=${1:-$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)}
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?$ ]] || die "not a date or time: $SINCE"
db_lock
connection SRC app
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120s -c TimeZone=Europe/Moscow"
psql_on SRC -v since="$SINCE" <<'SQL'
\pset format aligned
\pset border 1
\pset tuples_only off
CREATE TEMP TABLE voice AS
SELECT t.id, t.workspace_id, t.tools, t.outcome, t.duration_ms
FROM turn_log t
WHERE t.kind = 'person'
  AND t.started_at >= :'since'::timestamptz
  AND EXISTS (
    SELECT 1 FROM turn_log_entries e
    WHERE e.session_id = t.session_id AND e.turn_id = t.turn_id AND e.role = 'person'
      AND e.created_at >= t.started_at AND e.created_at <= coalesce(t.ended_at, now())
      AND e.text LIKE '[голосом]%');
\echo === voice turns
SELECT count(*) AS turns,
       count(DISTINCT workspace_id) AS workspaces,
       count(*) FILTER (WHERE outcome = 'completed') AS completed,
       count(*) FILTER (WHERE outcome = 'failed') AS failed,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) / 1000)::numeric, 1) AS median_s
FROM voice;
\echo === tools of voice turns
SELECT tool,
       count(*) AS turns,
       count(DISTINCT workspace_id) AS workspaces,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) / 1000)::numeric, 1) AS median_s,
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) / 1000)::numeric, 1) AS p90_s
FROM (
  -- A tool called twice in a turn counts once; the reply itself is no tool.
  SELECT DISTINCT id, workspace_id, duration_ms,
         unnest(CASE WHEN cardinality(asked) = 0 THEN ARRAY['(none)'] ELSE asked END) AS tool
  FROM (SELECT *, array_remove(array_remove(tools, 'send_message'), 'react_to_message') AS asked FROM voice) replies
) used
GROUP BY tool
ORDER BY turns DESC, tool;
SQL
