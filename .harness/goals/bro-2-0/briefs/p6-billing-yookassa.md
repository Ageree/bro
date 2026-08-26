# P6 — Биллинг ЮKassa + лимиты + paywall

Контекст: Bro — iMessage-консьерж (eve + Convex + Inkbox). Wakeups-примитив уже
внедрён. Прочитай перед работой: convex/schema.ts, convex/tenants.ts,
convex/http.ts, convex/secret.ts, agent/channels/imessage.ts,
convex/lib/accessPolicy.ts, scripts/access-policy-check.ts. Стиль репо,
минимум кода, БЕЗ новых npm-зависимостей (fetch + btoa/Buffer хватает).
Не трогай vendor/, convex/_generated/, agent/lib/imessage-text.ts.

## Модель

- Бесплатный режим (по умолчанию, ключей ЮKassa нет): всё работает как сейчас,
  но с лимитами: BRO_FREE_MSGS_PER_DAY (default 30 входящих сообщений/день),
  BRO_FREE_BROWSER_JOBS_PER_MONTH (default 5 стартов браузер-джобов/месяц).
- Оплата: разовый платёж «месяц» (BRO_PRICE_RUB, default 990) через ЮKassa →
  tenants.paidUntil = max(now, paidUntil) + 30 дней. Пока paidUntil в будущем —
  лимиты BRO_PAID_MSGS_PER_DAY (default 500) / BRO_PAID_BROWSER_JOBS_PER_MONTH
  (default 60).
- Все пороги читаются из env с дефолтами (Number(...) c fallback, как cap() в
  convex/access.ts).

## Файлы

### 1. convex/lib/billingPolicy.ts — ЧИСТЫЕ функции (без Convex-импортов)

- `dayKey(now: number, tz = "Europe/Moscow"): string` — "YYYY-MM-DD" в tz (Intl).
- `monthKey(now: number, tz?): string` — "YYYY-MM".
- `isPaid(paidUntil: number | undefined, now: number): boolean`
- `extendPaidUntil(paidUntil: number | undefined, now: number): number` —
  max(now, paidUntil ?? 0) + 30*24*3600*1000.
- `msgAllowance(paid: boolean, env: {free?: string; paid?: string}): number` и
  аналогичная `browserAllowance` — парс env c дефолтами 30/500 и 5/60.
- `paywallDecision(opts: {count: number; allowance: number; paywallSentDayKey?: string; dayKey: string}): "allow" | "paywall" | "drop"` —
  count < allowance → allow; иначе если paywallSentDayKey !== dayKey → paywall
  (шлём одно сообщение с ссылкой), иначе drop (молча).

### 2. convex/schema.ts — tenants +

`paidUntil: v.optional(v.number())`, `msgsDayKey: v.optional(v.string())`,
`msgsDayCount: v.optional(v.number())`, `browserMonthKey: v.optional(v.string())`,
`browserMonthCount: v.optional(v.number())`, `paywallSentDayKey: v.optional(v.string())`.
Не забудь отразить те же поля в tenantDoc в convex/tenants.ts.

### 3. convex/tenants.ts — новые функции

- `countInboundMessage` (mutation, public+secret): args {secret, phoneE164} →
  находит тенанта по телефону (нет — создаёт как upsert), катит окно
  (msgsDayKey != dayKey(now) → reset count), инкрементит msgsDayCount,
  возвращает {decision: "allow"|"paywall"|"drop", payUrl?: string}. decision из
  billingPolicy.paywallDecision. Для "paywall": проставь paywallSentDayKey и
  верни payUrl = `${process.env.CONVEX_SITE_URL_PUBLIC ?? ""}/pay?tid=${tenant._id}`
  — точнее: сформируй из env BRO_PAY_BASE (default пусто; если пусто, верни
  payUrl undefined — канал тогда шлёт paywall-текст без ссылки).
