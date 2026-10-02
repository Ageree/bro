#!/bin/bash
# What a step of Bro's own turns costs, from usage_costs (docs/agent-costs.md, 3.1 and 3.2) — read only:
#
#   host.py ops NAME usage-stats.sh [SINCE [UNTIL]]
#
# SINCE and UNTIL are dates or times PostgreSQL reads (2026-10-01, 2026-10-01T12:00+03); SINCE defaults to
# seven days ago, UNTIL to now. Prints aggregates only — counts, token medians, cache shares, roubles — never a
# workspace, session, run or anything a person wrote, so the job log holds no one's data:
#
#   - steps by source and channel: median input tokens (p25, p75), cache share (cached over input, summed),
#     roubles per step (mean, median) and in all; `interactive` is chat and browser-report together, the
#     steps that carry the full instructions (scripts/costs/step-context.ts);
#   - the same for interactive steps by day (Moscow), to compare before and after a release;
#   - steps by their place in the whole session, counted from its first step (Telegram's is one session for
#     good): whether a step grows with the conversation (roadmap item 28);
#   - errands: roubles per run_id over every source that carries it (model in the browser, its VM and proxy,
#     the report turns), for the runs whose first cost was recorded in the window — usage_costs has no start
#     of a run, and a run's costs land within minutes of each other.
#
# A step without a price (units.unpriced) counts in tokens, not in roubles.
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
# Every query reads the steps through this CTE: a read-only transaction may not create even a temporary view.
# It holds every step up to UNTIL, so a step's place counts the whole session, not just the window; each query
# keeps those from SINCE on.
STEPS="WITH all_steps AS (
  SELECT u.source,
         CASE WHEN u.source IN ('chat', 'browser-report') THEN 'interactive' ELSE u.source END AS kind,
         COALESCE(c.channel, 'none') AS channel,
         u.session_id,
         u.occurred_at,
         u.cost_rub,
         COALESCE((u.units->>'unpriced')::boolean, false) AS unpriced,
         (u.units->>'inputTokens')::bigint AS input,
         COALESCE((u.units->>'cachedInputTokens')::bigint, 0) AS cached,
         COALESCE((u.units->>'outputTokens')::bigint, 0) AS output
  FROM usage_costs u
  LEFT JOIN chats c ON c.session_id = u.session_id AND c.workspace_id = u.workspace_id
  WHERE u.source IN ('chat', 'background', 'browser-report')
    AND u.units ? 'inputTokens'
    AND u.occurred_at < :'until'::timestamptz
), placed_steps AS (
  SELECT *, row_number() OVER (PARTITION BY session_id, kind ORDER BY occurred_at) AS place
  FROM all_steps
), steps AS (
  SELECT * FROM placed_steps WHERE occurred_at >= :'since'::timestamptz
)"
echo "usage_costs from $SINCE to $UNTIL"
PGOPTIONS="-c default_transaction_read_only=on" psql_on SRC -v since="$SINCE" -v until="$UNTIL" <<SQL
\pset tuples_only off
\pset format aligned
\pset footer off

\echo
\echo Steps by kind, source and channel (tokens in thousands; cache = cached / input, summed)
$STEPS
SELECT kind, source, channel,
       count(*) AS steps,
       count(DISTINCT session_id) AS sessions,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY input)::numeric / 1000, 1) AS input_p50,
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY input)::numeric / 1000, 1) AS input_p25,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY input)::numeric / 1000, 1) AS input_p75,
       round(100.0 * sum(cached) / NULLIF(sum(input), 0), 1) AS cache_pct,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY output)::numeric, 0) AS output_p50,
       round(avg(cost_rub) FILTER (WHERE NOT unpriced), 4) AS rub_avg,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_rub) FILTER (WHERE NOT unpriced))::numeric, 4) AS rub_p50,
       round(sum(cost_rub), 2) AS rub_sum,
       count(*) FILTER (WHERE unpriced) AS unpriced
FROM steps
GROUP BY GROUPING SETS ((kind), (kind, source, channel))
ORDER BY kind, source NULLS FIRST, channel NULLS FIRST;

\echo
\echo Interactive steps by day (Moscow)
$STEPS
SELECT (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS day,
       count(*) AS steps,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY input)::numeric / 1000, 1) AS input_p50,
       round(100.0 * sum(cached) / NULLIF(sum(input), 0), 1) AS cache_pct,
       round(avg(cost_rub) FILTER (WHERE NOT unpriced), 4) AS rub_avg,
       round(sum(cost_rub), 2) AS rub_sum
FROM steps
WHERE kind = 'interactive'
GROUP BY 1
ORDER BY 1;

\echo
\echo Interactive steps by their place in the whole session (does a step grow with the conversation?)
$STEPS, placed AS (
  SELECT channel, input, cached, place
  FROM steps
  WHERE kind = 'interactive' AND session_id IS NOT NULL
)
SELECT channel,
       CASE WHEN place <= 10 THEN '001-010'
            WHEN place <= 50 THEN '011-050'
            WHEN place <= 100 THEN '051-100'
            WHEN place <= 200 THEN '101-200'
            WHEN place <= 500 THEN '201-500'
            ELSE '501+' END AS place,
       count(*) AS steps,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY input)::numeric / 1000, 1) AS input_p50,
       round(max(input)::numeric / 1000, 1) AS input_max,
       round(100.0 * sum(cached) / NULLIF(sum(input), 0), 1) AS cache_pct
FROM placed
GROUP BY 1, 2
ORDER BY 1, 2;

\echo
\echo Errands: roubles per run over every source that carries its run_id (runs whose first cost falls in the window)
WITH runs AS (
  SELECT run_id,
         min(occurred_at) AS first_cost,
         sum(cost_rub) AS rub,
         sum(cost_rub) FILTER (WHERE source = 'browser-run') AS browser_model,
         sum(cost_rub) FILTER (WHERE source = 'browser-vm') AS vm,
         sum(cost_rub) FILTER (WHERE source = 'proxy') AS proxy,
         sum(cost_rub) FILTER (WHERE source = 'browser-report') AS report_turns
  FROM usage_costs
  WHERE run_id IS NOT NULL
  GROUP BY run_id
)
SELECT count(*) AS errands,
       round(avg(rub), 2) AS rub_avg,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY rub)::numeric, 2) AS rub_p50,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY rub)::numeric, 2) AS rub_p90,
       round(avg(COALESCE(browser_model, 0)), 2) AS browser_model_avg,
       round(avg(COALESCE(vm, 0)), 2) AS vm_avg,
       round(avg(COALESCE(proxy, 0)), 2) AS proxy_avg,
       round(avg(COALESCE(report_turns, 0)), 2) AS report_turns_avg
FROM runs
WHERE first_cost >= :'since'::timestamptz AND first_cost < :'until'::timestamptz;
SQL
