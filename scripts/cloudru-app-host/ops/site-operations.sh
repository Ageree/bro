#!/bin/bash
# The site operations a workspace's browser learned, and how its direct reads went — read only:
#
#   host.py ops NAME site-operations.sh WORKSPACE_ID
#
# For each row of browser_site_operations (agent/lib/browser-vm/site-ops/): its name, how it reads (document
# or xhr), its results page as a template, the runs that found it, the direct reads it served, its failures in a
# row, the last one's reason and when, and when it was last kept. A template carries no value of an errand:
# every value is a %placeholder%, and only a short lower-case Latin part of a path stays as the site wrote it
# (site_path_part in browser-vm/worker/worker.py). No item's data is ever stored there.
source "$(dirname "$0")/db-lib.sh"
[ "$#" -eq 1 ] || die "usage: site-operations.sh WORKSPACE_ID"
WORKSPACE=$1
[[ "$WORKSPACE" =~ ^[a-z]+:[A-Za-z0-9_-]{1,64}$ ]] || die "not a workspace id: $WORKSPACE"
# In turn with the other db-*.sh: a restore holds the app's tables for its whole transaction.
db_lock
connection SRC app
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=60s -c TimeZone=Europe/Moscow"
psql_on SRC -v workspace="$WORKSPACE" <<'SQL'
\pset format aligned
\pset border 1
\pset tuples_only off
SELECT name,
       operation #>> '{source,kind}' AS via,
       left(operation ->> 'page', 160) AS page,
       runs,
       served,
       failures,
       last_failure,
       to_char(failed_at, 'DD.MM HH24:MI') AS failed,
       to_char(updated_at, 'DD.MM HH24:MI') AS kept
FROM browser_site_operations
WHERE workspace_id = :'workspace'
ORDER BY host, name;
SQL
