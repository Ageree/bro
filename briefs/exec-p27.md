# Задача: пункт 27 роадмапа — подписки на события

Текст пункта (`docs/roadmap.md`, 27): «Одна таблица: источник, условие, срок, действие, правило „будить ли человека“; шаблоны частых подписок; проверяет код без модели. Готово: d10 и d11 приходят сами, „следить за ценой“ неделю без модели, кроме найденного изменения.» Связано с P0 №5 роадмапа (проактивность: рейс и вечерняя почта не доходят) — закрой и его, если сделаешь d10/d11.

Решения оркестратора по открытым вопросам разбора:
- Тихие часы Бро остаются 22:00–08:00. Не будить ночью ничем, кроме срочного (рейс завтра рано, изменение рейса, безопасность). Вечерняя почта d11: смотри якоря кейса в `docs/benchmarks/ru/cases.json` и делай так, чтобы ответ на якорь 10 получался сам; если якорь требует разбора до сна — разбор до 22:00 одним сообщением, остальное — утром одним сообщением.
- Флаг — `SUBSCRIPTIONS_WORKSPACES` (список воркспейсов или email, `*` — все).
- Цена: шаблон `price` проверяет код (JSON-LD, meta, itemprop, простые адаптеры). Сайт, который не отдаёт цену обычным HTTP, — честный отказ при создании и предложение ежедневного расписания с браузером.
- Плюс-адреса в заготовках d11 (руководитель и друг) — артефакт заготовки: поправь заготовки бенчмарка (`scripts/bench/fixtures*`), а `-from:me` в продукте оставь.
- Учёт: строки `usage_costs` фоновых ходов должны нести `run_id` прогона, чтобы «неделю без модели» можно было доказать SQL-ом (как в разборе).
- Порядок PR — как в разделе 6 разбора (1: таблица, вычислитель, цена, инструмент, отчёт, правило будить; 2: рейсы; 3: вечерняя почта, посылки, заготовки d10/d11, вычёркивание).

## Разбор кода (исследователь оркестратора)

# Item 27: event subscriptions design brief

## 1. CURRENT STATE

Most of roadmap P0 item 5 is already in the code. The item is still not crossed out because d10 and d11 have not been re-run overnight on prod.

**Proactive watch: one hidden job per workspace**
- `agent/schedules/proactive.ts`: cron `*/5`. Each workspace is checked every 15 min (`checkEveryMs`), with at most 12 model runs a day (`maxRunsPerDay`).
  - `runProactiveChecks` (L61) leases watches with `claimDueProactiveWatches` (`db/services/proactive.ts:238`); the lease is the `next_check_at` field itself.
  - `checkByDay` (L110): `probeGoogleSignals`, then `filterUnseenProactiveSignals` (`db/services/proactive.ts:359`), then `catchUpSignals` (L148, ranks the backlog with `rankMail`), then `queueProactiveRun` (`db/services/proactive.ts:393`).
  - `queueProactiveRun` puts one run per check into `scheduled_agent_runs` of the hidden `kind='proactive'` job. It returns `busy` while a run is open; the daily cap is skipped when calendar signals are present.
  - `checkAtNight` (L173): a `nightOnly` probe that keeps the watermark. Then `deferProactiveWatch` moves the next check to the end of quiet hours.
  - `dispatchProactiveRun` (L233) sends `proactiveRunPrompt` to the `scheduled-run` channel as a `scheduled-worker` with `scheduledRunKind=proactive`.
- `agent/lib/proactive/probe.ts`:
  - `probeGoogleSignals` (L129) lists Gmail ids (`listMailIds` L315, up to 5×100) plus calendar events 26 h ahead. No model is called.
  - `readJson` (L102) retries once on `GoogleUnreadableAnswerError`. This is the fix for the "expected object, received string" cause in item 5.
  - `nightMail` reads subjects; `rankMail` (L209) reads headers of up to 60 messages.
