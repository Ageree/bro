# Яндекс Афиша: разведка веб-API (10.10.2026)

Спецификация для кода операций `afisha.search` и `afisha.tickets` инструмента `yandex`. Сняты
запросы `afisha.yandex.ru` из браузера пула Бро, вошедшего в аккаунт владельца (только чтение).
Фикстуры — `tests/fixtures/yandex/afisha/*.json`, значения выдуманы.

## Общее

|                           |                                                                              |
| ------------------------- | ---------------------------------------------------------------------------- |
| origin вкладки            | `https://afisha.yandex.ru/moscow` (любой город: `/<город>`)                  |
| загрузка (`cdp.py check`) | ≈ 4,4–9,3 с (тяжёлая, 1,4 МБ HTML) — это самый долгий старт из трёх сервисов |
| «не вошёл»                | `signedIn: false` в `check`; `userProfile` в `__APOLLO_STATE__` пуст         |
| капча                     | не встретилась                                                               |

### Защита

Токенов и подписи **нет**: фронтенд ходит на единственный GraphQL-эндпоинт
`POST /api/graphql?city=<город>&version=<сборка>&query_name=<ИмяЗапроса>` с телом
`{"operationName":…,"variables":…,"query":"<текст запроса>"}`, заголовки `content-type: application/json`
и `x-force-cors-preflight: 1`. Авторизация — cookies вкладки. Текст запроса сервер принимает любой
(persisted queries не используются), **интроспекция включена**: `{ __type(name:"Order"){ fields { name } } }`.
Поэтому операции пишут свои короткие запросы, а не копируют страничные фрагменты на 3 КБ.
`version=604.1.0` — номер фронтенд-сборки (`afisha-frontend/static/604/604.1`); брать из URL любого запроса
страницы (`performance.getEntriesByType("resource")`). Принимает ли сервер устаревшее значение — не проверялось.

Перечисления GraphQL пишутся **без кавычек** (`filterByDeviceType: web`, `filterByTypes: [event]`,
`groupBy: groupCode`); строка в кавычках даёт `Validation error (WrongType…)` (фикстура
`error-validation.json`, HTTP 200 с `errors`). Деньги — **копейки** целым числом
(`TicketPrice.value`, `OrderPrice.value`: 160000 = 1600 ₽).

## afisha.search — события по запросу, городу и дате

**Зачем:** «что сходить на джаз в Москве»; чтение.

**Запрос:** GraphQL `search(text, groups, docs, page, filterByDeviceType, filterByTypes, groupBy)`; группы —
рубрики (концерты, театр, …), документы — события. Выбираем `SearchObjectEvent`: `id url title placeTitle
minPrice{value} datePreview{text} type{name} tickets{saleStatus}`. Город — параметр `city` в URL
(`moscow`, `saint-petersburg`, …). Даты: `datePreview.text` — готовая строка («15 окт», «Октябрь —
декабрь»); сеансы и зоны зала — операция `afisha.prices` ниже. Фильтра по дате и
рубрике `search` не принимает: «концерты на следующей неделе», «кино в выходные» — режим `actualEvents` ниже.

### Рубрика и дни — `actualEvents` (снят вживую 21.10.2026, без cookies)

Операция включает этот режим, когда заданы `category`, `from`/`to` или нет ни слов, ни рубрики
(`BroListing` в `agent/lib/yandex/afisha/search.ts`; с сервера — `direct.ts`, 0,5–0,7 с):

```text
query BroListing($search: String, $tags: [String], $dates: DaysIntervalInput, $paging: PagingInput!) {
  actualEvents(search: $search, tags: $tags, dates: $dates, paging: $paging, sort: rank) {
    items { event { id url title type { name } tickets(dates: $dates) { minPrice { value } saleStatus } }
            scheduleInfo { placePreview preview { text } } } } }
variables: {"dates":{"date":"2026-10-26","period":7},"tags":["concert"],"search":null,"paging":{"limit":10,"offset":0}}
```

