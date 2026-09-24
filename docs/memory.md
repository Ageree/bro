# Memory architecture

Bro separates memory by authority instead of treating a transcript or a hosted
search index as the source of truth.

- Personal Info owns typed reusable form fields in Postgres.
- Workstreams own goals, constraints, decisions, evidence, and unresolved work.
- Profile memory owns durable facts, people, organizations, decisions, and
  preferences as revisioned Postgres records.
- Eve owns current conversation history and compaction.
- Supermemory is an optional semantic index for non-local profile records. Its
  search results are identifiers only: Bro re-reads the current Postgres record
  before adding any result to model context.

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
marked local-only. The original Blob document is intentionally retained during
the rollback window; the import marker is in Postgres, so an emptied scope is
not re-imported. New writes are authoritative in Postgres, which means rolling
back to the old file provider after cutover would hide post-cutover changes.

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
- Files and generated pictures go to a private Vercel Blob store.
- Google, Notion, and Slack grants live in Vercel Connect, not in Bro's
  database.
- Model providers see the conversation they answer, Browser Use sees the
  pages and vault values of the task it runs, and Supermemory indexes
  non-local profile facts when `SUPERMEMORY_API_KEY` is set.

## Deployment

1. Apply the Drizzle migrations before deploying the application code.
2. Configure `SUPERMEMORY_API_KEY` only in environments allowed to process
   non-local profile facts.
3. Deploy without changing the profile slot filename, implicit Eve namespace,
   or workspace scope. Those values derive the existing memory key.
4. Keep the previous Blob store during the rollback window. Do not overwrite or
   delete its `MEMORY.md` files during the initial cutover.
5. Monitor outbox failures by error code and lag, never by logging fact text or
   search queries.

To disable hosted processing, remove `SUPERMEMORY_API_KEY`. Pending work remains
durable and local memory remains available. Provider deletion should be drained
before intentionally retiring an account or key.
