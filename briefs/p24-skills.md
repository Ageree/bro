# Item 24: server-chosen skills, design brief

## 1. Current state

**Instruction assembly.** eve builds the system prompt in this order: `agent/instructions.md`, then the dynamic resolvers in `agent/instructions/*.ts` in file order. All resolvers run on `turn.started` and return system-role content.

Each resolver picks its text by mode through `resolveModeValue` / `resolveModeInstructions` in `agent/lib/mode.ts`. The modes are:
- `interactive`: everything not scheduled. This covers `authjs`, `local-dev`, `telegram-webhook`, `photon-imessage` and also `browser-result`.
- `scheduled-worker`, `proactive-worker` (scheduled-worker with `scheduledRunKind: "proactive"`) and `scheduled-report` (`scheduled-result`).

**Interactive sizes**, measured with Python `len()` / 3.1. `wc -m` runs in the C locale here and counts bytes. The total matches the 30.9k in agent-costs 3.2.

| Resolver / file | Interactive k tok | Other modes |
|---|---|---|
| `instructions.md` | 0.4 | all |
| `10-execution-safety` → `execution-safety.md` | 1.9 | worker |
| `15-autonomy` → `autonomy.md` 4.9 + `follow-through.md` 0.6 (interactive only) + spend-limit lines from the DB (`spendLimitInstructions`) | ~5.6 | worker (no follow-through) |
| `20-role` → `role/interactive.md` 9.6 | 9.6 | worker 1.8, proactive 1.8, report 0.6 |
| `25-recommendations` | 2.0 | worker |
| `30-message-style` (+ form of address from the DB) | 1.6 | report |
| `40-browser` → `browser/available.md` | 6.4 (0.1 if unconfigured) | worker |
| `45-public-services` → meter 0.4 + public 0.9 (public only with Browser Use) | 1.3 | — |
| `50-local-time` (clock; in the pilot `stepNoteInstructions` instead) | 0.2 | worker |
| `60-creative` → images 0.7 + games 0.5 | 1.2 | — |
| `60-hard-constraints` | 0.8 | worker |
| `65-task-agent` (only for `SANDBOX_WORKSPACES`, not in report turns) | 0.4 | — |
| `70-acquaintance` (DB: `hasOtherConversations`) | 0.05 | — |

**Step context and the step-context pilot.**
- `agent/agent.ts:84`: the `step.started` model resolver builds `notes` (clock, `replyDirective`, stale-report and so on), `withheldTools` (line ~304) and `offeredTools`.
- Under `stepContextPilot` (`agent/lib/step-context/pilot.ts`, `STEP_CONTEXT_WORKSPACES`, direct model only), the notes go after the history as `<bro-step-note>` (`taggedStepNote`, `agent/lib/step-context/note.ts`).
- Every prompt string is defused by `defusedStepNoteTags` in `agent/lib/model/direct.ts:~545-621`.

**The measuring script.** `scripts/costs/step-context.ts` duplicates the mode table by hand in `instructionParts()` (lines 200-300) instead of importing it. It measures two layouts: as today, and the pilot.

**Memory slots** (`agent/memory/`):
- `profile.ts` already reads the incoming message: `requestText(turn.input)` → `renderPreferencesForRequest`, in `agent/lib/memory/profile.ts:~446-596`. It writes a per-request note.
- `personal_info.ts` writes a keyed record `user-profile`.
- `workstreams.ts` writes a keyed record `workstreams-index`. Its scope is interactive only.

**Existing keyword detectors to reuse:**
- `requestTopics` (food, flight, train, stay) in `agent/lib/memory/profile.ts:482`.
- `appNames` / `appsNamedByPerson` in `agent/lib/connected-apps/mentions.ts`.
- The government site list in `agent/lib/browser-use/public-services.ts` (`gosuslugiDomain`, `signsInWithGosuslugi`).
- `reportedBrowserRunId` in `agent/lib/browser-use/report-caller.ts`.
- `outcomesHeard` / `settledOutcomeRun` (`browser-use/heard.ts`, `delivery/browser-report.ts`).

