# Яндекс Еда и Лавка: разведка веб-API (10.10.2026)

Спецификация для кода операций `food.*` инструмента `yandex`. Сняты запросы
`eda.yandex.ru` и `lavka.yandex.ru` из браузера пула Бро, вошедшего в аккаунт
владельца (только чтение). Фикстуры — `tests/fixtures/yandex/food/*.json`, значения
выдуманы, структура настоящая.

## Общее

|                           | Еда                                                                  | Лавка                                                                                                 |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| origin вкладки            | `https://eda.yandex.ru/`                                             | `https://lavka.yandex.ru/`                                                                            |
| загрузка (`cdp.py check`) | ≈ 3,7–4,1 с                                                          | ≈ 3,7 с                                                                                               |
| «не вошёл»                | `signedIn: false` в `check`; `/web-api/passport/profile` без профиля | `window.__PAGE_PROPS__.pageData.passportInfo.status` не авторизован; редирект на `passport.yandex.ru` |
| капча                     | не встретилась (ждать `showcaptcha`/SmartCaptcha, ответ 4xx с HTML)  | не встретилась (заголовки `X-Captcha-*` шлёт сам сайт)                                                |

Обе страницы — SPA: первая загрузка `/` даёт рабочий контекст (cookies, глобалы).
Достаточно открыть главную; `fetch` идёт с относительными URL.

**Заказы Лавки видны в обоих сервисах.** Единый список Еды
(`orders-info/v1/orders`) содержит и заказы Лавки (`order_nr` оканчивается на
`-grocery`), у этого аккаунта — только их, заказов ресторанов Еды в истории нет
(форма заказа ресторана **не наблюдалась**, см. «Не удалось»).

### Адрес доставки — важное расхождение

- **Лавка** берёт выбранный в аккаунте адрес: `window.__REACT_QUERY_STATE__.queries`,
  запись `["CommonStartup", lon, lat]` (ключ запроса несёт координаты, порядок
  `[lon, lat]`); все сохранённые адреса — запись `FavoriteAddresses`
  (`state.data[].address.{location:[lon,lat], city, street, house, flat…}`).
  Каждый запрос Лавки несёт и `additionalData` с подъездом/квартирой/комментарием
  курьеру — для чтения (поиск, корзина, история) он **не нужен**: работает
  `position.location` без него.
- **Еда** адреса аккаунта в `localStorage.eda_web` не держит
  (`app.lastSelectedAddress === null`): сайт берёт координаты по IP выхода
  браузера (у пула — не Москва, а регион выхода). Поэтому
  операции Еды принимают `lat`/`lon` в `args`, и Бро обязан подставить
  координаты адреса человека (например, из Лавки: `FavoriteAddresses` или
  `CommonStartup`, либо спросить). Без координат (`location`/`region_id`)
  поиск отвечает 400 `UNKNOWN_LOCATION`.
- В фикстурах и примерах — выдуманные координаты центра Москвы (55.7539, 37.6208).

### Заголовки

- Еда: достаточно `Content-Type: application/json;charset=UTF-8`, `X-Platform: desktop_web`,
  `X-App-Version: 18.50.1` (номер сборки; запросы работают и без точного совпадения,
  но берите свежий из `window`/запросов страницы) и для координатного контекста
  `X-Ya-Coordinates: latitude=<lat>,longitude=<lon>`. Токены (`X-Device-Id`,
  `X-Client-Session`) не обязательны — cookies страница прикладывает сама.
- Лавка: GET работают без заголовков (проверено, даже с неверным
  CSRF); POST шлют `X-Csrf-Token-Bff = window.__PAGE_PROPS__.csrfToken`
  (меняется на каждую загрузку страницы, `<timestamp>`-пара), `X-Lavka-Web-City =
__PAGE_PROPS__.pageEnv.cityId`, `X-Lavka-Web-Locale: ru-RU`,
  `X-Requested-With: XMLHttpRequest`, `X-Grocery-Trusted-User: true`,
  `X-Captcha-Service: lavka`, `X-Captcha-Language: ru`.

