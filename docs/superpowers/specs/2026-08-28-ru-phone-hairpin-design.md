# Bro звонит в РФ

_Date: 2026-08-28_

## Что отбросили

- **Voximplant:** RU DID, Caller ID и исходящие завязаны на верификацию
  личности / ЭЦП для ИП. Кабинет `ageree` есть, но без ЭЦП бесполезен.
  `+74992816046` — `auto_charge=off`.
- **Zadarma:** зарегистрироваться не вышло.
- Личный мобильный как CLI на Vox — кнопки нет, API `AddCallerID` = 104
  Forbidden.

## Что осталось без нового кабинета

Inkbox Developer уже есть, номер `+15189183436` живой, `+1` набирается.
`+7` пока `502`. Документация Inkbox: support включает destination
country (`D13` / `destination_country_not_enabled`).

Если откроют RU — `BRO_INKBOX_RU_ENABLED=1`, Bro бьёт клинику напрямую
с американским CLI. Мост не нужен. Pickup вторичен.

Письмо / A2A `@support`: включить outbound Russia для
`+15189183436` / `@bro-ageree`. hello@inkbox.ai
