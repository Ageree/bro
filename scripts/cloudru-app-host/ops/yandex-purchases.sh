#!/bin/bash
source "$(dirname "$0")/db-lib.sh"

[ "$#" -eq 1 ] || die "usage: yandex-purchases.sh WORKSPACE_ID"
[[ "$1" =~ ^[A-Za-z0-9:_-]{1,200}$ ]] || die "invalid workspace id"
connection SRC app
PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000" \
  psql_on SRC -v workspace="$1" <<'SQL'
SELECT json_build_object(
  'workspaceExists', EXISTS(SELECT 1 FROM workspaces WHERE id = :'workspace'),
  'activeBrowserPayments', (SELECT count(*) FROM browser_runs
    WHERE workspace_id = :'workspace' AND payment_allowed
      AND status IN ('created', 'queued', 'running', 'waiting')),
  'reservedBrowserPayments', (SELECT count(*) FROM spend_entries
    WHERE workspace_id = :'workspace' AND status = 'reserved'),
  'unresolvedPurchases', (SELECT count(*) FROM yandex_purchases
    WHERE workspace_id = :'workspace' AND state IN ('submitting', 'unknown')),
  'purchasesByState', (SELECT COALESCE(json_object_agg(state, total), '{}'::json)
    FROM (SELECT state, count(*) AS total FROM yandex_purchases
      WHERE workspace_id = :'workspace' GROUP BY state) counts),
  'latestPurchaseAt', (SELECT max(created_at) FROM yandex_purchases
    WHERE workspace_id = :'workspace')
);
SQL