## food.orders — последние заказы (чтение)

**Зачем:** «что я заказывал»; Еда и Лавка одним списком.

**Запрос (Еда, рекомендуется — один запрос на оба сервиса):**
`POST /eats/v1/orders-info/v1/orders`, тело `{"goods_items_limit": 6}`, страница
по 20 заказов; продолжение — `cursor` из `pagination_settings.cursor` в теле
следующего запроса (`has_more`). Деталь заказа (состав с ценами, чеки, адрес):
`POST /eats/v1/orders-info/v1/desktop/order-details`, `{"order_nr": "<order_nr>"}`.

**Запрос (Лавка, подробнее):** `GET /api/v1/orders/v1/history/list?count=10`
(поля `calculation`, `positions`, `courierInfo`, `trackedOrderInfo`; курьера в
ужатый ответ не берём).

**JS (Еда):**

```js
const args = { limit: 10 };
const h = {
  "Content-Type": "application/json;charset=UTF-8",
  "X-Platform": "desktop_web",
  "X-App-Version": "18.50.1",
};
const r = await fetch("/eats/v1/orders-info/v1/orders", {
  method: "POST",
  headers: h,
  body: JSON.stringify({ goods_items_limit: 6 }),
});
if (r.status !== 200) return { error: "http_" + r.status };
const j = await r.json();
const orders = (j.orders || []).slice(0, args.limit).map((o) => {
  const g = o.widgets.general;
  const items = (o.widgets.goods && o.widgets.goods.items) || [];
  return {
    orderNr: o.order_nr,
    service: o.order_nr.endsWith("-grocery") ? "lavka" : "eda",
    place: g.name,
    date: g.date,
    total: Number(g.cost_value),
    currency: g.currency.code,
    status: g.status.text,
    items: items.map((i) => i.title),
    itemsTotal: o.widgets.goods ? o.widgets.goods.total_items_number : null,
  };
});
return {
  orders,
  hasMore: !!(j.pagination_settings && j.pagination_settings.has_more),
};
```

**JS (Лавка):**

```js
const args = { limit: 10 };
const pp = window.__PAGE_PROPS__;
const H = {
  "X-Csrf-Token-Bff": pp.csrfToken,
  "X-Lavka-Web-City": String(pp.pageEnv.cityId),
  "X-Lavka-Web-Locale": "ru-RU",
  "X-Requested-With": "XMLHttpRequest",
  "X-Grocery-Trusted-User": "true",
  "X-Captcha-Service": "lavka",
  "X-Captcha-Language": "ru",
};
const r = await fetch(`/api/v1/orders/v1/history/list?count=${args.limit}`, {
  headers: H,
});
if (r.status !== 200) return { error: "http_" + r.status };
const j = await r.json();
const orders = j.data.orders.slice(0, args.limit).map((o) => ({
  orderNr: o.deliveryInfo.orderId,
  shortId: o.deliveryInfo.shortOrderId,
  date: o.deliveryInfo.createdAt,
  status: o.deliveryInfo.status, // closed | …; active orders have another value
  canceled: o.deliveryInfo.isCanceled || o.deliveryInfo.isFailed,
  total: Number(o.calculation.finalCost),
  delivery: Number(o.calculation.deliveryCost),
  items: o.positions
    .slice(0, 6)
    .map((p) => ({ name: p.title, qty: p.count, price: p.totalPrice })),
  itemsTotal: o.positions.length,
}));
return { orders, isEnd: j.data.isEnd };
```

