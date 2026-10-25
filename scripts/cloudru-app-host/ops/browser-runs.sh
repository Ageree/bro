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
#   - the model's calls by upstream host;
#   - runs by engine (browser-use's `agent`, `code`, `jev-then-agent`) and browser (chrome, helium), with where a
#     run's time went by the worker's clock (`runTiming` in agent/lib/costs/browser.ts, recorded since
#     2026-10-25): its wait before the agent started, its first step, and the median and p95 over the runs of
#     each run's own median and p95 time between steps; and the model's tokens a step, with the cached share;
#   - errands: an errand is the chain of browser_runs a run hands over to (`retried_as_run_id`: a queued start,
#     a retry past an anti-bot wall, a follow-up), counted by when its first row was recorded. Its time to the
#     first report the person got, to the last, the runs in it, and its roubles: the model and proxy of its
#     runs, its share of the sandbox, and the model of its report turns (`browser-report`). The time to the last
#     report holds the person's own replies when the errand asked them something.
#
# A run's time is created_at to finished_at: from Bro recording it, before the sandbox is up, to the worker's
# result, so the sandbox's start counts and the wait of an errand still queued before its run does not.
# Runs before 2026-10-25 have no engine, browser or timing recorded: they show as `-` and leave those blank.
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
         coalesce(u.units->>'engine', '-') AS engine,
         coalesce(u.units->>'browser', '-') AS browser,
         (u.units->'timing'->>'waitMs')::numeric / 1000 AS wait_sec,
         (u.units->'timing'->>'firstStepMs')::numeric / 1000 AS first_step_sec,
         (u.units->'timing'->'stepMs'->>'p50')::numeric / 1000 AS step_p50_sec,
         (u.units->'timing'->'stepMs'->>'p95')::numeric / 1000 AS step_p95_sec,
         (u.units->>'inputTokens')::numeric AS input_tokens,
         (u.units->>'cachedInputTokens')::numeric AS cached_tokens,
         (u.units->>'outputTokens')::numeric AS output_tokens,
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
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds)::numeric, 0) AS sec_p95,
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

\echo
\echo Runs over the window by engine and browser
$RUNS
SELECT engine, browser,
       $SHAPE
FROM runs
GROUP BY 1, 2
ORDER BY 1, 2;

\echo
\echo Where the time of the runs went, and the tokens of the model a step, by engine and browser
$RUNS
SELECT engine, browser,
       count(*) FILTER (WHERE step_p50_sec IS NOT NULL) AS timed,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_sec)::numeric, 1) AS wait_p50,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY first_step_sec)::numeric, 1) AS first_step_p50,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY step_p50_sec)::numeric, 1) AS step_p50,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY step_p95_sec)::numeric, 1) AS step_p95_p50,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY step_p95_sec)::numeric, 1) AS step_p95_p90,
       round(sum(input_tokens) / NULLIF(sum(steps) FILTER (WHERE input_tokens IS NOT NULL), 0)) AS in_per_step,
       round(sum(output_tokens) / NULLIF(sum(steps) FILTER (WHERE output_tokens IS NOT NULL), 0)) AS out_per_step,
       round(100 * sum(cached_tokens) / NULLIF(sum(input_tokens), 0)) AS cached_pct
FROM runs
GROUP BY 1, 2
ORDER BY 1, 2;

\echo
\echo Errands: chains of browser_runs, by the day (Moscow) their first row was recorded
WITH RECURSIVE heads AS (
  SELECT b.id, b.created_at
  FROM browser_runs b
  WHERE b.created_at >= :'since'::timestamptz AND b.created_at < :'until'::timestamptz
    AND NOT EXISTS (SELECT 1 FROM browser_runs p WHERE p.retried_as_run_id = b.id)
), chain AS (
  SELECT h.id AS head, h.id, 1 AS depth FROM heads h
  UNION ALL
  SELECT c.head, b.retried_as_run_id, c.depth + 1
  FROM chain c JOIN browser_runs b ON b.id = c.id
  WHERE b.retried_as_run_id IS NOT NULL AND c.depth < 32
), errands AS (
  SELECT h.created_at,
         count(DISTINCT c.id) AS runs,
         extract(epoch FROM min(b.report_delivered_at) - h.created_at) AS first_report_sec,
         extract(epoch FROM max(b.report_delivered_at) - h.created_at) AS last_report_sec,
         bool_or(b.report_delivered_at IS NOT NULL) AS reported,
         (SELECT sum(u.cost_rub) FROM usage_costs u
          WHERE u.run_id IN (SELECT c2.id FROM chain c2 WHERE c2.head = h.id)
            AND u.source IN ('browser-run', 'proxy', 'browser-vm', 'browser-report')) AS rub
  FROM heads h
  JOIN chain c ON c.head = h.id
  JOIN browser_runs b ON b.id = c.id
  GROUP BY h.id, h.created_at
)
SELECT to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day,
       count(*) AS errands,
       count(*) FILTER (WHERE reported) AS reported,
       round(avg(runs), 1) AS runs_avg,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY first_report_sec)::numeric, 0) AS first_report_p50,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY first_report_sec)::numeric, 0) AS first_report_p95,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY last_report_sec)::numeric, 0) AS last_report_p50,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY rub)::numeric, 2) AS rub_p50,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY rub)::numeric, 2) AS rub_p95,
       round(sum(rub), 2) AS rub_sum
FROM errands
GROUP BY 1
ORDER BY 1;
SQL
