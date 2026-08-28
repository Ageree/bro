# Bro звонит в РФ через Inkbox (hairpin)

_Date: 2026-08-28_

## Проблема

Inkbox Voice AI — правильный мозг (`place-call` + `hosted_agent` + `reason`).
Его PSTN — AWS Chime, номера только US `local`. `to_number=+7…` ловит
`destination_country_not_enabled` (D13), пока support не откроет страну.
Клинику в Москве всё равно лучше звонить с российского CLI.

## Решение

Inkbox **никогда не набирает +7**. Он набирает наш US DID (это всегда
разрешено). DID принадлежит Voximplant/Zadarma: входящий от номера Bro →
исходящий на настоящий +7 → мост медиа. Voice AI думает, что говорит с
мостом; в трубке — ресепшн клиники. `reason` на исходящем Inkbox — бриф
заявки.

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

## Не делаем

Retell/Vapi как ствол. Shared iMessage voice (это звонок пользователю Bro,
не в клинику). SIP URI в `to_number` (Inkbox принимает только E.164).

## Ops

Voximplant аккаунт `ageree` (11477486): приложение `bro-ru-bridge`
(id 59499143), сценарий `ru-hairpin` (3607805), правило `inbound-bridge`
(9330638, pattern `.*`). Convex `GET /call-bridge` живой на
`https://frugal-dragon-943.convex.site`. Inkbox `call.ended` подписан на
`https://bro-agent.vercel.app/webhooks/call`. Voice AI instructions
стоят на `@bro-ageree`.

Ещё не куплено (блокировки биллинга, не кода):
- Inkbox `POST /phone/numbers` → 402, план без PSTN. Апгрейд:
  https://inkbox.ai/console/organizations?tab=billing
- Voximplant баланс ≈8.6 ₽, US DID ≈157+157 ₽. Пополнить и купить
  US GEOGRAPHIC, привязать к `bro-ru-bridge`.

1. Купить US `local` PSTN в Inkbox (`INKBOX_PHONE_NUMBER`) и US DID
   у Voximplant (`BRO_RU_BRIDGE_E164`). RU CLI — `VOXIMPLANT_FROM_E164`
   в сценарии, не в Bro.
2. `BRO_INTERNAL_SECRET` на Convex deployment — без него
   `GET https://<deployment>.convex.site/call-bridge` отвечает 401.
3. Вставить `scripts/voximplant-ru-bridge.js` в Voximplant, повесить
   правило на входящие на мостовой DID.
4. `npm run webhooks` — отдельная identity-подписка `call.ended` на
   `/webhooks/call` (нельзя смешивать с `imessage.*`).
5. Если Inkbox support откроет RU: `BRO_INKBOX_RU_ENABLED=1` — тот же
   тул бьёт `to_number=+7…`, мост не нужен.

Квота Inkbox: 30 мин/номер/мес на Developer/Startup, $0.03/мин оверэйдж.
`hosted_agent` не крутит кастомные тулы mid-call; бриф — `reason` ≤2000.
41-ФЗ / 152-ФЗ для массовых звонков остаются на проде.
