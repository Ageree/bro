#!/bin/bash
# How much each Workflow run's history weighs, read only — what a session replays on every turn:
#
#   host.py ops NAME world-runs.sh [LIMIT]
#
# Prints the active runs with the most stored events (LIMIT, 10): the run's workflow, status and age, its
# events and their stored size, its steps and theirs, and the same as percentiles over every active run.
# Sizes come from pg_column_size, which reads a stored value's size without opening it: no event or step
# payload is read, and none is printed.
source "$(dirname "$0")/db-lib.sh"
LIMIT=${1:-10}
[[ "$LIMIT" =~ ^[0-9]+$ && "$LIMIT" -ge 1 && "$LIMIT" -le 50 ]] || die "LIMIT: 1 to 50"
connection SRC world
PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120s" psql_on SRC -v limit="$LIMIT" <<'SQL'
\pset tuples_only off
\pset format aligned
\pset footer off
WITH ev AS (
  SELECT run_id, count(*) AS n,
         sum(coalesce(pg_column_size(payload_cbor), 0) + coalesce(pg_column_size(payload), 0)) AS bytes
  FROM workflow.workflow_events GROUP BY run_id
), st AS (
  SELECT run_id, count(*) AS n,
         sum(coalesce(pg_column_size(input_cbor), 0) + coalesce(pg_column_size(output_cbor), 0)
             + coalesce(pg_column_size(input), 0) + coalesce(pg_column_size(output), 0)) AS bytes
  FROM workflow.workflow_steps GROUP BY run_id
), run_weight AS (
  SELECT r.id AS run_id, left(r.name, 40) AS workflow, r.status, r.created_at,
         coalesce(ev.n, 0) AS events, coalesce(ev.bytes, 0) AS event_bytes,
         coalesce(st.n, 0) AS steps, coalesce(st.bytes, 0) AS step_bytes
  FROM workflow.workflow_runs r
  LEFT JOIN ev ON ev.run_id = r.id
  LEFT JOIN st ON st.run_id = r.id
  WHERE r.status IN ('pending', 'running')
)
SELECT left(run_id, 14) || '…' AS run, workflow, status,
       round(extract(epoch FROM now() - created_at) / 86400, 1) AS age_days,
       events, pg_size_pretty(event_bytes) AS event_size,
       steps, pg_size_pretty(step_bytes) AS step_size
FROM run_weight
ORDER BY event_bytes DESC
LIMIT :limit;
WITH ev AS (
  SELECT run_id, count(*) AS n,
         sum(coalesce(pg_column_size(payload_cbor), 0) + coalesce(pg_column_size(payload), 0)) AS bytes
  FROM workflow.workflow_events GROUP BY run_id
), st AS (
  SELECT run_id, count(*) AS n,
         sum(coalesce(pg_column_size(input_cbor), 0) + coalesce(pg_column_size(output_cbor), 0)
             + coalesce(pg_column_size(input), 0) + coalesce(pg_column_size(output), 0)) AS bytes
  FROM workflow.workflow_steps GROUP BY run_id
), run_weight AS (
  SELECT r.id AS run_id, left(r.name, 40) AS workflow, r.status, r.created_at,
         coalesce(ev.n, 0) AS events, coalesce(ev.bytes, 0) AS event_bytes,
         coalesce(st.n, 0) AS steps, coalesce(st.bytes, 0) AS step_bytes
  FROM workflow.workflow_runs r
  LEFT JOIN ev ON ev.run_id = r.id
  LEFT JOIN st ON st.run_id = r.id
  WHERE r.status IN ('pending', 'running')
)
SELECT count(*) AS active_runs,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY events) AS events_p50,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY events) AS events_p90,
       max(events) AS events_max,
       pg_size_pretty(percentile_disc(0.5) WITHIN GROUP (ORDER BY event_bytes)) AS size_p50,
       pg_size_pretty(percentile_disc(0.9) WITHIN GROUP (ORDER BY event_bytes)) AS size_p90,
       pg_size_pretty(max(event_bytes)) AS size_max
FROM run_weight;
SQL
