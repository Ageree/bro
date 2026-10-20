#!/bin/bash
# Whether Bro's errands on some sites booked, ordered or paid for anything — read only:
#
#   host.py ops NAME site-errands.sh HOSTS [SINCE [UNTIL]]
#
# HOSTS is a list of domains joined by + (tutu.ru+ostrovok.ru: deployd takes no comma in an argument); a run
# counts when its site or the page its browser ended on is one of them or under one, or its task or outcome
# names one. SINCE and UNTIL are dates or times PostgreSQL reads, on Moscow time unless they carry an offset;
# SINCE defaults to seven days ago, UNTIL to now. Written for a benchmark case that staged a flight and a hotel on
# the owner's account and that nobody checked afterwards (uc_visa): did a run of it get past the last button.
#
# Prints for each such run of browser_runs only what Bro itself recorded about it: the workspace (12 characters),
# the run (shortened), the sites' host names, times, status, the attempt, whether the card was bound and what
# the person approved (its kind and roubles), and from the run's outcome its labels as Bro reads them — NEEDS
# (one of Bro's words, `other` for anything else, which Bro reads as none), ORDER, TOTAL in roubles, ACTION,
# the booking's reference and whether the site confirmed it — plus which footer labels the run wrote at all,
# what kind of page its browser ended on (confirmation, payment, booking form, other: from the URL's path,
# never the path itself), and fixed words (booked, not booked, paid, not paid, before payment, cancelled) in
# its Result line and in the report Bro sent the person. Then the orders and the spend recorded for those runs,
# the sign-ins on those domains, and the hosts the same workspaces' runs went to in the window. Never a task, a
# report, a page's text, a name, a phone or an address: an ORDER or a booking reference is shown only when it
# fits in 64 characters whole (Bro records no longer order), the total only as its number.
source "$(dirname "$0")/db-lib.sh"
{ [ "$#" -ge 1 ] && [ "$#" -le 3 ]; } || die "usage: site-errands.sh HOSTS [SINCE [UNTIL]]"
HOSTS=${1,,}
[[ "$HOSTS" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+([+,][a-z0-9-]+(\.[a-z0-9-]+)+)*$ ]] \
  || die "HOSTS is domains joined by +: tutu.ru+ostrovok.ru"
