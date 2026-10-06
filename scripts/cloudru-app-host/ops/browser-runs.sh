#!/bin/bash
# How long Bro's errands on its own browser take and what they cost (docs/browser-speed.md, 7) — read only:
#
#   host.py ops NAME browser-runs.sh [SINCE [UNTIL]]
#
# SINCE and UNTIL are dates or times PostgreSQL reads (2026-10-01, 2026-10-01T12:00+03); SINCE defaults to
# seven days ago, UNTIL to now. Reads browser_vm_runs (the runs of the pool and of the VMs) started in the
# window and their `browser-run` cost. Prints aggregates only — counts, seconds, steps, roubles, upstream
# hosts — never a workspace, session, run or anything a person or a page wrote, so the job log holds no one's
# data:
#
#   - runs by day (Moscow) and by who served their model: `together` once any call of the run went to Together
#     (the fast browser's pilot, BROWSER_FAST_WORKSPACES), `deepinfra`, `other`, or `unpriced` without a
#     recorded cost (a run that never settled, or a worker that sent no usage);
#   - the same over the whole window, the before and after of a release or a flag;
#   - the model's calls by upstream host.
#
# A run's time is created_at to finished_at: from Bro recording it, before the sandbox is up, to the worker's
# result, so the sandbox's start counts and the wait of an errand still queued before its run does not.
source "$(dirname "$0")/db-lib.sh"
SINCE=${1:-$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)}
UNTIL=${2:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
# The shape only keeps psql's quoting simple; PostgreSQL itself says whether the date exists.
shape='^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?$'
for value in "$SINCE" "$UNTIL"; do
  [[ "$value" =~ $shape ]] || die "not a date or time: $value"
done
connection SRC app
order=$(PGOPTIONS="-c default_transaction_read_only=on" psql_on SRC -v since="$SINCE" -v until="$UNTIL" \
  <<<"SELECT :'since'::timestamptz < :'until'::timestamptz;") \
  || die "PostgreSQL could not compare SINCE ($SINCE) and UNTIL ($UNTIL): its error is above"
[ "$order" = t ] || die "SINCE ($SINCE) must come before UNTIL ($UNTIL)"
# Every query reads the runs through this CTE: a read-only transaction may not create even a temporary view.
RUNS="WITH runs AS (
  SELECT r.status,
         r.created_at,
         extract(epoch FROM r.finished_at - r.created_at) AS seconds,
         u.cost_rub AS rub,
         NULLIF((u.units->>'steps')::int, 0) AS steps,
         u.units->'hosts' AS hosts,
         CASE WHEN u.id IS NULL THEN 'unpriced'
              WHEN jsonb_typeof(u.units->'hosts') <> 'object' THEN 'other'
              WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(u.units->'hosts') AS k WHERE k ILIKE '%together%')
                THEN 'together'
              WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(u.units->'hosts') AS k WHERE k ILIKE '%deepinfra%')
                THEN 'deepinfra'
              ELSE 'other' END AS served
  FROM browser_vm_runs r
  LEFT JOIN usage_costs u ON u.source = 'browser-run' AND u.run_id = r.id
  WHERE r.created_at >= :'since'::timestamptz AND r.created_at < :'until'::timestamptz
)"
SHAPE="count(*) AS runs,
       count(*) FILTER (WHERE status = 'completed') AS completed,
       count(*) FILTER (WHERE status IN ('failed', 'cancelled')) AS failed,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::numeric, 0) AS sec_p50,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY seconds)::numeric, 0) AS sec_p90,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY steps)::numeric, 0) AS steps_p50,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds / steps)::numeric, 1) AS sec_per_step_p50,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY rub)::numeric, 2) AS rub_p50,
       round(sum(rub), 2) AS rub_sum"
echo "browser_vm_runs from $SINCE to $UNTIL"
PGOPTIONS="-c default_transaction_read_only=on" psql_on SRC -v since="$SINCE" -v until="$UNTIL" <<SQL
\pset tuples_only off
\pset format aligned
\pset footer off

\echo
\echo Runs by day (Moscow) and by who served the model
$RUNS
SELECT to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day, served,
       $SHAPE
FROM runs
GROUP BY 1, 2
ORDER BY 1, 2;

\echo
\echo Runs over the window by who served the model
$RUNS
SELECT served,
       $SHAPE
FROM runs
GROUP BY 1
ORDER BY 1;

\echo
\echo Model calls by upstream host
$RUNS
SELECT h.key AS host,
       count(*) AS runs,
       sum(h.value::text::int) AS calls
FROM runs, jsonb_each(CASE WHEN jsonb_typeof(hosts) = 'object' THEN hosts ELSE '{}'::jsonb END) AS h
GROUP BY 1
ORDER BY 3 DESC;
SQL