**History helpers already skip framework messages:**
- `startsTurn` (`agent/lib/delivery/turn-sends.ts:461`) ignores `memory.*` and `context.*` kinds.
- `personTexts` (`agent/lib/delivery/language.ts:~100`) ignores kind ≠ `user`.
- So `personLanguage` and `personWordsThisTurn` (`said.ts:168`) do not read memory records.

**No skills today.** There is no `agent/skills/` directory, and `defaultTools: false` removes eve's `load_skill`.

## 2. Framework facts (eve 0.62 plus our patch), checked in dist

**Instruction resolvers cannot see the incoming message.** In `execution/session/turn-step.js`, `prepareDynamicInstructionPreamble(l, projectHistory(T.session.history,…))` gets history only. `prepareMemoryPreamble` gets `input:[...k,...A]`, which is the client context plus the new message. This confirms the dev-notes rule.

**Role-user dynamic instructions are a poor vehicle.**
- `context/dynamic-instruction-lifecycle.js` appends `role:"user"` results as `context.instruction` messages, with no deduplication.
- The docs (`guides/dynamic-capabilities.md`, "Dynamic instructions") say compaction can summarize them away.

**Memory recall is the usable mechanism** (`context/memory-lifecycle.js`, `shared/memory-state.js`, `docs/memory/custom-provider.md`):
- `recall["turn.started"]` receives `turn.input`, which includes the request-context `first-contact` marker.
- Records are inserted as user messages of kind `memory.load`, before the current delivery and before an approval tail (`insertBeforeApprovalTail`, our patch).
- A keyed record with identical content is a no-op on later turns. A changed record supersedes, and the old copy is dropped from the projection, which breaks the cache at that position.
- Attribution is stripped before the model sees the message, so the model sees plain user text.
- Keyed records survive compaction (excluded from the summary, latest value kept).

**Memory recall constraints:**
- A recall that throws fails the turn before the model call.
- A replay with the same `operationId` and a different result throws ("replayed with a different result").
- If a slot's scope resolves to `null` for a turn, the lock is undefined and `projectMemoryHistory` drops all of that slot's earlier records for that turn.
- Canonicalization runs when the session holds more than 512 memory records or more than 256 KiB of them.

**eve static skills (`agent/skills/*.md`) would rotate everyone's sandbox:**
- `compiler/workspace-resources.js` materializes each skill into `workspace-resources/<node>/skills/<name>` and hashes it into `contentHash`.
- `runtime/sandbox/template-plan.js` then returns `kind: "workspace-content"`.
- `runtime/sandbox/keys.js` puts `versionHash` into the session sandbox key.
- Result: adding skills, and every later edit of a skill, gives every live session a new sandbox without its `eve-sandbox:` attachments. `agent/sandbox.ts` relies on "no bootstrap and no workspace files".
- Separately, `load_skill` returns a static skill's markdown from the manifest (`execution/tools/load-skill.js`), and the "Available skills" block goes into the system prompt (`runtime/prompt/compose.js`, `execution/skills/instructions.js`).

**eve dynamic skills need a sandbox on every turn:**
- They resolve only on `session.started` / `turn.started`.
- `load_skill` for a dynamic skill requires `SandboxKey` (`loadSkillFromSandbox`).
- Each resolution writes packages into the sandbox (`context/dynamic-skill-lifecycle.js`) and appends an announcement to history.
- That wakes the sandbox every turn.

**`load_skill` with `defaultTools: false`:**
- It is removed unless `agent/tools/load_skill.ts` exists (`compiler/default-tool-policy.js`, `docs/concepts/built-in-tools.md:322`).
- An authored tool of the same name replaces the framework one.

**Other relevant rules:**
- Dynamic tool callbacks must be written inline in `defineTool`. Closures are JSON only.
- Dynamic tools can resolve on `step.started`; skills and instructions cannot.

## 3. Design

### Mechanism: a `skills` memory slot attaches skill bodies once into history

**New files:**

