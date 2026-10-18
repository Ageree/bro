#!/bin/bash
# The last steps of one Workflow run, read only — which of eve's steps a turn went through:
#
#   host.py ops NAME world-steps.sh RUN_ID_PREFIX [LIMIT]
#
# For the run whose id starts with RUN_ID_PREFIX (at least 12 characters, one run), prints its LIMIT (40)
# latest steps: name, status, attempt and times, and its latest events by type and time. Names, statuses
# and times only: no step input, output or event payload is read.
source "$(dirname "$0")/db-lib.sh"
PREFIX=${1:-}
LIMIT=${2:-40}
[[ "$PREFIX" =~ ^wrun_[0-9A-Z]{7,40}$ ]] || die "RUN_ID_PREFIX: wrun_ and at least 7 more characters"
[[ "$LIMIT" =~ ^[0-9]+$ && "$LIMIT" -ge 1 && "$LIMIT" -le 200 ]] || die "LIMIT: 1 to 200"
connection SRC world
PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=60s" psql_on SRC -v prefix="$PREFIX" -v limit="$LIMIT" <<'SQL'
\pset tuples_only off
\pset format aligned
\pset footer off
SELECT count(*) AS runs_matching FROM workflow.workflow_runs WHERE id LIKE :'prefix' || '%';
SELECT left(step_name, 70) AS step, status, attempt,
       to_char(created_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI:SS.MS') AS created,
       to_char(completed_at AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') AS completed
FROM workflow.workflow_steps
WHERE run_id = (SELECT id FROM workflow.workflow_runs WHERE id LIKE :'prefix' || '%' ORDER BY id LIMIT 1)
ORDER BY created_at DESC
LIMIT :limit;
SELECT type, to_char(created_at AT TIME ZONE 'UTC', 'MM-DD HH24:MI:SS.MS') AS created
FROM workflow.workflow_events
WHERE run_id = (SELECT id FROM workflow.workflow_runs WHERE id LIKE :'prefix' || '%' ORDER BY id LIMIT 1)
ORDER BY created_at DESC
LIMIT :limit;
SQL
