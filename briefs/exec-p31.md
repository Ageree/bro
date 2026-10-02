# Задача: пункт 31 роадмапа — ежедневная сводка памяти, история и экран памяти

Текст пункта (`docs/roadmap.md`, 31): «Фоновая задача переносит временное в рабочие записи, обобщает, пишет исправления с датой, вычищает одноразовые коды; хронология, история версий, экран памяти в `/workspace`. Готово: сводка идёт каждый день без участия модели основного агента, в памяти нет одноразовых кодов, d13 не ниже 7,5, человек видит и правит память в кабинете.»

ВАЖНО — уже найдено и чинится оркестратором отдельным срочным PR (ветка `claude/laughing-newton-wfp29r-memns`, заголовок про ключ памяти): на VM Cloud.ru у слотов `profile` и `workstreams` eve выбирал другой namespace (нет `VERCEL_PROJECT_ID`, appRoot сборки), поэтому с 02.10 память с Vercel не видна. Оркестратор закрепляет namespace явно и переносит записи, сделанные после переезда. НЕ делай этот фикс сам и не трогай namespace; начни с частей, которые от него не зависят (фильтр кодов, `memory_revisions`), а когда его PR сольют в `bro-next` — влей `bro-next` в свою ветку. Раздел «Possible memory scope fork» разбора поэтому уже решён.

Решения оркестратора по открытым вопросам разбора:
- Флаг — `MEMORY_DIGEST_WORKSPACES` (список воркспейсов или email, `*` — все) для шагов, меняющих записи (дедупликация, классификатор); вычистка одноразовых кодов и запрет их записи (`isSafeMemoryText`) — для всех сразу, это безопасность.
- Хранение истории: последние 10 версий на живую запись; текст истёкших и вычищенных сводкой — 30 дней. Забытое человеком стирается из истории сразу.
- Коды домофона и подъезда — не одноразовые, их не вычищать.
- Классификатор — дешёвая модель тем же прямым провайдером (`MEMORY_DIGEST_MODEL`, по умолчанию модель провайдера по умолчанию), reasoning выключен, вывод — только индексы, проверка кодом, лимиты; модель основного агента и ход eve сводка не зовёт. Расход — строкой `usage_costs` с источником `memory`.
- Обобщения v1 — слияние дублей, вложенность и исправления с датой, которые составляет код. Свободный пересказ моделью — нет.
- Экран: `/workspace/memory`; правила видны и удаляемы, но создаются и правятся только в разговоре с Бро («чтобы изменить правило, скажи Бро»).
- Пункт 34 роадмапа («ежедневный воркер памяти субагентом») заменяется этим решением — поправь его текст.
- Порядок PR — как в разделе 6 разбора (1: `memory_revisions` + история; 2: фильтр кодов + сводка кодом; 3: классификатор за флагом; 4: экран + tRPC + e2e).

## Разбор кода (исследователь оркестратора)

# Item 31: daily memory digest, timeline, version history and memory screen. Design brief

## 1. CURRENT STATE

**What memory is today**
- There is one store for profile memory: the `memory_records` table, plus `memory_scopes`, `memory_operations` and `memory_sync` (`db/schema/memory.ts`).
- Each record is keyed by `(workspace_id, scope_key, record_index)`. It carries `revision`, `generation`, `content` (jsonb `MemoryContent`, or null as a tombstone), `source_session_id`, `source_turn_id`, `created_at` and `updated_at`.
- At most 250 current records per scope (`maximumRecords`, `db/services/memory/records.ts:32`).
- **No version history exists.**
  - `updateMemory` (`records.ts:278`) overwrites `content`.
  - `forgetMemory` (`:344`) and `expireMemories` (`:437`) null it.
  - `memory_operations` logs only `(operationId, recordIndex, revision, action, createdAt)`, with no content. It is an idempotency ledger, not a history, and expiry writes no row to it.
- `MemoryContent` is defined in `shared/memory/schema.ts:54`.
  - Fields: `text` (up to 2 KB), `category ∈ fact|preference|person|organization|decision|rule`, `aliases` (up to 12), `relatedIndexes`, `validUntil` (nullable ISO date) and `localOnly`.
  - **There is no tier or kind field.** The only "temporary" signal is `validUntil`.

**Secret filter**
- `isSafeMemoryText` (`shared/memory/schema.ts:21`) is the only filter. It matches English keywords followed by `:`/`=`, token prefixes, and runs of 13–19 digits.
- I ran it in node. All of these pass as SAFE: "kod iz sms 482193", "SMS-kod: 4821", "parol: qwerty123", "OTP 123456", "kod podtverzhdeniya Gosuslug 123-456", "PIN 1234" (the Cyrillic originals, transliterated here).
- **Today, one-time codes written in Russian get into memory.** The only thing stopping them is the instruction in `agent/instructions/content/role/interactive.md:20`.
- Workstream content (`shared/workstreams/schema.ts`: notes up to 3,000 characters, sources) has **no** secret filter at all.

