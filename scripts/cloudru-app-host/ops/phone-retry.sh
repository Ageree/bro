#!/bin/bash
# Makes the next activation attempt of one person's phone line due now instead of after the backoff (up to six
# hours), for a line that is stuck and has been seen to be (26.10: a number without a SIP, see phone-lines.sh):
#
#   host.py ops NAME phone-retry.sh TELEGRAM_USERNAME
#
# Only a request that waits for a retry, whose line is `uncertain` and has not moved for half an hour, is touched; the
# schedule picks it up within a minute and `activatePhone` does the rest. Prints the request's state, never more.
source "$(dirname "$0")/db-lib.sh"
[ "$#" -eq 1 ] || die "usage: phone-retry.sh TELEGRAM_USERNAME"
NAME=${1#@}
[[ "$NAME" =~ ^[A-Za-z0-9_]{3,64}$ ]] || die "not a Telegram username: $1"
db_lock
connection SRC app
PGOPTIONS="-c statement_timeout=10000" psql_on SRC -v name="$NAME" <<'SQL'
\pset tuples_only on
\pset format unaligned
UPDATE phone_number_requests AS r
SET next_attempt_at = now(), updated_at = now()
WHERE r.state = 'retry'
  AND r.workspace_id IN (SELECT workspace_id FROM channel_identities
                         WHERE channel = 'telegram' AND lower(username) = lower(:'name'))
  AND EXISTS (SELECT 1 FROM phone_numbers n
              WHERE n.workspace_id = r.workspace_id AND n.state = 'uncertain'
                AND n.updated_at < now() - interval '30 minutes')
RETURNING 'made due now: state=' || r.state || ' attempts=' || r.attempts || ' lastFailure=' || coalesce(r.last_failure, '-');
SELECT 'request: ' || coalesce(string_agg('state=' || r.state || ' attempts=' || r.attempts
       || ' due=' || to_char(r.next_attempt_at, 'YYYY-MM-DD HH24:MI'), '; '), 'none')
FROM phone_number_requests r
WHERE r.workspace_id IN (SELECT workspace_id FROM channel_identities
                         WHERE channel = 'telegram' AND lower(username) = lower(:'name'));
SQL
