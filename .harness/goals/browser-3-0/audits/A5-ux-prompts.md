# A5 — UX & prompts audit: what the human sees, and the prompts that drive it

Scope: `agent/instructions.md`, `agent/instructions/jobs.ts`, `agent/lib/browseruse.ts` (scaffoldTask + friends), `agent/lib/browser-pay.ts`, `convex/lib/browserProfilePolicy.ts`, `convex/lib/browserInjectPolicy.ts`, `convex/lib/browserStartPolicy.ts`, `agent/tools/browser_task.ts`, `agent/tools/profile_setup.ts`, `agent/channels/imessage.ts` (wakeup route), `convex/lib/jobWakeLine.ts`, `convex/lib/jobNudgePolicy.ts`, `agent/lib/job-wake.ts`, `agent/lib/wakeup-text.ts`, `agent/lib/fast-ack.ts`, `agent/lib/short-ack.ts`, `agent/lib/silent-turn.ts`, `agent/lib/imessage-text.ts`, `agent/lib/order-policy.ts`, `agent/lib/purchase-policy.ts`, `scripts/imessage-text-check.ts`, `scripts/fast-ack-check.ts`, plus `convex/browserFollow.ts` / `convex/lib/browserFollowPolicy.ts` / `agent/lib/browser-policy.ts` (read to trace the actual runtime paths the prompts describe).

## 1. Summary

The individual pieces (fast-ack, inject policy, follow-through, iMessage text renderer) are each well tested and mostly careful. The damage is in the **seams**: nothing coordinates the fast-ack bubble with the tool's own canned "Ищу…" line, `needsProfileSync` fires even when the run already has a vault login bound to it, and — most seriously — once a browser job is given up on after 20 minutes, `nextBrowserAction` routes **every subsequent request, on any topic**, back to polling the dead job instead of starting what the human just asked for. Root instructions and the Cloud scaffold are dense, mostly non-contradictory on paper, but leave several tool outputs (`followUp:"retry"`, `status=limit`, `landed:false`) with no canonical phrasing at all, so the model has to freelance off hint strings that mix English, Russian and jargon inconsistently.

Three worst holes:
1. **P0 — stuck job eats every later request.** `nextBrowserAction` (`agent/lib/browser-policy.ts:41-55`) returns `"poll"` whenever the stored status is "active", regardless of what the new `incomingTask` says. After a 20-minute give-up the stored status is still `"running"` (never rewritten to a terminal state), so a brand-new unrelated errand silently re-polls the hung job and repeats "джоб висит слишком долго, предложи reset" forever, until the human explicitly says the word "reset".
2. **P0 — needsProfileSync fires against a run that just got a vault login.** `profileExtra()` (`agent/tools/browser_task.ts:408-431`) is computed only from `cookieDomains`/`profileSynced`, never from `vaultLogin`. A `[bro-errand]` run that just got `login:true` + `secretBindings` (vault login bound to *this* run) can still come back with `needsProfileSync:true`, telling the model to fire `profile_setup` — a second, competing browser session — while the first one is already logging in by itself.
3. **P1 — no single source of truth for the "looking" bubble.** Fast-ack (channel-level, pre-turn, 2-5 words) and the tool's own hardcoded `"Ищу, это может занять пару минут. Сам напишу, когда будет готово."` (`agent/tools/browser_task.ts:616`) are gated by unrelated mechanisms (`fastAckOf`/`peelFastAck` vs `turnSpoke`) that don't know about each other, so both can fire for one `browser_task` start.

## 2. Findings

### F1 — P0 — `needsProfileSync` ignores a vault login just bound to this same run
`agent/tools/browser_task.ts:408-431` (`profileExtra`), called at `:635`.
- Scenario: human has a saved WB login in the vault. `купи кроссовки на вб 42` → `vaultPasswordLoginForPages` finds a match, `vaultLogin.bindings` are attached and `login:true` is passed to `startRun` (`:569-582`) — the scaffold text the Cloud LLM receives already says "логин и пароль подключены секретами… сфокусируй поле и попроси секрет `site_login`/`site_password`" (`errandLoginBlock`, `browser-pay.ts:88-95`).
- `profileExtra(resolved, startPage)` is computed from `resolved` (cookie-domain sync state only) and has **no parameter for `vaultLogin`**. If WB cookies for this profile aren't synced yet (typical on a first run, or after `reset`), `profileExtra` still returns `needsProfileSync:true` with hint `"Сайт может потребовать логин. Сразу profile_setup с url страницы входа…"`.
- Result: the model may call `profile_setup`, which starts an **independent** second Cloud run (`profile_setup.ts:207-243`, its own `loginVaultTask`) hitting the same site, in parallel with the errand run that is already mid-login. Two browsers, two "сейчас войду" style texts, real risk of the vault credentials being typed twice or the two runs treading on each other's cookies/cart.
- Root cause: `profileExtra` was written before/without regard to the vault-login path added to the same tool call.
- Fix: pass `vaultLogin` (or just a boolean `usedVaultLogin`) into `profileExtra`; suppress `needsProfileSync` whenever `secretBindings`/`login:true` was attached to *this* run.
- Check script: extend `scripts/browser-policy-check.ts` or `profile-sync-check.ts` with a case: vault login present + cookies unsynced → `needsProfileSync` must be false.

