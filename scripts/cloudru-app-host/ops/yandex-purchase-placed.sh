#!/bin/bash
# An unknown Yandex purchase whose order the operator found in Yandex itself
# (its orders list and payment status): the record becomes placed with that
# order's id, and `yandex_purchase status` then reads its payment live. Until
# then an unknown record blocks every new purchase of the workspace. Only an
# unknown record without an order id changes; nothing else is touched.
source "$(dirname "$0")/db-lib.sh"

[ "$#" -eq 3 ] || die "usage: yandex-purchase-placed.sh WORKSPACE_ID PURCHASE_ID ORDER_ID"
[[ "$1" =~ ^[A-Za-z0-9:_-]{1,200}$ ]] || die "invalid workspace id"
[[ "$2" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "invalid purchase id"
[[ "$3" =~ ^[A-Za-z0-9_-]{1,200}$ ]] || die "invalid order id"
connection SRC app
PGOPTIONS="-c statement_timeout=10000" \
  psql_on SRC -v workspace="$1" -v purchase="$2" -v order="$3" <<'SQL'
UPDATE yandex_purchases
SET state = 'placed',
  merchant_order_id = :'order',
  outcome = jsonb_build_object('kind', 'placed', 'orderId', :'order', 'paymentStatus', 'pending'),
  updated_at = now(),
  settled_at = now()
WHERE id = :'purchase'
  AND workspace_id = :'workspace'
  AND state = 'unknown'
  AND merchant_order_id IS NULL
RETURNING json_build_object('purchase', id, 'state', state);
SQL