- `dates: {date, period}` — первый день `YYYY-MM-DD` и **число дней, включая первый** (`2026-10-26`+7 — по 1 ноября).
  Календарные дни города, часовой пояс не нужен. Невозможная дата (`2026-02-30`) — `Validation error`; `period`
  ≤ 0 или прошлое — пустой список без ошибки; 365 принимает. Пресеты сайта — `datePresets` (`weekend`: суббота, 2 дня).
- `tags: ["concert"]` — рубрика, коды меню города (`cityInfo(id){ eventsMenu { code name } }`, во всех городах одни):
  `concert`, `theatre`, `kids`, `sport`, `standup`, `circus_show`, `cinema`, `art`, `excursions`, `show`, `quest`,
  `musical`, `lectures`, `masterclass`, `attractions`, `ny_matinee`, `pushkin-card`, `discount-event`, `certificates`.
  Неизвестный код — пустой список без ошибки. `tags: []`/`null` — без рубрики. Даёт тот же набор, что
  `rubricEvents(tag)` (проверено: 478 концертов недели).
- `search` — **по заголовкам**, слова через И: слово-рубрика «концерт» находит только названия со словом «концерт» (6 за
  неделю при 478 концертах в рубрике), «концерты» — 0, «рок концерт» — 0. Поэтому рубрику задаёт `tags`, а не текст. `""` — без фильтра. Если с `tags`/`dates` слова ничего не нашли,
  операция один раз повторяет запрос с `search: null` и помечает ответ `queryDropped` (слова).
- `preview.text` слова для запрошенных дней («24 и 25 октября», «сб 24 окт, 19:00»), у `search` — для всех дат;
  у кино `null` или «Премьера», `placePreview` — «в 65 кинотеатрах». `tickets` — не больше одного элемента, `[]`
  у события без продажи; `tickets(dates:)` даёт цену тех дней (Пенкин: 3000 ₽ в субботу, 2800 ₽ в пятницу). `sort: rank` — популярные первыми.
- Интроспекция: `ActualEvent{event: EventPreview, scheduleInfo: EventScheduleInfo, rank}`, `EventScheduleInfo.dates` —
  все будущие даты события, а не только окно: для окна берите `preview`.

**JS:**

```js
const args = { query: "джаз", city: "moscow", limit: 10 };
const gql = async (name, query, variables) => {
  const r = await fetch(
    "/api/graphql?city=" +
      (args.city || "moscow") +
      "&version=604.1.0&query_name=" +
      name,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-force-cors-preflight": "1",
      },
      body: JSON.stringify({ operationName: name, variables, query }),
    }
  );
  if (r.status !== 200) return { error: "http_" + r.status };
  const j = await r.json();
  return j.errors
    ? { error: "gql", message: String(j.errors[0].message).slice(0, 120) }
    : j.data;
};
const d = await gql(
  "BroSearch",
  `query BroSearch($text: String!, $docs: Int!) {
  search(text: $text, groups: 5, docs: $docs, page: 0, filterByDeviceType: web, filterByTypes: [event], groupBy: groupCode) {
    groups { code title documentsTotal documents { object { __typename ... on SearchObjectEvent { id url title placeTitle minPrice { value } datePreview { text } type { name } tickets { saleStatus } } } } }
  } }`,
  { text: args.query, docs: args.limit }
);
if (d.error) return d;
const events = [];
for (const g of d.search.groups)
  for (const x of g.documents) {
    const o = x.object;
    if (o.__typename !== "SearchObjectEvent") continue;
    events.push({
      id: o.id,
      title: o.title,
      kind: o.type ? o.type.name : g.title,
      venue: o.placeTitle,
      when: o.datePreview ? o.datePreview.text : null,
      minPrice: o.minPrice ? o.minPrice.value / 100 : null,
      sale: o.tickets && o.tickets[0] ? o.tickets[0].saleStatus : null,
      url: "https://afisha.yandex.ru" + o.url,
    });
  }
return { events: events.slice(0, args.limit) };
```