### F2 — P0 — a given-up job silently swallows every later, unrelated request
`agent/lib/browser-policy.ts:41-55` (`nextBrowserAction`), `agent/tools/browser_task.ts:482-502` (poll branch), `convex/lib/browserFollowPolicy.ts:22-28` (`pollGiveUp`, 20 min).
- `nextBrowserAction` only consults `incomingTask` when the stored status is *done* (`isDoneStatus`) — for an *active* status it returns `"poll"` unconditionally: `if (isActiveStatus(opts.status)) return "poll";` (line 44), never comparing `incomingTask` to `storedTask`.
- At the 20-minute mark `browserFollow.ts` gives up and wakes the human ("джоб висит слишком долго…"), but it never rewrites `browserStatus` to a terminal value — `persist()` in the poll branch (`browser_task.ts:488`) just re-stores whatever `hydrate` returned, which is still `"running"` because the Cloud job itself hasn't necessarily failed, only *our* patience did.
- So: human says "ну и что там" → poll → still running → give-up hint again. Human says something **completely different** ("купи хлеб") an hour later → `nextBrowserAction` still sees `status:"running"` → `"poll"` → the new request is silently discarded, the model gets the stale run's payload and (per the hint) tells the human the *old* job is stuck, never touching the new ask.
- This is exactly the "no stuck jobs" failure mode the product vision calls out, and it is not theoretical — it fires on the very first message after any 20-minute-plus job.
- Fix (minimal, in repo style): once `pollGiveUp`/settle's "hangs" branch fires, persist a sentinel status (e.g. `"stalled"`) that `isActiveStatus`/`isDoneStatus` both treat as done, so the next `nextBrowserAction` call re-evaluates `looksLikeNewJob(incomingTask)` instead of blindly polling. Alternatively, add a `looksLikeNewJob` check to the active branch itself so a materially different incoming task always forces `"start"` once the run is stale (`now - startedAt > POLL_GIVE_UP_MS`).
- Check script: add to `scripts/browser-policy-check.ts` — active status + startedAt > 20 min + a new unrelated task → expect `"start"`, not `"poll"`.

### F3 — P1 — duplicate "looking" bubbles, no shared source of truth
`agent/lib/fast-ack.ts` (whole file), `agent/lib/early-deliver.ts:695-706` (`turnSpoke`/`markTurnSpoke`), `agent/tools/browser_task.ts:611-620`.
- The fast-ack bubble is sent by the **channel**, before `from(...).send()` even runs (`agent/channels/imessage.ts:469-483`), and does not call `markTurnSpoke` for the turn that is about to start (it has no `turnId` yet).
- `browser_task`'s own notify (`:611`, `"Ищу, это может занять пару минут. Сам напишу, когда будет готово."`) is gated purely by `turnSpoke(turnId)` — true only if the *model itself* streamed visible text this turn. Since the dynamic instruction (`fastAckInstruction`, `jobs.ts` via `fast-ack.ts:201-203`) explicitly tells the model **not** to write another looking line when a fast-ack already landed, the model typically emits no text before calling the tool — so `turnSpoke` stays false and the tool sends its own line anyway.
- Net effect for a plain "вызови такси": human sees fast-ack's short beat (e.g. "вызываю такси") **and then** the tool's longer canned sentence, half a second apart — two "looking" bubbles for one action, and the second one is a full sentence, not the "2-5 words" the Voice section mandates (`instructions.md:13`).
- `peelFastAck` (used by the delivery pipeline) only dedupes the *model's own* streamed text against the fast-ack beat — it has no visibility into a tool-sent string.
- Fix: give `browser_task` (and `profile_setup`) the same `fastAckOf(attrs)` check the dynamic instruction uses, and skip the tool's own notify whenever a fast-ack for this turn already fired. See §5 for the proposed single source of truth.
- Check script: new assertions in `scripts/fast-ack-check.ts` (or a new `browser-notify-check.ts`) that simulate a turn with `fastAck` set and assert `browser_task`'s start-notify is suppressed.

### F4 — P1 — the fast-ack lane also runs on bare OTP codes
`agent/lib/fast-ack.ts:59-75` (`shouldFastAck`).
- `shouldFastAck("482913")` returns `true`: it is non-empty, not a short-ack, not a help/telegram ask, under 600 chars, doesn't start with `[`. The tiny model (`FAST_ACK_SYSTEM`, no example for bare digits) will produce *something* — most likely `NONE`, but the system prompt's only "NONE" trigger is "just conversation" framing, and a bare 6-digit string doesn't obviously match either the tool-needed examples or the NONE examples, so its output is unspecified.
- Meanwhile `decideCloudInject`/`cloudInjectInstruction` deterministically produce the exact right first bubble, `"ввожу код"` (`browserInjectPolicy.ts:332`, mirrored in `instructions.md:19,60`). A fast-ack beat racing ahead of that (e.g. a stray "смотрю" or a hallucinated status word) adds noise or a wrong-tone bubble before the correct one.
- Fix: exclude `isChatCodeMessage(text)` from `shouldFastAck` (the same helper `browserInjectPolicy.ts` already exports) — a code injection has its own deterministic ack and does not need the LLM-guessed one.
- Check script: `scripts/fast-ack-check.ts` — add `assert(!shouldFastAck("482913"), ...)`.

