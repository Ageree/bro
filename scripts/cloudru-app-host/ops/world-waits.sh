#!/bin/bash
# How long a session's run takes to wake for a message, read only — the replay a turn waits for:
#
#   host.py ops NAME world-waits.sh [DAYS [RUNS]]
#
# For the RUNS (10) runs with the most events, over the last DAYS (3) days: every `hook_received` event (a
# message, a report or a card's answer reaching the session) and the seconds to the run's next event, which
# the run writes only once it has read its history again and replayed it. Prints, per run and day, how many
# such wakes there were and their median, p90 and longest wait. Event types and times only: no payload.
source "$(dirname "$0")/db-lib.sh"
DAYS=${1:-3}
RUNS=${2:-10}
[[ "$DAYS" =~ ^[0-9]+$ && "$DAYS" -ge 1 && "$DAYS" -le 30 ]] || die "DAYS: 1 to 30"
[[ "$RUNS" =~ ^[0-9]+$ && "$RUNS" -ge 1 && "$RUNS" -le 50 ]] || die "RUNS: 1 to 50"
connection SRC world
PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120s" psql_on SRC -v days="$DAYS" -v runs="$RUNS" <<'SQL'
\pset tuples_only off
\pset format aligned
\pset footer off
WITH top AS (
  SELECT run_id, count(*) AS events
  FROM workflow.workflow_events
  GROUP BY run_id
  ORDER BY count(*) DESC
  LIMIT :runs
), timed AS (
  SELECT e.run_id, e.type, e.created_at,
         lead(e.created_at) OVER (PARTITION BY e.run_id ORDER BY e.created_at, e.id) AS next_at
  FROM workflow.workflow_events e
  JOIN top USING (run_id)
), wakes AS (
  SELECT run_id, created_at, extract(epoch FROM next_at - created_at) AS wait_s
  FROM timed
  WHERE type = 'hook_received' AND next_at IS NOT NULL
    AND created_at > now() - make_interval(days => :days)
)
SELECT left(w.run_id, 14) || '…' AS run, top.events AS run_events,
       to_char(w.created_at AT TIME ZONE 'Europe/Moscow', 'MM-DD') AS day,
       count(*) AS wakes,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY w.wait_s)::numeric, 2) AS wait_p50,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY w.wait_s)::numeric, 2) AS wait_p90,
       round(max(w.wait_s)::numeric, 2) AS wait_max
FROM wakes w
JOIN top USING (run_id)
GROUP BY w.run_id, top.events, 3
ORDER BY top.events DESC, 3;
SQL