**Ответ (ужатый):** `{events: [{id, title, kind (тип: «Театр», «Концерт»), venue: string|null («в 3 местах» —
несколько площадок), when: string|null, minPrice: number|null (₽), sale: string|null («available»), url}]}`, ≤ 10.
Фикстура — `search.json` (сырой ответ; код пропускает документы не-события).
**Сбои:** ошибка запроса — HTTP 200 + `errors` → `{error:"gql", message}`; не 200 → `http_<код>`; пусто —
`events: []`.
**Замер:** 3549 / 1040 / 3217 → медиана **3217 мс** (сильный разброс 1–6 с, у сервера).
**Устойчивость:** `version` в URL; имена полей и перечислений проверять интроспекцией (`SearchObjectEvent`,
`SearchGroupingFields`, `SearchObjectTypes`, `DeviceType`). Если `search` отклоняет аргумент, посмотреть
ключ `search({…})` в `window.__APOLLO_STATE__.ROOT_QUERY` на странице `/search?search-text=…&city=…` —
там записаны настоящие аргументы страницы.

## afisha.tickets — мои билеты и заказы

**Зачем:** «какие билеты я уже купил»; чтение.

**Запрос:** GraphQL `orders(paging:{limit,offset}, sort: sessionDate)` → `OrderList{items, paging}`; REST-дубль
страницы `/orders` — `GET /api/orders?limit=8&offset=0&city=moscow` → `{"paging":{"limit","offset","total"},"items":[…]}`.
Поля `Order` (интроспекция): `id orderNumber dateTime passed ticketsCount hall total{value} event{title}
place{title address} tickets{row place level category}` и многие другие (`orderPdf`, `orderQrCode`,
`widgetUrl` — ссылки на файлы билетов, **не берём**).

**JS:**

```js
const args = { limit: 10, offset: 0 };
const r = await fetch(
  "/api/graphql?city=moscow&version=604.1.0&query_name=BroOrders",
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-force-cors-preflight": "1",
    },
    body: JSON.stringify({
      operationName: "BroOrders",
      variables: {},
      query: `query BroOrders {
  orders(paging: { limit: ${args.limit}, offset: ${args.offset} }, sort: sessionDate) {
    paging { total }
    items { id orderNumber dateTime passed ticketsCount hall total { value } event { title } place { title address } tickets { row place level category } }
  } }`,
    }),
  }
);
if (r.status !== 200) return { error: "http_" + r.status };
const j = await r.json();
if (j.errors)
  return { error: "gql", message: String(j.errors[0].message).slice(0, 160) };
const o = j.data.orders;
return {
  total: o.paging ? o.paging.total : null,
  orders: o.items.slice(0, args.limit).map((x) => ({
    id: x.id,
    number: x.orderNumber,
    event: x.event ? x.event.title : null,
    venue: x.place ? x.place.title : x.hall,
    address: x.place ? x.place.address : null,
    when: x.dateTime,
    passed: x.passed,
    tickets: x.ticketsCount,
    total: x.total ? x.total.value / 100 : null,
    seats: (x.tickets || []).map((t) =>
      [t.level, t.row && "ряд " + t.row, t.place && "место " + t.place]
        .filter(Boolean)
        .join(", ")
    ),
  })),
};
```

**Ответ (ужатый):** `{total: number, orders: [{id, number, event, venue, address, when (ISO), passed: boolean,
tickets: number, total: number (₽), seats: string[]}]}`. Фикстуры: `orders.json` (**синтетическая по схеме,
вживую не наблюдалась**), `orders-empty.json` (настоящая форма пустого ответа).
**Важно:** у аккаунта владельца заказов в Афише **нет** (`total: 0`, и в GraphQL, и в REST), поэтому
наполненный ответ и значения `passed`/`saleCancelStatus` вживую не видны; запрос проходит валидацию схемы
(без `errors`), поля взяты из интроспекции. Исполнитель должен написать разбор по фикстуре `orders.json` и
не падать на `null` в любом поле.
**Замер:** 4351 / 3392 / 1335 → медиана **3392 мс**.
**Устойчивость:** как у search; значения перечислений `OrdersSort`: `dateCreated, orderStatus, sessionDate, sessionDateAsc`.