**Ответ (Еда):** `{orders: [{orderNr, service: "lavka"|"eda", place, date (строка «09 октября 22:03»), total (число), currency, status ("Доставлен", "Отменён", …), items: string[≤6], itemsTotal}], hasMore}`.
**Ответ (Лавка):** `{orders: [{orderNr, shortId, date (ISO UTC), status ("closed"|…), canceled, total, delivery, items: [{name, qty, price}], itemsTotal}], isEnd}`.
Фикстуры: `eda-orders.json`, `lavka-orders.json`.

**Сбои:** не вошёл — `orders` пуст/401 (не наблюдалось, проверять `signedIn`
заранее); неверный/просроченный `cursor` — не проверялся.
**Замер:** Еда 425/657/480 → медиана **480 мс**; Лавка 729/874/647 → **729 мс**.
**Устойчивость:** курсор у Лавки содержит `grocery_cursor` — у человека с заказами
ресторанов, видимо, добавится ещё один курсор; не разбирать его, возвращать как есть.
`X-App-Version` — версия сборки.

## food.active — активный заказ (чтение)

**Не удалось наблюдать вживую:** у аккаунта в момент разведки активных заказов
не было (заказ не создаём — запрещено протоколом). Что проверено:

- **Лавка:** `GET /api/v1/providers/orders-tracking/v1/tracked-orders?devicePixelRatio=1&useCache=true`
  отвечает `[]` без активных заказов (440 мс медиана, фикстура
  `lavka-tracked-orders.json`). Форма непустого элемента неизвестна. По
  истории (`history/list`) у заказа есть `trackedOrderInfo` (`status`,
  `deliveryEtaMin`, `deliveryPromiseTs`, `courierInfo`, `actions`) и `trackingMapInfo`
  — те же поля, видимо, у активного. Активным надо считать заказ, у которого
  `deliveryInfo.status !== "closed"` (у завершённых — `closed`, `resolution:
succeeded`/отмена — `isCanceled`).
- **Еда:** отдельного эндпоинта активного заказа найти не удалось. Гипотеза:
  активный заказ — в `orders-info/v1/orders` со статусом не из «Доставлен/Отменён»
  (первая страница отсортирована по убыванию времени), а `order-details` даёт
  статус и ожидаемое время. Подтвердить, когда у владельца будет живой заказ.
  Расписание Бро (`browser-runs`/трекинг) может проверять это лишь по факту заказа.

**JS (проверенная часть, Лавка):**

```js
const pp = window.__PAGE_PROPS__;
const H = {
  "X-Csrf-Token-Bff": pp.csrfToken,
  "X-Lavka-Web-City": String(pp.pageEnv.cityId),
  "X-Lavka-Web-Locale": "ru-RU",
  "X-Requested-With": "XMLHttpRequest",
  "X-Grocery-Trusted-User": "true",
  "X-Captcha-Service": "lavka",
  "X-Captcha-Language": "ru",
};
const r = await fetch(
  "/api/v1/providers/orders-tracking/v1/tracked-orders?devicePixelRatio=1&useCache=true",
  { headers: H }
);
if (r.status !== 200) return { error: "http_" + r.status };
const list = await r.json(); // [] без активных заказов
return {
  active: list.length,
  orders: list.map((o) => ({ raw_keys: Object.keys(o) })),
};
```

Замер: 440/423/536 → **440 мс**. Телефон курьера в ужатый результат не брать.

## food.search — поиск заведений и товаров

**Зачем:** найти, где заказать (чтение).

**Еда:** `POST /eats/v1/full-text-search/v1/search`,
`{"text": "<запрос>", "filters": [], "location": {"longitude": <lon>, "latitude": <lat>}}`
→ `blocks[]`: блок `type:"places"` — до 20 заведений (`restaurant`/`shop`),
у каждого до 3 найденных позиций (`items`). Рейтинг — первый элемент
`lower_meta` с текстом «4.5 (1600+)»; время доставки — `delivery.text`; цена
доставки в выдаче **нет** (она в `food.menu`, `shippingInfo`). Фильтр `adult_dialog`
и рекламные поля игнорировать.