### F5 — P1 — root instructions contradict themselves on who logs in
`agent/instructions.md:57` vs `:144`.
- Line 57 (Browser section): *"The Cloud job must log in if the site shows «Войти». Do not start a second `profile_setup` while that job is already signing in."*
- Line 144 (Проактивность section): *"Сайту нужен аккаунт — сразу `profile_setup`."*
- Both are true in different circumstances (line 57 = mid-errand, Cloud already open; line 144 = proactive "save this login for later" flow), but nothing in the text tells a small model which situation it's in, and this is the exact ambiguity that lets F1 happen at the prompt level, not just the code level.
- Fix: see the rewritten Browser/Проактивность text in Appendix C — one line: "Пока `browser_task` уже идёт — он логинится сам, не зови `profile_setup` параллельно. `profile_setup` только когда *не* открыт браузер-job (человек попросил заранее сохранить вход, или `needsProfileSync` пришёл ПОСЛЕ того как прошлый job закончился)."

### F6 — P2 — two different give-up timeouts for the same concept
`convex/lib/browserFollowPolicy.ts:11` (`POLL_GIVE_UP_MS = 20 * 60_000`) vs `agent/lib/browser-policy.ts:59` (`POLL_GIVE_UP_MS = 30 * 60_000`, private, feeding the exported `pollTimedOut`).
- `agent/lib/browser-policy.ts` re-exports `nextFollowDecision`/`shouldStartFollowThrough` from the Convex module (so those correctly use 20 min) but *also* defines its own local `POLL_GIVE_UP_MS = 30 * 60_000` and `pollTimedOut`, unused by anything I could find outside this file (grep shows no other importer). Dead code with a different number than the one actually enforced — a future edit that "fixes" the timeout by changing this constant would fix nothing.
- Fix: delete the unused local constant/function, or if something does consume `pollTimedOut`, point it at the Convex constant.
- Check script: `scripts/browser-policy-check.ts` — assert the file has exactly one give-up constant, or grep-based check that `pollTimedOut` has a caller.

### F7 — P1 — scaffoldTask has no machine-readable outcome, `parseOrderFromResult` is regex archaeology
`agent/lib/browseruse.ts:176-211` (`scaffoldTask`), `agent/lib/order-policy.ts:39-256`.
- The scaffold's only structure requirement is prose: *"В конце верни краткий структурированный итог: что сделано; что нашёл…; что нужно от человека."* No labelled fields, no enumerated blocker type.
- `parseOrderFromResult` then has to guess an order id (`ORDER_LABEL`/`ORDER_BARE` regexes), a price (`PRICE_LABEL`/`PRICE_MARKED`), a title (quoted string or task text minus a shop-name tail) out of whatever free Russian text the Cloud LLM happened to write. Any of `CANCEL`/`FAIL`/`SUCCESS` word-list misses silently produces `status:"unknown"` or drops the order.
- There is nothing the *root* model can branch on to know "this needs a code" vs "this needs an address" vs "this needs a card" other than re-reading the same free text.
- Fix: add a mandatory last line to the scaffold, `NEEDS: none|sms_code|push|3ds|captcha|password|address|payment`, plus labelled `СДЕЛАНО:`/`ЗАКАЗ:`/`СУММА:`/`КОГДА:` lines (full proposal, Appendix B) and a small parser that reads those labels first, falling back to the current regexes only if a label is missing (keeps behavior for any in-flight runs started under the old scaffold).
- Check script: new `scripts/order-parse-check.ts` cases for the labelled format; keep existing `orders-check.ts` cases as the regression fallback path.

### F8 — P2 — scaffoldTask is silent on common e-commerce UX traps
`agent/lib/browseruse.ts:176-211`.
- No instruction to prefer the mobile site (often simpler DOM, fewer bot checks) — but `errandStartUrl` (`browserStartPolicy.ts:19-32`) hardcodes the desktop domains (`www.wildberries.ru`, `www.ozon.ru`, `taxi.yandex.ru`), so mobile isn't even the default landing page.
- No instruction to dismiss cookie banners / app-install promos / newsletter modals before acting.
- No instruction for a region/city picker (very common on Russian delivery/taxi sites on first load) — nothing tells the Cloud LLM to pick the city already implied by the task instead of asking the human or defaulting to the proxy's exit city.
- No instruction against double-adding to cart (a real risk across a poll → resume → poll cycle where the Cloud LLM re-reads the page and repeats a step it already did).
- No instruction to verify the order actually has a visible order number before declaring success — `finish` only says "Доводи дело до конца… Остановка на гостевом экране без входа — не результат," nothing about a *paid* order without confirmation.
- Fix: folded into the Appendix B rewrite.

### F9 — P1 — "до 5 вариантов" plus per-item links routinely blows past the 2-bubble Voice rule
`agent/instructions.md:16` ("Fact dump: at most two short bubbles") vs `agent/lib/imessage-text.ts:132-183` (`toIMessageBubbles`).
- The scaffold explicitly asks Cloud for "варианты с ценами/временами, до 5" (`browseruse.ts:210`). A natural rendering — `1. Nike Air 5990 ₽\nwildberries.ru/catalog/123\n2. …` — is a numbered list whose lines, once the markdown-link converter turns `[label](url)` into two lines (`imessage-text.ts:102-107`), are frequently ≥80 chars once counted together. `toIMessageBubbles`'s `long.length >= 2` branch (`:149-153`) then splits it into **up to 8 separate bubbles**, one per product — directly against the "at most two short bubbles" instruction, which exists in the prose instructions but is enforced nowhere in the renderer.
- Nothing in `instructions.md` tells the model to *compress* ("нашёл 3 варианта: Nike Air — 5990 ₽, …") the way the product vision's "Poke-style" wording implies; the closest existing text is generic ("Do not list options unless they asked to choose"), which doesn't cover the case where they *did* ask to choose from several finds.
- Fix: see Appendix D — a short "options found" reply template (one compact bubble, one line per option, no separate link line unless they ask to open one) that a weak model can copy structurally, plus a note in the renderer's docstring that a numbered options list from `browser_task` should stay one bubble unless the human asks to see a card.
- Check script: extend `scripts/imessage-text-check.ts` with a "5 short WB options with links" fixture asserting the bubble count stays at 1-2, not 5+.