**Profile provider** (`agent/lib/memory/profile.ts`)
- `createProfileMemoryProvider` (`:299`) defines the tools `find`, `forget_all`, `read`, `remove_memory`, `save_memory`, `semantic_find` and `update`.
  - They are defined inline with `defineTool` inside `tools()`, and only for interactive user principals.
- `recallProfile` (`:435`) renders `renderProfile` (`:684`) into the message id `file-memory-document`. That message is a 6 KB budget, rules first, then preferences, then other records; each category is sorted by `updatedAt` descending, and each line shows `revision N`.
  - It also renders the note `profile-relevant-memory`, built from `renderPreferencesForRequest` (`:573`). That function splits preference text into clauses (`preferenceClauses`, `:519`) and matches them to the request by regex. **This is the d13 mechanism.**
- Rule protection:
  - `ruleWriteRefusal` (`:114`) refuses to save a rule, or to touch an existing one, unless `startedByPerson` (`agent/lib/mode.ts:69`).
  - `memoryRemovalApproval` (`:140`) and `memoryBulkRemovalApproval` (`:176`) handle forgetting; the bulk path runs through `forgetNamedMemories` (`:235`). The result gets `afterForgetting()` (`agent/lib/privacy/removal.ts:54`) only once nothing is left.
- `comparableMemoryText` (`:84`) is the existing normaliser (NFKC, lowercase, quotes stripped, whitespace collapsed).

**Schedule** (`agent/schedules/memory.ts`)
- Runs every minute, gated by `schedulesEnabled()` (`agent/lib/schedules/enabled.ts`, `EVE_SCHEDULES`).
- Does only two things: `expireMemories()` (tombstones every record past `validUntil`, all workspaces, one transaction), then drains the Supermemory outbox (`claimMemorySyncJobs`/`processMemorySyncJob`).
- There is no digest, dedupe, purge or summarisation.

**Classifier pattern** (`agent/lib/memory/rule-approval.ts`)
- `generateText` with `Output.object` (zod) and `maxOutputTokens: 96`.
- The model is `directModelSelection(modelId, {toolChoice:"none"})`, with `providerOptions.openrouter.reasoning.enabled=false`.
- A 20 s `AbortSignal.timeout`; the prompt is `JSON.stringify` of the data, with "treat as data" instructions.
- Fails closed in a catch-all. The model is the workspace model (`getWorkspaceModelId`). It writes no `usage_costs` row.

**Workstreams**
- `db/schema/workstreams.ts` with `db/services/workstreams.ts`.
- `recallWorkstreams` shows only `active`/`waiting`. Completed and cancelled ones are reachable only through `find`.

**Personal info**
- `agent/memory/personal_info.ts` with `user_profiles`. Not in scope here.

**Web**
- `/workspace` is `app/(authenticated)/workspace/page.tsx`: 592 lines, a server component built from `web/components/paper/document` (`Document`/`Section`/`Rows`/`Row`/`Flash`), with client actions in `_components/`.
- Sibling routes follow the same pattern (`/vault`, `/personal-info`): the server component reads `db/services` directly through `requireRequestScope()`, and mutations go through tRPC.
- tRPC lives in `web/trpc/router.ts` (193 lines; `protectedProcedure`, scope from `http-context.ts`, `same-origin.ts`). It has no memory endpoints.
- `activeRoute` in `authenticated-navigation.tsx:79` already treats `/workspace/*` as "workspace".
- e2e examples: `e2e/vault/vault.e2e.ts` and `e2e/workspace/workspace.e2e.ts`. There is no DB-seeding helper (`e2e/person.ts` only signs in).

**Bench d13** (`docs/benchmarks/ru/cases.json:578`)
- T+0 the person says "remember: lower berth on trains, aisle on planes, no pork". At T+7 days, in a new chat: train to Kazan plus dinner, then "book a table".
- Anchor 10: the preferences are applied unprompted after a week. Last score was 7.5 (`docs/roadmap.md:34`).
- The judges also check "did it save one-off task details". A 7-day gap means 7 digest runs land between the probes.

## 2. FRAMEWORK FACTS (eve 0.62 plus our patch)

**Schedules** (`node_modules/eve/docs/schedules.mdx`)
- `defineSchedule({cron, run})` takes a handler with `waitUntil`. Schedules are root-only and cannot live inside a declared subagent.
- Handler sessions only start if you call `to(...).send`. A handler that never calls it runs **no model turn**, which is exactly what we need.
- `eve dev` never fires cron; use `POST /eve/v1/dev/schedules/<name>` (dev-notes: through `next dev` it needs the session cookie).
- Self-hosted: Nitro's scheduled-task runner must be running. The VM runs `node .output/server/index.mjs` (dev-notes). The existing schedules evidently fire there, since the Vercel cron was disabled on 02.10, but I could not check this from here (**unverified**).
- eve swallows errors from `waitUntil` work, so catch and log yourself (pattern: `agent/schedules/browser-sign-ins.ts`).

