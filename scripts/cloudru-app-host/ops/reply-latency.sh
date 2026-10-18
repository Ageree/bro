#!/bin/bash
# How long a person waits for Bro's first message, from turn_log and turn_log_entries — read only:
#
#   host.py ops NAME reply-latency.sh [SINCE [UNTIL]]
#
# SINCE and UNTIL are dates or times PostgreSQL reads (2026-10-11, 2026-10-18T05:00Z); SINCE defaults to seven
# days ago, UNTIL to now. A person's turn that ended (`completed`) counts; its first `bro` line of the transcript
# (a send_message call as the model asked for it, or the turn's own text) is the reply. Needs
# OWNER_TRANSCRIPTS=on: without the transcript there is no reply line and a turn shows as `no_reply`. The time
# runs from the person's line (`message.received`) and from the turn's start (`turn.started`); neither sees the
# way in before eve (Telegram, tg-bridge) nor the reply's way out (Telegram's sendMessage): `[telegram] reply`
# in eve's log holds those. Prints aggregates only — counts and milliseconds by channel and day, never a
# workspace, session or anything a person wrote — and the cache share of the first step of those turns
# (usage_costs), which is what decides how long the first step reads.
source "$(dirname "$0")/db-lib.sh"
SINCE=${1:-$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)}
UNTIL=${2:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
shape='^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?$'
for value in "$SINCE" "$UNTIL"; do
  [[ "$value" =~ $shape ]] || die "not a date or time: $value"
done
connection SRC app
TURNS="WITH person AS (
  SELECT t.session_id, t.turn_id, t.channel, t.started_at, t.ended_at, t.steps
  FROM turn_log t
  WHERE t.kind = 'person' AND t.outcome = 'completed'
    AND t.started_at >= :'since'::timestamptz AND t.started_at < :'until'::timestamptz
), timed AS (
  SELECT p.*,
         (SELECT min(e.created_at) FROM turn_log_entries e
          WHERE e.session_id = p.session_id AND e.turn_id = p.turn_id AND e.role = 'person'
            AND e.created_at BETWEEN p.started_at - interval '10 seconds' AND p.ended_at) AS heard_at,
         (SELECT min(e.created_at) FROM turn_log_entries e
          WHERE e.session_id = p.session_id AND e.turn_id = p.turn_id AND e.role = 'bro'
            AND e.created_at BETWEEN p.started_at AND p.ended_at) AS replied_at,
         (SELECT (u.units->>'inputTokens')::bigint FROM usage_costs u
          WHERE u.idempotency_key = 'step:' || p.session_id || ':' || p.turn_id || ':0') AS first_input,
         (SELECT COALESCE((u.units->>'cachedInputTokens')::bigint, 0) FROM usage_costs u
          WHERE u.idempotency_key = 'step:' || p.session_id || ':' || p.turn_id || ':0') AS first_cached
  FROM person p
), measured AS (
  SELECT channel, started_at, steps, first_input, first_cached,
         1000 * extract(epoch FROM replied_at - heard_at) AS heard_ms,
         1000 * extract(epoch FROM replied_at - started_at) AS start_ms,
         replied_at IS NULL AS no_reply
  FROM timed
)"
echo "person turns from $SINCE to $UNTIL"
PGOPTIONS="-c default_transaction_read_only=on" psql_on SRC -v since="$SINCE" -v until="$UNTIL" <<SQL
\pset tuples_only off
\pset format aligned
\pset footer off

\echo
\echo By channel: ms from the person's message (heard) and from the turn's start to the first reply line
$TURNS
SELECT channel,
       count(*) AS turns,
       count(*) FILTER (WHERE no_reply) AS no_reply,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY heard_ms)) AS heard_p50,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY heard_ms)) AS heard_p75,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY heard_ms)) AS heard_p90,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY start_ms)) AS start_p50,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY start_ms)) AS start_p90,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY steps)) AS steps_p50,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY first_input)::numeric / 1000, 1) AS first_input_k,
       round(100.0 * sum(first_cached) / NULLIF(sum(first_input), 0), 1) AS first_cache_pct
FROM measured
GROUP BY channel
ORDER BY turns DESC;

\echo
\echo By channel and day (Moscow)
$TURNS
SELECT channel, (started_at AT TIME ZONE 'Europe/Moscow')::date AS day,
       count(*) AS turns,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY heard_ms)) AS heard_p50,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY heard_ms)) AS heard_p90,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY first_input)::numeric / 1000, 1) AS first_input_k,
       round(100.0 * sum(first_cached) / NULLIF(sum(first_input), 0), 1) AS first_cache_pct
FROM measured
GROUP BY 1, 2
ORDER BY 1, 2;

\echo
\echo By cache share of the first step (the reply's main cost): ms from the person's message
$TURNS
SELECT channel,
       CASE WHEN first_input IS NULL THEN 'unknown'
            WHEN first_cached < 0.3 * first_input THEN '0-30%'
            WHEN first_cached < 0.7 * first_input THEN '30-70%'
            WHEN first_cached < 0.9 * first_input THEN '70-90%'
            ELSE '90-100%' END AS first_cache,
       count(*) AS turns,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY heard_ms)) AS heard_p50,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY heard_ms)) AS heard_p90,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY first_input)::numeric / 1000, 1) AS first_input_k
FROM measured
GROUP BY 1, 2
ORDER BY 1, 2;
SQL