- `countBrowserJobStart` (mutation, public+secret): то же для месячного окна
  браузер-джобов; возвращает {allowed: boolean}. Вызов добавится в P2-код
  browser_task (сделай сам: в agent/tools/browser_task.ts перед startRun —
  если !allowed, верни payload-объект {status:"limit", hint:"скажи человеку,
  что лимит браузер-задач на месяц исчерпан, предложи оплату"} и НЕ стартуй).

### 4. convex/billing.ts (новый) — ЮKassa

- `createPayment` (httpAction НЕ здесь — см. §5; здесь action):
  internalAction `createPaymentFor` args {tenantId} → читает env
  YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY (нет → throw "billing disabled");
  POST https://api.yookassa.ru/v3/payments, headers: Authorization Basic
  base64(shopId:secret), Idempotence-Key: crypto.randomUUID(),
  Content-Type json. Body: {amount:{value:"<BRO_PRICE_RUB>.00", currency:"RUB"},
  capture:true, confirmation:{type:"redirect", return_url: BRO_PAY_RETURN_URL
  ?? "https://bro-agent.vercel.app"}, description:"Bro — месяц",
  metadata:{tenantId}}. Верни {confirmationUrl} из ответа
  (confirmation.confirmation_url).
- `applyPayment` (internalMutation) args {tenantId} → patch paidUntil через
  billingPolicy.extendPaidUntil.
- `verifyAndApply` (internalAction) args {paymentId} → GET
  https://api.yookassa.ru/v3/payments/{id} с той же Basic-auth (это и есть
  проверка подлинности вебхука — мы верим только своему re-fetch, не телу
  вебхука; ponytail-коммент об этом). Если status==="succeeded" и
  metadata.tenantId — runMutation(applyPayment).

### 5. convex/http.ts — роуты

- `POST /yookassa` — httpAction: парсит JSON, берёт body.object?.id (string,
  иначе 200 и выход — вебхук всегда 200, чтобы ЮKassa не ретраила вечно),
  ctx.runAction(internal.billing.verifyAndApply, {paymentId}) в try/catch
  (ошибки логируй console.error), верни 200.
- `GET /pay` — httpAction: query tid; если нет YOOKASSA_* env → 503 текст
  "оплата скоро". Иначе runAction(createPaymentFor,{tenantId:tid}) → 302
  Location: confirmationUrl. try/catch → 500 с коротким текстом.

### 6. agent/channels/imessage.ts — enforcement

Во входящем вебхуке ПОСЛЕ определения remote и tenant-привязки, ПЕРЕД
`from(...).send(...)`: вызови новую обёртку `countInboundMessage(remote)`
(добавь в agent/lib/convex.ts через anyApi, как wakeups-обёртки).
- "allow" → как раньше.
- "paywall" → отправь ОДНО сообщение через sendBlueIMessage: «Лимит на сегодня
  исчерпан 🙈 Полный доступ — 990 ₽/мес: <payUrl>» (если payUrl нет — «…напиши
  @оператору»; текст держи коротким), верни 204, агент-ход НЕ запускай.
- "drop" → 204 молча.
- Ошибка биллинг-вызова (throw) → console.error и ПРОПУСТИ (fail-open,
  ponytail-коммент: биллинг не должен убивать чат).
Фоновые ходы (/internal/wakeup) лимитом сообщений НЕ считаются.

### 7. scripts/billing-check.ts + package.json

Голые assert по billingPolicy: dayKey/monthKey формат и tz-корректность;
isPaid до/после; extendPaidUntil от undefined и от будущего paidUntil
(стакается: +30д к БУДУЩЕМУ); msgAllowance дефолты и env-override;
paywallDecision: под лимитом allow, первый раз над лимитом paywall, повторно в
тот же день drop, на следующий день снова paywall. Финал:
`console.log("billing-check ok")`. package.json:
`"billing:check": "node --experimental-strip-types scripts/billing-check.ts"`.

### 8. .env.example + README

.env.example: блок YOOKASSA_SHOP_ID/YOOKASSA_SECRET_KEY/BRO_PRICE_RUB/
BRO_PAY_BASE/BRO_PAY_RETURN_URL + строка про лимиты BRO_FREE_*/BRO_PAID_*
(значения-дефолты в комментах). README: 3-4 строки про биллинг (env на Convex
deployment, вебхук https://<deployment>.convex.site/yookassa настраивается в
кабинете ЮKassa).

## Верификация

```bash
source ~/.nvm/nvm.sh && nvm use 24
npx eve build   # errors==0
npm run -s billing:check && npm run -s wakeups:check && npm run -s access:check && npm run -s browser:check && npm run -s connect-link:check && npm run -s imessage:check
```

НЕ запускай convex-команды. НЕ коммить. Секреты в код не вписывать. В конце —
список файлов + результаты проверок.
