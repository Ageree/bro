# Bro звонит в РФ через Inkbox (hairpin)

_Date: 2026-08-28_

## Проблема

Inkbox Voice AI — правильный мозг (`place-call` + `hosted_agent` + `reason`).
Его PSTN — AWS Chime. Живые пробы 2026-08-28: `+1` US/CA набираются,
`+7` и `+44` падают `502` upstream dial failed.
Клинику в Москве лучше звонить с любого рабочего CLI; pickup вторичен.

Voximplant отброшен: верификация RU-номера требует ЭЦП для ИП — слишком
долго. Код сценария оставлен в `scripts/voximplant-ru-bridge.js` как
архив. Купленный `+74992816046` деактивирован до 2026-09-11.

## Решение: Zadarma, не Voximplant

Inkbox **никогда не набирает +7**. Он набирает наш `+1` DID (US или CA)
у Zadarma. На `NOTIFY_START` Convex отвечает
`rewrite_forward_number` — PBX на лету подменяет форвард на настоящий
`+7`. Voice AI думает, что говорит с мостом; в трубке — ресепшн.

Почему Zadarma, а не Twilio/Telnyx:

- оплата в рублях, без иностранной карты;
- KYC — скан паспорта и адрес, **не ЭЦП**;
- входящие на купленный DID бесплатные;
- `NOTIFY_START` умеет `redirect` + `rewrite_forward_number` — тот же
  контракт, что был у Vox `GET /call-bridge`.

Цена last-mile: Standard ≈ **$0.33/мин** на RU mobile, **$0.22/мин**
город. Incoming US DID ≈ **$2/мес**. CLI будет американский, пока нет
отдельного RU DID (тот снова упрётся в документы, но не в ЭЦП).

```
человек в iMessage
  → phone_call
  → Convex callLegs (dest=+7495…, reason)
  → Inkbox place-call hosted_agent → +1 BRO_RU_BRIDGE_E164
  → Zadarma NOTIFY_START POST /zadarma-bridge
  → { redirect: "100", rewrite_forward_number: "7495…", return_timeout: 0 }
  → мост
  → Inkbox call.ended → [event:call] в тот же iMessage
```

Если Inkbox откроет RU (`BRO_INKBOX_RU_ENABLED=1`) — тот же тул бьёт
`to_number` напрямую, мост не нужен.

`decideCallRoute` режет hairpin, если `BRO_RU_BRIDGE_E164` сам `+7`.

## Не делаем

Retell/Vapi как ствол. Shared iMessage voice. SIP URI в `to_number`.
Ждать ЭЦП Voximplant.

## Live 2026-08-28

Inkbox `@bro-ageree`: dedicated PSTN `+15189183436` active, Voice AI
cedar / gpt-realtime-2. `+1` place-call ringing; `+7`/`+44` — 502.

Convex `frugal-dragon-943`:
- `GET /call-bridge` — старый Vox путь, пусть живёт
- `GET|POST /zadarma-bridge` — новый путь (`zd_echo` для проверки URL)
- `ZADARMA_API_SECRET` ещё не задан → POST отвечает 503, пока человек
  не заведёт кабинет

## Что сделать человеку (без ЭЦП)

1. Зарегистрироваться на https://zadarma.com тариф **Standard** ($0).
   Пополнить 500–1000 ₽.
2. Settings → Virtual phone numbers → US (NY или любой local) ≈ $2/мес.
   Загрузить паспорт + адрес. Активация — часы/дни, не недели ЭЦП.
3. Включить бесплатную ВАТС. На внутреннем `100` включить
   **безусловный форвард** на любой свой номер (заглушка). Bro его
   перепишет на клинику.
4. Settings → Integrations and API:
   - создать ключ, **secret** прислать / положить в
     `npx convex env set ZADARMA_API_SECRET …`
   - PBX call notifications URL:
     `https://frugal-dragon-943.convex.site/zadarma-bridge`
   - Enable.
5. Написать E.164 купленного `+1`. Bro проставит
   `BRO_RU_BRIDGE_E164` на Convex и Vercel и передеплоит eve.

Московский Vox `+74992816046` можно не верифицировать. Имеет смысл
выключить `auto_charge`, чтобы не сняли ещё 427 ₽.

Не покупать номер на каждого пользователя. Один shared Inkbox PSTN +
один shared Zadarma `+1`.

Квота Inkbox: 30 мин/орг/мес на Developer, $0.03/мин оверэйдж.
`hosted_agent` не крутит кастомные тулы mid-call; бриф — `reason` ≤2000.
41-ФЗ / 152-ФЗ для массовых звонков остаются на проде.
