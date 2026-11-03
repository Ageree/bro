#!/bin/bash
# What a person costs Bro per active day, from usage_costs — read only (docs/finmodel/):
#
#   host.py ops NAME cost-per-user.sh [SINCE [UNTIL]]
#
# SINCE and UNTIL are dates or times PostgreSQL reads; SINCE defaults to fourteen days ago, UNTIL to now.
# Prints aggregates only — counts, percentiles and shares — never a workspace id or anything a person wrote.
# Roubles are what usage_costs holds (model, browser model, VM share, proxy); the browser VM's powered-on
# time stays out (`browser-vm` is the host's rent, a fixed cost), as calls and voice do (usage_costs has none).
#
#   - people with any cost in the window, active days per person, and roubles per active day: p25, p50, p75,
#     p90 and the mean, with and without the single most expensive person (the owner's testing is one);
#   - the same by source: the mean roubles per person-day each source adds;
#   - roubles per person-day for people with 3 or more active days (the steady users).
source "$(dirname "$0")/db-lib.sh"
SINCE=${1:-$(date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ)}
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
\echo Per person, roubles per active day (Moscow days with any cost)
WITH days AS (
  SELECT workspace_id, source,
         (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS day,
         sum(cost_rub) AS rub
  FROM usage_costs
  WHERE occurred_at >= :'since'::timestamptz AND occurred_at < :'until'::timestamptz
    AND source <> 'browser-vm'
  GROUP BY 1, 2, 3
), person_days AS (
  SELECT workspace_id, day, sum(rub) AS rub FROM days GROUP BY 1, 2
), people AS (
  SELECT workspace_id, count(*) AS active_days, sum(rub) AS total, sum(rub) / count(*) AS per_day
  FROM person_days GROUP BY 1
), ranked AS (
  SELECT *, row_number() OVER (ORDER BY per_day DESC) AS rk FROM people
)
SELECT 'all' AS who, count(*) AS people, round(avg(active_days), 1) AS days_avg,
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY per_day)::numeric, 2) AS p25,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY per_day)::numeric, 2) AS p50,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY per_day)::numeric, 2) AS p75,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY per_day)::numeric, 2) AS p90,
       round(avg(per_day)::numeric, 2) AS mean, round(max(per_day)::numeric, 2) AS max
FROM ranked
UNION ALL
SELECT 'without the top one', count(*), round(avg(active_days), 1),
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY per_day)::numeric, 2),
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY per_day)::numeric, 2),
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY per_day)::numeric, 2),
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY per_day)::numeric, 2),
       round(avg(per_day)::numeric, 2), round(max(per_day)::numeric, 2)
FROM ranked WHERE rk > 1
UNION ALL
SELECT 'steady: 3+ days, without the top', count(*), round(avg(active_days), 1),
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY per_day)::numeric, 2),
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY per_day)::numeric, 2),
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY per_day)::numeric, 2),
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY per_day)::numeric, 2),
       round(avg(per_day)::numeric, 2), round(max(per_day)::numeric, 2)
FROM ranked WHERE rk > 1 AND active_days >= 3;

\echo
\echo Roubles per person-day by source, without the single most expensive person
WITH days AS (
  SELECT workspace_id, source, (occurred_at AT TIME ZONE 'Europe/Moscow')::date AS day, sum(cost_rub) AS rub
  FROM usage_costs
  WHERE occurred_at >= :'since'::timestamptz AND occurred_at < :'until'::timestamptz
    AND source <> 'browser-vm'
  GROUP BY 1, 2, 3
), totals AS (
  SELECT workspace_id, sum(rub) AS total FROM days GROUP BY 1
), top AS (
  SELECT workspace_id FROM totals ORDER BY total DESC LIMIT 1
), person_days AS (
  SELECT count(DISTINCT (workspace_id, day)) AS n FROM days WHERE workspace_id NOT IN (SELECT workspace_id FROM top)
)
SELECT d.source, round(sum(d.rub)::numeric, 1) AS rub_all,
       round((sum(d.rub) / (SELECT n FROM person_days))::numeric, 2) AS rub_per_person_day
FROM days d WHERE d.workspace_id NOT IN (SELECT workspace_id FROM top)
GROUP BY d.source ORDER BY rub_all DESC;
SQL
