# Goal: «Что-то сломалось у меня внутри» на фото + «Найди мне эту книгу на озоне»

2026-09-06 08:19 MSK (05:19Z): человек прислал фото книги + «Найди мне эту
книгу на озоне». Через 8 секунд Bro ответил fallback-строкой «Что-то
сломалось у меня внутри 🙈». Это второй слой из #23 сработал как задумано —
но сам ход упал.

## Что было (логи Vercel bro-agent, dpl_AdtdPQypvSb3jJ5boTm4hxR6nk1e)

1. 05:19:45Z `POST /webhooks/imessage` → `imessage inbound { chars: 1371,
   images: 1 }`. Фото скачано, ушло в `from().send([text, image])`.
2. 05:19:53Z три раза `[eve:dynamic-tools] Dynamic tool resolver
   (turn.started) failed — skipping its complete result. { error:
   'Expected a JSON-serializable value.' }` — memo, recall и archive
   остались без тулов на этот ход.
3. 05:19:53Z `AI_APICallError` 402 от OpenRouter: «This request requires
   more credits, or fewer max_tokens. You requested up to 131072 tokens,
   but can only afford 23281». `turn failed { code: MODEL_CALL_FAILED }`
   → канал отправил fallback.
4. Тот же 402 уже был накануне: 2026-09-05 11:02:45Z, turn_25
   (`in_flight_budget_exhausted`, «can only afford 48943») — вторая
   причина вчерашнего молчания, которую #23 не закрыл.

## Root cause

**Основной.** `agent/lib/model.ts` строит модель как
`createOpenAI(...).chat("z-ai/glm-5.3-flash")` без `maxOutputTokens`, запрос
уходит с `max_tokens: undefined`. OpenRouter резервирует под такой запрос
максимальную длину ответа модели (131 072 токена) и сверяет резерв с
балансом ДО вызова. Баланс просел до ~23k токенов по этой цене — каждый
ход любого пользователя падает 402, хотя реальный ответ Bro — сотни токенов.
eve не даёт per-call лимита вывода, поэтому кап надо ставить на самом
AI SDK-экземпляре модели.

**Побочный.** `agent/lib/inbound-image.ts` клал в file part `Uint8Array`
(байты фото) или `URL`. eve сериализует `turn.input` в durable-замыкание
тулов каждого memory-слота через строгий JSON-парсер
(`context/memory-tools.js` → `parseJsonObject({context, key})`); `Uint8Array`
и `URL` — не plain JSON → резолвер падает → тулы `memo__*`, `recall__*`,
`archive__*` пропадают на ход с фото. Тихая деградация: модель не может
ни вспомнить, ни записать.

## Исправление

- `model.ts`: `wrapLanguageModel` + middleware `transformParams`, который
  ставит `maxOutputTokens` (по умолчанию 8192, `BRO_MAX_OUTPUT_TOKENS`)
  когда вызывающий его не задал. Резерв OpenRouter падает с 131k до 8k
  токенов — работает и на малом балансе. `npm run model:check`.
- `inbound-image.ts`: part data — только строки: `data:<type>;base64,…`
  для скачанных байтов (кап 3 МБ), plain URL-строка как fallback.
  AI SDK принимает обе формы как есть. `isPlainJson` + проверка в
  `npm run image:check`, что выход `inboundUserContent` переживает
  `JSON.parse(JSON.stringify())`.
- README, .env.example.

## Что не чинится кодом

Баланс OpenRouter. Пополнить: https://openrouter.ai/settings/credits.
С капом 8k один ход требует резерва ~8k токенов, а не 131k.

## Приёмка

`npm run types:check`, `model:check`, `image:check`, `imessage:check`,
`silent:check` зелёные; `npx eve build` без ошибок; `eve deploy` —
вручную владельцем.
