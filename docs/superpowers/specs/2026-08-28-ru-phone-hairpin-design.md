# Bro звонит в РФ

_Date: 2026-08-30_

## Что отбросили

- **Voximplant:** RU DID, Caller ID и исходящие завязаны на верификацию
  личности / ЭЦП для ИП. Кабинет `ageree` есть, но без ЭЦП бесполезен.
  `+74992816046` — `auto_charge=off`.
- **Zadarma:** зарегистрироваться не вышло.
- Личный мобильный как CLI на Vox — кнопки нет, API `AddCallerID` = 104
  Forbidden.

## Живой путь: МТС Exolve callback + Inkbox Voice AI

Inkbox **не** набирает `+7` (live `502`). Мозг остаётся Inkbox
`hosted_agent`. Последняя миля — Exolve `MakeCallback`:

1. Bro пишет brief в `PUT /phone/hosted-agent-config`
2. Convex `exolve.startCallback` → `POST /call/v1/MakeCallback`
3. Exolve звонит на Inkbox `+15189183436` (line_1), Voice AI берёт трубку
4. Exolve звонит в клинику `+7` (line_2), CLI = российский DID Exolve
5. `call.ended` → `[event:call]`

Маршрут `exolve_callback` включается, когда на Convex **и** Vercel стоят
`EXOLVE_API_KEY`, `EXOLVE_NUMBER`, `EXOLVE_CALLBACK_RESOURCE_ID`.

Физлицо: договор через **Госуслуги**, без КриптоПро / ЭЦП ИП.
Callback у физлиц «будет ограничено» — для Bro этого хватает.
SIP ID физлицам недоступен — не нужен.

Запасной `+1` hairpin: `TWILIO_NUMBER` / `BRO_RU_BRIDGE_E164` +
`POST /twilio-voice?secret=`. Inkbox умеет набирать `+1`. Нужна
иностранная карта.

Если Inkbox support откроет Russia — `BRO_INKBOX_RU_ENABLED=1`, мост
не нужен (американский CLI).

## Кабинет Exolve (сделать один раз)

1. https://exolve.ru — регистрация email или МТС ID
2. «Получить полный доступ» → правовая форма **Физлицо** →
   «Онлайн, через Госуслуги» → заполнить → дождаться проверки
   (обычно ≤1 рабочий день) → подписать одним кликом
3. Пополнить баланс (тестовые 300 ₽ сгорят после договора)
4. Создать приложение, скопировать API-ключ
5. Купить **один** городской или мобильный номер РФ
6. Прислать ключ + E.164 номера сюда. Ресурс callback Bro создаст
   сам: `npm run exolve:setup`

Не коммитить ключ. Не покупать номер на каждого пользователя —
один общий DID.