### F10 — P1 — several tool-result fields have no canonical phrasing anywhere in root instructions
`agent/instructions.md` (searched in full) vs actual fields returned by `browser_task`/`profile_setup`.
- `followUp:"retry"` (`browser_task.ts:367-369`, hint = `FOLLOW_RETRY_HINT` from `browserFollowPolicy.ts:174-175`) — never mentioned in `instructions.md`. The model's only guidance is the hint string itself, which names the tool (`browser_task`) and jargon (`доводка`) directly to relay.
- `status:"limit"` (`browser_task.ts:539-542`, `profile_setup.ts:196-199`) — never mentioned; same pattern, model relays the literal Russian hint verbatim ("скажи человеку, что лимит браузер-задач…").
- `landed:false` (set by `waitForPageLanding`/`applyCdpPage`, surfaced in the payload at `browser_task.ts:637`) — never mentioned at all; a run that opened *a* page but not the *right* one (wrong region redirect, bot-check interstitial) has no scripted reply.
- Fix: Appendix C adds a single canonical "tool result → reply" table covering every field actually emitted, replacing the current pattern of "read the hint string and hope."

### F11 — P2 — jargon/anglicisms sit inside strings meant to become chat text
`agent/tools/browser_task.ts:351,497`; `convex/lib/browserFollowPolicy.ts:175`; `agent/instructions.md:19,57,60,70,74,80,82` (all the `Cloud`-prefixed compounds).
- `"джоб висит слишком долго, скажи человеку и предложи reset"` (`:351`) — "джоб" and "reset" are internal/English terms sitting inside a string whose only job is to become a Russian sentence to a human who was promised no dead-end and no jargon.
- `"Оплата не началась: предыдущий браузер-job ещё идёт. Дождись его завершения и вызови browser_task с pay ещё раз."` (`:497`) — same, plus names the tool by its code identifier.
- `FOLLOW_RETRY_HINT = "доводка временно не подцепилась — спроси человека или вызови browser_task ещё раз"` — names the tool.
- `instructions.md` itself routinely says `Cloud-сессия`, `Cloud-профиль`, `Cloud должен войти сам` — fine as *system*-prompt shorthand, but it is the same vocabulary the model has been shown as acceptable register, raising the odds a tired/weak model echoes "Cloud" to the human the one time it is unsure how to paraphrase.
- Full list + replacements: Appendix F.

### F12 — P2 — `errandLoginBlock` and `errandFinishBlock` sit next to each other with no priority marker
`agent/lib/browseruse.ts:137-161`.
- Login block: *"Если пароля нет и без него дальше нельзя — остановись и дай live-URL."*
- Finish block (no-pay branch): *"Остановка на гостевом экране без входа — не результат."*
- These describe different situations (login attempted-but-blocked vs never-attempted guest screen) but read back-to-back with no explicit "these are not the same case" marker; a lower-capability model conflates them and either stops too early (treating any auth friction as "no password, stop") or pushes too hard (ignoring a legitimate live-URL stop because "finish the job" reads as an override).
- Fix: Appendix B's rewrite states the two cases as an explicit if/else pair instead of two separate paragraphs.

### F13 — P2 — static Voice rule vs dynamic fast-ack override, same situation, opposite instruction
`agent/instructions.md:19` ("write one short line the human can see first, then call the tool. A tool-only step with no text leaves them on read") vs `agent/lib/fast-ack.ts:201-203` (`fastAckInstruction`: "do not repeat, rephrase, or write another looking/status line… call the tool now").
- Both are live in the same turn whenever a fast-ack fired: the static instruction says a tool call needs a preceding visible line, the per-turn override says exactly the opposite. A model that resolves the conflict wrong either produces the F3 duplicate or (worse) refuses/hesitates to call the tool at all without text.
- Fix: the static line should carve out the exception explicitly: *"...leaves them on read — unless Bro already sent a first line for this turn (see below), in which case call the tool with no extra text."*

### F14 — P2 — OTP section duplicates part of the Browser section almost verbatim
`agent/instructions.md:60` and `:82` say close to the same thing ("человек прислал код/подожди/уточнение → browser_task с этой строкой, первое «ввожу код»/«ввожу»") in two different sections with slightly different wording and coverage (line 60 lists "OTP for that login, address/size/ПВЗ correction, «подожди»"; line 82 lists "цифры / «подожди» / уточнение"). Redundant density that a 40B-class model has to reconcile instead of using one rule. Folded into Appendix C's single table.

## 3. Ideas

