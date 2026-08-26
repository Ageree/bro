# bro — jobs + own mailbox

_Date: 2026-08-27_

## Product

Bro is an actor: iMessage + his own Inkbox mailbox + jobs that can park.
Chat stays the default. Bro opens a job when the work needs a wait
(email reply, human yes/no, browser). `/goal` for life, not for code:
one-line objective, one-line «done when», loop until that or cancel.

## Decisions

- **Mailbox is Inkbox.** Already on the identity, stored as `tenants.emailAddress`.
  Bro sends and receives from that address. Composio Gmail stays «their apps».
- **Jobs live in Convex**, not `@convex-dev/workflow`. The graph is unknown
  (clinic says «only Tuesday»). Eve is the brain; events wake the same iMessage
  thread via `from(conversationId).send`.
- **Bro decides** when a turn is a job. Human does not type a command.
- **Wake events:** inbound mail, human iMessage, browser (existing poll).
  No timer in v1.
- **Isolation:** job and mailbox belong to one tenant. Inbound mail maps
  `emailAddress → tenant`. Fail closed if zero or two matches.
- **Out of scope:** virtual card, morning briefing, custom sending domain,
  Composio as Bro's outbound mail, job list UI.

## Data

`jobs`: `tenantId`, `goal`, `doneWhen`, `status` (`open` | `waiting` |
`done` | `failed`), `waitingFor` (`human` | `email` | `browser`), `note`,
`emailThreadId`, `emailMessageId`. Index `by_tenant`.

`tenants`: index `by_email` on `emailAddress` (lowercased).

Cap: 8 open+waiting jobs per person.

## Flow

1. Human texts. Bro chats. If it needs a wait: `job_open`, do the step
   (`bro_mail` / `browser_task`), `job_wait`.
2. Inbound `message.received` on Bro's mailbox → POST `/webhooks/mail?h=`
   → tagged `[event:mail]` into the bound iMessage session. Not shown as
   the human speaking. Bro's reply goes out as iMessage.
3. Thread match if `emailThreadId` lines up; else the single job that is
   `waiting` on `email`; else Bro picks from the wake list.
4. `job_done` when `doneWhen` holds, or the human cancels.

Confirm before the first outbound mail of a job. Continuations on the
same thread do not re-ask.

## Files

- `convex/schema.ts`, `convex/jobs.ts`, `convex/tenants.ts`, `convex/access.ts`
- `convex/lib/mailPolicy.ts`, `convex/lib/accessPolicy.ts`
- `agent/tools/job_open.ts`, `job_wait.ts`, `job_done.ts`, `bro_mail.ts`
- `agent/lib/mail-inbound.ts`, `agent/lib/convex.ts`, `agent/channels/imessage.ts`
- `agent/instructions.md`, `agent/instructions/jobs.ts`
- `scripts/setup-inkbox-webhooks.ts`, `scripts/jobs-check.ts`

## Verification

- `npm run jobs:check` — attach-to-job, mailbox isolation, wake text, URLs
- `npm run access:check` — still green (mail URL helper)
- New identity from landing gets a mail webhook as well as iMessage
- Inbound mail to Bro's address texts the bound iPhone, not another tenant
