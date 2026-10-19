#!/bin/bash
# A workspace's wallet payments (agent/tools/yoomoney_pay.ts) — read only:
#
#   host.py ops NAME yoomoney-payments.sh WORKSPACE_ID
#
# Prints the wallet's connection (since when, and the rights it was granted: a consent anew replaces both), the
# latest onboardings from a chat (its channel, and when it was made, connected, finished and told in the chat),
# how many payments each state holds, and the latest 20: the payment
# (shortened), its kind, state and YooMoney's error code, the sum in roubles, whether it goes on a card, the host
# of a bank form still waiting for the person, the chat channel it was asked in, and when it was created, sent,
# settled and told (Moscow time). A service's title only — a transfer's names the recipient's wallet — and never
# the form's details, the request, the card or the token: what a payment that never reached the person's bank,
# or never came back from it, did.
source "$(dirname "$0")/db-lib.sh"

[ "$#" -eq 1 ] || die "usage: yoomoney-payments.sh WORKSPACE_ID"
[[ "$1" =~ ^[A-Za-z0-9:_-]{1,200}$ ]] || die "invalid workspace id"
connection SRC app
PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000 -c TimeZone=Europe/Moscow" \
  psql_on SRC -v workspace="$1" <<'SQL'
SELECT json_build_object(
  'connection', (SELECT json_build_object(
      'since', to_char(created_at, 'YYYY-MM-DD HH24:MI:SS'), 'scope', scope)
    FROM yoomoney_connections WHERE workspace_id = :'workspace'),
  'onboardings', (SELECT COALESCE(json_agg(row_to_json(latest)), '[]'::json) FROM (
    SELECT left(id::text, 8) AS id, conversation_channel AS channel,
      to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created,
      to_char(connected_at, 'YYYY-MM-DD HH24:MI:SS') AS connected,
      to_char(ready_at, 'YYYY-MM-DD HH24:MI:SS') AS ready,
      to_char(resumed_at, 'YYYY-MM-DD HH24:MI:SS') AS resumed
    FROM yoomoney_onboardings WHERE workspace_id = :'workspace'
    ORDER BY created_at DESC LIMIT 5) latest),
  'byState', (SELECT COALESCE(json_object_agg(state, total), '{}'::json)
    FROM (SELECT state, count(*) AS total FROM yoomoney_payments
      WHERE workspace_id = :'workspace' GROUP BY state) counts),
  'latest', (SELECT COALESCE(json_agg(row_to_json(latest)), '[]'::json) FROM (
    SELECT left(id::text, 8) AS id, kind, state, error, amount_minor / 100.0 AS rub,
      CASE WHEN kind = 'service' THEN title END AS service,
      card_id IS NOT NULL AS card,
      split_part(split_part(bank_uri, '://', 2), '/', 1) AS bank_form,
      conversation_channel AS channel,
      to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created,
      to_char(submitted_at, 'YYYY-MM-DD HH24:MI:SS') AS sent,
      to_char(settled_at, 'YYYY-MM-DD HH24:MI:SS') AS settled,
      to_char(outcome_told_at, 'YYYY-MM-DD HH24:MI:SS') AS told
    FROM yoomoney_payments WHERE workspace_id = :'workspace'
    ORDER BY created_at DESC LIMIT 20) latest)
);
SQL