## afisha.prices — сеансы события и зоны зала (снято вживую 22.10.2026, без входа)

**Зачем:** «какие есть билеты на …», «возьми два по 4 200» — до браузера. 22.10 браузер искал места по
4 200 ₽ в зоне без мест («VIP-входной (свободная рассадка)» в «Графите»), не нашёл и сказал, что такую цену
не купить; зона без мест берётся количеством, а не местом.

**Сеансы** — GraphQL Афиши, тот же публичный эндпоинт, что у `search`:

```text
query BroSessions($id: ID!, $dates: DaysIntervalInput) { eventScheduleOtherByDate(id: $id, dates: $dates) {
  sessions { place { title address } session { datetime ticket { id widgetUrl saleStatus minPrice { value } maxPrice { value } } } } } }
```

`id` — id события из `afisha.search` (24 hex). Без `dates` ответ пустой: без дня операция берёт сегодня по Москве
и 180 дней. `ticket.id` — ключ сеанса в виджете (base64 `venueId|ticketsEventId|hallId|ms`), `widgetUrl` —
`https://widget.afisha.yandex.ru/w/sessions/<ключ>`.

**Зоны** — план зала виджета `widget.afisha.yandex.ru` (Яндекс Билеты), с сервера, без браузера и cookies человека:

1. `GET /robots.txt` виджета — анонимные cookies посетителя. План принимает `yandexuid` только вместе с
   подписанной `i`; одна `yandexuid` даёт `400 ANTIBOT_TOKEN_MISMATCH` (сервер выдаёт новый uid).
2. `POST /api/antibot/check {"sessionKey": "<ключ>"}` с этими cookies → `{jwt, captchaRequired: false}`; токен
   привязан к `yandexuid`. `captchaRequired: true` — зоны не читаем (нужен браузер).
3. `GET /api/tickets/v4/sessions/<ключ>/hallplan` с cookies и `X-Antibot-Token` → `{"status":"running"}`, через
   ~1 с `{"status":"completed","url":"https://….svc.cdn.yandex.net/hallplans/<sha>"}`. Без токена —
   `400 MISSING_ANTIBOT_TOKEN`; `clientKey` и CSRF не нужны.
4. `GET <url>` (gzip, `content-encoding`) → `{status, result: {saleStatus, hallplanDisplayType, hallplan}}`.

`hallplan.levels[]` — зоны: `name`, `admission` (**true — без мест, по количеству**), `availableSeatCount`,
`prices[]`, `categories[{id, name}]`; `hallplan.categories[]` — `priceInfos[{price, fee, total}]` и
`priceChanges[{startDate, priceInfo}]` (объявленное подорожание: «через 10 дней цена вырастет до 4500 ₽»);
`maxTicketsCount` — билетов в заказе; `settings.hideAdmissionAvailableSeatsCount` — сайт прячет остаток зон без
мест (операция отдаёт `left: null`). Имена категорий бывают с кириллицей вместо латиницы («VIР lоungе»), имя
зоны — нормальное. Сеанс с местами в театре — одна категория на зону и десятки цен по рядам.

**Ответ:** `{more, sessions: [{when, venue, address, sale, link, minPrice, maxPrice, maxTickets, zones, zonesMore}]}`,
до 8 сеансов, зоны — у первых трёх в продаже; `zones[]`: `{zone, ticket, seats, prices: [{price, withFee}], left, rise}`,
`seats` — «picked on the hall map» или «none: bought by count, no seat to pick»; у зоны больше 8 цен — 7 дешёвых и
самая дорогая. Больше 40 зон (секторы стадиона) — все зоны без мест и самые дешёвые с местами, остаток в `zonesMore`.
Весь виджет — за 9 с на вызов; отказ (403/429/5xx) или зависание — 10 минут виджет не спрашиваем, сеансы идут без зон. Через вкладку (сервер отказал)
— те же сеансы с `zones: null`: виджет на другом origin и без CORS. Код — `agent/lib/yandex/afisha/prices.ts`,
`hall.ts`, `direct.ts`.
**Замер (из облачной сессии через прокси):** «Свидание» 5,3–6,6 с, театр с тремя сеансами 5,6–11 с; на VM
прода не мерили.

