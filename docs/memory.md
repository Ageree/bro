# Memory architecture

Bro separates memory by authority instead of treating a transcript or a hosted
search index as the source of truth.

- Personal Info owns typed reusable form fields in Postgres.
- Workstreams own goals, constraints, decisions, evidence, and unresolved work.
- Profile memory owns durable facts, people, organizations, decisions,
  preferences, and the rules the person set for Bro as revisioned Postgres
  records.
- Workspace settings own how Bro addresses the person («ты» or «вы», and the
  name they asked to be called by) under the `form_of_address` key. The
  `form_of_address` tool writes it, and every step's reply note repeats it, so
  the choice holds in every chat and channel instead of depending on the model
  noticing a profile record.
- Eve owns current conversation history and compaction.
- Supermemory is an optional semantic index for non-local profile records. Its
  search results are identifiers only: Bro re-reads the current Postgres record
  before adding any result to model context.

A profile record with the category `rule` is a boundary the person set for Bro
in their own message («никогда ничего не оплачивай и никому не пиши без моего
ок», «никогда не пиши маме»). Recall shows rules first, under their own
heading, as restrictions that hold in every conversation and background run and
never authorize or order anything, so a rule an email slipped in can only make
Bro more careful. Where a rule takes away what the spend limit or a standing
permission allows, Bro narrows that policy in the same turn; narrowing never
needs an approval card. A rule is forgotten like any other record.

Records with the category `preference` («свинину не ем», «в поезде только
нижняя полка») come next, under their own heading, as conditions of every pick,
booking and purchase they bear on: Bro filters by them and names the ones it
applied («учёл: без свинины»).

Profile records are partitioned by both authenticated workspace and Eve's
deployment-aware memory scope key. Updates use optimistic revisions. Forgetting
tombstones local content immediately and queues permanent deletion of every
indexed revision; a provider outage cannot make forgotten content visible
because remote text is never trusted or returned directly.

`SUPERMEMORY_API_KEY` enables semantic indexing. Without it, local save, recall,
keyword search, correction, expiry, and forgetting continue to work. Semantic
search is an explicit tool with a short, non-sensitive topical query; raw turn
text and transcripts are never automatic queries. Background uploads and deletes
use a durable outbox reconciled by `agent/schedules/memory.ts`.

Records marked `localOnly` never enter the hosted index. Legacy Eve file-memory
entries are copied into the local store on the first authenticated recall and
marked local-only. The old file document is read from the `memory_documents`
table (it was never in Blob on the production store, so there is nothing left
to import there); the import marker is in Postgres, so an emptied scope is
not re-imported. New writes are authoritative in Postgres, which means rolling
back to the old file provider after cutover would hide post-cutover changes.

