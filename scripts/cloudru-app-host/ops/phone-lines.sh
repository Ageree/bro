#!/bin/bash
# State of every workspace's phone line — read only, for finding lines that never became usable (26.10: a
# number bought on 25.10 stayed at stage `sip-creating`, with no SIP at the carrier, and its owner's calls never
# started). No numbers or names are printed: Telegram username, state, stage, which ids are set, and the ages.
#
#   host.py ops NAME phone-lines.sh [SINCE]
#
# SINCE is a date PostgreSQL reads, default thirty days ago; lines created before it are not listed.
source "$(dirname "$0")/db-lib.sh"
{ [ "$#" -ge 0 ] && [ "$#" -le 1 ]; } || die "usage: phone-lines.sh [SINCE]"
SINCE=${1:-$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)}
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?$ ]] || die "not a date or time: $SINCE"
db_lock
connection SRC app
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=120s -c TimeZone=Europe/Moscow"
psql_on SRC -v since="$SINCE" <<'SQL'
\pset tuples_only on
\pset format unaligned
SELECT n.state || '/' || n.stage || ': ' || count(*) || ' lines'
FROM phone_numbers n WHERE n.created_at >= :'since'::timestamptz
GROUP BY n.state, n.stage ORDER BY 1;
SELECT E'\n--- lines that are not active, oldest first';
SELECT coalesce((SELECT '@' || i.username FROM channel_identities i
                 WHERE i.workspace_id = n.workspace_id AND i.channel = 'telegram' LIMIT 1), 'no telegram')
       || ' state=' || n.state || ' stage=' || n.stage
       || ' number=' || (n.number_id IS NOT NULL)::text || ' sip=' || (n.sip_id IS NOT NULL)::text
       || ' agent=' || (n.agent_id IS NOT NULL)::text || ' outbound=' || (n.outbound_phone_number_id IS NOT NULL)::text
       || ' created=' || to_char(n.created_at, 'YYYY-MM-DD HH24:MI')
       || ' updated=' || to_char(n.updated_at, 'YYYY-MM-DD HH24:MI')
FROM phone_numbers n
WHERE n.created_at >= :'since'::timestamptz AND n.state <> 'active'
ORDER BY n.created_at;
SELECT E'\n--- active lines without a SIP or an outbound id';
SELECT count(*) FROM phone_numbers n
WHERE n.created_at >= :'since'::timestamptz AND n.state = 'active'
  AND (n.sip_id IS NULL OR n.outbound_phone_number_id IS NULL);
SQL
