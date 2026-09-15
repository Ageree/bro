# B1 — Chat → live session injection: confirm kind, liveness, code gating, CDP, fast-ack

Read first: `goal.md`, `convex/lib/browserInjectPolicy.ts`, `agent/lib/browser-cdp.ts`,
`agent/lib/fast-ack.ts`, `agent/instructions/jobs.ts`, `scripts/browser-inject-check.ts`,
`scripts/fast-ack-check.ts`, `agent/lib/otp-policy.ts` (for `extractOtpCodes` disambiguation).
Audit: `audits/A2-inject.md` (F1–F6, F11, F_extra) — read it.

Files you own: `convex/lib/browserInjectPolicy.ts`, `agent/lib/browser-cdp.ts`,
`agent/lib/fast-ack.ts`, `agent/instructions/jobs.ts`, `scripts/browser-inject-check.ts`,
`scripts/fast-ack-check.ts`. Do NOT edit `agent/tools/browser_task.ts` (package A3 wires you in);
keep every existing export signature backward compatible (new optional fields only).

## Changes

1. **`CloudInjectKind` += `"confirm"`.** Head-anchored regex (like `WAIT_HEAD`):
   `подтвердил(а)?|подтверждаю|одобрил(а)?|готово|сделал(а)?|вошел|вошла|зашел|зашла|оплатил(а)?|approved|done|confirmed|ок, подтвердил`
   with optional tail («подтвердил вход», «готово, оплатил»). `injectCandidate`, `decideCloudInject`
   (kind `confirm` allowed when `cloudSessionLooksLive` OR `opts.need ∈ {push,3ds,captcha,password}`
   even if status is terminal), `injectAckText("confirm") = "проверяю"`, `injectQueueText` for confirm:
   «Человек подтвердил со своего телефона / завершил шаг в live-view («…»). Проверь, продвинулся ли
   экран, и продолжи поручение на открытой странице. Ничего не вводи повторно.»,
   `injectQueueInterrupt("confirm") = false`, `cloudInjectAttribute` / `cloudInjectKindFromAttrs` /
   `cloudInjectInstruction("confirm", live)` (first bubble «проверяю», then browser_task with the exact line).
2. **`CloudInjectAttrs` += `need?: string`** (`browserNeed` from the tenant, A2 adds the field) and
   `browserProbed?: boolean` (true when `findBrowserForSession` was actually called and returned).
   `cloudSessionLooksLive`: the `startedAt < 20 min` clause only applies when `browserProbed !== true`
   (i.e. we could not check); when probed and not listed and status terminal → false.
   When `need` is set (waiting for a human) → true regardless of status (the session is parked).
3. **Bare digits gating** (`codeRelevantToSession`): a message that is ONLY digits (no
   `код|otp|sms|смс|push|пуш` keyword) is a code only if `need ∈ {sms_code,email_code}` OR
   `pageWaitsForCode(pageUrl)` OR `resultWaitsForCode(...)` OR login-wait/vault-login task.
   Drop the `isBroCloudTask(storedTask)` fallback for keyword-less digits. With a keyword the old
   behaviour stays.
4. **`extractChatCode`**: two candidates → prefer the one within 12 chars after/before
   `код|code|otp|sms|смс|пуш|push`; reject candidates adjacent to `заказ|order|№|руб|₽|р\.`.
   Cases: «код 482913, заказ 55081234» → 482913; «1500» alone stays a candidate (gated by 3);
   «1500 руб» → null; «2024» → null; «89161234567» → null (11 digits > 8).
5. **CDP typing** (`TYPE_INTO_PAGE` in `agent/lib/browser-cdp.ts`): remove the
   `ranked.length === 1` escape hatch — require `score > 0` or `activeElement === target`.
   For a `maxLength===1` single box with a multi-digit value: type only the first char and
   return `{typed:true, submitted:false, partial:true}`. Extract the scoring into an exported pure
   TS function `scoreOtpInput({name,id,placeholder,ariaLabel,type,autocomplete,active,maxLength}, valueLen)`
   used to build the injected JS string (so the check can assert scores; keep the JS in sync by
   generating it from the same source or by duplicating with a comment + a string-includes check).
   Add a code comment that iframes (3-D Secure) are invisible to top-frame evaluate — by design.
6. **fast-ack**: `shouldFastAck(text)` returns false for `isChatCodeMessage(text)`,
   `isWaitInject(text)` and the new confirm shape (import from browserInjectPolicy).
7. **`NO_LIVE_RUN_TEXT`** → «Сейчас нет открытой страницы, которая ждёт этот код — она уже закрылась.
   Скажи, что нужно сделать, и я зайду заново.» Keep it password-free (check asserts).
8. **`agent/instructions/jobs.ts`**: pass `need: tenant?.browserNeed` (optional chaining, the field
   may not exist yet) into `cloudSessionLooksLive` and add the confirm branch of `cloudInjectInstruction`.
9. **`injectQueueText` for `code`**: mention the site if `storedTask` names one? No — keep short.
   But add: «Если поле кода не видно — сначала нажми «Получить код»/«Войти по SMS» не более одного раза.»

## Checks
Extend `scripts/browser-inject-check.ts` for every item above (confirm family incl. false
positives «готово к выходу?» must NOT match — head anchor + ≤ 40 chars; liveness matrix;
digits gating; extractChatCode table; `scoreOtpInput` table). Extend `scripts/fast-ack-check.ts`
(`shouldFastAck("482913") === false`, `shouldFastAck("подтвердил") === false`).
Run: `npm run -s inject:check && npm run -s fast-ack:check && npm run -s queue:check && npm run types:check`.
