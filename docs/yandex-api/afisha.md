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
декабрь»); точный список сеансов — отдельным запросом `eventSchedule`/`actualEvents(dates:{date,period})`
(не включён). Фильтр по дате поиск `search` не принимает; для «что на выходных» — `actualEvents`
(`dates:{date:"2026-10-10",period:7}, paging:{limit,offset}, sort:rank`, элемент `ActualEvent.event` — `EventPreview`
с `title`, `url`, `tickets`), его поля сняты из состояния страницы, но отдельным запросом не прогонялись.

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

## Не удалось / что отдать `browser_task`

- Покупка билетов и выбор мест (виджет `widgetUrl`, корзина `cart`, оплата) — через `browser_task` с «да» человека.
- Расписание сеансов конкретного события (`eventSchedule`) не снималось.
- Наполненный заказ вживую не видели (см. выше).
- Страница тяжёлая: на холодном старте вкладки ждать до ≈ 9 с до первого запроса; запросы к `/api/graphql` идут с
  любой страницы домена (проверено на `/moscow`; другие не пробовали).