**JS (Еда):**

```js
const args = { query: "пицца", lat: 55.7539, lon: 37.6208, limit: 10 };
const h = {
  "Content-Type": "application/json;charset=UTF-8",
  "X-Platform": "desktop_web",
  "X-App-Version": "18.50.1",
  "X-Ya-Coordinates": `latitude=${args.lat},longitude=${args.lon}`,
};
const r = await fetch("/eats/v1/full-text-search/v1/search", {
  method: "POST",
  headers: h,
  body: JSON.stringify({
    text: args.query,
    filters: [],
    location: { longitude: args.lon, latitude: args.lat },
  }),
});
if (r.status !== 200) return { error: "http_" + r.status };
const j = await r.json();
const block = (j.blocks || []).find((b) => b.type === "places");
const places = ((block && block.payload) || [])
  .slice(0, args.limit)
  .map((p) => {
    const meta = (p.lower_meta || [])
      .map((m) => m.payload && m.payload.text && m.payload.text.value)
      .filter(Boolean);
    return {
      slug: p.slug,
      title: p.title,
      kind: p.business, // restaurant | shop | store
      available: p.available,
      rating: meta.find((t) => /^\d(\.\d)? \(/.test(t)) || null,
      deliveryTime: (p.delivery && p.delivery.text) || null,
      price: (p.price_category && p.price_category.title) || null,
      tags: (p.tags || []).map((t) => t.title).slice(0, 4),
      items: (p.items || []).slice(0, 3).map((i) => ({
        name: i.title,
        price: i.decimal_price == null ? null : Number(i.decimal_price),
        weight: i.weight || null,
      })),
    };
  });
return { total: j.header && j.header.text, places };
```

Ответ: `{total, places: [{slug, title, kind, available, rating|null, deliveryTime|null, price, tags[≤4], items: [{name, price, weight|null}]}]}`
(`kind`: `restaurant`/`shop`). Фикстура `eda-search.json`.
Замер: 3500/273/3408 → медиана **3408 мс** (холодный поиск ≈ 3,4 с, повтор того
же запроса из кэша — 0,3 с).

**Лавка:** `POST /api/v1/providers/search/v3/lavka`,
`{"text": "<запрос>", "productsLimit": 32, "subcategoriesLimit": 0, "position": {"location": [<lon>, <lat>]}, "depotType": "regular", "source": "manual_input"}`
(нужен CSRF-заголовок). Ответ: `layoutItems` — порядок, `cacheProducts` — товары.
Цена доставки/время — отдельно `GET /api/v1/providers/v2/service-info?...` (ответ на
страницу уже в состоянии `CommonServiceInfo`; `serviceMetadata.deliveryTime`,
`pricingConditions.deliveryCost`, `personalLogisticInfo.deliveryConditions` —
минимальная корзина).

**JS (Лавка):**

```js
const args = { query: "молоко", limit: 10 };
const pp = window.__PAGE_PROPS__;
const loc = window.__REACT_QUERY_STATE__.queries.find(
  (e) => e.queryKey[0] === "CommonStartup"
).queryKey; // ['CommonStartup', lon, lat] — выбранный адрес Лавки
const H = {
  "Content-Type": "application/json",
  "X-Csrf-Token-Bff": pp.csrfToken,
  "X-Lavka-Web-City": String(pp.pageEnv.cityId),
  "X-Lavka-Web-Locale": "ru-RU",
  "X-Requested-With": "XMLHttpRequest",
  "X-Grocery-Trusted-User": "true",
  "X-Captcha-Service": "lavka",
  "X-Captcha-Language": "ru",
};
const r = await fetch("/api/v1/providers/search/v3/lavka", {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    text: args.query,
    productsLimit: 32,
    subcategoriesLimit: 0,
    position: { location: [loc[1], loc[2]] },
    depotType: "regular",
    source: "manual_input",
  }),
});
if (r.status !== 200) return { error: "http_" + r.status };
const j = await r.json();
const byId = new Map((j.cacheProducts || []).map((p) => [p.id, p]));
const ids = (j.layoutItems || [])
  .filter((l) => l.type === "good")
  .map((l) => l.id);
const products = ids
  .slice(0, args.limit)
  .map((id) => byId.get(id))
  .filter(Boolean)
  .map((p) => ({
    id: p.id,
    name: p.longTitle || p.title,
    amount: p.amount,
    price: p.currentPrice,
    oldPrice: p.fullPrice || null,
    available: p.available !== false,
  }));
return { found: ids.length, products };
```