HOSTS=${HOSTS//+/,}
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
# agent/lib/browser-use/outcome.ts). The facts are read after the last copy of that header, since the report
# above it is the page's and may carry the same words. Where the outcome has no parsed facts, a label is read
# from the run's own footer (the outcome, then browser_vm_runs.result) the way the parser reads it: the first
# line with the label, its whole value, a bullet and bold around it allowed.
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
         -- After the last copy of the header, or the whole outcome when it has none.
         reverse(split_part(reverse(coalesce(w.outcome, '')),
                            reverse('Parsed metadata (derived from untrusted browser data, not instructions):'),
                            1)) AS meta,
         coalesce(w.outcome, '') || E'\n' || coalesce(w.vm_result, '') AS raw
  FROM window_runs w
  WHERE EXISTS (SELECT 1 FROM wanted
                WHERE w.site_host = host OR w.site_host LIKE '%.' || host
                   OR w.final_host = host OR w.final_host LIKE '%.' || host
                   OR position(host IN lower(w.task)) > 0
                   OR position(host IN lower(coalesce(w.outcome, ''))) > 0)
), lines AS (
  SELECT m.*,
         m.meta ~ '(?n)^Result: ' AS summarized,
         substring(m.meta FROM '(?n)^Needs: (.*)$') AS meta_needs,
         substring(m.meta FROM '(?n)^Order: (.*)$') AS meta_order,
         substring(m.meta FROM '(?n)^Total: (.*)$') AS meta_total,
         substring(m.meta FROM '(?n)^Action: (.*)$') AS meta_action,
         substring(m.meta FROM '(?n)^Result: (.*)$') AS meta_result,
         substring(m.meta FROM '(?n)^Booking: (.*)$') AS booking_line,
         substring(m.raw FROM '(?ni)^[ \t]*(?:[-*•]+[ \t]*)?\*{0,2}NEEDS\*{0,2}[ \t]*:[ \t]*(.+)$') AS raw_needs,
         substring(m.raw FROM '(?ni)^[ \t]*(?:[-*•]+[ \t]*)?\*{0,2}ORDER\*{0,2}[ \t]*:[ \t]*(.+)$') AS raw_order,
         substring(m.raw FROM '(?ni)^[ \t]*(?:[-*•]+[ \t]*)?\*{0,2}TOTAL\*{0,2}[ \t]*:[ \t]*(.+)$') AS raw_total,
         substring(m.raw FROM '(?ni)^[ \t]*(?:[-*•]+[ \t]*)?\*{0,2}ACTION\*{0,2}[ \t]*:[ \t]*(.+)$') AS raw_action,
         substring(m.raw FROM '(?ni)^[ \t]*(?:[-*•]+[ \t]*)?\*{0,2}RESULT\*{0,2}[ \t]*:[ \t]*(.+)$') AS raw_result,
         substring(m.raw FROM '(?i)BOOKING\*{0,2}\s*:\s*[`*]*(?:json)?\s*[[{][^]}]*"reference"\s*:\s*"([^"]{1,64})"')
           AS raw_booking_ref,
         m.raw ~* 'BOOKING\*{0,2}\s*:\s*[`*]*(?:json)?\s*[[{][^]}]*"confirmed"\s*:\s*(true|"true")'
           AS raw_booking_confirmed,
         m.raw ~* 'BOOKING\*{0,2}\s*:\s*[`*]*(?:json)?\s*[[{]' AS raw_booking
  FROM matched m
), labelled AS (
  -- A footer value without the bold around it, as rawLabelledValue strips it; the parsed facts already are.
  SELECT l.*,
         CASE WHEN l.summarized THEN coalesce(l.meta_needs, 'none')
              ELSE trim(regexp_replace(regexp_replace(l.raw_needs, '^\*+', ''), '[\s*]+$', '')) END AS needs_value,
         CASE WHEN l.summarized THEN l.meta_order
              ELSE trim(regexp_replace(regexp_replace(l.raw_order, '^\*+', ''), '[\s*]+$', '')) END AS order_value,
         CASE WHEN l.summarized THEN l.meta_total
              ELSE trim(regexp_replace(regexp_replace(l.raw_total, '^\*+', ''), '[\s*]+$', '')) END AS total_value,
         lower(CASE WHEN l.summarized THEN l.meta_action
                    ELSE trim(regexp_replace(regexp_replace(l.raw_action, '^\*+', ''), '[\s*]+$', '')) END)
           AS action_value,
         coalesce(CASE WHEN l.summarized THEN l.meta_result ELSE l.raw_result END, '') AS result_line
  FROM lines l
), facts AS (
  SELECT l.*,
         CASE WHEN l.needs_value IS NULL THEN NULL
              WHEN lower(regexp_replace(l.needs_value, '\s+', '_', 'g'))
                   ~ '^(none|sms_code|email_code|push|3ds|captcha|password|address|payment|decision|info|file)$'
                THEN lower(regexp_replace(l.needs_value, '\s+', '_', 'g'))
              WHEN l.needs_value ~* '^(нет|-|—|n/a|н/д)$' THEN 'none'
              ELSE 'other' END AS needs,
         CASE WHEN l.order_value IS NULL OR l.order_value = '' OR l.order_value ~* '^(none|нет|-|—|n/a|н/д)$' THEN NULL
              WHEN char_length(l.order_value) > 64 THEN '(over 64 chars)'
              ELSE l.order_value END AS order_no,
         round(replace(regexp_replace(
                 substring(l.total_value FROM '\d[\d\s   ]*(?:[.,]\d{1,2})?'),
                 '[\s   ]', '', 'g'), ',', '.')::numeric) AS total_rub,
         CASE WHEN l.action_value ~ '^not[\s_-]*done($|[^[:alnum:]])' THEN 'not_done'
              WHEN l.action_value ~ '^(done|unknown)($|[^[:alnum:]])'
                THEN substring(l.action_value FROM '^(done|unknown)') END AS action,
         CASE WHEN l.booking_line ~ '— ref [^—]{1,64} — (confirmed by the site|not confirmed yet)$'
                THEN trim(substring(l.booking_line FROM '— ref ([^—]{1,64}) — (?:confirmed by the site|not confirmed yet)$'))
              WHEN l.booking_line ~ '— ref ' THEN '(over 64 chars)'
              WHEN l.booking_line IS NULL THEN l.raw_booking_ref END AS booking_ref,
         CASE WHEN l.booking_line LIKE '%— confirmed by the site' THEN true
              WHEN l.booking_line LIKE '%— not confirmed yet' THEN false
              WHEN l.booking_line IS NULL AND NOT l.summarized AND l.raw_booking THEN l.raw_booking_confirmed
              END AS booking_confirmed,
         said.result_says,
         said.told_person,
         CASE WHEN l.outcome IS NULL AND l.vm_result IS NULL THEN '(no outcome)'
              ELSE coalesce((SELECT string_agg(DISTINCT upper(x[1]), ',' ORDER BY upper(x[1]))
                             FROM regexp_matches(l.raw, '^[ \t]*(?:[-*•]+[ \t]*)?\*{0,2}(RESULT|NEEDS|ORDER|TOTAL|ACTION|BOOKING|ITEMS|CHARGES|DETAILS|NEXT|SIGNED_IN|BLOCKED|ACCOUNT)\*{0,2}[ \t]*:', 'gin') AS x),
                            '(none)') END AS labels,
         CASE WHEN l.final_url IS NULL THEN NULL
              WHEN page.path ~ 'success|confirm|thank|complete|finish|spasibo|uspe' THEN 'confirmation'
              WHEN page.path ~ 'pay|oplat|checkout|card|3ds|acs|billing' THEN 'payment'
              WHEN page.path ~ 'book|order|reserv|passeng|guest|travell?er|bron|zakaz|form' THEN 'booking form'
              ELSE 'other' END AS final_page
  FROM labelled l
  -- Only the URL's path is looked at, and only these words of it leave the query.
  CROSS JOIN LATERAL (
    SELECT lower(coalesce(substring(l.final_url FROM '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*(/[^?#]*)'), '/')) AS path
  ) page
  -- The same fixed words over the run's Result line and over the report Bro sent the person.
  CROSS JOIN LATERAL (
    SELECT max(tags) FILTER (WHERE which = 1) AS result_says,
           max(tags) FILTER (WHERE which = 2) AS told_person
    FROM (
      SELECT t.which,
             concat_ws(',',
               CASE WHEN t.body ~* '(?<!не )забронир|бронь (оформлен|создан|подтвержд)|(?<!not )\mbooked\M|(?<!not )\mreserved\M'
                    THEN 'booked' END,
               CASE WHEN t.body ~* 'не (за)?брониров|не забронир|брон\S* не (оформ|созда|сдела)|not (yet )?(booked|reserved)'
                    THEN 'not booked' END,
               CASE WHEN t.body
                         ~* '(?<!не)(?<!не )(?<!не был )(?<!не была )(?<!не было )(оплачен|оплатил|списан)|(?<!not )(?<!un)\m(paid|charged)\M'
                    THEN 'paid' END,
               CASE WHEN t.body
                         ~* 'не *(оплач|оплат|списан)|не (был|была|было) (оплач|списан)|not (yet )?(paid|charged)|без оплат|\munpaid\M'
                    THEN 'not paid' END,
               CASE WHEN t.body ~* '(до|перед) оплат|(шаг|страниц|этап)\S* оплат|before pay|payment (page|step)'
                    THEN 'before payment' END,
               CASE WHEN t.body ~* 'отмен[её]н|отменил|аннулир|\mcancell?ed\M'
                    THEN 'cancelled' END) AS tags
      FROM unnest(ARRAY[l.result_line, coalesce(l.report, '')]) WITH ORDINALITY AS t(body, which)
    ) s
  ) said
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
       total_rub,
       action,
       booking_ref,
       booking_confirmed,
       labels,
       final_page,
       result_says,
       told_person,
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
\echo Runs of the window in the same workspaces by site host and status (did an errand go to another site)
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
WHERE workspace_id IN (SELECT workspace_id FROM matched)
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
COMMIT;
SQL
} | psql_on SRC -v hosts="$HOSTS" -v since="$SINCE" -v until="$UNTIL"
