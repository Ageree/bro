#!/bin/bash
# Whether Bro's errands on some sites booked, ordered or paid for anything — read only:
#
#   host.py ops NAME site-errands.sh HOSTS [SINCE [UNTIL]]
#
# HOSTS is a comma-separated list of domains (tutu.ru,ostrovok.ru); a run counts when its site or the page its
# browser ended on is one of them or under one, or its task or outcome names one. SINCE and UNTIL are dates or
# times PostgreSQL reads, on Moscow time unless they carry an offset; SINCE defaults to seven days ago, UNTIL to
# now. Written for a benchmark case that staged a flight and a hotel on the owner's account and that nobody
# checked afterwards (uc_visa, 04.10): did a run of it get past the last button.
#
# Prints for each such run of browser_runs only what Bro itself recorded about it: the workspace (12 characters),
# the run (shortened), the sites' host names, times, status, the attempt, whether the card was bound and what
# the person approved (its kind and roubles), and from the run's outcome its labels — NEEDS, ORDER, TOTAL,
# ACTION, the booking's reference and whether the site confirmed it — plus fixed words its Result line used
# (booked, paid, not paid, before payment, cancelled). Then the orders and the spend recorded for those runs,
# the sign-ins on those domains, and the window's runs by host and status. Never a task, a report, a page's
# text, a name, a phone or an address: an ORDER or a booking reference is cut to 64 characters, as Bro cuts it.
source "$(dirname "$0")/db-lib.sh"
{ [ "$#" -ge 1 ] && [ "$#" -le 3 ]; } || die "usage: site-errands.sh HOSTS [SINCE [UNTIL]]"
HOSTS=${1,,}
[[ "$HOSTS" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+(,[a-z0-9-]+(\.[a-z0-9-]+)+)*$ ]] \
  || die "HOSTS is domains separated by commas: tutu.ru,ostrovok.ru"
