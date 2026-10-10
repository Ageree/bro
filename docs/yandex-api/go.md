# Яндекс Go (такси): разведка веб-API (10.10.2026)

Спецификация для кода операций `go.estimate` и `go.rides` инструмента `yandex`. Сняты запросы
веб-версии такси из браузера пула Бро, вошедшего в аккаунт владельца (только чтение). Такси **не
вызывалось**. Фикстуры — `tests/fixtures/yandex/go/*.json`, значения выдуманы.

## Общее

|                           |                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| где веб-заказ             | `https://taxi.yandex.ru/` («Яндекс Go — заказ поездок онлайн»). `go.yandex` — лендинг без входа, не годится  |
| origin вкладки            | `https://taxi.yandex.ru/`                                                                                    |
| API-хост                  | `https://ya-authproxy.taxi.yandex.ru` (CORS с `taxi.yandex.ru` разрешён, cookies — `credentials: "include"`) |
| загрузка (`cdp.py check`) | ≈ 4,1 с                                                                                                      |
| «не вошёл»                | `signedIn: false` в `check`; `GET /user-info` отдаёт `status != "VALID"`; API — 401                          |
| капча                     | не встретилась; страница ведёт на `/captcha-success` (заголовок `x-retpath-y`) после прохождения             |

### Три обязательных вещи для каждого вызова API

1. **`X-YaTaxi-UserId`** — 32 hex. Страница хранит его в IndexedDB `turboapp-taxi`, хранилище
   `redux-persist`, ключ `persist:session`, поле **`userId`** (значение — объект, не строка).
   Из cookie или HTML он не берётся. Читаем одной транзакцией (транзакция закрывается на первом
   `await fetch`, поэтому сначала достаём значение). Нет поля — вход не выполнен или страница ещё не
   создала сессию: `{error:"no_user_id"}`.
2. **CSRF**: `POST /csrf_token` с телом `{}` и теми же заголовками → `{"sk":"<…>:<unix>","max-age-seconds":3600}`;
   значение уходит заголовком **`x-csrf-token`**. Без него — 401 (проверено). Заголовок `sk` вместо этого
   запрещён CORS-ом.
3. Заголовки: `content-type: application/json`, `x-requested-with: XMLHttpRequest`,
   `x-taxi: <UA> turboapp_taxi`, `accept-language: ru`, `x-yataxi-tz-offset: 10800` (минуты зоны ×60, Москва).

Общий префикс всех JS ниже (userId + CSRF + хелпер `post`):

```js
const db = await new Promise((res, rej) => {
  const q = indexedDB.open("turboapp-taxi");
  q.onsuccess = () => res(q.result);
  q.onerror = () => rej(q.error);
});
const v = await new Promise((r) => {
  const q = db
    .transaction("redux-persist", "readonly")
    .objectStore("redux-persist")
    .get("persist:session");
  q.onsuccess = () => r(q.result);
});
const raw = typeof v === "string" ? JSON.parse(v) : v;
const userId = raw.userId;
if (!/^[0-9a-f]{32}$/.test(userId || "")) return { error: "no_user_id" };
const A = "https://ya-authproxy.taxi.yandex.ru";
const base = {
  "content-type": "application/json",
  "x-requested-with": "XMLHttpRequest",
  "x-yataxi-userid": userId,
  "x-taxi": navigator.userAgent + " turboapp_taxi",
  "accept-language": "ru",
  "x-yataxi-tz-offset": "10800",
};
const skRes = await fetch(A + "/csrf_token", {
  method: "POST",
  headers: base,
  credentials: "include",
  body: "{}",
});
if (skRes.status !== 200) return { error: "csrf_" + skRes.status };
const H = { ...base, "x-csrf-token": (await skRes.json()).sk };
const post = async (path, body) => {
  const r = await fetch(A + path, {
    method: "POST",
    headers: H,
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (r.status !== 200) return { error: "http_" + r.status };
  return r.json();
};
```

(Фикстура токена — `csrf-token.json`.)

