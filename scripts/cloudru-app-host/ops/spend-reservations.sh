#!/bin/bash
# Open spend reservations of one workspace, and the operator's release of one:
#
#   host.py ops NAME spend-reservations.sh WORKSPACE_ID
#   host.py ops NAME spend-reservations.sh WORKSPACE_ID release ENTRY_ID
#
# A reservation holds money for a browser errand that may still pay. One whose
# run stopped on a code (sms_code, 3ds, push, email_code) stays for a day, and
# while it stays every Yandex purchase of the workspace answers «another payment
# is under way» (`claimYandexPurchase`). Release one only after the shop shows
# that its errand paid nothing (22.10: an SBP order of Afisha whose `pay` ended
# `payment-timeout`). Only a reservation whose run is no longer going is
# released; an order the shop did take is recorded by the errand, not here.
#
# Prints amounts, sources, shops and the run's state and `NEEDS:` label only,
# never what a person or a page wrote.
source "$(dirname "$0")/db-lib.sh"

[ "$#" -eq 1 ] || [ "$#" -eq 3 ] ||
  die "usage: spend-reservations.sh WORKSPACE_ID [release ENTRY_ID]"
[[ "$1" =~ ^[A-Za-z0-9:_-]{1,200}$ ]] || die "invalid workspace id"
connection SRC app

if [ "$#" -eq 3 ]; then
  [ "$2" = release ] || die "the second argument is release"
  [[ "$3" =~ ^[A-Za-z0-9:_-]{1,200}$ ]] || die "invalid entry id"
  PGOPTIONS="-c statement_timeout=10000" \
    psql_on SRC -v workspace="$1" -v entry="$3" <<'SQL'
UPDATE spend_entries AS entry
SET status = 'released', updated_at = now()
WHERE entry.id = :'entry'
  AND entry.workspace_id = :'workspace'
  AND entry.status = 'reserved'
  AND NOT EXISTS (
    SELECT 1 FROM browser_runs AS run
    WHERE run.id = entry.browser_run_id
      AND run.status IN ('created', 'queued', 'running', 'waiting')
  )
RETURNING json_build_object('released', entry.id, 'amountRub', entry.amount_rub);
SQL
  exit 0
fi

PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000" \
  psql_on SRC -v workspace="$1" <<'SQL'
SELECT COALESCE(json_agg(json_build_object(
  'entry', entry.id,
  'run', entry.browser_run_id,
  'amountRub', entry.amount_rub,
  'feeRub', entry.fee_rub,
  'source', entry.source,
  'merchant', entry.merchant,
  'category', entry.category,
  'createdAt', entry.created_at,
  'runStatus', run.status,
  'runCompletedAt', run.completed_at,
  'needs', substring(run.outcome FROM '(?im)^needs:[ \t]*([a-z0-9_]+)'),
  'retryAt', run.retry_at,
  'retriedAs', run.retried_as_run_id
) ORDER BY entry.created_at), '[]'::json)
FROM spend_entries AS entry
LEFT JOIN browser_runs AS run ON run.id = entry.browser_run_id
WHERE entry.workspace_id = :'workspace' AND entry.status = 'reserved';
SQL