Every revision of a profile record is appended to `memory_revisions` in the
transaction that writes it, with who wrote it (`model`, `person`, `digest`,
`system`) and what it did (save, update, forget, expire, import, and the
digest's merge, correction, one-off and purge). Existing records with content start
their history with one `import` revision, and the hourly pass gives one to
each record saved by a release that did not write history. The history is for the person to see
and undo changes on the memory screen in the cabinet (`/workspace/memory`);
it never enters the model's context. Forgetting — at the person's
word or by the model — wipes the text of every earlier revision of that record
at once. A live record keeps its earlier texts up to its last ten revisions. The text of a record that expired or that the digest merged,
corrected or found one-off stays readable for 30 days, to be restored, and
then the hourly `agent/schedules/memory-history.ts` wipes it; the same pass
wipes the history of a record forgotten by a release that writes no revisions
(a rollback or a deploy window). «Забудь всё» (`profile__forget_all` leaving nothing)
also deletes the history of records that expired or were removed earlier.
`memory_scopes.last_recalled_at` marks, at most hourly, the scope key Bro's
conversations read, so the cabinet can show that scope's memory.

A daily digest (`agent/schedules/memory-digest.ts`, every hour at :41, each
workspace once per local day from 04:00) runs without a conversation and
without the main agent's model, and only for the pilot
(`MEMORY_DIGEST_WORKSPACES`): it changes what people saved, so with the
variable unset it runs for no one. `memory_digest_runs` holds each workspace's
day: the claim with its lease and the outcome in counts, never text. It cuts
one-time codes and credentials out of memory (`isSafeMemoryText`, in Russian
and English; a door's code, a phone number and a reference number such as a
client's or a bank's stay): the code itself is replaced by «[удалено]» and
the record keeps the rest; one that said nothing but the code is forgotten.
Workstream notes are redacted the same way, and any revision text with one is
wiped. It keeps the last ten revisions of each memory, and folds memories that
say the same words, or whose words another memory of the same category,
validity and `localOnly` says in full as a sentence of its own, into the one
that stays, with their aliases; rules are never folded, and what was folded
stays restorable from history for 30 days. A record the conversation changed
since the digest read it is left for the next day. Saving refuses a text with
a code for everyone, as before.
For the pilot, and only with a direct model provider, the digest also asks a
cheap model which memories are one-off task details, duplicates in other
words, or facts a newer one corrects — only when memory changed since the
start of the last digest that asked it. The model is the digest's own:
`MEMORY_DIGEST_MODEL`, or `deepseek/deepseek-v4-flash` when unset (a third of
the main default's price on RouterAI), never the main agent's or the
workspace's model; reasoning off, 400 output tokens. It never sees a rule, a
preference or a local-only memory. The model returns indexes only; code keeps
a proposal only where it holds (`agent/lib/memory/digest/classifier.ts`): a
one-off is a fact, decision or organization without a validity date that the
model read in full; a duplicate's every word is in the record it folds into,
in the same order; a correction goes from an older to a newer fact, person or
organization, and code writes its dated text («… (с 01.10; раньше: …)»). At
most three of each kind and a fifth of the memories change in a day; a failed
call changes nothing. Its cost is a `usage_costs` row with the source
`memory`.

The memory screen (`/workspace/memory`, tRPC `memory.*` in
`web/trpc/router.ts`) shows the scope Bro's conversations last read, or,
before any recall was marked (a scope from before the mark), the one written
last: rules,
preferences and the rest, and a timeline of the last changes. The person
edits a record's text (checked by `memoryTextSchema`, refused on a stale
revision), deletes it (history wiped as when Bro forgets it), and brings back
an earlier revision from the record's history (`restoreMemory`, written as
`restore` by `person`); a memory the digest removed or that expired comes
back from the timeline while its text is kept. A revision whose text the
filter now refuses is shown without it. Rules are only deleted there: they are set and changed
in the conversation, where a rule write needs the person's own turn.
Every call names the scope key the page showed, checked against the
workspace's own, so a conversation that recalls another scope meanwhile
does not redirect a delete; restore and edit refuse a stale revision, and an
edit drops the old aliases. Forgetting a record, here or in a conversation,
also wipes the history of the gone records the digest folded into it — every
word of their text is in the forgotten one — so a merged duplicate or a
corrected older fact does not stay restorable after the person deleted what
held it.

Forgetting a profile record means Bro stops using its content immediately and
requests permanent provider-document deletion. It does not erase existing chat
messages, historical infrastructure backups, or third-party logs. Telemetry is
configured to omit message, model, and tool payloads so new facts are not copied
into operational traces.

## Where the data lives

Bro is a hosted service, not software on the person's own machine or server,
and the interactive instructions (`agent/instructions/content/role/interactive.md`,
«Как ты устроен») tell people exactly this; keep the two in sync.

- The app and the agent run on Vercel; eve keeps conversation state in Vercel
  Workflow.
- Postgres on Neon holds the workspace, memory, schedules, orders, and the
  vault. Vault secrets are AES-256-GCM ciphertext under
  `SECRET_ENCRYPTION_KEY` (`db/services/vault.ts`); no model reads them.
- Files and generated pictures go to a private bucket of Object Storage on
  Cloud.ru, under `artifacts/` (`shared/object-storage/artifacts.ts`).
- Google, Notion, Slack and other connected apps' grants live in Composio,
  not in Bro's database; Bro keeps no provider token.
- Model providers see the conversation they answer, Browser Use sees the
  pages and vault values of the task it runs, and Supermemory indexes
  non-local profile facts when `SUPERMEMORY_API_KEY` is set.

## Deployment

1. Apply the Drizzle migrations before deploying the application code.
2. Configure `SUPERMEMORY_API_KEY` only in environments allowed to process
   non-local profile facts.
3. Deploy without changing the profile slot filename, implicit Eve namespace,
   or workspace scope. Those values derive the existing memory key.
4. Keep the previous Blob store during the rollback window: the installation
   secrets still live there (`db/services/installation-secrets.ts`).
5. Monitor outbox failures by error code and lag, never by logging fact text or
   search queries.

To disable hosted processing, remove `SUPERMEMORY_API_KEY`. Pending work remains
durable and local memory remains available. Provider deletion should be drained
before intentionally retiring an account or key.