## go.estimate — цена и подача по тарифам между двумя адресами

**Зачем:** «сколько стоит такси от А до Б и когда подадут»; чтение. **Заказ не создаётся.**

**Запросы:**

1. Геокодирование (по одной точке): `POST /4.0/persuggest/v1/suggest`,
   тело `{"type":"a","client_id":"turboapp-taxi","state":{"accuracy":0,"location":[lon,lat],"fields":[]},"position":[lon,lat],"action":"user_input","part":"<текст адреса>","sticky":false}`
   (`location`/`position` — точка смещения, например центр города; выдача сортируется по близости). Берётся
   первый `results[]` с `type:"address"` и полем `position` **[lon, lat]**. Фикстура — `suggest.json`.
2. Оценка: `POST /3.0/routestats`, тело
   `{"id":"<userId>","route":[[lonA,latA],[lonB,latB]],"selected_class":"econom","format_currency":true,"payment":{"type":"cash"},"supported":[],"requirements":{},"skip_estimated_waiting":false,"suggest_alternatives":false}`.
   В ответе `distance`, `time`, `service_levels[]` (тарифы; `is_hidden:true` — межгород/скрытые, не показываем),
   `offer` (id оферты для заказа). Цена — строка вида `"780 $SIGN$$CURRENCY$"` (заменить на ₽, число брать цифрами).
   Фикстура — `routestats.json`.

**JS:**

```js
const args = {
  from: "Красная площадь",
  to: "Парк Горького",
  near: [37.6177, 55.7558],
};
const point = async (q) => {
  if (Array.isArray(q)) return { text: q.join(","), position: q };
  const s = await post("/4.0/persuggest/v1/suggest", {
    type: "a",
    client_id: "turboapp-taxi",
    state: { accuracy: 0, location: args.near, fields: [] },
    position: args.near,
    action: "user_input",
    part: q,
    sticky: false,
  });
  if (s.error) return s;
  const hit =
    (s.results || []).find((r) => r.position && r.type === "address") ||
    (s.results || []).find((r) => r.position);
  return hit
    ? { text: hit.text.trim(), position: hit.position }
    : { error: "address_not_found" };
};
const a = await point(args.from);
if (a.error) return { error: a.error, which: "from" };
await new Promise((r) => setTimeout(r, 1000));
const b = await point(args.to);
if (b.error) return { error: b.error, which: "to" };
await new Promise((r) => setTimeout(r, 1000));
const j = await post("/3.0/routestats", {
  id: userId,
  route: [a.position, b.position],
  selected_class: "econom",
  format_currency: true,
  payment: { type: "cash" },
  supported: [],
  requirements: {},
  skip_estimated_waiting: false,
  suggest_alternatives: false,
});
if (j.error) return j;
const rub = (s) =>
  Number(
    String(s)
      .replace(/[^\d.,]/g, "")
      .replace(",", ".")
  ) || null;
return {
  from: a.text,
  to: b.text,
  distance: j.distance,
  duration: j.time,
  tariffs: (j.service_levels || [])
    .filter((s) => !s.is_hidden)
    .map((s) => ({
      class: s.class,
      name: s.name,
      price: rub(s.price),
      fixed: s.is_fixed_price,
      pickupMinutes: s.estimated_waiting
        ? Math.round(s.estimated_waiting.seconds / 60)
        : null,
    })),
};
```

**Ответ (ужатый):** `{from, to (нормализованные адреса), distance («4,5 км»), duration («11 мин»), tariffs: [{class
(«econom», «business»=Комфорт, «comfortplus», «vip»=Business, «ultimate»=Premier, «maybach»=Élite,
«child_tariff», «minivan», «premium_van»=Cruise), name, price: number|null (₽), fixed: boolean, pickupMinutes: number|null}]}`.
Ошибки: `{error:"address_not_found", which:"from"|"to"}`, `{error:"http_401"}`, `{error:"csrf_…"}`.
Цены — «на сейчас» (динамические, за 3 прогона эконом 780 ₽ при подаче 6–11 мин); показывать как
оценку. Можно передать координаты вместо текста: `args.from = [lon, lat]`.