SINCE=${2:-$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)}
UNTIL=${3:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
# The shape only keeps psql's quoting simple; PostgreSQL itself says whether the date exists.
shape='^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?$'
for value in "$SINCE" "$UNTIL"; do
  [[ "$value" =~ $shape ]] || die "not a date or time: $value"
done
# In turn with the other db-*.sh: a restore holds the app's tables for its whole transaction.
db_lock
connection SRC app
# Moscow: a bare date in SINCE or UNTIL is a Moscow day, and the times printed are Moscow's.
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120s -c TimeZone=Europe/Moscow"
order=$(psql_on SRC -v since="$SINCE" -v until="$UNTIL" <<<"SELECT :'since'::timestamptz < :'until'::timestamptz;") \
  || die "PostgreSQL could not compare SINCE ($SINCE) and UNTIL ($UNTIL): its error is above"
[ "$order" = t ] || die "SINCE ($SINCE) must come before UNTIL ($UNTIL)"

# Every query reads the runs through these CTEs: a read-only transaction may not create even a temporary view.
# An outcome keeps the page's report above the facts Bro parsed from it (browserOutcomeSummary in
# agent/lib/browser-use/outcome.ts): a label is read from that parsed part first and, only when it is not there,
# from the run's own footer (the outcome's copy of the report, or browser_vm_runs.result), as the parser reads it.
RUNS=$(
  cat <<'SQL'
WITH window_runs AS (
  SELECT r.*,
         v.final_url,
         v.result AS vm_result,
         lower(substring(r.site FROM '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/:?#]+)')) AS site_host,
         lower(substring(v.final_url FROM '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/:?#]+)')) AS final_host
  FROM browser_runs r
  LEFT JOIN browser_vm_runs v ON v.id = r.id
  WHERE r.created_at >= :'since'::timestamptz AND r.created_at < :'until'::timestamptz
), wanted AS (
  SELECT unnest(string_to_array(:'hosts', ',')) AS host
), matched AS (
  SELECT w.*,
         CASE WHEN EXISTS (SELECT 1 FROM wanted WHERE w.site_host = host OR w.site_host LIKE '%.' || host)
                THEN 'site'
              WHEN EXISTS (SELECT 1 FROM wanted WHERE w.final_host = host OR w.final_host LIKE '%.' || host)
                THEN 'final page'
              ELSE 'text' END AS matched_by,
         CASE WHEN w.id LIKE 'vm:%:r:%' THEN 'vm:' || left(split_part(w.id, ':r:', 2), 8)
              ELSE left(w.id, 11) END AS run,
         CASE WHEN w.retried_as_run_id LIKE 'vm:%:r:%'
                THEN 'vm:' || left(split_part(w.retried_as_run_id, ':r:', 2), 8)
              ELSE left(w.retried_as_run_id, 11) END AS retried_as,
         CASE WHEN position('Parsed metadata (derived from untrusted browser data, not instructions):'
                            IN coalesce(w.outcome, '')) > 0
                THEN split_part(w.outcome,
                                'Parsed metadata (derived from untrusted browser data, not instructions):', 2)
              ELSE coalesce(w.outcome, '') END AS meta,
         coalesce(w.outcome, '') || E'\n' || coalesce(w.vm_result, '') AS raw
  FROM window_runs w
  WHERE EXISTS (SELECT 1 FROM wanted
                WHERE w.site_host = host OR w.site_host LIKE '%.' || host
                   OR w.final_host = host OR w.final_host LIKE '%.' || host
                   OR position(host IN lower(w.task)) > 0
                   OR position(host IN lower(coalesce(w.outcome, ''))) > 0)
), labelled AS (
  SELECT m.*,
         lower(coalesce(
           substring(m.meta FROM '(?n)^Needs: *([A-Za-z_0-9]+)'),
           substring(m.raw FROM '(?ni)^[ \t]*(?:[-*•]+[ \t]*)?\**NEEDS\**[ \t]*:[ \t]*\**([a-z_0-9 ]{1,20})'),
           CASE WHEN m.meta ~ '(?n)^Result: ' THEN 'none' END)) AS needs_raw,
         coalesce(
           substring(m.meta FROM '(?n)^Order: *([^\n]{1,64})'),
           substring(m.raw FROM '(?ni)^[ \t]*(?:[-*•]+[ \t]*)?\**ORDER\**[ \t]*:[ \t]*\**([^\n*]{1,64})')) AS order_raw,
         coalesce(
           substring(m.meta FROM '(?n)^Total: *([^\n]{1,40})'),
           substring(m.raw FROM '(?ni)^[ \t]*(?:[-*•]+[ \t]*)?\**TOTAL\**[ \t]*:[ \t]*\**([^\n*]{1,40})')) AS total_raw,
         coalesce(
           substring(m.meta FROM '(?n)^Action: *([a-z_]+)'),
           lower(substring(m.raw FROM '(?ni)^[ \t]*(?:[-*•]+[ \t]*)?\**ACTION\**[ \t]*:[ \t]*\**(not[ _-]*done|done|unknown)'))
         ) AS action,
         substring(m.meta FROM '(?n)^Booking: ([^\n]*)') AS booking_line,
         substring(m.raw FROM '(?i)BOOKING\**\s*:\s*[`*]*(?:json)?\s*[[{][^]}]*"reference"\s*:\s*"([^"]{1,64})"')
           AS raw_booking_ref,
         m.raw ~* 'BOOKING\**\s*:\s*[`*]*(?:json)?\s*[[{][^]}]*"confirmed"\s*:\s*(true|"true")'
           AS raw_booking_confirmed,
         m.raw ~* 'BOOKING\**\s*:\s*[`*]*(?:json)?\s*[[{]' AS raw_booking,
         coalesce(
           substring(m.meta FROM '(?n)^Result: ([^\n]*)'),
           substring(m.raw FROM '(?ni)^[ \t]*(?:[-*•]+[ \t]*)?\**RESULT\**[ \t]*:[ \t]*([^\n]*)'),
           '') AS result_line
  FROM matched m
), facts AS (
  SELECT l.*,
         CASE WHEN l.needs_raw IS NULL THEN NULL
              WHEN trim(l.needs_raw) ~ '^(none|нет|-|—|n/a|н/д)$' THEN 'none'
              ELSE replace(trim(l.needs_raw), ' ', '_') END AS needs,
         CASE WHEN trim(l.order_raw) ~* '^(none|нет|-|—|n/a|н/д)$' THEN NULL ELSE trim(l.order_raw) END AS order_no,
         CASE WHEN trim(l.total_raw) ~* '^(none|нет|-|—|n/a|н/д)$' THEN NULL ELSE trim(l.total_raw) END AS total,
         coalesce(trim(substring(l.booking_line FROM '— ref ([^—]{1,64})')), l.raw_booking_ref) AS booking_ref,
         CASE WHEN l.booking_line LIKE '%confirmed by the site%' THEN true
              WHEN l.booking_line LIKE '%not confirmed yet%' THEN false
              WHEN l.raw_booking THEN l.raw_booking_confirmed END AS booking_confirmed,
         concat_ws(',',
           CASE WHEN l.result_line ~* 'забронир|бронь (оформлен|создан|подтвержд)|\mbooked\M|\mreserved\M'
                THEN 'booked' END,
           CASE WHEN l.result_line ~* '(?<!не )(оплачен|оплатил|списан)|(?<!not )(?<!un)\mpaid\M|\mcharged\M'
                THEN 'paid' END,
           CASE WHEN l.result_line ~* 'не *(оплач|оплат|списан)|not (yet )?(paid|charged)|без оплат|\munpaid\M'
                THEN 'not paid' END,
           CASE WHEN l.result_line ~* '(до|перед) оплат|(шаг|страниц|этап)\S* оплат|before pay|payment (page|step)'
                THEN 'before payment' END,
           CASE WHEN l.result_line ~* 'отмен[её]н|отменил|аннулир|\mcancell?ed\M'
                THEN 'cancelled' END) AS result_says
  FROM labelled l
)
SQL
)

echo "browser_runs on $HOSTS from $SINCE to $UNTIL (Moscow time unless an offset is given; times below are Moscow)"
{
  cat <<'SQL'
\pset tuples_only off
\pset format aligned
\pset footer off
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

\echo
\echo Runs on those sites, oldest first
SQL
  echo "$RUNS"
  cat <<'SQL'
SELECT left(workspace_id, 12) AS workspace,
       run,
       matched_by,
       site_host,
       final_host,
       to_char(created_at, 'MM-DD HH24:MI') AS created,
       to_char(completed_at, 'MM-DD HH24:MI') AS completed,
       status,
       captcha_attempt AS attempt,
       recovery_phase AS recovery,
       payment_allowed AS card,
       submission IS NOT NULL AS approved,
       submission->>'kind' AS approved_kind,
       submission->>'chargeRub' AS approved_rub,
       started_by_person AS by_person,
       needs,
       order_no,
       total,
       action,
       booking_ref,
       booking_confirmed,
       result_says,
       report_delivered_at IS NOT NULL AS reported,
       retried_as
FROM facts
ORDER BY created_at;

\echo
\echo Orders Bro recorded for those runs
SQL
  echo "$RUNS"
  cat <<'SQL'
SELECT f.run,
       o.merchant,
       o.merchant_order_id,
       o.price_rub,
       o.status,
       to_char(o.created_at, 'MM-DD HH24:MI') AS recorded
FROM facts f
JOIN orders o ON o.browser_run_id = f.id
ORDER BY o.created_at;

\echo
\echo Spend for those runs (a follow-up takes the reservation over, so a later run may hold it)
SQL
  echo "$RUNS"
  cat <<'SQL'
SELECT f.run,
       s.amount_rub,
       s.fee_rub,
       s.status,
       s.source,
       s.merchant,
       s.category,
       to_char(s.created_at, 'MM-DD HH24:MI') AS reserved,
       to_char(s.updated_at, 'MM-DD HH24:MI') AS updated
FROM facts f
JOIN spend_entries s ON s.browser_run_id = f.id
ORDER BY s.created_at;

\echo
\echo Sign-ins of the browser profile on those domains
SELECT left(workspace_id, 12) AS workspace,
       domain,
       state,
       to_char(checked_at, 'YYYY-MM-DD HH24:MI') AS checked,
       to_char(used_at, 'YYYY-MM-DD HH24:MI') AS used
FROM browser_sign_ins
WHERE EXISTS (SELECT 1 FROM unnest(string_to_array(:'hosts', ',')) AS host
              WHERE domain = host OR domain LIKE '%.' || host)
ORDER BY 1, 2;

\echo
\echo Every run of the window by workspace, site host and status
SQL
  echo "$RUNS"
  cat <<'SQL'
SELECT left(workspace_id, 12) AS workspace,
       coalesce(site_host, '(no site)') AS site_host,
       status,
       count(*) AS runs,
       count(*) FILTER (WHERE payment_allowed) AS with_card,
       count(*) FILTER (WHERE submission IS NOT NULL) AS approved
FROM window_runs
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
COMMIT;
SQL
} | psql_on SRC -v hosts="$HOSTS" -v since="$SINCE" -v until="$UNTIL"
