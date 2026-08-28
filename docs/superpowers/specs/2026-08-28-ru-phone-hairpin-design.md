# Bro звонит в РФ через Inkbox (hairpin)

_Date: 2026-08-28_

## Проблема

Inkbox Voice AI — правильный мозг (`place-call` + `hosted_agent` + `reason`).
Его PSTN — AWS Chime. Живые пробы 2026-08-28: `+1` US/CA набираются,
`+7` и `+44` падают `502` upstream dial failed (не D13 — тот был бы 422).
Клинику в Москве всё равно лучше звонить с российского CLI.

## Решение

Inkbox **никогда не набирает +7**. Он набирает наш `+1` DID (US или CA).
DID принадлежит Voximplant: входящий от номера Bro → исходящий на
настоящий +7 → мост медиа. Voice AI думает, что говорит с мостом; в
трубке — ресепшн клиники. `reason` на исходящем Inkbox — бриф заявки.

```
человек в iMessage
  → phone_call
  → Convex callLegs (dest=+7495…, reason)
  → Inkbox place-call hosted_agent → +1 BRO_RU_BRIDGE_E164
  → Voximplant: GET /call-bridge?from=+1inkbox → dest
  → Voximplant callPSTN(+7495…) с RU CLI
  → мост
  → Inkbox call.ended → [event:call] в тот же iMessage
```

Если Inkbox откроет RU (`BRO_INKBOX_RU_ENABLED=1`) — тот же тул бьёт
`to_number` напрямую, мост не нужен.

`decideCallRoute` режет hairpin, если `BRO_RU_BRIDGE_E164` сам `+7`:
это CLI, не dest, который Inkbox умеет набрать.

## Не делаем

Retell/Vapi как ствол. Shared iMessage voice (это звонок пользователю Bro,
не в клинику). SIP URI в `to_number` (Inkbox принимает только E.164).

## Live 2026-08-28

Inkbox `@bro-ageree` (`d051f194-1bd9-405b-b6fe-2b3544caec58`):
- Developer plan, dedicated PSTN `+15189183436` (NY local, active,
  `incoming_call_action=hosted_agent`, SMS ещё `pending`)
- `call.ended` → `https://bro-agent.vercel.app/webhooks/call`
- Voice AI: cedar / gpt-realtime-2, инструкции на русском
- Probe: NIST `+13034997111` → 200 ringing, hangup local, не ответили
- Probe: Toronto `+14163922489` → 200 ringing (значит CA `+1` тоже ок)
- Probe: `+74992816046`, `+79001234567`, `+447418353977` → 502

Voximplant `ageree` (11477486), баланс ≈281.60 RUR после покупки:
- app `bro-ru-bridge` (59499143), scenario `ru-hairpin` (3607805,
  CLI live `+74992816046`), rule `inbound-bridge` (9330638)
- куплен Moscow 499 `+74992816046` (phone_id 9051), 427 ₽/мес,
  bound to `bro-ru-bridge` / `inbound-bridge`
- `can_be_used: false`, `verification_status: REQUIRED`,
  `activation_status: DEACTIVATED`, hold до 2026-09-11
- regulation address пустой — без верификации номер мёртв
- US GEOGRAPHIC/MOBILE/TOLLFREE stock = 0 (по штатам тоже пусто)
- GB MOBILE есть (~157+157 ₽), но Inkbox `+44` не набирает
- CA MOBILE мелькал, list/regulations недоступны (529/581)

Convex `frugal-dragon-943`: `INKBOX_PHONE_NUMBER=+15189183436`,
`BRO_RU_BRIDGE_E164=+74992816046` (сейчас это CLI, hairpin заблокирован
политикой), `BRO_INTERNAL_SECRET` стоит. `GET /call-bridge` —
401 без секрета, 404 `no pending` с секретом.

Vercel `bro-agent`: те же `INKBOX_*` / `BRO_RU_BRIDGE_E164`, redeploy
`dpl_2xjyKsP7pZcgizUrXR5jzsMeXyQZ` READY.

## Ещё нужно человеку

1. Верификация RU в кабинете Voximplant (документы / regulation
   address), иначе `+74992816046` снимут после 2026-09-11.
   https://manage.voximplant.com/
2. `+1` DID у Voximplant как настоящий `BRO_RU_BRIDGE_E164`. US сейчас
   нет в наличии. Когда появится: ≈157+157 ₽, на балансе 281 — не хватает
   ~33 ₽, плюс привязать к `bro-ru-bridge`.
3. Либо Inkbox support открывает destination RU — тогда
   `BRO_INKBOX_RU_ENABLED=1` и мост не нужен (CLI будет американский).

Не покупать номер на каждого пользователя. Один shared Inkbox PSTN +
один shared Vox bridge + один RU CLI.

Квота Inkbox: 30 мин/орг/мес на Developer, $0.03/мин оверэйдж.
`hosted_agent` не крутит кастомные тулы mid-call; бриф — `reason` ≤2000.
41-ФЗ / 152-ФЗ для массовых звонков остаются на проде.