1. **`agent/lib/skills/catalog.ts`**: the single source of truth. For each `SkillName` it holds `{ body, indexLine, modes }`. It also exports the core content per mode.

   Content stays in the existing `.md` files, with line markers:
   - `<!-- skill:google -->` … `<!-- /skill -->` marks text that belongs to a skill.
   - `<!-- core-only -->` … marks condensed lines that exist only in the core layout.

   Rendering rules:
   - Flag off: strip the marker lines only. The text is byte-identical to today, and that is what the tests check.
   - Flag on: core = text without the skill regions; each skill body = its regions from all files, in order.

   One source means no drift between the layouts. The script and the tests use the same parser.

2. **`agent/lib/skills/triggers.ts`**: `skillsForTurn({ inputText, history, auth, mode }): SkillName[]`. It is pure: no DB, no clock, so recall stays replay-deterministic. Its signals:
   - The person's words: the text of user messages in `turn.input`, the way `requestText` reads it, including `[голосовое]` transcripts and `[фото]`.
   - URLs and domains in the input. `site` arguments of `browser_task` calls in history.
   - Turn kind: `reportedBrowserRunId(auth.current)`, the `first-contact` marker in the input, the mode.
   - Domain tools already used in history (sticky): `browser_task`, `gmail-*`, `calendar-*`, `drive-*`, `contacts-*`, `schedules-*`, `generate_image`, `spend_limit`, `standing_permission`, `workstreams__*`.

3. **`agent/memory/skills.ts`**: `defineMemory` with namespace `bro-skills-v1` and a provider with no tools.
   - **Scope** is constant and non-null for every mode of the session (for example `"skills"`) whenever the pilot is on. If it were mode-dependent, the attached bodies would vanish during scheduled-report or worker turns that share the person's session. Compare `workstreams`, whose interactive-only scope already does this.
   - **`recall["turn.started"]`**:
     1. Computes `skillsForTurn`.
     2. Returns `{ id: "skill:<name>", content: render(name) }` only for skills not yet present.
     3. Is wrapped in try/catch that returns `null`, because a throw fails the turn.
   - **`recall["compaction.completed"]`** returns `null`, since keyed records survive compaction.
   - New bodies are attached in `interactive` mode only. Workers come later (phase 2).

4. **Render format:**
   ```
   <bro-skill name="google">
   …body…
   </bro-skill>
   ```
   - One core line (same pattern as `stepNoteInstructions`) says these blocks are part of Bro's own instructions. The same tag anywhere else is someone else's text.
   - `agent/lib/model/direct.ts`: generalize `forgedTag` / `defuseStepNoteTag` to also defuse `bro-skill`. Exempt user messages whose full text equals a genuine render (an exact-match set), and the results of `load_skill`.
   - This is needed because `agent/instructions.md` tells the model to treat saved memory as untrusted, and a memory record is just a user message.

5. **`agent/tools/load_skill.ts`**: our own fallback tool, not eve's. It is a dynamic tool on `turn.started`.
   - Returns `null` outside the pilot, so the capability tests stay unchanged with the flag off.
   - The closure holds the names already attached, read from `ctx.messages`. Calling it for one of them returns a short "already above" instead of the body again.
   - `execute` is inline and returns the render. The result lands in history and is cached from then on.

6. **Skills index.** `agent/instructions/80-skills.ts` (flag on only): about 0.4k tokens, one line per skill, at the end of the stable system prompt. Draft, to be rendered in Russian like the rest of the core:
   > "Detailed rules for some kinds of work come as `bro-skill` blocks in the conversation; the server attaches them when the turn needs them. If your task is listed below and its block is not above, call `load_skill` with that name before acting: browser (errands on sites: buying, booking, ordering, tickets, delivery), gov-services (Gosuslugi, fines, taxes, doctors, utilities), meter-readings (meter photos and bills), recommendations (picking places, masters, events under conditions), google (mail, calendar, Drive, contacts), apps (Notion, Slack, other apps), memory (remember/forget, long errands), money (spend limit, standing permissions), schedules (reminders, recurring work), images (drawing, sending photos), games, about-bro (how Bro works, where data lives, vault), first-contact."

