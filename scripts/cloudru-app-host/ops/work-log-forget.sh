#!/bin/bash
# Forgets what the work log (`work_log`, agent/lib/work-log/) holds of some chats of one workspace — test chats on
# the owner's account, a test person's chats whose answers went wrong — without «забудь всё», which takes the
# person's memory with it:
#
#   host.py ops NAME work-log-forget.sh WORKSPACE_ID SESSION[+SESSION...]
#
# SESSION is an eve session id (`wrun_…`), as the web chat's address or a test driver prints it; deployd takes no
# commas, so several are joined with «+». Prints how many lines each session lost, never their text.
source "$(dirname "$0")/db-lib.sh"
[ "$#" -eq 2 ] || die "usage: work-log-forget.sh WORKSPACE_ID SESSION[+SESSION...]"
WORKSPACE=$1
SESSIONS=$2
[[ "$WORKSPACE" =~ ^[a-z]+:[0-9a-f]{8,64}$ ]] || die "not a workspace id: $WORKSPACE"
[[ "$SESSIONS" =~ ^wrun_[0-9A-Z]{26}(\+wrun_[0-9A-Z]{26}){0,15}$ ]] || die "not session ids: $SESSIONS"
db_lock
connection SRC app
PGOPTIONS="-c statement_timeout=10000" psql_on SRC -v workspace="$WORKSPACE" -v sessions="$SESSIONS" <<'SQL'
\pset tuples_only on
\pset format unaligned
WITH gone AS (
  DELETE FROM work_log
  WHERE workspace_id = :'workspace'
    AND session_id = ANY (string_to_array(:'sessions', '+'))
  RETURNING session_id
)
SELECT s AS session, count(gone.session_id) AS lines
FROM unnest(string_to_array(:'sessions', '+')) AS s
LEFT JOIN gone ON gone.session_id = s
GROUP BY s
ORDER BY s;
SQL