## Покупка зоны без мест — `yandex_purchase` (22.10.2026, пилот)

В пилоте `YANDEX_AFISHA_PURCHASE_WORKSPACES` билеты зоны без мест покупаются запросами самого виджета из вкладки
человека, привязанной картой: `agent/lib/yandex/afisha/checkout.ts`, поток и гарантии — `docs/yandex-api/purchases.md`
(«Афиша»). Запросы виджета 608.0 (пробы 22.10 и код бандла):

- Страница сеанса `GET /w/sessions/<ключ>` рендерит в `window['__config']` `X-CSRF-Token`, `X-Yandex-Uid`,
  `X-Request-Id` и `clientKey.id`; виджет шлёт их и `timeout`, `x-force-cors-preflight: 1` в каждом запросе.
- `GET /api/user` — контакты `{fullName, email, phone}` как `{value}`; `GET /api/tickets/v1/sessions/<ключ>?clientKey=`
  — `saleStatus`, `maxTicketsCount`, требования к данным покупателя; `GET /api/session/<ключ>` — `cart.cart.cartId`
  (`puid_<uid>_sessionkey_<ключ>`, один на человека и сеанс).
- `POST /api/session-order-preview/` (`X-Tickets-Client: <clientKey>`, `X-Antibot-Token`) и опрос
  `GET /api/session-order-preview/<id>` → `orderPreviewResult` (`SUCCESS` или `DONE`): `paymentVariants` с привязанными
  картами (`card-…`, `pspPaymentMethodId`), `boundPaymentMethod`, `priceInfo.total.preview`. Контакты — строками:
  объект вместо строки дал HTML 404. Предпросмотр ничего не держит (`reserveTimer` 0).
- `POST /api/tickets/v2/orders/create` (`X-Antibot-Token`, `timeout: 10000`) — тело как у виджета: `order_preview_id`,
  `cart_id`, `payment_way: "bound-card"`, `quick_purchase_card_id`, `psp_payment_method_id`, `personal_data`,
  `items[]` с числовыми `category_id`, `ext_session_id`, `level_id`. Ответ — `result.order.id` вида `<число>@<uuid>`.
- `GET /api/tickets/v2/orders/<id>/operation/{reserve,pay,sale-approve}?clientKey=` → `{status, statusCode,
redirectUrl3ds, purchaseToken}` (`redirectUrl3ds` первые минуту-две — форма `/web/payment`, потом `/web/open_3ds` —
  проверка банка; человек получает `open_3ds` по `purchaseToken` сразу; провал — `statusCode: fail-3ds`);
  `GET /api/tickets/v2/orders/<id>?clientKey=` — `amountToPay`, `paymentForm.targetUrl` (форма оплаты Trust
  `/web/payment`: открытая отдельно, она показала ошибку). `@` в id — `%40`.

## Не удалось / что отдать `browser_task`

- Выбор мест на схеме и покупка вне пилота (виджет `widgetUrl`, оплата) — через `browser_task` с «да» человека;
  зону без мест браузер берёт количеством (`eventTicketLine` в `agent/tools/browser_task.ts`). Корзина виджета —
  `POST /api/cart/<id>/update` с `admission`, `category_id`, `level_id` (в бандле `widget.js`) — не пробовали.
- Наполненный заказ вживую не видели (см. выше).
- Страница тяжёлая: на холодном старте вкладки ждать до ≈ 9 с до первого запроса; запросы к `/api/graphql` идут с
  любой страницы домена (проверено на `/moscow`; другие не пробовали).