**Subagents cannot help** (`node_modules/eve/docs/subagents/index.mdx:188`)
- A subagent is reached only through the parent model's tool call, so it needs a main-agent turn.
- Dev-notes add that a dynamic subagent needs a static model and that `task` is withheld outside the pilot.
- So a "memory worker as a subagent" (roadmap 34's wording) would need a main-agent turn, which fails the done criterion. **Use a plain `generateText` from the schedule handler instead.**

**Memory scope key** (`docs/memory/custom-provider.md:93`, `docs/memory/overview.mdx`)
- `memory.scope.key` is an opaque digest of namespace plus scope, computed **at runtime** by `defaultNamespace` (`dist/src/public/memory/index.js`, called from `dist/src/context/memory-lifecycle.js`).
- With no `VERCEL_PROJECT_ID`/`VERCEL_OIDC_TOKEN` it falls back to `["…","local", sha256(appRoot), node, slot]`.
- `scripts/cloudru-app-host/host.py:682` lists `VERCEL_PROJECT_ID` as NOT_RUNTIME ("never in the VM's env").
- **So the VM's profile and workstream scope keys probably differ from the Vercel-era keys** (unverified on data: see Risks).
- Consequences for this item:
  - The web screen and the digest cannot compute the key. They must read `memory_scopes` rows.
  - `listCurrentRules` ignores `scopeKey`, so rules survive a fork; facts and preferences do not.

**Recall messages are appended to history**
- They are user-role messages, never system (`custom-provider.md`, "Recall results").
- A stable `id` is replaced. Dev-notes: the profile document is re-appended to history **only when it changes**.
- So any digest write changes `renderProfile` output (revision numbers, order by `updatedAt`), which costs one extra profile copy (up to 6 KB) in each active session's history on its next turn.

**Constraints from dev-notes and the patch**
- Dynamic tool callbacks stay inline in `defineTool`. No new tools are proposed, so this is not an issue.
- Closures are JSON-only.
- The `durableMemoryToolsContext` hunk empties `messages` in the memory tools closure. Untouched here.
- Instruction resolvers do not see the incoming message. Irrelevant: no new instructions.
- `.refine()` is lost only in **static** tool JSON Schema. The memory tools are dynamic, and `memoryContentSchema.parse` is re-run in `saveMemory`/`updateMemory` anyway, so a stronger `isSafeMemoryText` takes effect both at the tool boundary and in the DB layer.
- RouterAI plus DeepSeek reasons by default. Reasoning must be disabled exactly as `rule-approval.ts` does. `directModelSelection` already applies `provider.ignore`/order and the RouterAI fetch.

## 3. DESIGN

### 3.1 Vocabulary (no schema change to `MemoryContent`)
- **Temporary** = a current record with `validUntil` set (trip dates, a week's plans), plus records the classifier tags as a one-off task detail.
- **Working** = current records with no `validUntil`.
- **Timeline** = the append-only revision log (below). Expired and forgotten-by-digest items move there, not into the profile.
- Rejected: adding `tier`/`kind` to `MemoryContent`. It changes the dynamic tool input schema (schema tokens on every step, item 25's cache work, `agent.test.ts` pins) for no gain.

### 3.2 Data model (migration 0044+, generated on top of `bro-next` right before merge, per dev-notes)

**`memory_revisions`** (append-only), in `db/schema/memory.ts`:
- Columns: `workspace_id` (FK cascade), `scope_key`, `record_index`, `revision`, `content jsonb NULL`, `action text`, `actor text`, `session_id text NULL`, `created_at`.
- `action` CHECK: `save|update|forget|expire|import|digest_merge|digest_purge|digest_oneoff|digest_correct|web_update|web_forget|web_restore`.
- `actor` CHECK: `model|person|digest|system`.
- PK `(workspace_id, scope_key, record_index, revision)`; index `(workspace_id, scope_key, created_at)` for the timeline.
- Written **inside the existing transactions** in `saveMemory`, `updateMemory`, `forgetMemory`, `expireMemories` and `importLegacyMemories`. Add an optional `origin: {actor, action}` parameter that defaults to model.
- **Privacy rules:**
  - `forgetMemory` sets `content = NULL` on every revision of that record, in the same transaction. Forgetting must stay "content gone now" (`docs/memory.md`).
  - A digest purge of a code wipes history too.
  - When `forget_all` leaves nothing (`nothingLeftBut`), wipe the scope's whole history.
  - Retention, in the digest: keep the last 10 revisions per live record; null the content of expired and forgotten-by-digest records after 30 days. Retention days are an owner decision.
- Backfill in the migration: `INSERT … SELECT` one `import` row per current record.
- Rejected alternative: adding `content` to `memory_operations`. Operations are idempotency keys, expiry writes none, and digest steps are not one-to-one with them.

**`memory_digest_runs`**:
- Columns: `workspace_id` (FK), `local_date date`, `status` (CHECK `running|done|failed`), `lease_until`, `started_at`, `finished_at`, `outcome jsonb` (counts: `purged`, `deduped`, `contained`, `oneOff`, `corrected`, `historyTrimmed`, `classifier: {called, model, inputTokens, outputTokens}`), `error_code`.
- PK `(workspace_id, local_date)`. This is both the per-day idempotency key and the done criterion's evidence.

**`memory_scopes.last_recalled_at`** (nullable):
- Touched by `recallProfile` at most hourly (a conditional `UPDATE … WHERE last_recalled_at < now()-1h`).
- Lets the web screen pick the scope key the agent actually uses. Fallback: the scope with the most current records.

**`usage_costs`**:
- Add source `memory` and widen `usage_costs_source_check` in the migration. One row per classifier call (`units.model`, tokens, `steps:1`, no `session_id`).
- This makes "no main-agent model" provable.

### 3.3 Code layout
| Path | Role |
|---|---|
| `shared/memory/schema.ts` | Extend `isSafeMemoryText` (shared by db, agent and web). Rejects Russian and English one-time codes and credentials (details below). Domofon/entrance codes are not one-time: allowed by default, owner to confirm. |
| `db/services/memory/records.ts` | `origin` parameter and revision writes as above. New `listMemoryScopes(workspaceId)`. |
| `db/services/memory/revisions.ts` | `listRecordHistory`, `listTimeline(scope, before, limit)`, `wipeRecordHistory`, `trimHistory`, `restoreRevision` (an `updateMemory` with `actor: person`). |
| `db/services/memory/digest-runs.ts` | `claimDigestDay(workspaceId, localDate, leaseMs)`: `INSERT … ON CONFLICT DO UPDATE … WHERE status='failed' OR (status='running' AND lease_until<now())`; `completeDigestDay`; `failDigestDay`. |
| `agent/lib/memory/digest/run.ts` | Per-workspace orchestration (steps below). |
| `agent/lib/memory/digest/dedupe.ts` | Pure functions using `comparableMemoryText`. |
| `agent/lib/memory/digest/classifier.ts` | The `generateText` call. |
| `agent/schedules/memory-digest.ts` | `cron: "41 * * * *"`, `schedulesEnabled()` gate, `waitUntil(runDueDigests())` with its own try/catch and log. |
| (no change) | `agent/agent.ts` and `agent/instructions/*`: no new tools, no instruction text. |

`isSafeMemoryText` additions, in detail:
- Code keyword plus a digit group: `(kod|code|pin|pin-kod|otp|cvv|cvc)\D{0,25}\d{3,8}`, where the keyword group must include the Cyrillic forms of kod/pin. Only when it sits next to an SMS/confirmation/sign-in/one-time/2FA keyword or a known service name, so that "city code 843" and "order number 123456" still pass.
- Password word followed by a value: `(parol|password|passwd)\s*[:=—-]?\s*\S+`, with the Cyrillic form of parol included.
- Keep plain regexes. These are not emitted as JSON Schema `pattern`, so the OpenAI dialect rule does not apply, but stay simple anyway.

### 3.4 Digest algorithm

**Per tick:**
- Pick workspaces that have `memory_scopes` rows or workstreams, whose local time (`user_profiles.timezone` via `resolveTimeZone`) is at least 04:00, and that have no `done` row for `localDayKey(now, tz)` (`shared/calendar/local-period.ts:26`).
- Claim up to 25 with the lease. A missed hour retries next hour.
- The `AccessScope` comes from the workspace owner (`workspace_memberships.role='owner'`).

**Per workspace, per scope key, in order. All writes go through the `records.ts` functions** (scope lock, `expectedRevision`, sync outbox, revision rows):

1. **Purge codes (code only).**
   - For every current record failing the new `isSafeMemoryText`: `forgetMemory` with action `digest_purge`, then wipe its history.
   - For workstreams: replace each matched substring in `notes`/`sources[].observation` with a placeholder via `saveWorkstream(expectedRevision)`.
   - Also null the content of any revision row whose text fails the check.
2. **Exact dedupe (code only).**
   - Same category and equal `comparableMemoryText`: keep the lowest index, union aliases (up to 12) with one `updateMemory`, forget the others (`digest_merge`).
3. **Containment (code only).**
   - Same category, and A's comparable text is a substring of B's: forget A.
   - Never across categories. Never for preferences when B is not itself a preference.
4. **Expiry already happens every minute.** It now writes `expire` revisions, so the timeline shows "trip to Kazan, expired 12.10" with no extra step.
5. **Classifier, LLM, optional, behind a flag.**
   - Runs only when some non-rule record changed since the last `done` run, and only if `directModelActive()`.
   - Input: `{today, records:[{index, category, text, validUntil, updatedAt}]}` for categories other than rule.
   - Output (zod, nullable arrays, `maxOutputTokens` around 400, 30 s timeout, `reasoning.enabled=false`, `toolChoice:"none"`, model `env.MEMORY_DIGEST_MODEL ?? <provider default flash>`, deliberately not the workspace's chosen main model): `{oneOff:int[], duplicateOf:[{index, of}], supersededBy:[{older, newer}]}`.
   - **Code validates every proposal:**
     - Indexes must exist and be current.
     - `oneOff` only for `fact|decision|organization`, never `preference|person|rule`.
     - `duplicateOf` is accepted only if every content word (at least 4 letters) of the dropped text appears in the kept one, the same containment test as step 3, so a clause can never be lost.
     - `supersededBy` only for `fact|person|organization` in the same category, with `newer.updatedAt > older.updatedAt`. The **dated correction text is composed by code**, not by the model: `newer.text + " (since DD.MM; previously: older.text)"`, passing the 2 KB limit and the safety check. The older record is forgotten (`digest_correct`).
     - Cap per run: at most 3 one-offs and at most 3 corrections, and at most 20% of records changed. Anything beyond the cap is ignored.
     - Parse errors or timeouts change nothing (fail closed, opposite to rule-approval's deny: here inaction is the safe side).
6. **Retention trim**, then `completeDigestDay(outcome)` and one log line per workspace: `[memory-digest] run {workspaceId, outcome}`. Counts only, never text.

**Invariants, enforced in code and tested:**
- The digest never reads or writes a record whose category is `rule`, before or after.
- It never writes `category:"rule"` or `"preference"`; it only forgets duplicates or contained preferences.
- It never touches `settings`, spend policy or standing permissions.
- It never creates a record. Its only writes are update or forget of existing ones, so it cannot add or widen a rule; `ruleWriteRefusal`'s purpose is preserved without a session.
- Every change is reversible from history through the web "Restore" action.

**"Generalisation" in v1** = merge, containment and dated corrections. Free-form summary text written by the model is **v2**, shown as suggestions on the memory screen that the person accepts with a tap. It is rejected for v1 because a weak model rewriting preferences would break `preferenceClauses` matching, which is the d13 risk.

**Rejected designs:**
- An eve markdown schedule or worker session: it is a main-agent model turn, and dev-notes say the worker path costs about 3.9k tokens with no benefit.
- An eve subagent: needs a parent turn (section 2).
- Extending the minute tick in `memory.ts`: it is a global transaction, has no per-workspace lease, and runs 1,440 times a day.

### 3.5 Web memory screen (`/workspace/memory`)

**Route files**
- `app/(authenticated)/workspace/memory/page.tsx`: a server component that reads through `db/services` (`app/` must not import `agent/`, per `no-forbidden-layer-imports`).
- `_components/`:
  - `memory-records.tsx`: list grouped as rules, preferences, other. Search input, a category `select`, `Rows`/`Row`, `badge` for category and for "until DD.MM".
  - `memory-record-dialog.tsx`: `dialog`, `textarea`, `input`, `field`.
  - `memory-history.tsx`: a `sheet` with the per-record revisions, dated, with a "Restore" button.
  - `memory-timeline.tsx`: `Section` "Timeline", paged.
- Use `web/components/ui` primitives and `type-fine`/`type-status`/`type-act`, matching the vault page.
- `/workspace/page.tsx` gets one `Row` linking to the screen ("N records"). Optionally a nav item.

**tRPC endpoints** (`web/trpc/router.ts`), all `protectedProcedure`, scope from the session, and each takes `scopeKey` + `index` validated against `listMemoryScopes(ctx.scope.workspaceId)`:
- `memory.list({query, category, offset})`
- `memory.history({scopeKey, index})`
- `memory.timeline({before})`
- `memory.update({scopeKey, index, expectedRevision, text, aliases, validUntil})`
- `memory.remove({scopeKey, index, expectedRevision})`
- `memory.restore({scopeKey, index, revision})`
- `memory.clearHistory()`

**Rule handling in the web (v1)**
- View: yes. Delete: yes; it is the person's own authenticated act, actor `person`.
- **Create, edit or recategorise a rule from the web: no.** In chat, stating a rule also narrows the spend limit and standing permissions in the same turn, and triggers `ruleAccessNote` (Google read-only offer). A web edit would bypass that. The UI says "to change a rule, tell Bro".
- Category changes to or from `rule` are refused in the procedure.

**Create from web**
- Allowed for non-rule categories only when a scope row exists (the key is opaque; see section 2). Otherwise the screen shows "appears after your first chat with Bro".

**Copy updates**
- `agent/lib/privacy/removal.ts` `removalOutsideMemory()`: add the memory screen via `cabinetPage("/workspace/memory", …)` and mention that history and timeline are cleared by "forget everything". Delivered through the tool result, not the instructions, per the dev-notes rule.
- `agent/lib/privacy/facts.ts` `dataProcessors`: add a line saying that a daily digest sends memory texts to model X.
- Also update `docs/memory.md` and add a dev-notes entry under "Память Бро".

## 4. RISKS & GOTCHAS

**Possible memory scope fork at the VM cutover (unverified, check first)**
- On the VM, `defaultNamespace` likely resolves to `local`+`sha256(appRoot)`, and `appRoot` may even change per release path. If so, profile and workstream memory written on Vercel is invisible on the VM, and possibly after every release. Rules still apply because `listCurrentRules` ignores the key.
- Check through a VM ops script, SQL on stdin, counts only: `SELECT workspace_id, scope_key, count(*), max(updated_at) FROM memory_records WHERE content IS NOT NULL GROUP BY 1,2 ORDER BY 1,4`.
- If a workspace has records under two or more keys after 02.10, fix that before this item: a pinned `namespace` in `agent/memory/profile.ts`/`workstreams.ts` plus a key migration. Both the digest and the web screen depend on the right key.

**d13 regressions**
- A preference rewritten or merged incorrectly drops a clause, and `renderPreferencesForRequest` then stops matching "no pork" to dinner. Mitigations: preferences are never rewritten; drops pass the word-containment check; `oneOff` excludes preferences.
- A trip record ("weekend in Kazan") with `validUntil` that the classifier marks one-off would lose the city-conflict probe. Mitigation: `oneOff` only touches records with no `validUntil`. Add this to the validation rules.

**Cache and cost**
- Every digest write changes `renderProfile` (revision numbers, `updatedAt` order), which re-appends about 2k tokens per active session once per day.
- A run that changes nothing must write nothing: no `updated_at` bump, no revision. Test that the profile output is byte-identical.
- No instruction or schema change, so there is no prefix break and no conflict with items 24/25.

**Concurrency**
- A model `profile__update` racing the digest makes the `expectedRevision` mismatch throw ("Memory changed…"). The digest catches it per record and skips; it must not fail the day.
- `lockScope` takes `FOR UPDATE` on the workspace row. Process scopes one at a time (as `forgetNamedMemories` does) so the pool is not exhausted.

**Security rules that must hold**
- `ruleWriteRefusal`, `memoryRemovalApproval` and `memoryBulkRemovalApproval` are unchanged.
- The digest never touches rules. Web cannot create or edit rules.
- Classifier input is untrusted (records can come from report turns). Its output is indexes only, validated, capped and reversible.
- Forgetting must wipe history content, and so must purge. `forget_all` with nothing left wipes the timeline, or "forget everything" (d14) would leave text behind.
- The `said.ts` and approval cards are unaffected (the digest has no session).
- Digest logs carry counts only (`docs/memory.md`: never log fact text). `psql` errors stay terse.

**False positives in the new code regex**
- Phone numbers, order numbers, flight numbers, postcodes, city codes, door codes. Unit-test a table of both sides.
- A stricter `isSafeMemoryText` also makes `importLegacyMemories` drop more legacy lines, which is acceptable.

**Tests that pin current behaviour**
- `tests/agent/memory.test.ts`: `renderProfile` output ("reads as it always did…", "keeps the rules when the facts no longer fit"), the forget paths, "isolates both the workspace and Eve scope key", "replays operations without duplicating records".
- `tests/agent/schedules/switch.test.ts`: enumerates schedules; add `memory-digest`.
- `agent/lib/memory/rule-approval.test.ts`: the classifier pattern.
- `tests/agent/tools/privacy.test.ts`: `removalOutsideMemory` text.
- `tests/agent/agent.test.ts:424`: tool list. Should be unchanged.
- `db/tests/database-schema.test.ts` and `database-migration.test.ts`.
- `tests/agent/memory-tools-attachments.test.ts` and `approval-memory-recall.test.ts`: must not change.

**PGlite tests**
- Re-import `@db` per case after `vi.resetModules()`, per dev-notes.

**Environment**
- `EVE_SCHEDULES=off` on the stand silences the digest.
- On the stand, set `MEMORY_DIGEST_MODEL` to a cheap model, or leave the classifier off.

## 5. TEST & ACCEPTANCE PLAN

**Unit tests (vitest; use `env -u TELEGRAM_BOT_USERNAME` in the cloud session)**
- `shared/memory` safety table:
  - Rejected: Russian and English one-time codes, "parol: x", "OTP 123456", "kod podtverzhdeniya 123-456".
  - Accepted: "city code 843", "order 1234567", a phone number with +7, "flight SU 1234", a postcode, a door code.
- `db/services/memory` revisions (PGlite):
  - Save, update, forget and expire each write a row with the right action and actor.
  - Forget nulls all content of that record.
  - Restore re-applies a prior revision with `expectedRevision`.
  - Trim keeps the last 10.
  - Backfill migration row.
  - Workspace and scope isolation.
- Digest (PGlite plus `vi.mock("ai")` at the boundary, as `rule-approval.test.ts` does):
  - Purges a code record and its history.
  - Redacts codes in workstream notes.
  - Exact and containment dedupe keeps the lowest index and unions aliases.
  - **Never touches a rule even when the classifier names it.**
  - Never drops a preference unless it is contained in another.
  - Ignores proposals over the caps.
  - The classifier is not called when nothing changed.
  - A classifier throw or bad JSON means no LLM changes, but the code steps still apply.
  - Re-running the same `local_date` is a no-op; a crashed `running` row is reclaimed after the lease; a concurrent revision bump is skipped.
  - `renderProfile` is byte-identical after a no-op run.
  - `providerOptions.openrouter.reasoning.enabled === false` and `maxOutputTokens` is bounded.
  - A `usage_costs` row with source `memory` is written.
- `switch.test.ts`: `memory-digest` does nothing when `EVE_SCHEDULES=off`.
- `web/trpc/router.test.ts`:
  - `memory.update` refuses category `rule` and editing a rule.
  - It refuses unsafe text.
  - It refuses another workspace's `scopeKey`.
  - Remove and restore work.

**e2e: `e2e/memory/memory.e2e.ts`** (commit the `.e2e/cache/` entries)
- `smoke`: a new person's memory screen shows the empty state and "appears after your first chat".
- `agent`: in chat, ask Bro to remember "no pork" → open `/workspace/memory` → the record is visible → edit it to add lamb → the history sheet shows the previous text with today's date → Restore → Delete → empty. Use exact locators for the buttons (the vault test explains why).
- `agent`: tell Bro to remember an SMS code with digits; the memory screen afterwards has no record with digits. Alternatively the web form shows the refusal.

**Evals** (`eve eval agent --tag memory`, plus `privacy`, plus `schedules`; dev-notes cover the cloud setup)
- Add to `evals/agent/memory.eval.ts`: "Does not save a one-time code given in Russian" (no `profile__save_memory` carrying digits, or a refusal note).
- Re-run the existing "Recalls a stable preference in a separate session" and "Does not save an explicitly one-off preference".
- `privacy`: the forget-everything reply mentions the memory screen.

**Bench**
- RU d13 on prod with the digest enabled for the owner's workspace: `pnpm bench run --case d13-memory`, then `bench next` after 7 days.
- In between, confirm 7 `done` rows in `memory_digest_runs` for the bench workspace and that the three preference clauses survived (the record's revision history in the UI).
- Two judges; the target is at least 7.5. Also re-run d14, because forget and rules are touched.
- Clean up digest traces afterwards (dev-notes: earlier runs leak into later cases).

**Prod acceptance (counts only, via VM ops scripts)**
- **"Every day":** `SELECT local_date, status, count(*) FROM memory_digest_runs WHERE local_date >= current_date-7 GROUP BY 1,2` shows one `done` per workspace with memory, every day, and no stuck `running` rows.
- **"Without the main agent's model":** `usage_costs WHERE source='memory'` shows only the digest model with `steps=1`. No new `background` usage rows or eve sessions coincide with digest ticks. The journald line `[memory-digest] run` has `classifier.called` true or false.
- **"No one-time codes":** a SQL scan with a Postgres `~*` port of the new pattern over `memory_records.content->>'text'`, `memory_revisions.content::text` and `workstreams.content::text` returns 0 rows. Run it once before the first digest (baseline) and daily after.
- **"Person sees and edits memory":** e2e green in CI (the `E2E` job), plus an owner check on `brobro.tech/workspace/memory`.

## 6. SIZE

Four PRs, about 2.5k lines including tests.

1. **`memory_revisions` and `last_recalled_at`.**
   - Revision writes and history wipes in `records.ts`, backfill migration, recall touch in `profile.ts` (`recallProfile`), tests. Small to medium.
2. **Code patterns in `shared/memory/schema.ts` plus the code-only digest.**
   - `memory_digest_runs`, `agent/lib/memory/digest/{run,dedupe}.ts`, `agent/schedules/memory-digest.ts`, `switch.test.ts`, the new eval, `docs/memory.md` and a dev-notes entry. Medium.
3. **Classifier step behind `MEMORY_DIGEST_MODEL`/pilot (`MEMORY_DIGEST_WORKSPACES`).**
   - `usage_costs` source migration, `env.ts`, `privacy/facts.ts`, tests. Medium.
4. **The `/workspace/memory` screen.**
   - Plus tRPC, `removal.ts` copy, e2e and cache. Large.

| File or area | Overlap with other items |
|---|---|
| `agent/agent.ts` | None (no tools, no `withheldTools` change). |
| `agent/instructions/*` | None. Avoids conflict with item 24's skill split. One optional later edit: mention the memory screen in "How you are built" if item 24 moves that text into a skill. |
| `agent/lib/model/*` | Read-only use of `directModelSelection`/`modelEndpoint`. A signature change by item 25 or the step-context pilot would touch `classifier.ts`. |
| `db/schema/memory.ts`, `db/schema/usage-costs.ts`, `db/schema/index.ts`, `db/migrations/meta/_journal.json` | Migration numbering and journal conflicts with items 26 (`site_guidance`), 27 (subscriptions) and 32. Regenerate on top of `bro-next` before merge. |
| `shared/environment/env.ts` | Shared with every item that adds a flag. |
| `agent/lib/privacy/removal.ts`, `facts.ts` | Item 32 (mail onboarding) and item 33 (agent mailbox) will also touch these. |
| `web/trpc/router.ts`, `app/(authenticated)/workspace/page.tsx` | Item 32 may add a cabinet row as well. |
| `agent/lib/memory/profile.ts` | Item 32 ("write only confirmed") writes through `saveMemory`, so it should pass the new `origin`. |
| Roadmap item 34 | Its "daily memory worker via subagent" is superseded by this design: a plain handler with no subagent. Update roadmap 34's text in PR 2. |

ultracode

Ты — исполнитель в работах над Бро (личный ассистент в мессенджерах), репозиторий `Ageree/bro`, основная ветка `bro-next`, прод https://brobro.tech. Работу ведёт сессия-оркестратор: она ревьюит, сливает твои PR и выкатывает их на прод. Владелец пишет оркестратору; ты владельцу не пишешь и вопросов не задаёшь — решай сам, а то, что может сделать только владелец, записывай в описание PR.

## Как работать

1. Сначала: `AGENTS.md` и `docs/dev-notes.md` (подключены через `CLAUDE.md`), свой пункт в `docs/roadmap.md`, `docs/instinct.md` (разделы 4–5 и 7). Ниже — разбор кода по твоему пункту, который сделал исследователь оркестратора: это сильная отправная точка, но проверяй утверждения в коде.
2. Окружение свежей облачной сессии: `pnpm install`; Node 24 по `docs/dev-notes.md`, раздел «Процесс» (`npm pack node-linux-x64@24` в scratchpad, `bin` — в начало `PATH`); vitest — через `env -u TELEGRAM_BOT_USERNAME`; для сборок заглушки `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (не короче 32 знаков). Локальный Postgres для миграций — от не-root, данные вне `/tmp/claude-0` (`setpriv --reuid=postgres`).
3. Ultracode включён: на каждую содержательную часть запускай workflow с подагентами (модель opus 5.5, effort high): проект решения с независимыми вариантами, реализация, состязательное ревью (корректность, безопасность и правила fail-closed, кэш промпта, правила `AGENTS.md`) до пуша. Токены не экономь.
4. Поведение, меняющее ответы Бро или фоновые действия, — только за флагом-списком воркспейсов (образец: `STEP_CONTEXT_WORKSPACES`, `agent/lib/workspace-list.ts`, переменная — в `shared/environment/env.ts`). Оркестратор включит флаг владельцу, прогонит бенчмарк и потом включит всем.
5. Перед каждым пушем — все четыре зелёные: `pnpm types:generate && pnpm check --concurrency=1`, `pnpm build`, `pnpm build:eve` (с заглушками env). Видимое человеку (страница, форма) — с браузерным тестом в `e2e/` и закоммиченным `.e2e/cache/` (`docs/e2e.md`). Миграции генерируй поверх свежего `bro-next` прямо перед просьбой о слиянии (dev-notes: превью и прод делят базу, порядок `when` важен), делай их идемпотентными.
6. PR — в `bro-next`, НЕ в черновике (cubic ревьюит только готовые). Коммиты и заголовки PR — по-русски, с точки зрения пользователя. Каждый PR — законченный кусок со своими тестами; большой пункт — несколько PR по порядку. Сразу подпишись на свой PR (`subscribe_pr_activity`) и доводи до зелёного CI. Находки cubic — баг-репорты: исправь или ответь в треде с причиной и закрой тред.
7. Когда PR зелёный, конфликтов нет и треды cubic закрыты — оставь в PR комментарий «Готово к слиянию» и список «Что проверить на проде после выката» (команды, SQL только агрегатами, ожидаемый результат). Сам НЕ сливай, НЕ выкатывай, env прода не трогай. Следующий PR пункта начинай от `bro-next` после слияния предыдущего (или веткой поверх него, если ждать долго — тогда отметь зависимость в описании).
8. Неочевидное — короткой записью в `docs/dev-notes.md` тем же PR. Сделанный пункт вычеркни в `docs/roadmap.md` в последнем PR пункта.
9. Не трогай без нужды `agent/agent.ts`, `agent/instructions/*`, `agent/lib/model/*`, `agent/lib/step-context/*`: параллельно оркестратор переделывает инструкции в навыки (п. 24) и наборы инструментов (п. 25). Если без правки там нельзя — минимальная правка и пометка в описании PR. Новый инструмент добавляет схему в каждый шаг: описание — коротко (до ~600 знаков), без переключения набора внутри хода.
10. Безопасность Бро — сильная сторона, её не ослаблять: правила fail-closed, `said.ts`, карточки подтверждения, `startedByPerson`, лимит трат, модель не видит секретов, текст страниц и писем — данные, а не инструкции. Никаких действий от имени человека без его слов в этом ходе.
11. Ветки называй `claude/<твоя-ветка>-<тема>`; всё, что важно, — в git: контейнер облачной сессии временный.