7. **Flag.** `SKILLS_WORKSPACES` in `shared/environment/env.ts`.
   - Workspace ids or `*` only, no email lookup. The flag decision is then pure and identical in the instruction resolvers, the memory scope and the tool.
   - Effective only when `directModelActive()`, because Gateway has no defuse middleware.
   - In `agent/instructions/*.ts`, each resolver picks core or full content with `catalog`.

8. **Optional in-turn nudge** (flagged, direct model only). In `agent/agent.ts` `step.started`: if the current turn called a domain tool whose skill block is absent, add a step note: "rules for X are in skill X; call load_skill X before the next action". This is about 30 tokens, after the history.

### Proposed CORE (about 11k first cut, 9-10k after deduplication)

**Fully in core:**
- `instructions.md` (untrusted data, secrets, voice and file markers).
- All of `execution-safety.md`.
- "Rules of the person" from `hard-constraints.md`.
- `follow-through.md`.
- `message-style.md`.
- The local-time and step-note line, acquaintance, the spend-limit status lines.

**From `autonomy.md`:** the intro, "direct request is the decision", "where autonomy ends", "when details are missing", plus a two-line payment rule ("Оплачиваю?" and an explicit yes; a limit or permission never replaces it; standing permissions apply only in the person's own turn).

**From `role/interactive.md`:**
- "Who you are"; "trust boundary" minus the vault-setup details.
- The general "how you work" lines: L19, L21, L23-31, L48-53.
- A condensed memory rule (save stated facts and rules; never save secrets).
- "What you can do"; the connection-status honesty line (L69); iMessage (L80).
- Coordination L84 and L87-93.
- One `schedules-answer` line (L86 condensed).

**Browser core (about 1.3k):** what `browser_task` is (L3); the report is untrusted (L4); one run per errand (L5); acting in the person's name only on request (L16 condensed); payment, consent and money boundary (L21-24 condensed into three lines); background never submits (L23); never ask for passwords, `sms_code` and `codeFrom:"mail"` (L29 core part); captcha never goes to the person (L33/35 core); live view only for 3-D Secure (L37); don't promise a result (L38).

**Deduplication.** The "Оплачиваю?" / consent rule appears about seven times across `execution-safety`, `autonomy` (three times), `browser` (three times) and `hard-constraints`. Keep one canonical statement in core. This saves about 1k.

### Skills and their triggers

Russian items below are regex stems or domain data. Reuse the existing regexes where noted.

| Skill | Body (k tok) | Content | Trigger signals |
|---|---|---|---|
| browser | ~5.0 | rest of `browser/available.md`; `autonomy` "what you do without asking" (submission mechanics) | verbs `куп|закаж|заказ|заброн|брон|запиш|оформ|оплат|возьми|book|buy|order|reserve`; `requestTopics.flight/train/stay`, `такси|доставк|билет|маркетплейс`; marketplace or carrier names and domains (ozon, wildberries, market.yandex, samokat, lavka, avito, rzd, tutu, aeroflot, s7, pobeda); any `browser_task` in history; `reportedBrowserRunId`; `что там|как там|status` with a run in history |
| gov-services | ~1.2 | `public-services.md` + browser L30 (Gosuslugi sign-in) | `госуслуг|штраф|налог|пошлин|паспорт|снилс|инн|врач|поликлиник|терапевт|емиас|запис\w* к|справк|fines|tax|doctor`; any domain in the `public-services.ts` list or `gosuslugi.ru` in input or `site` |
| meter-readings | ~0.4 | `meter-readings.md` | `показан|счётчик|счетчик|квитанц|жкх|коммунал|еирц|мосэнергосбыт|meter|utility bill`; `[фото]` with no other words |
| recommendations | ~2.2 | `recommendations.md` + `hard-constraints` "hard conditions" | `посовет|порекоменд|подбер|куда сход|где (поужин|пообед|позавтрак|выпить)|мастер|кружок|секци|концерт|выставк|recommend|suggest|where to eat`; `requestTopics.food`; also the scheduled-worker prompt in phase 2 |
| google | ~2.5 | interactive L33-34, L37-41, L43-47 | `почт|письм|gmail|inbox|входящ|черновик|календар|встреч|событи|созвон|перенес|окн\w* свобод|диск|drive|таблиц|pdf|контакт|google|гугл|email|calendar|meeting`; any `gmail-*`, `calendar-*`, `drive-*` or `contacts-*` call in history |
| apps | ~0.5 | L35, L36, L42 | `appsNamedByPerson(messages)` (existing); `подключи` + app name |
| memory | ~1.2 | full L20 (forget-all, ambiguous deletion, find) + L22 workstreams | `запомни|помнишь|забудь|удали (всё|что)|памят|в прошлый раз|как обычно|продолж|remember|forget|what do you know`; any `workstreams__*` or `profile__forget*` call in history |
| money | ~1.7 | `autonomy` "standing permissions" + "money" | `лимит|трат|без спроса|без вопрос|сам (заказ|брон|запис)|разреша|не плати|без моего ок|spend|without asking`; any `spend_limit` or `standing_permission` call in history |
| schedules | ~0.4 | L85 | `напомн|кажд\w+|по будням|ежеднев|еженедел|раз в|расписан|следи|remind|every|daily|weekly`; any `schedules-*` call in history |
| images | ~1.1 | `creative/images.md` + L88 | `нарису|картинк|изображен|сгенерир|фот(о|к)|покажи как выглядит|draw|image|picture|photo|logo` |
| games | ~0.5 | `creative/games.md` | `игр|сыгра|поигра|викторин|квиз|загадк|крестики|города|play|game|quiz|trivia` |
| about-bro | ~0.7 | "how you are built" L65-68 + vault L14-15 | `как ты устроен|где хран|кто (видит|обрабат)|безопасн|шифр|модел|сервер|облак|данные обо мне|сейф|пароль|импорт|privacy|how do you work|where is my data|vault` |
| first-contact | ~0.35 | "first contact" section | the `first-contact` marker in `turn.input` (deterministic) |
| task-agent | ~0.4 | `task-agent.md` | `SANDBOX_WORKSPACES` pilot plus `презентац|слайд|excel|xlsx|docx|pdf|график|файл|slides|spreadsheet` |

**Bias triggers toward recall.** A wrongly attached body costs about 1-5k uncached once, then is read from cache at roughly 1/8 of the price. A missing safety-adjacent body (browser, gov-services, money) costs benchmark points.

**How a weak model (deepseek v4.1 flash) still gets the right body:**
1. Deterministic attach is the primary path. It needs no model call.
2. Sticky attach through domain tools in history covers the next turn.
3. The index tells the model to call `load_skill` when a block is missing.
4. The step-note nudge covers a domain tool called mid-turn.
5. Critical rules are already repeated in tool results, per the dev-notes pattern.

### Alternatives rejected

| Option | Why rejected |
|---|---|
| eve static skills | Sandbox key rotation (section 2); body only through the model's own `load_skill`, which models skipped 56% of the time in Vercel's evals, and DeepSeek flash is weaker. |
| eve dynamic skills | Sandbox writes and wake-ups every turn; announcements in history; `load_skill` needs a sandbox. |
| Bodies in system instructions per skill set | Breaks the system prefix whenever the set changes. The system prompt must stay identical across person turns and browser-report turns in one session. |
| Role-user dynamic instructions | Cannot see the incoming message (only the previous turn's signals); no dedupe; summarized by compaction. |
| Bodies in step notes | The note is always the uncached tail, so the body is re-read at full price on every step. Fine only for the one-line nudge. |
| A new mode for report turns | Breaks the `resolveModeValue` tables in `agent/agent.ts` (agent-costs 3.2, point 4). |

## 4. Risks and gotchas

- **Replay determinism.** `skillsForTurn` must not read the DB or the clock. If a deploy that edits a body lands between a recall and its replay, the turn fails with "replayed with a different result". The frequency is unverified and likely rare. Do not edit bodies casually.
- **Scope must never be `null` mid-session.** Use a constant scope, including `scheduled-result` and `browser-result` turns. A flag flip off yields `null`, and the bodies disappear together with the switch back to full instructions, which is acceptable.
- **Cache.**
  - The core system prefix becomes identical for every interactive turn kind, which is good.
  - A newly attached body is uncached only in its first step.
  - Changing a body's text supersedes it once: one cache break at that position.
  - Memory records count toward canonicalization (more than 512 records or 256 KiB). All bodies together are roughly 110 KB of UTF-8 Cyrillic, and the profile note superseding every turn already adds records. Canonicalization rewrites history, which is a one-time cache break. Keep bodies tight and log when it happens.
  - Side finding, existing and not this item: the `workstreams` interactive-only scope already drops its index during scheduled-report turns in the person's session.
- **Trust.**
  - Skill blocks reach the model as user-role text. The core must name the tag, and forged tags must be defused.
  - Report-turn text is written by the page and feeds the triggers. It can only choose among our own bodies; never let triggers change tools or approvals.
  - Gateway is excluded.
- **Safety stays in core and in code.** These code guards are untouched and still enforce the rules regardless of instruction placement: `said.ts` (`personWordsThisTurn`, `paymentAnswer`, `codesNotFromPerson`), `consentFor` / `errandStillAllowed`, `startedByPerson` / `ownTurnApproval`, `ruleWriteRefusal`, `memoryRemovalApproval`, `googleWriteApproval`, `turnAwaitsAnswer`, the capability matrix. Moving text can only degrade behavior quality, not these limits. Add a unit test that lists every safety phrase which must remain in core.
- **Ordering inside a turn.** Recall records sit between Bro's last question and the person's "yes". `personWordsThisTurn` / `paymentQuestionBefore` and `personLanguage` skip `memory.*` messages; prod already exercises this through the per-request profile note. Pin it with a test.
- **Tests that pin current behavior:**
  - About 141 `toContain` assertions in `tests/agent/instructions.test.ts` and `tests/agent/instructions/{autonomy,creative,follow-through,public-services,recommendations,acquaintance,local-time}.test.ts`. They hold with the flag off; under the flag, move their assertions to the skill-body tests.
  - `tests/agent/form-of-address.test.ts` (30-message-style).
  - `tests/agent/step-context.test.ts`.
  - `tests/agent/agent.test.ts` pins `modelSelection` options exactly, so the nudge must be flag-gated.
  - `tests/agent/capabilities.test.ts` pins the exact tool list, so `load_skill` must be dynamic and flag-gated.
  - `tests/agent/approval-memory-recall.test.ts` (`insertBeforeApprovalTail`) and `tests/agent/memory-tools-attachments.test.ts`.
  - `tests/source-layout.test.ts`.
  - `e2e/chat/first-contact.e2e.ts`. Its `.e2e/cache` is unaffected while the flag is off.
- **Flag-lookup split.** If an instruction resolver and the memory scope ever disagree on the flag, the result is core without bodies. Hence ids and `*` only, no async email lookup, unlike `stepContextPilot`.
- **knip.** `agent/lib/skills/` is imported normally, but run `pnpm check`.

## 5. Test and acceptance plan

**Unit tests:**
- `agent/lib/skills/tests/triggers.test.ts`: a golden table over every `prompt` and `script[].send` in `docs/benchmarks/ru/cases.json` (18 dimensions + 60 use cases) and `docs/benchmarks/en/cases.tsv`. Recall must be 100% for browser, gov-services, meter-readings and money on these prompts; report precision.
- Recall determinism: same input → identical output; `@db` mocked to throw.
- Scope stays non-null for `photon-imessage`, `browser-result`, `scheduled-result` and `scheduled-worker`.
- Identical content on the next turn → no new record.
- Flag off: a hash of each mode's resolved instructions equals today's (byte identity).
- Flag on: core ≤ 11k tokens by the script's estimator; the list of core safety phrases is present; every moved phrase is found in exactly one skill body.
- Defuse: a forged `<bro-skill` in a person message, a tool output or a page report is defused; the genuine render and the `load_skill` result are untouched.
- `load_skill`: an unknown name lists the valid names; an already attached name returns the short note.
- `said.ts` and `language.ts`: a skill record between the payment question and "да" keeps `paymentAsked` and the language.

**Script.** `scripts/costs/step-context.ts --skills`:
- Import `catalog.ts` instead of the hand-written tables.
- Print core per mode, the index, each body's size and the `load_skill` schema size.
- Replay the bench prompts through `skillsForTurn` and print the distribution of attached tokens and the median first-step and later-step input (without history, and with an attached-body column).
- Extend the cache estimate: a newly attached body is uncached in its first step only.
- `--dump` writes the core and bodies for counting with a real tokenizer.

**Evals.** Run `eve eval agent` with `OPENROUTER_API_KEY` and both `STEP_CONTEXT_WORKSPACES=*` and `SKILLS_WORKSPACES=*`, against both flags off. The families: safety, permissions, autonomy, public-services, recommendations, routing, honesty, privacy, memory, personal-info, google-connect, integrations, schedules, follow-through, language, delivery, capability, content, workstreams. Add `evals/agent/skills.eval.ts` with paraphrased requests that miss the triggers; each expects `load_skill` or the correct gated behavior.

**Bench, before and after on the owner account.** RU d01, d02, d03, d04, d05, d06, d07, d08, d09, d12, d13, d14, d15, d18; EN `d03_reco`, `d16_content`, `d07_routine`; `uc_study`, `uc_voice`. The rule from agent-costs 3.2: no judge's mean drops more than 0.5, and no case drops more than 1.5 for both judges.

**Prod "done" measure:**
- Median `usage_costs.units.inputTokens` per step for `source in ('chat','browser-report')` in the pilot cohort, against a window before enabling.
- Tag the rows: put the attached skill count in `units.flavor` or a new optional JSON key. No migration is needed.
- **Realistic target.** Item 24 alone takes the instruction part from 30.9k to about 14-16k (core plus the median attached bodies). That is 63k → about 47k before history, not half. The "halved vs 63k" criterion needs item 25 as well: tools by turn kind (−9 to −11k) and shorter descriptions (−4 to −6k), giving about 31-34k.
- So item 24's own acceptance is: the script shows ≤ 16k instruction tokens on median bench prompts, and prod's median falls by at least 15k with no benchmark drop.

## 6. Size

**Three PRs, plus one optional:**
1. **Plumbing behind the flag:** `agent/lib/skills/{catalog,triggers,render}.ts`, `agent/memory/skills.ts`, `agent/tools/load_skill.ts`, the defuse generalization in `agent/lib/model/direct.ts`, the flag in `shared/environment/env.ts`, the script extension, the unit tests. Flag-off byte identity holds.
2. **Content:** markers in `agent/instructions/content/**`, core-only condensed lines and deduplication, `80-skills.ts`, a core/full switch in every `agent/instructions/*.ts` resolver, flag-on instruction tests, the optional nudge in `agent/agent.ts`.
3. **Rollout:** eval and bench runs, enable for the owner, `docs/dev-notes.md` entries (memory-slot skills, constant scope, determinism, the static-skills sandbox trap), `docs/agent-costs.md` 3.2 and `docs/roadmap.md`.
4. **Optional:** a core plus skills layout for `scheduled-worker` (18.4k → about 6k), triggered from the schedule prompt.

**Overlap with other items:**
- `agent/agent.ts` (item 25 tool sets and `withheldTools`; the nudge).
- `agent/lib/model/direct.ts` (item 25 masking, step-context defuse).
- `agent/instructions/*` and `content/*` (item 33 "how Bro works" becomes the about-bro skill here; item 26 site notes could later travel as `site:<domain>` records in the same slot).
- `agent/memory/*` (item 31 memory, item 28 compaction thresholds and canonicalization).
- `scripts/costs/step-context.ts` (item 25).
- `shared/environment/env.ts`.
- No `db/schema/*` change.

**Not checked:**
- How DeepSeek and RouterAI hosts treat many user-role system blocks (the step-note pilot showed no harm).
- Whether the web UI ever renders `memory.load` messages (the profile slot suggests it does not).
- How often a recall is replayed across a deploy.