- `agent/lib/proactive/signals.ts`:
  - `gmailProbeQuery` (L36): `in:inbox … -from:me`.
  - `calendarSignals` keys events as `id@start`.
  - `flightReminders` (L186) is a stateless, clock-driven function:
    - `#checkin`: 3–24 h before departure, daytime only.
    - `#evening`: 18:00–23:00 local, for a flight tomorrow before 12:00.
    - Keys are `eventId@start#kind`, so a reminder fires even when the flight was "seen" before.
  - `isFlight` is a regex on summary/location. `isNightFlight` means within 12 h. `isNightSubject` matches flight or security subjects.
  - `mailRank` (L257) and `selectRunSignals` (L287): calendar first, then mail by rank, capped at 12.
  - `proactiveRunPrompt` (L355) and `reminderTasks` tell the worker what to say. The evening reminder asks the worker to start with `[срочно]`.
- `agent/lib/proactive/quiet-hours.ts:35` `quietHoursEnd`: fixed 22:00–08:00 local.
- `agent/lib/proactive/delivery.ts:32` `proactiveReportTiming`: `held` / `night` / `day`. A report may go out at night only if it is `time_sensitive` and (it carries a calendar event or the run was a night run).
- Dedupe and state live in `db/schema/proactive.ts`:
  - `proactive_watches`: lease, mail watermark, remembered messenger/web chats, `google_state`.
  - `proactive_signals`: PK `(workspace_id, source, dedupe_key)`, pruned after 14 days.
- Worker role: `agent/instructions/content/role/proactive-worker.md`. It sorts signals into 6 categories. Its only tools are `calendar-list-events`, `gmail-read-thread` and `gmail-search` (pinned in `tests/agent/capabilities.test.ts`).

**User schedules**
- `agent/tools/schedules.ts`: `schedules-create/list/update/answer`, interactive only.
  - `scheduleApproval` requires a card when `!startedByPerson`.
  - `schedulePromptSchema` forbids conditions the person did not state.
- `db/services/scheduled-agent-jobs.ts`:
  - `materializeDueScheduledAgentRuns` (L305) and `claimReadyScheduledAgentRuns` (L360) filter on `kind`, default `'task'`.
  - `ownedTasks` (L127) means `kind='task'`.
- `agent/schedules/dynamic.ts` (cron every minute) dispatches workers, answers and reports.
- Today a "watch the price" request becomes an interval `task` schedule. Every run is a model worker; the `scheduled-worker` mode has `web_fetch`, `find_images` and `browser_task`. The model is paid on every check.

**Delivery of background results**
- A finished run with `reportStatus='pending'` is picked up by `listRecoverableScheduledReports` (L1216). For proactive jobs it goes through `dispatchRecoverableReport` (`dynamic.ts:234`) and `proactiveReportTiming`.
- `dispatchScheduledReport` (`agent/lib/schedules/report.ts:38`) runs a report turn (`scheduled-result`, `turnPolicy: "queue"`) via `to(telegram|photon)` or `attachSession(webSessionId)`.
- Target: `reportConversations` (`scheduled-agent-jobs.ts:1154`) picks the last messenger, otherwise the latest web chat. Overnight reports are merged by `absorbHeldProactiveReports` (L1100).
- The report turn uses the model: the `scheduled-report` mode has only `send_message` and `request_vault_setup`.

**Still open from item 5**
- Plus-address fixture mail (boss and friend in d11) is labelled SENT and excluded by `-from:me`. This is a bench artifact (`docs/benchmarks/README.md`, dev-notes "Бенчмарк").
- Phishing landing outside Inbox: cause unverified, likely Spam.
- The worker making time errors (model).
- No overnight re-run of d10/d11 since these fixes.