- **Compact options template as a tool-side helper, not model freelancing.** `browser_task`'s payload could pre-format `result` into a `optionsSummary` string (one line per item, price first, no URL) when it detects a numbered "1. … 2. …" pattern, so the model has a ready-made compact reply instead of relaying raw Cloud prose through the renderer's guesswork. Size: S. Files: `agent/tools/browser_task.ts`, maybe a small helper next to `order-policy.ts`.
- **Stamp `browserStatus:"stalled"` explicitly at give-up**, distinct from `"running"`, so `isActiveStatus`/`isDoneStatus` and every downstream read (not just the next `browser_task` call) agree the job is no longer trustworthy. Size: S. Files: `agent/lib/browser-policy.ts`, `convex/browserFollow.ts`, `agent/tools/browser_task.ts` `settle()`.
- **One `cloudResultLine()` formatter** shared by `browser_task`'s hint, the `browser_poll` wakeup prompt, and the "готово"/"нужно от тебя" split, so all three code paths that turn a Cloud result into human text point at the same function instead of three ad hoc string templates. Size: M.
- **Fold `NEEDS:` parsing into `browserInjectPolicy.ts`'s `resultWaitsForCode`.** Right now `resultWaitsForCode` regex-sniffs for OTP words in free text; once the scaffold emits a labelled `NEEDS:` line (Appendix B), that function becomes a one-line label check instead of a fragile regex, which also fixes the current risk of false negatives on a paraphrase Cloud didn't use the expected words for. Size: S.

## 4. Open questions

- Whether anything outside this file actually calls `pollTimedOut` from `agent/lib/browser-policy.ts:61-67` (F6) — grep found none, but I did not do a full repo-wide TS project reference check.
- Whether the fast-ack tiny model (`fastAckModel()`, OpenRouter) has been observed in practice to hallucinate a beat for bare digit input (F4) — I could not run it live; this is a code-path risk, not an observed incident.
- Whether `errandStartUrl`'s hardcoded desktop URLs (`browserStartPolicy.ts:11-13`) were a deliberate choice over mobile (e.g. because CDP navigation or Cloud viewport is desktop-shaped) — if so, F8's "prefer mobile" idea needs to be reconciled with that constraint rather than blindly added to the scaffold.
- Whether the two-timeout situation in F6 is a stale leftover from a refactor (Convex module took over the constant) or the local one is genuinely still consumed via a re-export path I missed under a different name.

---

## Appendix A — Transcripts

Conventions: `〈fast-ack〉` = tiny-model channel bubble sent before the real turn; `〈tool〉` = text the tool itself sends via `deliverHumanRouted`/`deliverHuman`; `〈model〉` = the root model's own reply.

### a. «вызови такси до Шереметьево» — no Yandex login in the vault

```
Человек: вызови такси до Шереметьево
〈fast-ack〉 вызываю такси                                   [~700ms budget, tiny model]
〈tool〉    Ищу, это может занять пару минут. Сам напишу,     [F3: 2nd looking bubble,
           когда будет готово.                                full sentence not 2-5 words]
```
No further bubble until the Cloud LLM either finishes (guest checkout worked, no login needed) or hits `errandLoginBlock`'s stop condition. Since there is no vault login for Yandex, the scaffold tells Cloud: *"Если пароля нет и без него дальше нельзя — остановись и дай live-URL"* (`browser-pay.ts` n/a here — this is `errandLoginBlock`, `browseruse.ts:148-149`). If Yandex Taxi requires phone+SMS sign-in, Cloud stops and returns `liveUrl`. The follow-through wakeup fires (`kind:"browser_poll"`), model gets the generic prompt (`imessage.ts` ~line 715) and, per `instructions.md:62` ("`liveUrl` → login or 3-D Secure, not a re-approve"), should send the link. **But there is no scripted phrase for this** — F10. A plausible model reply:
```
〈model〉  Яндекс просит войти по номеру телефона — открой и подтверди:
           https://…live-view…
```
This part is fine *if* the model correctly infers phrasing; nothing enforces it. When the human later texts the SMS code, see scenario **f**.

### b. «купи молоко и хлеб на самокате» — vault card present, site asks for address

```
Человек: купи молоко и хлеб на самокате
〈fast-ack〉 ищу на самокате
〈tool〉    Ищу, это может занять пару минут. Сам напишу,     [F3 again]
           когда будет готово.
```
`pay` is attached (vault card found), so `payScaffold` is in the scaffold. Cloud fills the cart, hits an address field, and (per scaffold) *"Если данных не хватает… закончи и перечисли, что нужно уточнить"* — a free-text stop, no `NEEDS:` label (F7). Wakeup fires; model must parse the free text to notice "address" is missing:
```
〈model〉  Корзина готова, не хватает адреса — куда доставить?
Человек: Ленина 5, кв 12
```
`"Ленина 5, кв 12"` matches `STREET_LINE`/`CORRECTION` in `browserInjectPolicy.ts:171-179`; since the task text doesn't match the `taxi`/`shop` keyword lists in `correctionFitsTask` (`:150-155`, "самокат" isn't in either), it falls into the permissive `!taxi && !shop → true` branch and is injected as a `"correction"` — this happens to work, but only because the shop-keyword regex is incomplete, not because it was designed for grocery-delivery sites (worth widening `shop` regex to include других origins, or dropping the keyword gate and trusting `looksLikeCorrectionText` alone).
```
〈model〉  ввожу
```
…then Cloud resumes, finishes checkout, and (if the scaffold had the Appendix B `NEEDS`/labelled lines) the model could give a clean "готово" reply with order number; today it has to reconstruct that from prose.

