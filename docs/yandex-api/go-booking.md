# Заказ Яндекс Go через API

`yandex_purchase` с `action: "book"` заказывает эконом сразу, без вопроса:
так решил владелец (11.10). Инструмент есть только в ходе, который открыло
сообщение человека, как у `phone-call`. `cancel` отменяет текущую поездку по
просьбе человека; где машина и сколько ехать — `yandex` `go.ride`.

## Протокол (`agent/lib/yandex/go/booking.ts`)

Всё в одной вкладке `taxi.yandex.ru/robots.txt`, запросами самой страницы:

1. `/4.0/orderhistory/v2/list` — если есть заказ с `is_active`, второй не
   создаётся: ответ `already_active` с этой поездкой.
2. Место: текст → `/4.0/persuggest/v1/suggest` → `position`;
   `/4.0/persuggest/v1/finalsuggest` (`pin_drop`) даёт объект адреса для маршрута.
3. Оплата: `cash`, `card` (подтверждённая карта из `/3.0/paymentmethods`) или
   `current` — выбранная в Go (IndexedDB `persist:payment-methods`).
4. `/3.0/routestats` — фиксированная цена эконома (`max_price_as_decimal`) и
   `offer`; выше `maxPriceRub` — `over_limit`, без заказа.
5. `/external/3.0/orderdraft` → `orderid`. Отказ черновика — ничего не заказано.
6. `/external/3.0/ordercommit` → `status` (`search`…). На 202 сайт шлёт коммит
   снова, мы тоже (до трёх раз); без ответа — `unknown` с `orderId`.

Отмена: `/3.0/taxiontheway` текущего заказа; если `cancel_disabled` — нельзя,
иначе тот же запрос с `break: "user"` → `status: "cancelled"`.

Проверено вживую 11.10 пробой (`scripts/cloudru-app-host/yandex-probe.py`):
наличные, дом → м. Раменки, 415 ₽, `search`, затем `cancelled` до назначения машины.