**Pieces that already exist for code-only checks**
- SSRF-safe fetch: `agent/lib/sandbox/public-fetch.ts` `fetchPublic` (pins resolved public IPs, https only), plus `downloadWithin` (`agent/lib/inbound-media/download.ts`) with an `allowUrl` check on every redirect hop. Used in `agent/lib/sandbox/router.ts:178`.
- JSON-LD and meta scanning already exists in `agent/tools/find_images.ts` (`scanPage`, ~L398).
- Routing without a model: `findPlaces` and `measureRoutes` in `agent/lib/routes/openstreetmap.ts`.
- Residential RU proxy: `BROWSER_VM_PROXY`, `agent/lib/browser-vm/proxy.ts`.
- The browser worker has a "direct mode" with no agent: `POST /v1/sessions/<id>/open`, `GET …/state`, `POST …/action` (`browser-vm/worker/worker.py:33`). No TypeScript caller exists today.

## 2. FRAMEWORK FACTS (eve 0.62 + patch)

**Schedules** (`node_modules/eve/docs/schedules.mdx`)
- Static files only: one `defineSchedule` per file, 5-field cron in UTC, minute granularity. The handler gets `to`, `waitUntil` and `appAuth`.
- Our patch adds `attachSession` to `ScheduleHandlerArgs` (`patches/eve@0.62.0.patch`, ScheduleDispatcher hunk and `.d.ts` L150).
- `eve dev` never fires crons; use `POST /eve/v1/dev/schedules/<name>`.
- Self-hosted builds run schedules as Nitro scheduled tasks. On our VM eve runs as `node .output/server/index.mjs`, and the existing schedules fire there (unverified beyond the fact that proactive runs in prod).
- From dev-notes: Nitro hands an overlapping tick the same pending promise, so one hung check would bury every later tick. Every await in a tick must be bounded (see `agent/lib/browser-use/deadline.ts`). eve swallows schedule background errors, so catch them yourself.

**Application-managed rows** (`docs/patterns/dynamic-scheduling.md`)
- The recommended shape is: rows in your own store, plus one minute-level dispatcher schedule with an atomic lease, plus CRUD tools. This is what we already do.

**Delivery always goes through a session turn**
- `to(channel).send` and `attachSession().send` both start a turn; there is no "post text without a turn" primitive.
- Our Bot API path (`agent/lib/owner-alert.ts`) is owner-only and bypasses session history. Not suitable for people.

**Web fetch**
- `eve/tools/web_fetch` `executeWebFetchTool` (`dist/src/execution/web-fetch/execute.js`) has an SSRF guard (`request.js`: loopback/private/reserved, at most 10 redirects).
- It truncates output to 50 KB / 2000 lines (`truncateHead`), so JSON-LD further down a page is lost. The internal `requestPublicUrl` is not exported.
- Conclusion: use our `fetchPublic` + `downloadWithin` for full bodies.

**Tool constraints** (dev-notes, verified in tool code)
- Dynamic tool callbacks must be inline in `defineTool`.
- The person's words reach a tool only through a JSON closure built in the `turn.started` resolver, as `schedules-answer` does with `answerableScheduledQuestions`.
- `eve build` drops `.refine()` from static tool schemas.
- Avoid exotic regex `pattern` in schemas (OpenAI dialect).

**Instruction resolvers** do not see the incoming message, so tool gating has to happen in `turn.started`/`step.started` tool resolvers.

**Patch hunks to respect**
- `insertBeforeApprovalTail`: append nothing after the approval response.
- Rebind: `turn.started` resolvers must be idempotent.
- `attachSession` in the schedule handler.
- None of these are touched by this design.

## 3. DESIGN

### 3.1 Data model (one migration, generated on top of bro-next)

New table `subscriptions` in `db/schema/subscriptions.ts`:

| column | type / rule |
|---|---|
| `id` | uuid pk |
| `workspace_id`, `created_by_user_id` | text; FK `(workspace_id, created_by_user_id)` → `workspace_memberships` ON DELETE CASCADE |
| `job_id` | uuid NOT NULL → `scheduled_agent_jobs.id` CASCADE. This is the delivery vehicle: conversation target, run rows, reports. |
| `origin` | `'person' \| 'bro'`. Person rows are created only in the person's turn; bro rows only by code. |
| `template` | `'price' \| 'flight' \| 'mail_digest' \| 'parcel'` |
| `dedupe_key` | text NOT NULL. Price: normalized URL. Flight: `eventId@start#kind`. |
| `source` | jsonb (zod per template; CHECK `jsonb_typeof(source)='object'`). Price: `{url, title, extractor:{kind:'jsonld'\|'meta'\|'adapter', path}, sku?}`. Flight: `{eventId, start, summary}`. |
| `condition` | jsonb CHECK object. Price: `{kind:'below', amount, currency}` or `{kind:'drop', percent}`. Flight: `{kind:'at', fireAt}`. |
| `action` | `'notify' \| 'worker'`. `notify` means code writes the outcome and only the report turn uses the model; `worker` queues a model worker run. |
| `wake` | `'day_only' \| 'urgent_at_night'`. This is the "wake the person or not" rule. |
| `state` | jsonb, small: `{lastValue, lastSeenAt, previousValue}` |
| `status` | `'active' \| 'paused' \| 'fired' \| 'expired' \| 'failed' \| 'cancelled'` |
| `next_check_at` | timestamptz NOT NULL; doubles as the lease, as in `proactive_watches` |
| `check_every_s` | int; CHECK `>= 900` for template `price` |
| `expires_at` | timestamptz NOT NULL; CHECK `expires_at > created_at` and `expires_at <= created_at + interval '90 days'` |
| `failures`, `checks`, `hits` | int NOT NULL DEFAULT 0 |
| `last_error`, `last_checked_at`, `last_hit_at`, `created_at`, `updated_at` | |

Indices:
- partial `(next_check_at) WHERE status='active'`
- `(workspace_id, status)`
- `UNIQUE (workspace_id, template, dedupe_key) WHERE status IN ('active','paused')`

Changes to existing tables (`db/schema/schedules.ts`):
- `scheduled_agent_jobs.kind` CHECK gains `'subscription'`: one hidden job per person subscription, so `schedules-list` can show it. Bro-origin rows reuse the workspace's `proactive` job.
- `scheduled_agent_runs.subscription_id` uuid NULL → `subscriptions` ON DELETE SET NULL, so the report turn and the wake rule know which subscription fired.
- Per dev-notes: drizzle applies the batch in one transaction, and `NOT VALID` does not shorten the lock.

**Rejected alternatives**
- Generic JSON rules evaluated by a DSL: too much surface for a weak model to fill.
- Reusing `proactive_signals` for every hit: that table is novelty dedupe for mail and calendar, not state.
- Columns per template: drizzle churn every time a template is added.

### 3.2 Evaluator

New file `agent/schedules/subscriptions.ts`, cron `*/5 * * * *`, gated by `schedulesEnabled()`.

It is kept separate from `dynamic.ts` so a slow site cannot stall report delivery (Nitro single-flight).

Each tick:
1. `claimDueSubscriptions({limit: 50, leaseForMs: 10 min})` with `FOR UPDATE SKIP LOCKED`; set `next_check_at = now + lease`.
2. Overall deadline 4 min. Each check runs under `AbortSignal.timeout(15 s)`; at most 2 concurrent checks per host plus jitter.
3. `evaluate(template)` is a pure function per template in `agent/lib/subscriptions/<template>.ts`. It returns one of:
   - `{kind:'quiet', state}`
   - `{kind:'hit', outcome | workerPrompt, urgency}`
   - `{kind:'failed', reason}`
4. Persist with a compare-and-set on the lease (the `deferProactiveWatch` pattern):
   - quiet → `next_check_at = now + check_every_s`
   - failed → `failures+1`, backoff ×2. At 3 failures: `status='failed'` and one `blocked` outcome run, so the person hears once.
   - hit → see 3.3.
5. Rows past `expires_at` become `expired` and get one short `result` report, for person rows only.
6. Log one line per check, `[subscriptions] check {template, outcome, workspaceId}`. Never log page bodies.

### 3.3 Hit to person

`recordSubscriptionHit` inserts the run in one transaction and increments `hits`. Price rows become `fired`; re-arming on a further drop is optional later.