### c. «запиши меня к стоматологу на завтра вечером» — clinic form wants name/phone

```
Человек: запиши меня к стоматологу на завтра вечером
〈fast-ack〉 ищу стоматолога
〈tool〉    Ищу, это может занять пару минут. Сам напишу,     [F3]
           когда будет готово.
```
Name/phone are usable from chat/memory per Trust section (`instructions.md:70`), so if the model has them in memory it can pass them straight into the `task` string and Cloud fills the form without asking. If memory is empty, Cloud stops per the same free-text rule as scenario b (F7 again — no structured field for "missing: phone"). No scaffold guidance exists for date/time slot pickers (F8), so a clinic site with a calendar widget is handled purely by the Cloud LLM's own judgement, unguided by the scaffold.

### d. «ну что?» at minute 3; job completes at minute 7

```
Человек: ну что?
〈fast-ack〉 (uncertain — "ну что?" has no matching FAST_ACK example; likely NONE or a
            guessed beat, see Open Questions)
〈model〉   ещё ищу, скоро напишу              [nextBrowserAction → "poll", still running,
                                                generic hint "Still running… tell them
                                                you're looking, don't ask to check back"]
```
4 minutes later, the follow-through workflow (2-min poll cadence, `POLL_INTERVAL_MS`) detects `status:"completed"`, fires `kind:"browser_poll"`. `nextBrowserAction` sees `isDoneStatus` + `normalizeTask(storedTask) === normalizeTask(incomingTask)` (payload is the *original* stored task) → `"reuse"`, hydrates, `settle()` sees terminal → payload hint `"Send these results to the human now."`
```
〈model〉   Готово: заказ №… на …₽, приедет к …    [correct — single message, no "check
                                                    back" languishing]
```
This path works. The only risk is translation quality of the English meta-hints (F10/F11) and whether the model compresses a 5-option `result` correctly (F9) if this had been a search rather than an order.

### e. Job fails / gives up after 20 minutes