Ответ: `{found, products: [{id, name, amount, price, oldPrice|null, available}]}`
(`id` — id продукта Лавки, длинная строка). Фикстура `lavka-search.json`.
Замер: 695/671/648 → **671 мс**. Пустой результат: Лавка — `layoutItems` без
`good`; Еда — `Найден 1 результат` с блоком `places` из ближайшего «похожего»
(проверено на бессмысленной строке: 200, `filters`+`places`).

## food.menu — меню заведения

**Зачем:** позиции и цены (чтение). Слаг — из `food.search` (`places[].slug`) или
из ссылки `https://eda.yandex.ru/restaurant/<slug>` (для магазинов — `/retail/<slug>`,
не проверялось).

**Запросы (Еда):**

- меню: `GET /api/v2/menu/retrieve/<slug>?latitude=<lat>&longitude=<lon>&autoTranslate=false`
  → `payload.categories[]` (`id`, `name`, `items[]`; у раздела «Выбор
  пользователей» нет `id` — это дубли позиций других разделов);
- заведение: `GET /api/v2/catalog/<slug>?latitude=…&longitude=…&shippingType=delivery`
  → `payload.foundPlace.{place, locationParams}` (рейтинг, время, плата за
  доставку по порогам, `minimalOrderPrice`).

**JS:**

```js
const args = {
  slug: "papa_dzhons_bolshoj_fakelnyj_pereulok_3s2",
  lat: 55.7539,
  lon: 37.6208,
  limit: 30,
};
const h = {
  "X-Platform": "desktop_web",
  "X-App-Version": "18.50.1",
  "X-Ya-Coordinates": `latitude=${args.lat},longitude=${args.lon}`,
};
const q = `latitude=${args.lat}&longitude=${args.lon}`;
const rm = await fetch(
  `/api/v2/menu/retrieve/${encodeURIComponent(args.slug)}?${q}&autoTranslate=false`,
  { headers: h }
);
if (rm.status === 404) return { error: "place_not_found" };
if (rm.status !== 200) return { error: "http_" + rm.status };
const menu = await rm.json();
await new Promise((s) => setTimeout(s, 1100));
const rc = await fetch(
  `/api/v2/catalog/${encodeURIComponent(args.slug)}?${q}&shippingType=delivery`,
  { headers: h }
);
const fp = rc.status === 200 ? (await rc.json()).payload.foundPlace : null;
const items = [];
for (const c of menu.payload.categories || []) {
  if (c.id == null || !c.name || !(c.items || []).length) continue; // у «Выбор пользователей» нет id, это дубли позиций других разделов
  for (const i of c.items) {
    if (items.length >= args.limit) break;
    items.push({
      section: c.name,
      id: i.id,
      name: i.name,
      price: Number(i.decimalPromoPrice || i.decimalPrice),
      oldPrice: i.decimalPromoPrice ? Number(i.decimalPrice) : null,
      weight: i.weight || null,
      available: i.available !== false,
      needsOptions: (i.optionsGroups || []).length > 0,
    });
  }
}
const p = fp && fp.place,
  l = fp && fp.locationParams;
return {
  place: p && {
    name: p.name,
    rating: p.rating,
    ratingCount: Number(p.ratingCount),
    minOrder: p.minimalOrderPrice,
  },
  delivery: l && {
    available: l.available,
    minutes: l.deliveryTime && `${l.deliveryTime.min}–${l.deliveryTime.max}`,
    fees: ((l.shippingInfo || [])[0] || { thresholds: [] }).thresholds.map(
      (t) => `${t.name}: ${t.value}`
    ),
  },
  sections: (menu.payload.categories || [])
    .filter((c) => c.id != null && c.name && (c.items || []).length)
    .map((c) => c.name),
  items,
};
```