- **`action='notify'`**: insert a `scheduled_agent_runs` row already `status='completed'`, with `outcome = {kind:'result', summary:<code-built text>, urgency}`, `reportStatus='pending'` and `subscription_id`.
  - From there the existing `dynamic.ts` path delivers it: `listRecoverableScheduledReports`, `reportConversations`, report turn.
  - No worker model call at all; the only model use is the report turn.
- **`action='worker'`** (flight, parcel): insert a `queued` run on the proactive job and let `proactive.ts` dispatch it.
  - Bridge for flights: write a `proactive_signals` row with key `eventId@start#kind` and call the existing `queueProactiveRun`. This reuses `reminderTasks`, `proactiveRunPrompt` and the cap exemption for calendar runs.
  - If the result is `busy`, the subscription stays due and retries next tick.

**Wake rule** (generalize `proactiveReportTiming`):
- `dispatchRecoverableReport` also applies timing to `jobKind==='subscription'`.
- `mayWake = subscription.wake==='urgent_at_night' && outcome.urgency==='time_sensitive'`. Otherwise the report is deferred to `quietUntil + 10 min` and absorbed into the morning message.
- `readProactiveMessages` opt-out applies only to `origin='bro'`. This matches the `proactive_messages` tool contract that person-made schedules are unaffected.
- Person-origin price drops are `day_only` by default. Today `task` reports ignore quiet hours, so a 03:00 price drop would currently be delivered at night.

**Report prompt**: `scheduledReportTask` (`report.ts:196`) gets a `subscription` branch, for example "Your watch for <title> found: <fact>. One short message; the link is the one the person gave."

### 3.4 Templates

**price** (person)
- Extraction ladder in code, in this order:
  1. JSON-LD `Product.offers.price` / `lowPrice` (+`priceCurrency`, `sku`/`name` to pin the product)
  2. `og:price:amount` / `product:price:amount`
  3. `itemprop="price"`
  4. Small per-site adapters for public JSON endpoints. Wildberries card API: unverified reachable from the VM.
- Fetch: `downloadWithin(url, 2 MB, {fetch: fetchPublic, allowUrl})`. Move or import `public-fetch.ts`; keep the owner in `agent/lib`, not `shared`.
- On a 403/429/captcha (reuse `challengeWording`), optionally retry once through the residential proxy (this costs the `proxy` usage source).
- Ozon is expected to block plain HTTP (`agent-costs.md` 3.3). Then the tool refuses at creation and offers a daily browser schedule instead.
- Default cadence 6 h, minimum 1 h. Expiry 30 days, maximum 90.
- Fire only when the same `extractor` reads the same `sku`/`name` and the value meets the condition. If the product identity changed, treat it as `failed`, not a hit.

**flight** (bro)
- On every probe, `syncFlightSubscriptions(events)` upserts rows per flight event, using `flightReminders`' rules as pure fire-time functions:
  - `evening`: 18:00 local D-1, or now if first seen 18:00–23:00. `wake=urgent_at_night`, because the report may finish after 22:00.
  - `checkin`: `max(departure−24h, next 08:00 if inside quiet hours)` and `< departure−3h`. `wake=day_only`.
  - `status`: from T−6h, each tick runs a code-only Gmail search for the flight number since the last check. A hit queues a worker with `urgent_at_night`; this is the "night wake only on match".
- When an event moved or was cancelled, its old rows become `expired` (the key carries the start).
- Code computes and passes into the worker prompt the departure local time, check-in open/close local time and a leave-by estimate (`findPlaces`/`measureRoutes` from the Personal Info address). This removes the time errors item 5 saw.
- Under the flag, `flightReminders` stops emitting `#checkin`/`#evening` signals in `probe.ts`.

**mail_digest** (bro, one per workspace)
- Keeps today's per-check mail runs by day. From 21:00 local, non-urgent runs are `day_only` with a morning merge, so d11's 21:00–23:30 letters become one morning message instead of 1–2 evening ones plus a morning one.
- **Product decision needed:** whether the evening batch starts at 21:00 or stays at 22:00.

