#!/bin/bash
# The Workflow world's queue as eve sees it, read only — whether a turn waits behind other jobs:
#
#   host.py ops NAME world-queue.sh [SAMPLES [EVERY_S]]
#
# Prints, SAMPLES times (1) EVERY_S seconds apart (5), the graphile-worker jobs by task: how many, how many
# are due and free, locked, waiting for a later run_at, the age of the oldest due free one, and the open
# Postgres sessions that LISTEN (graphile's NOTIFY path; without one a job waits for the 0.5 s poll). Counts
# and seconds only: a job's payload carries the session's events and is never read.
source "$(dirname "$0")/db-lib.sh"
SAMPLES=${1:-1}
EVERY=${2:-5}
[[ "$SAMPLES" =~ ^[0-9]+$ && "$SAMPLES" -ge 1 && "$SAMPLES" -le 120 ]] || die "SAMPLES: 1 to 120"
[[ "$EVERY" =~ ^[0-9]+$ && "$EVERY" -ge 1 && "$EVERY" -le 60 ]] || die "EVERY_S: 1 to 60"
connection SRC world
for ((i = 1; i <= SAMPLES; i++)); do
  PGOPTIONS="-c default_transaction_read_only=on" psql_on SRC <<'SQL'
\pset tuples_only off
\pset format aligned
\pset footer off
SELECT to_char(now() AT TIME ZONE 'UTC', 'HH24:MI:SS') AS utc,
       t.identifier AS task,
       count(*) AS jobs,
       count(*) FILTER (WHERE j.is_available AND j.run_at <= now()) AS due_free,
       count(*) FILTER (WHERE j.locked_at IS NOT NULL) AS locked,
       count(*) FILTER (WHERE j.run_at > now()) AS later,
       round(extract(epoch FROM now() - min(j.run_at) FILTER (WHERE j.is_available AND j.run_at <= now()))::numeric, 1)
         AS oldest_due_s
FROM graphile_worker._private_jobs j
JOIN graphile_worker._private_tasks t ON t.id = j.task_id
GROUP BY t.identifier
ORDER BY jobs DESC;
SELECT count(*) FILTER (WHERE query ILIKE 'LISTEN%') AS listening,
       count(*) AS sessions
FROM pg_stat_activity
WHERE datname = current_database();
SQL
  [ "$i" -lt "$SAMPLES" ] && sleep "$EVERY"
done