Ответ: `{place: {name, rating, ratingCount, minOrder}, delivery: {available, minutes, fees[]}, sections[], items: [{section, id, name, price, oldPrice|null, weight, available, needsOptions}≤30]}`.
`needsOptions` — у позиции обязательные группы опций (размер/тесто), без них
корзину не собрать. Фикстура `eda-menu.json` (оба ответа: `menu` и `catalog`).
Замер: 3418/3668/2406 → **3418 мс** (два запроса подряд с паузой 1,1 с; меню ≈
1,3 МБ).
**Сбои:** неизвестный слаг — `404`, тело `[]` (→ `place_not_found`).
**Лавка:** «меню» нет — каталог по категориям (`providers/v2/category`,
`category-group`), не нужен для операций; поиск (`food.search`) покрывает.

## food.cart — корзина (чтение)

**Еда:** `POST /eats/v1/cart/v2/multi-carts?longitude=<lon>&latitude=<lat>&screen=catalog&shippingType=delivery&autoTranslate=false&plus_subscription_toggle_state=false&combo_subscription_toggle_state=false`,
тело `{"need_items_icons": true}` — все корзины по заведениям; корзина одного
заведения — `POST /eats/v1/cart/v2/full-carts?…&screen=menu…`, тело `{}`
(даёт `cart.{items, subtotal, delivery_fee, total, …}`).

```js
const args = { lat: 55.7539, lon: 37.6208 };
const h = {
  "Content-Type": "application/json;charset=UTF-8",
  "X-Platform": "desktop_web",
  "X-App-Version": "18.50.1",
  "X-Ya-Coordinates": `latitude=${args.lat},longitude=${args.lon}`,
};
const r = await fetch(
  `/eats/v1/cart/v2/multi-carts?longitude=${args.lon}&latitude=${args.lat}&screen=catalog&shippingType=delivery&autoTranslate=false&plus_subscription_toggle_state=false&combo_subscription_toggle_state=false`,
  {
    method: "POST",
    headers: h,
    body: JSON.stringify({ need_items_icons: true }),
  }
);
if (r.status !== 200) return { error: "http_" + r.status };
const j = await r.json();
// carts:[] — корзин нет (title/subtitle в этом случае шаблонные); форма непустой корзины не проверена
return { carts: (j.carts || []).length, raw: (j.carts || []).slice(0, 3) };
```

Пустая корзина: `carts: []` (поля `title`/`subtitle` «Слишком много корзин» в
этом случае шаблонные, смысла не несут). Фикстура `eda-cart.json`.
Замер: 379/351/376 → **376 мс**. Форма **непустой** корзины не проверена (корзину не меняем).

**Лавка:** `POST /api/v1/providers/cart/v1/retrieve`,
`{"position": {"location": [lon, lat]}, "depotType": "regular"}` (CSRF). `cartId`
сервер выдаёт сам; запрос ничего не создаёт.