**parcel** (bro, later)
- Created when ranked mail matches `parcelWords` plus `trackingNumber`.
- Condition: a new message in that Gmail thread or for that tracking number (code, Gmail ids only), until delivered or 14 days. `action='worker'`.
- Polling carrier sites directly: unverified; also a new data processor, which must be added to `agent/lib/privacy/` `dataProcessors`.

### 3.5 Tool

New `agent/tools/watch.ts`, tool `watch-create`, interactive only (`resolveModeValue`).
- Input:
  - `{template:'price', url, condition:{below?|dropPercent?}, title?, untilDays?}`
  - The description is kept short (under ~600 characters) because of the per-step token cost (items 24/25).
- `approval: (ctx) => watchApproval(ctx)`, inline. It returns `user-approval` when `!startedByPerson`, mirroring `scheduleApproval`.
- The `turn.started` resolver closes over the person's own words as JSON: `personWordsThisTurn(context.messages).said` plus the URLs in earlier person messages. `execute` then refuses unless:
  - the URL is one the person wrote, and
  - the threshold appears in their words (8к / 8 000 / 8 тыс). Same spirit as `quotedFromPerson` in `said.ts`.
  - This is fail-closed: a page or report turn cannot plant a URL or threshold.
- `execute` performs the first check synchronously. It returns the current price and extractor, or "cannot watch by code" with the alternative. It creates the hidden `kind='subscription'` job plus the row.
- List and cancel reuse `schedules-list` / `schedules-update`:
  - extend `ownedTasks` to `kind IN ('task','subscription')`;
  - `scheduleListSummary` gets a watch line;
  - `schedules-update` on a subscription job allows only status changes (pause/resume/delete) and refuses timing or prompt edits.
  - `materializeDue` stays `kind='task'`.
- `schedules-update` is already in `actionsHeldForAnswer`, so cancel stays held while a question is open.
- `follow-through.md` already forbids unrequested price watches; add one line pointing price, parcel and "notify me when" to `watch-create`.

**Rejected alternatives**
- Folding into `schedules-create`: its schema is already huge, and a weak model would mix the timing and condition shapes.
- Three new tools (create/list/cancel): extra schemas on every step.
- Model-written scripts run in Monty: phase 4, per `agent-costs.md` 3.4.
- Browser direct-mode checks: phase 4. The worker supports it, but there is no TypeScript caller and it needs a VM or pool lease.

### 3.6 Flag and migration path

`SUBSCRIPTIONS_WORKSPACES`, checked via `listsWorkspace` (`agent/lib/workspace-list.ts`) and validated in `shared/environment/env.ts`.

| PR | Contents |
|---|---|
| 1 | Schema + evaluator + price template + `watch-create` + report branch + wake rule, flag-gated. `proactive.ts` untouched. |
| 2 | Flight rows from the probe, code-computed times, `status` mail watch. `flightReminders` emission off under the flag. `proactive_signals` stays for mail/calendar novelty. |
| 3 | mail_digest wake/batch rule, parcel, removal of the flagged legacy flight path once d10 passes. |
| Later | Gmail push (`agent-costs.md` 3.5), direct-mode/Monty checks (3.4). |

**For d10/d11 per item 5:**
- d10 needs PR 2 plus an overnight re-run. The current code may already pass; re-run first to get a baseline.
- d11 needs:
  - fix the fixture so the boss and friend write from an address that is not a plus-alias of the tester (`scripts/bench` fixtures); the product query `-from:me` stays;
  - investigate where the phishing message lands (check `labelIds` of the inserted message);
  - the evening batch rule.
- The roadmap points the "-from:me" problem at fixtures; dropping `-from:me` in the product is rejected, because self-sent mail would reach workers.

## 4. RISKS & GOTCHAS

