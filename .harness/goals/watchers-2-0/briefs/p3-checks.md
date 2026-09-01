# P3 — scripts/watchers-check.ts (оффлайн-проверки policy)

Прочитай `briefs/contract.md` §1 и `scripts/wakeups-check.ts` для стиля.
`convex/lib/watcherPolicy.ts` пишет параллельно P1 — импортируй по контракту.

Единственный файл пакета: `scripts/watchers-check.ts`. Импорты только из
`../convex/lib/watcherPolicy.ts` и `node:crypto`. Top-level await допустим.
Финал — `console.log("watchers-check ok")`.

Обязательные asserts:

- `triggerSpec("gmail")` → slug `GMAIL_NEW_GMAIL_MESSAGE`, toolkit `gmail`,
  config `labelIds === "INBOX"`, `interval === 1`, нет `query`;
  `triggerSpec("gmail", " from:bank.ru ")` → `query === "from:bank.ru"`, нет `labelIds`;
  `triggerSpec("calendar")` → slug `GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER`,
  toolkit `googlecalendar`, `calendarId === "primary"`, `showDeleted === true`.
- `isWatchSource`: gmail/calendar true, "slack" false; `WATCH_SOURCES.length === 2`.
- HMAC: `hmacSha256Base64("whsec_test", "msg_1.1700000000.{}")` равен
  `createHmac("sha256","whsec_test").update("msg_1.1700000000.{}").digest("base64")`.
- `signatureMatches("v1,AAA v1,BBB", "BBB")` true; `("v1,AAA","BBB")` false;
  `("v2,BBB","BBB")` false; `("", "BBB")` false.
- `timestampFresh`: ровно now → true; now-299s → true; now-301s → false;
  "abc" → false; будущее +200s → true.
- `verifyComposioWebhook` end-to-end: собери body (V3 JSON), подпиши
  node:crypto, проверь true; поменяй 1 символ body → false; пустой secret →
  false; старый timestamp → false; header с двумя подписями, вторая верная → true.
- `parseComposioEvent`:
  - V3 `{ id:"msg_1", type:"composio.trigger.message", metadata:{ trigger_id:"ti_1", trigger_slug:"gmail_new_gmail_message", user_id:"+79990000000", connected_account_id:"ca_1" }, data:{ subject:"hi" } }`
    → eventId `msg_1`, triggerId `ti_1`, slug `GMAIL_NEW_GMAIL_MESSAGE`, userId, connectedAccountId, `data.subject === "hi"`.
  - V3 с `type:"composio.connected_account.expired"` → null.
  - V3 без `id`, webhookId `"wh_9"` → eventId `wh_9`.
  - V2 `{ type:"gmail_new_gmail_message", data:{ trigger_id:"ti_2", user_id:"+7", connection_id:"ca_2", subject:"v2" }, log_id:"log_2" }`
    → slug upper, eventId `log_2`, `data.subject === "v2"`, в `data` нет `trigger_id`.
  - V1 `{ trigger_name:"gmail_new_gmail_message", trigger_id:"ti_3", connection_id:"ca_3", payload:{ subject:"v1" }, log_id:"log_3" }` → ок.
  - `"not json"` → null; `{}` → null; V3 без `id` и без webhookId → null.
- `formatEvent`:
  - gmail с sender/subject/message_timestamp/message_id/thread_id/message_text
    → начинается с `[event:gmail]`, содержит `от: `, `тема: `, `текст:`;
    `message_text` из 3000 символов → результат короче 1800 и содержит `…`;
    без `message_text` → нет строки `текст:`.
  - calendar: `event_type`, `summary`, `start_time`, `attendees:[{email:"a@x"},{email:"b@x"}]`
    → `[event:calendar]`, `изменение: created`, `участники: a@x, b@x`.
  - неизвестный slug `FOO_BAR` с `{a:1}` → `[event:foo_bar]` и `"a":1`.
- `eventPayload("письма от банка", "[event:gmail]\nтема: x")` начинается с
  `Сторож: письма от банка` и содержит `[event:gmail]`.
- `eventPrompt("p")` начинается с `[background wakeup] p`, содержит `[SILENT]`
  и слово `данные`.
- `ownsEvent({tenantPhone:"+7", status:"active"}, {userId:"+7"})` true;
  userId undefined → true; другой userId → false; status "stopped" → false.
- `deliveryBackoffMs(0) === 30_000`, `(1) === 60_000`, `(2) === 120_000`;
  `shouldRetryDelivery(0)`, `(1)` true, `(2)` false; `MAX_DELIVERY_ATTEMPTS === 3`;
  `EVENT_TTL_MS === 86_400_000`; `WEBHOOK_TOLERANCE_S === 300`.
- `describeWatcher({_id:"w1", source:"gmail", about:"банк", filter:"from:bank", events:2})`
  === `"w1 gmail: банк (фильтр: from:bank), событий: 2"`;
  без filter/events === `"w1 gmail: банк"`.

НЕ трогай другие файлы, НЕ коммить. Скрипт можно запустить, только если
`convex/lib/watcherPolicy.ts` уже появился; иначе просто сдай файл.
