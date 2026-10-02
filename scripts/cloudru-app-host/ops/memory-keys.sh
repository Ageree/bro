#!/bin/bash
# Which memory scope keys hold what, per workspace — read only, counts only:
#
#   host.py ops NAME memory-keys.sh [SINCE]
#
# eve derives a memory slot's scope key from its namespace, and without one from where it runs: on Vercel the
# project, on the VM the path the release was built from. So profile and workstreams memory moved to new keys
# when production left Vercel on 02.10, and again with every release built from another checkout. This prints,
# for each workspace (its id cut to 12 characters) and each key (cut to 10), how many profile records and
# workstreams are live, how many were forgotten (not expired) and expired since SINCE (default 2026-10-02),
# when the key was first and last written, and how many forget operations it saw since SINCE: enough to tell
# the Vercel key from the VM ones and to find what someone forgot on a key that is about to be left behind.
# Never a record's text.
source "$(dirname "$0")/db-lib.sh"
SINCE=${1:-2026-10-02}
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "SINCE is a date: YYYY-MM-DD"
connection SRC app
PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120s" psql_on SRC -v since="$SINCE" <<'SQL'
\pset tuples_only off
\pset format aligned
\pset footer off
\echo Profile records by workspace and scope key
SELECT left(r.workspace_id, 12) AS workspace,
       left(r.scope_key, 10) AS key,
       count(*) FILTER (WHERE r.content IS NOT NULL) AS live,
       count(*) FILTER (WHERE r.content IS NOT NULL AND r.content->>'category' = 'rule') AS live_rules,
       count(*) FILTER (WHERE r.content IS NULL AND r.last_operation_id NOT LIKE 'expiry:%'
                          AND r.updated_at >= :'since'::date) AS forgotten_since,
       count(*) FILTER (WHERE r.content IS NULL AND r.last_operation_id LIKE 'expiry:%'
                          AND r.updated_at >= :'since'::date) AS expired_since,
       min(r.created_at)::date AS first_written,
       max(r.updated_at) AS last_written,
       (SELECT count(*) FROM memory_operations o
         WHERE o.workspace_id = r.workspace_id AND o.scope_key = r.scope_key
           AND o.action = 'forget' AND o.created_at >= :'since'::date) AS forgets_since
FROM memory_records r
GROUP BY r.workspace_id, r.scope_key
ORDER BY 1, min(r.created_at);

\echo
\echo Workstreams by workspace and scope key
SELECT left(workspace_id, 12) AS workspace,
       left(scope_key, 10) AS key,
       count(*) FILTER (WHERE content IS NOT NULL) AS live,
       count(*) FILTER (WHERE content IS NULL AND updated_at >= :'since'::date) AS forgotten_since,
       max(updated_at) AS last_written
FROM workstreams
GROUP BY workspace_id, scope_key
ORDER BY 1, max(updated_at);
SQL