**Security**
- The URL fetcher must stay SSRF-safe: `fetchPublic` with pinned public IPs and an `allowUrl` check on every redirect hop. Never use plain `fetch`.
- On the VM the `bro` user's egress only blocks metadata (`scripts/cloudru-app-host/host/egress.sh`).
- Page text never enters a prompt. Only the extracted number and title go in, the title sanitized and capped at 120 characters, then passed through `defuseStepNoteTag`. The report prompt keeps the "treat as data" line.
- Unchanged: `scheduled-report` mode stays at `send_message` + `request_vault_setup`; the proactive worker toolset stays at 3 read tools; `said.ts`, card approvals and `startedByPerson` rules stay.
- A subscription never acts. A price hit only informs; buying goes through the person's own turn and `allowSubmit`.

**Reliability**
- Bound every await (Nitro single-flight) and catch everything inside `waitUntil`.
- Treat a lease mismatch as a lost race, as `deferProactiveWatch` does.
- Two eve processes on one database would double-claim. That is already "one eve per world DB".

**False alerts**
- A changed extractor or product identity is a failure, not a hit.
- Currency must match.
- Do not fire on the first-ever reading unless the person asked "сразу скажи если уже ниже"; the tool reports the current price instead.

**Cost and cache**
- The new tool schema is added to every interactive step: a one-time cache break and roughly +0.5–1k tokens a step. This works against items 24/25. Measure with `scripts/costs/step-context.ts`.
- Do not toggle the tool per turn; item 25 wants a byte-stable schema block.

**Network**
- Ozon, WB and Market antibot from the Cloud.ru IP is unverified. Residential proxy traffic is billed. The bench "price a week" must use a site that answers plain HTTP.

**Delivery**
- With no messenger, reports land in the latest web chat (roadmap P2 item 21). For person-origin watches, prefer the chat the watch was created in, which `reportConversations` `own` already handles.

**Tests that pin current behavior**
- `tests/agent/capabilities.test.ts` (mode tool lists; `watch-create` joins the interactive list).
- `tests/agent/schedules/proactive.test.ts`, especially "queues a flight reminder that is due even when nothing else is new" and "looks only for what cannot wait at night".
- `agent/lib/proactive/tests/signals.test.ts` ("flight reminders by the clock", `gmailProbeQuery` "-from:me").
- `agent/lib/proactive/tests/delivery.test.ts`.
- `db/tests/proactive.test.ts` ("reminds of a flight a run already saw…past the daily cap", "sends the reports held overnight…").
- `tests/agent/schedules/dynamic.test.ts` and `web-delivery.test.ts`.
- `tests/agent/tools/schedules.test.ts` (`ownedTasks` behavior).
- `evals/agent/proactive.eval.ts`.
- knip: a new `agent/lib/subscriptions/` used only by the schedule may need `knip.config.ts` entry points.

## 5. TEST & ACCEPTANCE PLAN

**Unit tests**
- `agent/lib/subscriptions/tests/price.test.ts`:
  - JSON-LD (array/graph/`lowPrice`), meta, itemprop and comma/space decimals ("7 490,00 ₽");
  - identity mismatch counts as failed;
  - below/drop conditions; currency mismatch.
- `flight.test.ts`:
  - fire times for 07:05 tomorrow (evening at 18:00; check-in moved out of quiet hours; nothing after departure−3h);
  - a moved event expires the old rows;
  - DST zone.
- `tests/agent/schedules/subscriptions.test.ts`:
  - lease, deadline, backoff;
  - three failures produce one blocked report;
  - expiry;
  - a hit with `notify` inserts a completed run with `subscription_id`;
  - `worker` on `busy` stays due;
  - `EVE_SCHEDULES=off` does nothing.
- `db/tests/subscriptions.test.ts` (PGlite; re-import `@db` per case per dev-notes):
  - unique dedupe under concurrency;
  - CHECKs;
  - cascade on membership delete;
  - `ownedTasks` includes subscription jobs;
  - `materializeDue` ignores them.
- `delivery.test.ts`: a `day_only` hit at 03:00 is held and absorbed into the morning message; `urgent_at_night` + `time_sensitive` goes out.
- `tests/agent/tools/watch.test.ts`:
  - refuses a URL or threshold not in the person's words;
  - card required when not started by the person;
  - first-check failure message.
