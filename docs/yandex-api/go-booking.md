# Заказ Яндекс Go через API

`yandex_purchase` с `action: "book"` заказывает эконом сразу, без вопроса:
так решил владелец (11.10). Инструмент есть только в ходе, который открыло
сообщение человека, как у `phone-call`. `cancel` отменяет текущую поездку по
просьбе человека; где машина и сколько ехать — `yandex` `go.ride`.

## Протокол (`agent/lib/yandex/go/booking.ts`)

Всё в одной вкладке `taxi.yandex.ru/robots.txt`, запросами самой страницы:

1. `/3.0/launch` — текущие заказы (`orders`; история заказов показывает поездку
   лишь после конца). Если заказ есть, второй не создаётся: ответ
   `already_active` с этой поездкой (`taxiontheway`: статус, маршрут, цена).
2. Место: текст → `/4.0/persuggest/v1/suggest` → `position`;
   `/4.0/persuggest/v1/finalsuggest` (`pin_drop`) даёт объект адреса для маршрута.
3. Оплата: `cash`, `card` (подтверждённая карта из `/3.0/paymentmethods`) или
   `current` — выбранная в Go (IndexedDB `persist:payment-methods`); с `card`
   и `cardLast4` — карта, которую назвал человек (иначе `card_not_found`). Нет
   подтверждённой — `no_verified_card` с `unverifiedCardId` (выбранная в Go
   или первая из `unverified_cards`).
4. `/3.0/routestats` — фиксированная цена эконома (`max_price_as_decimal`) и
   `offer`; выше `maxPriceRub` — `over_limit`, без заказа.
5. `/external/3.0/orderdraft` → `orderid`. Отказ черновика — ничего не заказано.
6. `/external/3.0/ordercommit` → `status` (`search`…). На 202 сайт шлёт коммит
   снова, мы тоже (до трёх раз); без ответа — `unknown` с `orderId`.

Заказ другому человеку (кнопка сайта «Заказ другому человеку», 23.10; внутри покупок Яндекса всем —
владелец; `YANDEX_GO_PASSENGER_WORKSPACES=off` — откат, список id — только им): `passengerPhone` и
`passengerName` уходят в черновик полями сайта `extra_contact_phone` (номер, как форма сайта его
хранит: только цифры и `+`) и `extra_passenger_name`. Яндекс сообщает пассажиру о машине и водителе (пушем в
его Go, иначе SMS); поездка остаётся в аккаунте человека и на его оплате. Тариф может
отказать: `order_for_other_prohibited: true` у уровня `routestats` — тогда `order_for_other_unavailable`
без черновика (сайт пишет «Заказ другому недоступен»). Поля взяты из бандла веб-клиента
(`txf-turboapp-taxi` 4.145.1, модуль сборки `orderdraft`). Проверено вживую 23.10 (заказ брату
владельца, отменён): `taxiontheway` заказа отдаёт `extra_contact_phone` пассажира; пассажиру с
приложением Go пришёл пуш «Вам заказали такси, его оплатит заказчик…» со ссылкой на карту; у
заказчика поездка в его Go с пометкой «Заказ другому — Пришлём уведомление ему в приложение».
SMS о заказе с сайта («Вам оплатили такси», «Водитель на месте») Яндекс всё равно шлёт и на
телефон аккаунта: так было и без пассажира. `dont_sms` черновика это, возможно, глушит, но и
пассажиру тоже — не проверяли.
`yandex_purchase` берёт номер пассажира, только если человек написал его в разговоре или он есть в
записной книжке Бро (`ridePassenger`): модель заполняет каждое необязательное поле, а выдуманный
номер отправил бы чужому SMS о поездке. При `off` полей пассажира в схеме `yandex_purchase` нет:
схема и описание инструмента байт в байт прежние. Номер самого человека (его телефоны в Бро или
номера аккаунта из `launch`: `phone`, `phones`) — его собственная поездка, без пассажира.

Своя поездка человека (24.10, `YANDEX_GO_OWN_RIDE_WORKSPACES`, id или `*`; с 25.10 в проде `*`): у заказов из
приложения Go в `taxiontheway` стоит `dont_sms: true`, а черновик сайта шлёт `dont_sms: false` —
и Яндекс писал человеку SMS «Вам оплатили такси» со ссылкой на страницу, где точку подачи не
поменять; человек принимал это за заказ от кого-то другого и перезаказывал из приложения
(24.10: эконом Бро отменён, через 5 минут Комфорт из приложения с того же места). В пилоте
черновик своей поездки идёт с `dont_sms: true`, поездки пассажиру — как прежде. Сайт ещё шлёт
заголовок `X-Personal-Phone-Id` (`personal_phone_id` из `launch`) на `routestats` и
`orderdraft`; мы его не шлём, а `phone_id` заказа и так номер аккаунта.

Отмена: заказ из `launch`, затем `/3.0/taxiontheway`; если `cancel_disabled` — нельзя,
иначе тот же запрос с `break: "user"` → `status: "cancelled"`.

Проверено вживую 11.10 пробой (`scripts/cloudru-app-host/yandex-probe.py`):
наличные, дом → м. Раменки, 415 ₽, `search`, затем `cancelled` до назначения машины;
заказ в поиске виден в `launch.orders`, а в истории — нет. Через чат Бро
`book` занял 4,6 с. Поля машины в `taxiontheway` (`driver`) после назначения не
проверены вживую: заказ отменяли раньше.

## Проверка карты банком (`agent/lib/yandex/go/card.ts`)

Go держит привязанную карту в `unverified_cards` (`verify_strategy:
card_antifraud`), пока банк её не подтвердил; проверка общая для сервисов
Яндекса. На `no_verified_card` `yandex_purchase` зовёт `go.card_verify`: со
страницы Go `POST https://trust.yandex.ru/web/create_verification_intent?service_token=<trustToken Go>`
с телом `{currency, binding_id, form_params: {integrationProfileId, mode:
"default", flow: "card", type: "verification", query_params: {theme, lang,
layout}}}` (как `verifyPaymentMethodV2` веб-SDK Trust) → 201 и `form_url`
`https://trust.yandex.ru/web/binding?…verification_intent_id=…`. Ссылку
человек получает один раз за разговор (повтор `book` в течение 10 минут даёт
ту же) и открывает сам; Бро её не открывает.