```js
const pp = window.__PAGE_PROPS__;
const loc = window.__REACT_QUERY_STATE__.queries.find(
  (e) => e.queryKey[0] === "CommonStartup"
).queryKey;
const H = {
  "Content-Type": "application/json",
  "X-Csrf-Token-Bff": pp.csrfToken,
  "X-Lavka-Web-City": String(pp.pageEnv.cityId),
  "X-Lavka-Web-Locale": "ru-RU",
  "X-Requested-With": "XMLHttpRequest",
  "X-Grocery-Trusted-User": "true",
  "X-Captcha-Service": "lavka",
  "X-Captcha-Language": "ru",
};
const r = await fetch("/api/v1/providers/cart/v1/retrieve", {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    position: { location: [loc[1], loc[2]] },
    depotType: "regular",
  }),
});
if (r.status !== 200) return { error: "http_" + r.status };
const c = await r.json();
return {
  itemsCount: c.totalItemsCount,
  itemsPrice: Number(c.totalItemsPrice),
  total: Number(c.totalPriceValue),
  deliveryCost: Number(c.orderConditions.deliveryCost),
  canCheckout: c.availableForCheckout,
  blocker: c.checkoutUnavailableReason || null,
  // поля позиции не проверены на непустой корзине (корзину не меняли); берём как в mockActiveCart.items истории заказов
  items: (c.items || []).slice(0, 20).map((i) => ({
    id: i.id,
    name: i.title,
    qty: Number(i.quantity),
    price: Number(i.price),
  })),
};
```

Ответ: `{itemsCount, itemsPrice, total, deliveryCost, canCheckout, blocker|null, items: [{id, name, qty, price}]}`;
`blocker: "cart_empty"` у пустой. Поля позиции взяты из `mockActiveCart.items`
истории заказов — на непустой корзине **не проверены**. Фикстура `lavka-cart.json`.
Замер: 864/552/485 → **552 мс**.

## Оформление заказа (только «какой запрос это был бы»)

Не исследовалось. Лавка: `POST /api/v1/providers/orders/v1/checkout-layout`,
`…/cart/v1/update` (изменение корзины), `…/cart/v1/set-payment`, оплата — через
`payments/v1/*`; Еда: `cart/v2/*` и checkout на странице. Всё это — через
`browser_task` с карточкой согласия.

## Устойчивость и риски

- Сборка: Еда — `X-App-Version` (18.50.1) и webpack-чанки; Лавка — rspack-чанки
  `yastatic.net/s3/lavka-web/public/js/*.<hash>.desktop.js`. API-пути версионируются
  (`/v1/`, `/v2/`) — стабильнее чанков, но JS-путь к CSRF/координатам
  (`__PAGE_PROPS__.csrfToken`, `__REACT_QUERY_STATE__`, ключ `CommonStartup`)
  зависит от сборки Лавки. Если сломается — получить заново: перехватить `fetch`
  (`window.fetch = …` до действия страницы), вызвать SPA-навигацию
  (`history.pushState` + `dispatchEvent(new PopStateEvent("popstate"))`) и
  прочитать заголовки и тело запроса (так найден `providers/search/v3/lavka`).
- Лавка `csrfToken` — на загрузку страницы, не кэшировать между вкладками.
- Еда: адрес не привязан к аккаунту → результат зависит от переданных координат,
  а не от того, что человек выбрал на сайте. Для Лавки — наоборот: берётся
  выбранный на странице адрес; другой — через `position.location` в запросах.
- Ограничивать частоту: ~1 запрос/с; холодный поиск Еды медленный (3,4 с).
- Данные владельца (адрес, телефон курьера, номера заказов) в ужатые результаты
  не включены; `courierInfo` и `destination` в Лавке опускаем.

## Что не удалось

- Форма **заказа ресторана Еды** (в истории аккаунта их нет) и состав
  `order-details` для Еды: структура общая (`order.header/main_section/sections`),
  но для ресторана не проверена.
- **Активный заказ** (обе службы): нет живого заказа; см. `food.active`.
- **Непустые корзины** (обе службы).
- Поиск/каталог **магазинов Еды (`/retail`)** — только через `full-text-search`
  (`kind: "shop"`), страницы магазина не снимались.
- Капчу не встречали, поведение при `showcaptcha` не проверено.