- SSRF: a private IP, or a redirect to 169.254.169.254, is refused.

**Evals**
- Extend `schedules.eval.ts` with a case: «следи за ценой на <url>, напиши когда станет меньше 8к» calls `watch-create` with `below: 8000` and not `schedules-create`.
- Add a «не надо следить» negative.
- Run the `reply` and `schedules` tags with the flag on.

**Bench**
- d10: `fixtures seed --case d10-proactive`, then `observe --minutes 720`. Expect a check-in message by day, an evening message 18:00–23:00, and nothing 23:00–07:00 unless a gate/delay mail exists.
- d11: seed at 21:00 with `--spread-min 150` and the fixed fixture senders. Expect one morning message: CDEK handled, a draft for the boss, the friend left alone, phishing flagged.
- `uc-sh-price-watch` on a site reachable by HTTP.

**Prod done criterion: "a week without the model except on a change"**
- `checks ≈ 7×24×3600/check_every_s`, `hits = 0` until the change.
- `count(scheduled_agent_runs WHERE job_id = <watch job>) = hits` (every run row on that job is a hit).
- Zero `usage_costs` rows for those runs. This needs `turnCostSource` (`agent/lib/costs/turns.ts`) to put `scheduledRunId` into `run_id` for `background` turns; a small change pinned by `tests/agent/costs/turns.test.ts`.
- `[subscriptions] check` log lines show no `failed` streak.

## 6. SIZE

Three PRs, plus an optional fourth (direct-mode/Monty checks).

**PR 1: about 1.5k LOC**
- New: `db/schema/subscriptions.ts`, migration, `db/services/subscriptions.ts`, `agent/schedules/subscriptions.ts`, `agent/lib/subscriptions/{price,evaluate,claims}.ts`, `agent/tools/watch.ts`, tests.
- Changes: `db/schema/schedules.ts` (kind CHECK, `subscription_id`), `db/services/scheduled-agent-jobs.ts` (`ownedTasks`, report listing), `agent/lib/schedules/report.ts`, `agent/lib/schedules/tools.ts`, `agent/schedules/dynamic.ts`, `agent/lib/proactive/delivery.ts`, `shared/environment/env.ts`, `agent/instructions/content/follow-through.md`, `tests/agent/capabilities.test.ts`, `knip.config.ts`, `docs/dev-notes.md`.

**PR 2: about 800 LOC**
- `agent/lib/proactive/{probe,signals}.ts`, `agent/schedules/proactive.ts`, `agent/lib/subscriptions/flight.ts`, worker prompt facts, `agent/lib/routes` use.

**PR 3: about 500 LOC**
- Batch rule in `delivery.ts`, parcel template, bench fixture senders (`scripts/bench`), d10/d11 re-run, crossing out roadmap items 5 and 27.

**Overlap with other items**

| Area | Overlap |
|---|---|
| `agent/agent.ts` | None needed; the new tool goes through normal mode resolution. |
| `agent/instructions/*` | `follow-through.md` (item 24 moves instruction bodies into skills; keep the watch rule in the core). |
| `agent/lib/model/*` | None. |
| `db/schema/*` | `schedules.ts` CHECK plus a new table; migration ordering against items 26 (`site_guidance`) and 31. Generate on top of bro-next right before merge. |
| Tool schema block | Items 24/25 (step tokens, byte-stable tools). |
| `agent/lib/costs/turns.ts` | Item 22 accounting. |
| `reportConversations` | P2 item 21. |
| Direct-mode checks | Items 23/29 (pool leases). |

**Unverified:** reachability of Ozon, WB and Market by plain HTTP from Cloud.ru; how Gmail labels the plus-alias messages created by `messages.insert`; why the phishing fixture ends up outside Inbox; whether Nitro fires schedules under `node .output/server/index.mjs` (inferred only from prod behavior); the cost of a report turn per hit (estimated at roughly 0.1–0.4 ₽, not measured).

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
