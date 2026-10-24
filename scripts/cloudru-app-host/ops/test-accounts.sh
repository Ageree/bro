#!/bin/bash
# Production's test accounts (test-accounts.ts): web-only people for live checks, none of them real.
#
#   host.py ops NAME test-accounts.sh ensure s3put:<result key>   # make them once, one-time sign-in links to the PUT URL
#   host.py ops NAME test-accounts.sh state [SINCE]               # read only: what Bro ↔ Bro holds of them
#
# state prints, as one JSON object, for the accounts whose mail is bro-test-*@telegram.local-vault.invalid and
# nobody else: their workspace, its phone number requests and numbers (there must be none), the chats Bro
# remembers they wrote from, and since SINCE (ISO 8601, a day back by default) their invites, links, and the
# threads between two of them with both sides, every message and every report. Only test data: a thread with a
# real person's workspace is left out whole.
set -euo pipefail
case "${1:-}" in
  ensure)
    shift
    node "$(dirname "$0")/test-accounts.mjs" ensure "$@"
    ;;
  state)
    source "$(dirname "$0")/db-lib.sh"
    since=${2:-}
    [ -z "$since" ] || [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+(Z|[+-][0-9:]+)?)?$ ]] || die "SINCE: an ISO 8601 date"
    connection SRC app
    PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=20000 -c TimeZone=Europe/Moscow" \
      psql_on SRC -v since="${since:-$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)}" <<'SQL'
WITH tests AS (
  SELECT m.workspace_id, u.name FROM "user" u
  JOIN workspace_memberships m ON m.user_id = 'better-auth:' || u.id
  WHERE u.email LIKE 'bro-test-%@telegram.local-vault.invalid'
), threads AS (
  SELECT t.* FROM bro_threads t
  WHERE t.initiator_workspace_id IN (SELECT workspace_id FROM tests)
    AND t.responder_workspace_id IN (SELECT workspace_id FROM tests)
    AND t.created_at >= :'since'::timestamptz
)
SELECT json_build_object(
  'accounts', (SELECT COALESCE(json_agg(json_build_object(
      'name', t.name, 'workspace', t.workspace_id,
      'phoneNumberRequests', (SELECT count(*) FROM phone_number_requests r WHERE r.workspace_id = t.workspace_id),
      'phoneNumbers', (SELECT count(*) FROM phone_numbers p WHERE p.workspace_id = t.workspace_id),
      'messenger', (SELECT w.messenger_channel FROM proactive_watches w WHERE w.workspace_id = t.workspace_id),
      'webChat', (SELECT w.web_conversation_id FROM proactive_watches w WHERE w.workspace_id = t.workspace_id),
      'profile', (SELECT json_build_object('firstName', p.first_name, 'timezone', p.timezone)
        FROM user_profiles p WHERE p.workspace_id = t.workspace_id)
    ) ORDER BY t.name), '[]'::json) FROM tests t),
  'invites', (SELECT COALESCE(json_agg(json_build_object(
      'id', i.id, 'inviter', (SELECT name FROM tests WHERE workspace_id = i.inviter_workspace_id),
      'label', i.label, 'expires', i.expires_at,
      'openedBy', (SELECT name FROM tests WHERE workspace_id = i.opened_by_workspace_id), 'openedAt', i.opened_at,
      'redeemedBy', (SELECT name FROM tests WHERE workspace_id = i.redeemed_by_workspace_id),
      'redeemedAt', i.redeemed_at, 'created', i.created_at
    ) ORDER BY i.created_at), '[]'::json) FROM bro_invites i
    WHERE i.inviter_workspace_id IN (SELECT workspace_id FROM tests) AND i.created_at >= :'since'::timestamptz),
  'links', (SELECT COALESCE(json_agg(json_build_object(
      'id', l.id, 'owner', (SELECT name FROM tests WHERE workspace_id = l.workspace_id),
      'peer', (SELECT name FROM tests WHERE workspace_id = l.peer_workspace_id),
      'status', l.status, 'calendar', l.calendar, 'shareNotes', l.share_notes, 'label', l.peer_label,
      'revision', l.revision, 'created', l.created_at, 'removed', l.removed_at
    ) ORDER BY l.created_at), '[]'::json) FROM bro_links l
    WHERE l.workspace_id IN (SELECT workspace_id FROM tests)
      AND l.peer_workspace_id IN (SELECT workspace_id FROM tests)
      AND (l.removed_at IS NULL OR l.removed_at >= :'since'::timestamptz)),
  'threads', (SELECT COALESCE(json_agg(json_build_object(
      'id', t.id, 'initiator', (SELECT name FROM tests WHERE workspace_id = t.initiator_workspace_id),
      'responder', (SELECT name FROM tests WHERE workspace_id = t.responder_workspace_id),
      'topic', t.topic, 'status', t.status, 'nextSide', t.next_side, 'nextAt', t.next_at,
      'version', t.version, 'envoyMessages', t.envoy_messages, 'failedSteps', t.failed_steps,
      'agreedProposal', t.agreed_proposal_id, 'created', t.created_at, 'closed', t.closed_at,
      'sides', (SELECT json_agg(json_build_object(
          'side', s.side, 'who', (SELECT name FROM tests WHERE workspace_id = s.workspace_id),
          'mandate', s.mandate, 'ownerAnswers', s.owner_answers, 'waitingOwner', s.waiting_owner,
          'question', s.pending_question, 'held', s.held_message, 'confirmed', s.confirmed_proposal_id,
          'declined', s.declined_at, 'alerted', s.alerted_categories, 'reportTarget', s.report_target,
          'calendar', s.calendar_state, 'calendarAttempts', s.calendar_attempts
        ) ORDER BY s.side) FROM bro_thread_sides s WHERE s.thread_id = t.id),
      'messages', (SELECT json_agg(json_build_object(
          'id', m.id, 'side', m.side, 'action', m.action, 'body', m.body, 'proposal', m.proposal,
          'approvedByOwner', m.approved_by_owner, 'at', m.created_at
        ) ORDER BY m.created_at) FROM bro_messages m WHERE m.thread_id = t.id)
    ) ORDER BY t.created_at), '[]'::json) FROM threads t),
  'reports', (SELECT COALESCE(json_agg(json_build_object(
      'id', r.id, 'to', (SELECT name FROM tests WHERE workspace_id = r.workspace_id), 'kind', r.kind,
      'thread', r.thread_id, 'status', r.status, 'attempts', r.attempts, 'error', r.last_error,
      'target', r.target, 'payload', r.payload, 'created', r.created_at, 'delivered', r.delivered_at
    ) ORDER BY r.created_at), '[]'::json) FROM bro_reports r
    WHERE r.workspace_id IN (SELECT workspace_id FROM tests) AND r.created_at >= :'since'::timestamptz
      AND (r.thread_id IS NULL OR r.thread_id IN (SELECT id FROM threads)))
);
SQL
    ;;
  *)
    echo "usage: test-accounts.sh ensure s3put:<result key> | state [SINCE]" >&2
    exit 1
    ;;
esac