**Запрос заказа (НЕ отправлять, описано словами):** в мобильном API заказ создаёт `POST /3.0/taxi` с `id`,
`offer` из `routestats` и выбранным `class`, способом оплаты и маршрутом. Веб-страница делает то же
после кнопки «Заказать». Запрос не наблюдался и не вызывался. Заказ и оплата — только через
`browser_task` и явное «да» человека.

**Замер:** 3811 / 3656 / 3792 → медиана **3792 мс** (из них ≈ 2 с — две паузы по 1 с между тремя
запросами ради лимита; чистое время запросов ≈ 1,8 с, из них routestats ≈ 1 с, CSRF ≈ 0,3 с).
**Устойчивость:** `client_id: "turboapp-taxi"` и пути `/3.0/routestats`, `/4.0/persuggest/v1/suggest` — в клиентском
бандле (`yastatic.net/s3/taxi-front/txf-turboapp-taxi/…`, версия `clientConfig.version`, сейчас 4.139.4).
Хранилище `redux-persist` имеет `_persist.version` (24) — при смене формы искать `userId` заново:
в записях `persist:*` найти 32-hex, равный `id` в ссылке `taxi.yandex.ru/support?id=…` на странице.

## go.rides — последние поездки

**Зачем:** «куда я ездил, сколько платил»; чтение.

**Запрос:** `POST /4.0/orderhistory/v2/list`, тело
`{"services":{"taxi":{"image_tags":{"size_hint":9999},"flavors":["default"]}},"range":{"results":10},"country_code":"RU","include_service_metadata":true}`
(+ общие заголовки). В `orders[].data`: `created_at`, `route.source`, `route.destination`, `payment.cost`
(число, ₽), `tariff_class` (название тарифа), `status` (`finished`, `cancelled`, …), `is_active`.
Водителя, телефон, номер машины в ужатый ответ не берём. Фикстура — `orderhistory.json`.

**JS:**

```js
const args = { limit: 10 };
const j = await post("/4.0/orderhistory/v2/list", {
  services: { taxi: { image_tags: { size_hint: 9999 }, flavors: ["default"] } },
  range: { results: args.limit },
  country_code: "RU",
  include_service_metadata: true,
});
if (j.error) return j;
const rides = (j.orders || [])
  .filter((o) => o.service === "taxi")
  .slice(0, args.limit)
  .map((o) => {
    const d = o.data;
    return {
      date: d.created_at,
      from: d.route ? d.route.source : null,
      to: d.route ? d.route.destination : null,
      price: d.payment ? d.payment.cost : null,
      currency: d.payment ? d.payment.currency_code : null,
      tariff: d.tariff_class,
      status: d.status,
    };
  });
return { rides };
```

**Ответ (ужатый):** `{rides: [{date (ISO с +0300), from, to, price: number|null, currency, tariff, status}]}`, ≤ 10.
Отменённая поездка: `price: 0`, `status: "cancelled"`.
**Сбои:** нет `userId` — `no_user_id`; не вошёл — `http_401`.
**Замер:** 6598 (холодный первый, включает загрузку чанков) / 702 / 749 → медиана **749 мс**.
**Устойчивость:** то же, что у estimate; на странице истории (`ya-authproxy…/webview/yaproxy/history?services=taxi&id=<userId>`)
те же вызовы идут с заголовком `x-requested-uri`, наш вариант работает и без него.

## Не удалось / что отдать `browser_task`

- Создание заказа не проверялось (запрещено правилами), поля и ответ `/3.0/taxi` неизвестны.
- Статус активной поездки (`/3.0/taxiontheway`, `/4.0/orderperformerinfo`) в страницу приходит сам, в
  операции не включён; содержит имя и телефон водителя.
- Адреса «Дом/Работа» человека лежат в `zerosuggest`; их использование для оценки не описано
  (Бро может передать их текстом или координатами).
