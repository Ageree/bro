# Bro звонит в РФ без нового кабинета

_Date: 2026-08-28_

## Почему не Vox RU DID / не Zadarma

- Voximplant RU-номер требует ЭЦП для ИП — слишком долго.
- Zadarma: с аккаунтом не получилось зарегистрироваться.
- Twilio/Exolve — ещё одна регистрация плюс карта/договор.

Кабинет Voximplant `ageree` уже есть. Покупать номер не надо.

## Решение: verified Caller ID + StartScenarios

Inkbox по-прежнему не набирает `+7`. Voximplant сам звонит на
`INKBOX_PHONE_NUMBER` (inbound `hosted_agent`) и на клинику, CLI —
подтверждённый личный мобильный (звонок с кодом, не ЭЦП).

```
iMessage → phone_call
  → Convex callLegs
  → PUT hosted-agent-config (reason на inbound)
  → Vox StartScenarios rule outbound-callback
       callPSTN(Inkbox +1518…, cli=+7личный)
       on Connected: callPSTN(клиника, cli=+7личный)
  → Inkbox call.ended → [event:call]
```

Live: app `bro-ru-bridge` (59499143), scenario `ru-callback` (3608292),
rule `outbound-callback` (9331615). Скрипт:
`scripts/voximplant-ru-callback.js`.

`VOXIMPLANT_FROM_E164` ещё не задан — человек должен подтвердить свой
мобильный в
https://manage.voximplant.com/settings/caller_ids
и прислать E.164.

Московский `+74992816046` не нужен, `auto_charge` выключен.
`POST /zadarma-bridge` живой, но не используется.