```
[20 min elapsed, still "running" per Browser Use, our patience runs out]
〈background wakeup〉  Проверь статус текущего браузер-джоба… Если failed или
                       джоб завис — коротко скажи об этом. …
〈model〉   Задача зависла, я не смог довести до конца. Начать заново?
```
(follows the `hint:"джоб висит слишком долго, скажи человеку и предложи reset"` — F11's jargon risk lives here.) **The dangerous part is what happens next** (F2): if the human doesn't say the literal word for reset, or says something else entirely ("а купи хлеб"), the tenant's `browserStatus` is still `"running"`, so the *next* `browser_task` call — for the completely different request — routes to `"poll"` again and returns the *same* give-up hint, ignoring "купи хлеб" outright. The human never finds out their new request was dropped.

### f. Human sends «482913» while Yandex waits for SMS; then the taxi is ordered

```
Человек: 482913
〈fast-ack〉 (F4: shouldFastAck("482913") = true — an LLM-guessed beat may or may not
            fire here; if it does, it races the deterministic ack below)
〈model〉   ввожу код                          [fixed by cloudInjectInstruction, matches
                                                instructions.md:19/60 exactly]
```
Code is queued into the live session (`injectQueueText`, `browserInjectPolicy.ts:364-369`) and typed via CDP if reachable. Tool call returns quickly (2s wait budget); job likely still running → generic "still running" hint. Follow-through eventually completes:
```
〈model〉   Такси вызвано, приедет через ~7 минут, госномер …
```
This scenario is one of the better-behaved ones in the system, marred only by F4's possible extra bubble before "ввожу код".

### g. 3-D Secure during a WB purchase

```
Человек: купи кроссовки nike air на вб 42 размер
〈fast-ack〉 ищу на вб
〈tool〉    Ищу, это может занять пару минут. Сам напишу,     [F3]
           когда будет готово.
```
`payScaffold` (`browser-pay.ts:118-142`) tells Cloud: *"3-D Secure, код из SMS или подтверждение в приложении банка — остановись и дай live-URL."* Cloud stops, `run.liveUrl` is set. Nothing in `browser_task.ts` auto-delivers this liveUrl the way `profile_setup.ts` does for logins (`loginChatText` call at `:294-301`) — the model must notice `liveUrl` in the JSON payload and compose the message itself. `instructions.md:62` says only *"`liveUrl` → login or 3-D Secure, not a re-approve"* — no worked phrasing, no confirmation this becomes a URL-on-its-own-line message (F10). Best case:
```
〈model〉   Банк просит подтвердить оплату:
           https://…live-view…
```
No code-level guarantee this happens correctly, and no reply-format guidance exists for this exact tool-result shape.

---

## Appendix B — Rewritten `scaffoldTask` (Russian, ≤25 lines) + parser sketch

```text
[bro-errand]
Задача: {task}. Пиши и работай на языке сайта (обычно русский).
{alreadyOpen — страница уже открыта на {startPage} / сайт открой сам}
Сначала закрой баннеры cookie, промо и подписки — не читая их.
Если сайт спрашивает город/регион — выбери тот, что в задаче или ближайший смысловой; не спрашивай человека.
{errandLoginBlock: vault-login OR "войди сам, паспорт/ID нормально" OR "нет пароля — стоп, live-URL"}
{payScaffold, если оплата} иначе: если по ходу нужна оплата — остановись и дай live-URL.
Прежде чем оформить — проверь, что товар/услуга не добавлены в корзину/запись дважды.
Доводи дело до конца: жми финальную кнопку (Заказать/Оплатить/Записаться), если человек об этом просил. Гостевой экран без попытки войти — не результат.
Стоп-события (дай live-URL и сразу переходи к итогу, ничего не выдумывай): 3-D Secure, код из SMS/push/приложения банка, капча, нет пароля.
Если не хватает данных (имя/телефон/адрес/время/размер) — не выдумывай, перечисли в итоге.
После оформления проверь, что на экране виден номер заказа/записи — без него это не «готово».
Сайт медленный/недоступен/капча без выхода — пропусти, возьми альтернативу.

Итог — только в этом формате, каждое поле с новой строки:
СДЕЛАНО: <одна фраза>
ЗАКАЗ: <номер или "нет">
СУММА: <₽ или "нет">
КОГДА: <дата/время/ETA или "нет">
ВАРИАНТЫ: <до 5, "название — цена", или "нет">
NEEDS: <none|sms_code|push|3ds|captcha|password|address|payment>
```
(23 content lines excluding the `[bro-errand]` mark line and blank separator — fits the ≤25 budget.)

**Parser sketch** (replaces the free-text guessing in `order-policy.ts` as the first attempt, falling back to today's regexes if labels are absent — keeps old in-flight runs working):

```ts
type CloudNeed =
  | "none" | "sms_code" | "push" | "3ds" | "captcha" | "password" | "address" | "payment";

type CloudOutcome = {
  done?: string;
  orderId?: string;
  amountRub?: number;
  when?: string;
  options?: string[];      // "название — цена" lines
  needs: CloudNeed;
};

function parseLabelled(result: string): CloudOutcome | null {
  const grab = (label: string) =>
    result.match(new RegExp(`^${label}:\\s*(.+)$`, "im"))?.[1]?.trim();
  const needsRaw = grab("NEEDS")?.toLowerCase();
  if (!needsRaw) return null; // old-format result — caller falls back to regex parse
  const done = grab("СДЕЛАНО");
  const orderRaw = grab("ЗАКАЗ");
  const sumRaw = grab("СУММА");
  const when = grab("КОГДА");
  const optsRaw = grab("ВАРИАНТЫ");
  return {
    done,
    orderId: orderRaw && orderRaw !== "нет" ? orderRaw : undefined,
    amountRub: sumRaw && sumRaw !== "нет" ? parseRub(sumRaw) : undefined,
    when: when && when !== "нет" ? when : undefined,
    options: optsRaw && optsRaw !== "нет" ? optsRaw.split(/;\s*|\n/).filter(Boolean) : undefined,
    needs: (["none","sms_code","push","3ds","captcha","password","address","payment"]
      .includes(needsRaw) ? needsRaw : "none") as CloudNeed,
  };
}

// order-policy.ts: parseOrderFromResult(args) tries parseLabelled(result) first;
// only runs the existing CANCEL/FAIL/SUCCESS/PRICE_LABEL/ORDER_LABEL regex path
// when parseLabelled returns null.
```

---

## Appendix C — Tightened root instructions (Browser / Login / OTP / Purchase)

Design: short imperative rules, one canonical table at the end that a DeepSeek-V4.1-Flash-class model can pattern-match against instead of re-deriving behavior from prose scattered across four sections.

```markdown
## Browser

`browser_task` is one cloud job per person — start it, or poll it, never both at once for the same ask.

- New errand → `browser_task` with the task text. Bro opens the site himself.
- Ping on a running job («ну что», «как там») → `browser_task` with the SAME task text (it polls, it does not search again).
- `browser_task` is already running (mid-login or mid-errand) → never call `profile_setup` at the same time. `profile_setup` is only for: (a) the human explicitly asks to save a login for later, with no job running, or (b) `needsProfileSync` came back on a run that did NOT already use a vault login (`login:true` in the same call).
- The Cloud agent logs itself in (vault → cookies → click «Войти» → passport/SMS is normal). Never tell it not to log in. Never ask the human for a password.
- Live session + the human sent a one-time code / «подожди» / an address·size·ПВЗ correction for THIS errand → first bubble exactly «ввожу код» / «ввожу» / «подожду», then `browser_task` with their exact line. A code already sent must be used, never re-asked, never dropped.
- Reply table below covers every other tool-result shape.

## Login / vault

- Vault login exists for this site → Cloud uses it silently, nothing to say beyond the normal "ищу" beat.
- No vault login, no cookies → Cloud opens the login page itself and stops there; send the live-view link only once that page is actually showing (never as a "here's an option").
- Cookies already cover this site → say "вход уже сохранён", no link, straight to `browser_task` (cookies are not proof of a logged-in tab — Cloud still clicks «Войти» if the page is a guest view).
- Never ask for a password in chat. Never suggest the human paste one "just this once."

## OTP

1. A one-time code the human already sent, for a LIVE Cloud session → inject it (see Browser rule above). Never re-ask for it.
2. `worker` reports it needs a code → check Bro's mailbox first (`otp`/`otp_lookup`, then `bro_mail` inbox / `archive__search`); only ask the human if no letter exists after that.
3. Found in mail → straight back into the same worker turn, do not quote it in chat; one short line: «код из почты, ввожу».
4. 3-D Secure / bank app / push → this is a live-URL case, not a mailbox OTP; a code the human types in chat still goes into the live tab, never quoted back.

## Purchase / orders

- «купи»/«закажи»/«оформи» → find it and pay with the vault card in the same turn. No second confirmation of shop/item/qty/total.
- Only a named ceiling stops a purchase on price. Stop conditions otherwise: no card, needs a login with nothing in the vault, 3-D Secure, sum above a named ceiling.
- After a purchase the order already lives in `orders` — never invent a number; `list_orders` answers "где заказ"/"когда ПВЗ" before anything else.

## Canonical tool-result → reply table

| tool result                                   | say this (paraphrase, don't quote hints verbatim) |
|---|---|
| `status:"completed"`, `result` has products/times | compact options reply — see options-found format below |
| `status:"completed"`, `result` is an order confirmation | "готово" reply — order number / price / ETA, one line each |
| still running (poll), no injectable follow-up | one short "ищу"-class line, never "check back later" |
| `status:"no_wait"` | "сейчас нет открытой сессии, которая ждёт этот код" |
| `status:"limit"` | "лимит браузер-задач на этот месяц исчерпан" + offer to pay for more |
| `followUp:"retry"` | "не получилось подхватить довести дело до конца — спрошу ещё раз" (never name the tool) |
| `landed:false` | "сайт открылся, но нужная страница ещё не загрузилась — жду" (do not claim done) |
| `needsProfileSync:true` AND no vault login used this call | call `profile_setup` with the login page URL |
| `needsProfileSync:true` AND a vault login WAS used this call | ignore it — Cloud is already logging in |
| `liveUrl` present, no `landed` context | it's a login page or a bank 3-D Secure/SMS step — send the URL on its own line with one line of context ("банк просит подтвердить" / "открой и войди") |
| `NEEDS:` line ≠ none (once Appendix B ships) | map directly: sms_code/push → "жду код"; 3ds → send liveUrl; captcha → "сайт просит капчу, зайду позже/дай ссылку"; password/address/payment → ask exactly that one thing |
```

---

## Appendix D — Reply formats

**Options found** (replaces ad hoc numbered lists that fragment into many bubbles, F9):
```
нашёл 3 варианта на вб: Nike Air 5990 ₽, Nike Zoom 6400 ₽, Nike React 5200 ₽ — какой брать?
```
One bubble, no URLs unless the human asks to see a specific card (then, and only then, one URL on its own line for that item).

**Ordered** (maps to Appendix B's `СДЕЛАНО/ЗАКАЗ/СУММА/КОГДА`):
```
Готово: кроссовки Nike Air, 42 размер — 5990 ₽.
Заказ №1234-5678, приедет в ПВЗ на Ленина 5 послезавтра.
```
Two bubbles max, blank line between fact groups per the existing Voice rule.

**Needs X** (maps to `NEEDS:`):
```
Не хватает адреса доставки — куда?
```
or, for a hard stop:
```
Банк просит подтвердить оплату:
https://…live-view…
```

## Appendix E — Wakeup "готово" vs "нужно от тебя" phrasing

Proposed addition to the `browser_poll` wakeup prompt (`agent/channels/imessage.ts`, currently one generic sentence for both done and give-up phases):
```
Если завершилось успешно — напиши «готово»-сообщением: что куплено/забронировано,
номер заказа/записи если есть, сумма, когда/куда. Одно-два коротких сообщения, без канцелярита.
Если завершилось, но чего-то не хватает (NEEDS ≠ none) — напиши «нужно от тебя: …»
с ОДНИМ конкретным вопросом (адрес/код/подтверждение), не списком.
Если джоб завис или упал — коротко скажи и предложи начать заново, без слов "reset"/"джоб".
Если ещё работает и вводить нечего — ответь [SILENT].
```

## Appendix F — Language/jargon leak list and replacements

| leak (file:line) | leaks as | replace with |
|---|---|---|
| `browser_task.ts:351` `"джоб висит слишком долго, скажи человеку и предложи reset"` | "джоб", "reset" | "это зависло — скажи человеку и предложи начать заново" |
| `browser_task.ts:497` `"...предыдущий браузер-job ещё идёт... вызови browser_task с pay ещё раз"` | "браузер-job", tool name | "...прошлое дело ещё не закончилось. Дождись и попробуй оплату снова." |
| `browserFollowPolicy.ts:175` `FOLLOW_RETRY_HINT` names `browser_task` | tool name | "не получилось продолжить само — попробуй ещё раз или спроси человека" |
| `instructions.md:19,57,60,70,74,80` — `Cloud`, `Cloud-сессия`, `Cloud-профиль`, `Cloud-входа`, `Cloud-поручению` | "Cloud" (English brand-ish word) inside otherwise-Russian system text the model is shown as acceptable register | use "браузер"/"браузер-сессия" throughout, drop "Cloud" as a stand-alone word entirely from anything the model might echo |
| `composio.ts:169,194` `"...browser_task: они режут прямой HTTP."` | tool name + "HTTP" (fine as an internal hint since it never reaches the human path, but flagged since it's adjacent to F10/F11 style) | leave as-is (internal routing hint, not user-facing), but worth a comment marking it "never relay verbatim" |
| `profile_setup.ts:181` `"...Куки ≠ вход: если на экране Войти, Cloud должен войти."` | "Cloud" | "...сайт должен войти сам." |
