#!/bin/bash
# What phone calls cost and how long people talk, from phone_calls — read only (docs/finmodel/):
#
#   host.py ops NAME phone-minutes.sh [SINCE [UNTIL]]
#
# SINCE defaults to thirty days ago, UNTIL to now. Aggregates only: counts, minutes, percentiles and
# roubles, never a workspace, number or anything said. usage_costs holds no calls (the bridge and ElevenLabs
# bill outside it), so this is where the finance model's "minutes of calls per person" comes from:
#   - calls by state, and the minutes and the carrier's roubles of the connected ones;
#   - minutes per person with calls, and per call: p50, p90, mean, max;
#   - ElevenLabs' own price (cost_usd, only calls that ran through it; GPT-Live's are not priced here).
source "$(dirname "$0")/db-lib.sh"
SINCE=${1:-$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)}
UNTIL=${2:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
shape='^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?$'
for value in "$SINCE" "$UNTIL"; do
  [[ "$value" =~ $shape ]] || die "not a date or time: $value"
done
connection SRC app
PGOPTIONS="-c default_transaction_read_only=on" psql_on SRC -v since="$SINCE" -v until="$UNTIL" <<'SQL'
\pset tuples_only off
\pset format aligned
\pset footer off
\echo Calls by state and direction
SELECT state, direction, count(*) AS calls,
       round(coalesce(sum(duration_seconds), 0) / 60.0, 1) AS minutes,
       round(coalesce(sum(carrier_rub), 0)::numeric, 1) AS carrier_rub,
       round(coalesce(sum(cost_usd), 0)::numeric, 3) AS provider_usd
FROM phone_calls
WHERE created_at >= :'since'::timestamptz AND created_at < :'until'::timestamptz
GROUP BY 1, 2 ORDER BY 3 DESC;

\echo
\echo Connected calls (duration over 5 s): per call, and per person with calls
WITH c AS (
  SELECT workspace_id, duration_seconds / 60.0 AS minutes, coalesce(carrier_rub, 0) AS carrier_rub
  FROM phone_calls
  WHERE created_at >= :'since'::timestamptz AND created_at < :'until'::timestamptz
    AND duration_seconds > 5
), p AS (
  SELECT workspace_id, count(*) AS calls, sum(minutes) AS minutes, sum(carrier_rub) AS carrier_rub
  FROM c GROUP BY 1
)
SELECT 'per call' AS what, count(*) AS n,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)::numeric, 2) AS p50_min,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes)::numeric, 2) AS p90_min,
       round(avg(minutes)::numeric, 2) AS mean_min, round(max(minutes)::numeric, 2) AS max_min
FROM c
UNION ALL
SELECT 'per person', count(*),
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes)::numeric, 2),
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY minutes)::numeric, 2),
       round(avg(minutes)::numeric, 2), round(max(minutes)::numeric, 2)
FROM p
UNION ALL
SELECT 'calls per person', count(*),
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY calls)::numeric, 1),
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY calls)::numeric, 1),
       round(avg(calls)::numeric, 1), max(calls)
FROM p;
SQL
