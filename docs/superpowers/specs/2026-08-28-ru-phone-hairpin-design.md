# Bro звонит в РФ

_Date: 2026-08-30_

## Что отбросили

- **Voximplant:** RU DID, Caller ID и исходящие завязаны на верификацию
  личности / ЭЦП для ИП. Кабинет `ageree` есть, но без ЭЦП бесполезен.
  `+74992816046` — `auto_charge=off`. Не использовать как
  `BRO_RU_BRIDGE_E164`: это `+7`, Inkbox его не наберёт.
- **Zadarma:** зарегистрироваться не вышло.

## Живой путь: Twilio +1 hairpin + Inkbox Voice AI

Inkbox **не** набирает `+7` (live `502`). `+1` набирает. Мозг —
`hosted_agent` с per-call `reason` (не inbound-конфиг).

1. Bro паркует ногу (`dest` = клиника `+7`, `route` = `ru_bridge`)
2. Inkbox `place-call` на Twilio DID `+1`
3. Twilio `POST /twilio-voice` → Convex claims the leg
4. TwiML `<Dial answerOnBridge="true">+7клиника</Dial>`
5. Клиника видит американский CLI. Pickup вторичен.
6. `call.ended` → `[event:call]`

Включается, когда на Convex **и** Vercel стоит `TWILIO_NUMBER=+1…`.
Подпись Twilio (`TWILIO_AUTH_TOKEN`) предпочтительнее query-secret.

Обязательно: Voice Geographic Permissions → Russia/Kazakhstan (+7)
low-risk. Иначе Twilio `21215`. Trial без апгрейда звонит только на
верифицированные номера — карта должна быть на аккаунте.

Один общий DID, не на пользователя. ~$1.15/мес + ~$0.34–0.43/мин на +7.

## Запасной путь: МТС Exolve callback

Если Twilio geo/карту режут — физлицо через Госуслуги, `MakeCallback`
на Inkbox inbound + клинику. Маршрут `exolve_callback`.

## Кабинет Twilio (сделать один раз)

1. https://www.twilio.com/try-twilio — почта, не РФ-карта
2. Billing → добавить иностранную карту (это снимает trial-лимит)
3. Прислать Account SID + Auth Token сюда. Bro сам:
   купит US Local, пропишет Voice URL на
   `https://frugal-dragon-943.convex.site/twilio-voice`,
   включит RU/KZ low-risk (`npm run twilio:setup`)
4. Либо руками: Phone Numbers → купить US Local Voice;
   Voice webhook POST на Convex URL; Console → Voice → Settings →
   Geo permissions → Russia/Kazakhstan (+7) → Low risk On

Не коммитить SID/token.
