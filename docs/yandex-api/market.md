# Яндекс Маркет: спецификация API для Бро

Разведка единицы `d-market` плана «API сервисов Яндекса для Бро» (10.10.2026).
Читает исполнитель, который по этому файлу пишет код операций и не видит браузера.
Всё ниже проверено на живом аккаунте Бро в браузере пула, кроме мест, помеченных
**не проверено**. Фикстуры — `tests/fixtures/yandex/market/*.json`, синтетические
(структура настоящая, значения выдуманы).

## 0. Контекст и общие правила

- **Origin и стартовая страница.** Все запросы делаются из вкладки на
  `https://market.yandex.ru/` (та же origin, cookies и вход приложит браузер).
  Стартовая страница — сама главная `https://market.yandex.ru/`: её загрузка
  (`cdp.py check`) — **4,2–4,4 с**; `/my/orders`, `/compare`, `/my/wishlist`
  грузятся за 3,7 с, `robots.txt` — 3,7 с (время почти целиком уходит на открытие
  вкладки, а не на страницу), поэтому лёгкой страницы выигрыша нет. Берите ту, что
  открывает keep-alive вкладка. Главная даёт `window.state.user.sk`; со страницы без
  `window.state` (например `robots.txt`) `getSk()` из пролога сам достаёт `sk` из
  HTML `/my/wishlist` (+0,9 с).
- **Вход.** Страница состояния кладёт `window.state.user = {sk, uid, login}`; в HTML
  любой страницы то же самое: `"user":{"sk":"…","uid":"…","login":"…"}`. Не вошёл
  (**не проверено**: из аккаунта владельца выходить нельзя) — по аналогии с другими
  сервисами Яндекса запрос уходит редиректом на `passport.yandex.*`; пролог ловит и это
  (`r.url`), и отсутствие `uid` в HTML, и 401/403 у POST.
- **Капча.** За всю разведку (~150 запросов) не встретилась. Признаки (**не проверено**):
  редирект на `/showcaptcha…`, статус 429. Операции возвращают `error.code = 'captcha'`;
  по протоколу — остановиться, не решать.
- **Нагрузка.** Не больше ~1 запроса в секунду: многозапросные операции делают
  `sleep(1100)` между запросами.
- **Что приходит из страницы.** Маркет — серверный рендер (SSR): данные страниц
  лежат в самом HTML, а клиентские действия ходят в два семейства POST:
  1. `POST /api/resolve/?r=<путь резолвера>:<имя>` (можно несколько `r=`), тело
     `{"params":[…],"path":"<текущая страница>"}`, ответ `{"results":[{"data":…}]}`;
  2. `POST /api/web/<service>/<handler>`, тело `{"path":"…","params":{…}}`, ответ
     `{"result":{"result":…,"collections":…}}`; ошибка — `{"error":{"name","message"}}` и HTTP 500.
     Обязательный заголовок обоих — `sk: <window.state.user.sk>`; без него 500 с пустым
     телом. Заголовки `x-market-front-glue` и `x-market-app-version` (версия сборки) **не
     нужны** — проверено, всё работает без них.
- **Структура Маркета, важная для задач Бро.** Каждая карточка товара (`/card/<slug>/<sku>`)
  — это **один продавец** (в schema.org `offerCount = 1`). «Вариантов продавцов» у
  карточки нет: другого продавца того же товара ищут поиском как отдельную карточку.
- **Сборка запроса.** Каждая операция ниже — тело для `cdp.py eval --url
https://market.yandex.ru/ --js файл`: берётся **пролог (раздел 0.1) + тело операции**,
  склеенные в один файл. Аргументы — объект `args` первой строкой тела. Результат —
  JSON; всегда `ok: true|false`; при `ok:false` есть `error: {code, message}`.
  Коды: `not_signed_in`, `captcha`, `http_<код>`, `bad_argument`, `not_found`,
  `bad_response` (страница сменила разметку), `add_failed`, `change_failed`,
  `not_in_cart`.

### 0.1 Пролог (вставляется в начало каждого JS)

```js
const T0 = performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (code, message) => ({ ok: false, error: { code, message } });
const getSk = async () => {
  const s = window.state && window.state.user && window.state.user.sk;
  if (s) return s;
  const h = await (
    await fetch("/my/wishlist", { credentials: "include" })
  ).text();
  const m = h.match(/"sk":"(u[0-9a-f]{20,})"/);
  return m && m[1];
};
// GET an HTML page; returns {doc, html} or {error} for login/captcha redirects
const getPage = async (path) => {
  const r = await fetch(path, { credentials: "include" });
  if (/passport\.yandex\./.test(r.url))
    return {
      error: fail("not_signed_in", "redirected to " + new URL(r.url).host),
    };
  if (/showcaptcha|\/captcha/.test(r.url) || r.status === 429)
    return { error: fail("captcha", "captcha at " + new URL(r.url).pathname) };
  if (!r.ok) return { error: fail("http_" + r.status, path) };
  const html = await r.text();
  if (!/"user":\{"sk":"[^"]+","uid":"\d+"/.test(html))
    return { error: fail("not_signed_in", "no uid in page state") };
  return { html, doc: new DOMParser().parseFromString(html, "text/html") };
};
```

## 1. `market.search` — поиск товара (чтение)

**Зачем человеку.** «Найди кабель USB-C подешевле»: до 10 предложений с ценой, рейтингом,
сроком доставки и ссылкой.

**Запрос.** `POST /api/resolve/?r=../../../b2c-shared/src/resolvers/search/resolvePoorRemoteSearchApphost:resolvePoorRemoteSearchApphost`
(строка `r=` берётся как есть, это внутреннее имя резолвера).

| Заголовок                 | Значение               |
| ------------------------- | ---------------------- |
| `content-type`            | `application/json`     |
| `sk`                      | `window.state.user.sk` |
| `x-market-page-id`        | `market:search`        |
| `x-market-apphost-target` | `SEARCH`               |
| `x-market-core-service`   | `mf-search-desktop`    |
| `x-requested-with`        | `XMLHttpRequest`       |

Тело: `{"params":[{"text":<строка>,"how":<сортировка>,"searchPlace":"__standalone__","filters":{"pricefrom":"300","priceto":"600"},"page":<1..>,"withResults":true,"viewtype":"list","urlParams":{},"noSearchFilters":"1","noSearchResults":false,"omitFilters":false}],"path":"/search?text=<text>&how=<how>"}`.

- `how`: `dpop` (по популярности), `aprice` (дешевле), `dprice` (дороже), `rating`.
- `filters.pricefrom/priceto` (строки, ₽) работают и применяются к цене «с картой Яндекс
  Пэй» (`priceCard`): при 300–600 и `aprice` первые карточки были 300, 300, 301… 306 ₽.
  Фильтр, переданный в `urlParams` или как `glprice`, **игнорируется**.
- `backendState`/`page-token`, которые шлёт страница, **не нужны**: `page: 2` работает и без них.
- На странице 8 товаров и до 2 рекламных вставок (`type: "incut"`, пропускаются). Для 10
  результатов нужны 2 запроса (пауза 1,1 с).
- Вариант без JS-резолвера: `GET /search?text=…&how=…` отдаёт 8 карточек в SSR-HTML
  (1,1 с, `[data-zone-name="productSnippet"]`), но без магазина, `offerId` в удобном виде и
  токенов — он хуже; не используйте.

**JS** (`args` по умолчанию — пример):

```js
const args = {
  query: "наушники",
  sort: "popular",
  priceFrom: null,
  priceTo: null,
  limit: 10,
};
const HOW = {
  popular: "dpop",
  price_asc: "aprice",
  price_desc: "dprice",
  rating: "rating",
};
const how = HOW[args.sort] || "dpop";
const filters = {};
if (args.priceFrom != null) filters.pricefrom = String(args.priceFrom);
if (args.priceTo != null) filters.priceto = String(args.priceTo);
const sk = await getSk();
if (!sk) return fail("not_signed_in", "no sk");
const path = "/search?text=" + encodeURIComponent(args.query) + "&how=" + how;
const num = (v) =>
  v == null || v === "" ? null : Number(String(v).replace(/\s/g, ""));
const nano = (v) => (v == null ? null : Math.round(Number(v) / 1e7));
const items = [];
const seen = new Set();
let total = null;
for (let page = 1; page <= 3 && items.length < args.limit; page++) {
  if (page > 1) await sleep(1100);
  const r = await fetch(
    "/api/resolve/?r=../../../b2c-shared/src/resolvers/search/resolvePoorRemoteSearchApphost:resolvePoorRemoteSearchApphost",
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        sk,
        "x-market-page-id": "market:search",
        "x-market-apphost-target": "SEARCH",
        "x-market-core-service": "mf-search-desktop",
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify({
        params: [
          {
            text: args.query,
            how,
            searchPlace: "__standalone__",
            filters,
            page,
            withResults: true,
            viewtype: "list",
            urlParams: {},
            noSearchFilters: "1",
            noSearchResults: false,
            omitFilters: false,
          },
        ],
        path,
      }),
    }
  );
  if (/showcaptcha|captcha/.test(r.url) || r.status === 429)
    return fail("captcha", "search resolver");
  if (r.status === 401 || r.status === 403)
    return fail("not_signed_in", "resolver " + r.status);
  if (!r.ok) return fail("http_" + r.status, "search resolver");
  const j = await r.json();
  const d = j.results && j.results[0] && j.results[0].data;
  const col = d && d.search && d.search.collections;
  if (!col || !Array.isArray(col.widgets))
    return fail("bad_response", JSON.stringify(j).slice(0, 200));
  const vsr = Object.values(col.visibleSearchResult || {})[0];
  if (vsr) total = vsr.total;
  let added = 0;
  for (const w of col.widgets) {
    if (w.type !== "product" || !w.product) continue;
    const p = w.product.productPayload;
    const cb = p.cartButton || {};
    if (!cb.offerId || seen.has(cb.offerId) || items.length >= args.limit)
      continue;
    seen.add(cb.offerId);
    added++;
    const price = num(cb.price && cb.price.valueFmt);
    const old = nano(cb.oldPrice);
    const ap = p.price && p.price.actualPrice;
    const cardPrice =
      ap && ap.suffix === "YA_PAY" ? num(ap.amount.intPart) : null;
    const bought = ((p.productRating && p.productRating.descriptionList) || [])
      .map((s) => s.match(/^(\d+)\s+купил/))
      .find(Boolean);
    const opt =
      p.deliveryInfo && p.deliveryInfo.options && p.deliveryInfo.options[0];
    const bm = opt && opt.baobabModel;
    const sku =
      p.offerParams &&
      (p.offerParams.oskuId || p.offerParams.legacyOfferParams.skuId);
    items.push({
      offerId: cb.offerId,
      sku,
      title: p.title.value,
      price,
      priceCard: cardPrice && cardPrice !== price ? cardPrice : null,
      oldPrice: old && old > price ? old : null,
      shop: (p.signals && p.signals.shop && p.signals.shop.text.text) || null,
      rating: p.rating
        ? {
            value: p.rating.ratingValue,
            count: p.rating.ratingCount,
            bought: bought ? Number(bought[1]) : null,
          }
        : null,
      delivery: bm
        ? {
            text: bm.deliveryText.replace(/[\s\u00a0]*\*[\s\u00a0]*/g, ", "),
            type: bm.deliveryType,
            from: bm.deliveryDateFrom,
            to: bm.deliveryDateTo,
          }
        : null,
      flags: [
        p.signals && p.signals.crossborder ? "crossborder" : null,
        cb.isSponsored ? "sponsored" : null,
        p.signals && p.signals.resale ? "resale" : null,
        p.signals && p.signals.lastStock ? p.signals.lastStock.text.text : null,
      ].filter(Boolean),
      url:
        "/card/" + p.offerParams.slug + "/" + sku + "?do-waremd5=" + cb.offerId,
    });
  }
  if (!added) break;
}
return {
  ok: true,
  query: args.query,
  total,
  count: items.length,
  items,
  ms: Math.round(performance.now() - T0),
};
```

**Ответ** (ужатый):

| Поле                | Тип                              | Смысл                                                                                                      |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `total`             | число \| null                    | всего найдено                                                                                              |
| `items[].offerId`   | строка (22 симв.)                | id предложения (waremd5) — нужен в корзине                                                                 |
| `items[].sku`       | строка                           | id карточки (OSKU)                                                                                         |
| `items[].title`     | строка                           | название                                                                                                   |
| `items[].price`     | число                            | обычная цена, ₽ (без карты Пэй)                                                                            |
| `items[].priceCard` | число \| null                    | цена при оплате картой Яндекс Пэй, если ниже обычной                                                       |
| `items[].oldPrice`  | число \| null                    | зачёркнутая цена                                                                                           |
| `items[].shop`      | строка \| null                   | магазин; **в выдаче почти всегда null** (поле есть лишь у части карточек) — имя берите из `market.product` |
| `items[].rating`    | `{value, count, bought}` \| null | оценка, число оценок, «N купили»                                                                           |
| `items[].delivery`  | `{text, type, from, to}` \| null | самый ранний вариант на адрес аккаунта (`PICKUP`/`COURIER`…), даты ISO                                     |
| `items[].flags`     | строки                           | `crossborder` (из-за рубежа), `sponsored` (реклама), `resale` (уценка), «Осталось N шт»                    |
| `items[].url`       | строка                           | `/card/<slug>/<sku>?do-waremd5=<offerId>` — аргумент `market.product`/`market.cart_add`                    |

**Цена доставки в выдаче не приходит** (только срок). Цена доставки — в `market.product`
(`delivery.price`). В режиме `popular` (`dpop`) у всех наблюдавшихся карточек
`isSponsored = true`, при сортировке по цене флага нет; считайте `sponsored` свойством
режима выдачи, а не отдельной рекламной карточки.

**Фикстура:** `tests/fixtures/yandex/market/search.json` — сырой ответ резолвера (3 товара и
1 рекламная вставка).

**Сбои.**

- Пустой результат: `ok:true, total:0, items:[]` (проверено: `priceFrom` 99999990). Заведомо
  бессмысленный запрос пустым **не** бывает — Маркет отдаёт приблизительные совпадения
  (`total` в тысячах): проверяйте `title`.
- `sort` вне списка → `popular`. Нет `sk` → `not_signed_in`.
- Не вошёл / капча — раздел 0; ответ резолвера без `collections.widgets` →
  `bad_response` с началом тела.

**Замер** (поверх открытой страницы, 3 прогона, мс в странице): `limit` ≤ 8 (один запрос)
— 1180, 1431, 782, медиана **1180**; `limit` 10 (два запроса и пауза) — 4588, 5787, 3132,
медиана **4588**. Позже, когда сеть браузера замедлилась, тот же запрос шёл 3–5 с.

**Устойчивость.**

- Хрупко: имя резолвера в `r=`, имена заголовков `x-market-*`, путь
  `results[0].data.search.collections.widgets[].product.productPayload`, поля
  `cartButton.price.valueFmt`, `cartButton.oldPrice` (в «нано-рублях»: ÷ 10 000 000),
  `signals.shop`, `deliveryInfo.options[].baobabModel`.
- Достать заново: `cdp.py record --url "https://market.yandex.ru/search?text=наушники" --seconds
14 --js scroll.js` (`scroll.js`: `for (let i=0;i<8;i++){ window.scrollTo(0, document.body.scrollHeight*(i+1)/8); await new Promise(r=>setTimeout(r,900)); }`); в записи найти `POST
/api/resolve/?r=…` с `page: 2` — `r=` и заголовки скопировать, тело сверить с этим
  разделом. Селекторы не нужны: операция читает JSON, а не DOM.
- Версия сборки (`window.state.version`, `mf-offline.2026.10.9.3…`) в запросы не входит.

## 2. `market.product` — карточка товара (чтение)

**Зачем человеку.** Узнать цену, наличие, продавца, срок и цену доставки и ключевые
характеристики перед заказом.

**Запрос.** `GET <url>` — карточка из `items[].url` поиска (`/card/<slug>/<sku>?do-waremd5=<offerId>`).
Это SSR-страница ~2 МБ (1,0–1,1 с); данные берутся из:
`script[type="application/ld+json"]` с `"@type":"Product"` (название, бренд, наличие,
оценка), из `<noframes data-apiary="patch">` с `collections.buyOption` (цены, `offerId`,
`feeShow`, магазин, флаги), и из DOM по `data-auto`: `shop-info-title`, `shop-info-rating`,
`snippet-delivery-options`, `specs-list-minimal`. Классы вида `_2Kqmz` хэшированы — не
использовать.

**JS:**

```js
const args = {
  url: "/card/kabel-usb-type-c-dlya-samsung-s20-s9-s8-xiaomi-huawei-p30-pro-5-a-1-m-03-m/103686617517?do-waremd5=uGdX3w9c5mASBYDfYQutVw",
};
const path = args.url.replace(/^https:\/\/market\.yandex\.ru/, "");
if (!/^\/card\/[^/?#]+\/\d+/.test(path))
  return fail(
    "bad_argument",
    "url must look like /card/<slug>/<sku>?do-waremd5=<offerId>"
  );
const pg = await getPage(path);
if (pg.error) return pg.error;
const { doc } = pg;
const text = (sel) => {
  const e = doc.querySelector(sel);
  return e ? e.textContent.replace(/\s+/g, " ").trim() : null;
};
const ldText = [...doc.querySelectorAll('script[type="application/ld+json"]')]
  .map((s) => s.textContent)
  .find((t) => /"@type"\s*:\s*"Product"/.test(t) && t.includes('"offers"'));
if (!ldText)
  return fail(
    "not_found",
    "no Product JSON-LD (card removed or not a card page)"
  );
const ld = JSON.parse(ldText);
let buy = null;
doc.querySelectorAll('noframes[data-apiary="patch"]').forEach((n) => {
  if (buy || !n.textContent.includes('"buyOption"')) return;
  try {
    const c = JSON.parse(n.textContent).collections;
    if (c && c.buyOption) buy = Object.values(c.buyOption)[0];
  } catch (e) {}
});
const specBox = doc.querySelector('[data-auto="specs-list-minimal"]');
let specs = [];
if (specBox) {
  specBox.querySelectorAll("script,noframes,svg").forEach((x) => x.remove());
  const leaf = [...specBox.querySelectorAll("*")]
    .filter((x) => !x.children.length)
    .map((x) => x.textContent.trim())
    .filter(
      (t) =>
        t && t !== "Все характеристики" && !t.startsWith("Внешний вид товаров")
    );
  for (let i = 0; i + 1 < leaf.length; i += 2)
    specs.push({ name: leaf[i], value: leaf[i + 1] });
}
const dBox = doc.querySelector('[data-auto="snippet-delivery-options"]');
let delivery = null;
if (dBox) {
  dBox.querySelectorAll("script,noframes,svg").forEach((x) => x.remove());
  const t = [...dBox.querySelectorAll("*")]
    .filter((x) => !x.children.length)
    .map((x) => x.textContent.trim())
    .filter(Boolean)
    .join(" ");
  const pm = t.match(/(\d[\d ]*)\s*₽/);
  delivery = {
    text: t.slice(0, 160),
    price: pm ? Number(pm[1].replace(/\s/g, "")) : null,
  };
}
const rate = ld.aggregateRating;
return {
  ok: true,
  title: ld.name,
  brand: ld.brand || null,
  sku: ld.sku,
  offerId: buy ? buy.offerId : null,
  available: /InStock/.test(ld.offers.availability),
  price: buy ? buy.price.value : ld.offers.price,
  priceCard:
    buy && buy.analytics && buy.analytics.yaBankPrice
      ? Number(buy.analytics.yaBankPrice)
      : null,
  oldPrice: buy && buy.basePrice ? buy.basePrice.value : null,
  minQty: buy ? buy.minimum : null,
  maxQty: buy ? buy.maximum : null,
  rating: rate ? { value: rate.ratingValue, count: rate.ratingCount } : null,
  shop: {
    name: buy ? buy.supplierName : text('[data-auto="shop-info-title"]'),
    rating: text('[data-auto="shop-info-rating"]'),
  },
  delivery,
  specs: specs.slice(0, 8),
  flags: buy ? buy.flags : [],
  sellers: {
    note: "one card = one seller (schema.org offerCount=1); other sellers are other cards found via search",
  },
  url: ld.url + (buy ? "?do-waremd5=" + buy.offerId : ""),
  ms: Math.round(performance.now() - T0),
};
```

**Ответ:**

| Поле                               | Тип                      | Смысл                                                           |
| ---------------------------------- | ------------------------ | --------------------------------------------------------------- |
| `title`, `brand`, `sku`, `offerId` | строки                   | `brand` может быть null                                         |
| `available`                        | bool                     | `schema.org/InStock`                                            |
| `price`                            | число                    | обычная цена (`buyOption.price`)                                |
| `priceCard`                        | число \| null            | цена с картой Пэй (`analytics.yaBankPrice`)                     |
| `oldPrice`                         | число \| null            | зачёркнутая цена (`basePrice`)                                  |
| `minQty`/`maxQty`                  | числа                    | сколько можно положить в корзину                                |
| `rating`                           | `{value, count}` \| null | оценка карточки                                                 |
| `shop`                             | `{name, rating}`         | `rating` — текст вида «4.4 330.1K оценок»                       |
| `delivery`                         | `{text, price}` \| null  | текст блока доставки и первая цена в ₽ (`219`) из него          |
| `specs`                            | `[{name,value}]`         | до 8, на карточке показываются 1–5 строк («минимальный» список) |
| `flags`                            | строки                   | `isDsbs`, `isCrossborder`… из `buyOption.flags`                 |
| `sellers`                          | объект                   | пояснение: продавец один (`offerCount = 1`)                     |

**Продавцы (до 5).** Не реализуется: в модели «карточка = продавец» других продавцов у
карточки нет (проверено на двух карточках: дешёвый кабель и iPhone 15, `offerCount = 1`,
ни ссылки `/offers`, ни блока «другие предложения» нет). Замена: `market.search` с
названием товара и `sort: price_asc` — получить сопоставимые карточки; это решение
следующей единицы.

**Фикстура:** `product.json` — поле `html`: минимальная синтетическая страница со всеми
перечисленными зацепками (то, что операция читает, и ничего лишнего).

**Сбои.** URL не карточки → `bad_argument`. Карточка снята/неверный id → `not_found` (в
ответе нет Product JSON-LD; проверено с выдуманным id). Не вошёл/капча — раздел 0.

**Замер:** 889, 1046, 839 мс, медиана **889** (позже при замедлении сети — 3,6–5,2 с).

**Устойчивость.** Хрупкие: `data-auto` имена; ключ `collections.buyOption` в `noframes`;
`analytics.yaBankPrice`. Если `buyOption` пуст — операция всё равно вернёт данные из
JSON-LD (цена из `offers.price`, `offerId` будет null). Заново: открыть карточку,
`document.querySelectorAll('noframes[data-apiary="patch"]')` и найти патч с `buyOption`.

## 3. `market.cart` — корзина (чтение)

**Зачем человеку.** «Что у меня в корзине и сколько это стоит».

**Запрос.** `GET /my/cart` (SSR-страница, 1,4 МБ). Позиции — `[data-zone-name="productSnippet"]`
с JSON в `data-zone-data` (цены, лимиты), идентификаторы корзины (`cartItemId`, количество)
— объект `"cartModel":{…}` в HTML (сбалансированные скобки, не regexp), итоги —
`[data-auto="total-price"]` («с картой») и `total-price-without-card`.

**JS:**

```js
const pg = await getPage("/my/cart");
if (pg.error) return pg.error;
const { doc, html } = pg;
// cartModel (offerId -> cartItemId, count) sits in the page state as plain JSON: cut the balanced object out of the HTML
let model = {};
const at = html.indexOf('"cartModel":{');
if (at >= 0) {
  let depth = 0,
    end = -1;
  for (let i = at + 12; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  try {
    model = JSON.parse(html.slice(at + 12, end)).items || {};
  } catch (e) {}
}
const txt = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : null);
const money = (s) => {
  const m = s && s.match(/(\d[\d ]*)\s*₽/);
  return m ? Number(m[1].replace(/\s/g, "")) : null;
};
const items = [];
doc.querySelectorAll('[data-zone-name="productSnippet"]').forEach((s) => {
  let zd;
  try {
    zd = JSON.parse(s.getAttribute("data-zone-data"));
  } catch (e) {
    return;
  }
  if (!zd || zd.type !== "offer") return;
  const m = model[zd.wareId] || {};
  const card = (zd.loyaltyPrices || []).find((p) => p.priceType === "yaBank");
  const disc = (zd.loyaltyPrices || []).find(
    (p) => p.priceType === "withDiscount"
  );
  items.push({
    offerId: zd.wareId,
    cartItemId: m.cartItemId || null,
    title: txt(s.querySelector('[data-auto="snippet-title"]')),
    count: m.count || zd.itemsCount,
    maxCount: zd.maxQuantity || null,
    available: zd.isAvailable !== false,
    price: disc
      ? disc.priceValue
      : money(txt(s.querySelector('[data-auto="snippet-price-current"]'))),
    priceCard: card ? card.priceValue : null,
    oldPrice: zd.price && disc && zd.price > disc.priceValue ? zd.price : null,
    delivery: txt(s.querySelector('[data-auto="delivery-wrapper"]')),
  });
});
const total = money(txt(doc.querySelector('[data-auto="total-price"]')));
const totalNoCard = money(
  txt(doc.querySelector('[data-auto="total-price-without-card"]'))
);
return {
  ok: true,
  count: items.length,
  items,
  total: {
    withCard: total,
    withoutCard: totalNoCard,
    line: txt(doc.querySelector('[data-auto="item-summary-info"]')),
  },
  ms: Math.round(performance.now() - T0),
};
```

**Ответ:** `items[]`: `offerId`, `cartItemId`, `title`, `count`, `maxCount`, `available`,
`price` (обычная), `priceCard`, `oldPrice`, `delivery` (текст); `total`: `{withCard,
withoutCard, line}`. Пустая корзина — `count: 0, items: []` (**не проверено** на живой
пустой корзине: корзину владельца нельзя опустошать; структура страницы без позиций не
наблюдалась).

**Фикстура:** `cart.json` (`html`).

**Сбои:** раздел 0. Если `cartModel` не найден — `cartItemId: null` у всех позиций
(`market.cart_remove` тогда вернёт `not_in_cart`).

**Замер:** 811, 546, 577 мс, медиана **577**.

**Устойчивость.** Хрупко: имена `data-auto`/`data-zone-name`, форма `data-zone-data`
(`loyaltyPrices[priceType=yaBank|withDiscount]`), ключ `cartModel`. Заново: сохранить
HTML `/my/cart` и поискать название позиции — оно лежит в JSON внутри `data-zone-data`.

## 4. `market.cart_add` — добавить товар в корзину (запись)

**Зачем человеку.** «Положи это в корзину» (оформление и оплата — только через `browser_task`).

**Запрос.** Сначала `GET <url карточки>` (чтобы взять `offerId` и `feeShow` из
`collections.buyOption`; `feeShow` — подписанный токен показа, одноразовость **не проверена**),
затем

`POST /api/web/market.front.purchaseCore.PurchaseCore/prepareCartModelAddItems`

Заголовки: `content-type: application/json`, `sk`, `x-market-apphost-target: ACTUALIZER`,
`x-market-page-id: market:cart`, `x-market-core-service: mf-search-desktop`,
`x-requested-with: XMLHttpRequest`. Тело:
`{"path":"/my/cart","params":{"items":[{"offerId":"…","feeShow":"…"}],"settings":{"buttonType":"FLAT","isSins":false,"isSeparatedDomainSins":false}}}`.

Достаточно `offerId` + `feeShow` (проверено: `cpc`, `encryptedUrl`, `cpaUrl` страница шлёт, но не
нужны). Только `offerId` → HTTP 500 `CartButtonAction node error`. Только `offerId + cpc` →
тот же 500. Ответ содержит всю корзину (`collections.cartModel`). Повторное добавление
уже лежащей позиции: **не проверено** (не стал менять количество в корзине владельца).

**JS:**

```js
const args = {
  url: "/card/kabel-usb-type-c-dlya-samsung-s20-s9-s8-xiaomi-huawei-p30-pro-5-a-1-m-03-m/103686617517?do-waremd5=uGdX3w9c5mASBYDfYQutVw",
};
const path = args.url.replace(/^https:\/\/market\.yandex\.ru/, "");
if (!/^\/card\/[^/?#]+\/\d+/.test(path))
  return fail(
    "bad_argument",
    "url must look like /card/<slug>/<sku>?do-waremd5=<offerId>"
  );
const pg = await getPage(path);
if (pg.error) return pg.error;
let buy = null;
pg.doc.querySelectorAll('noframes[data-apiary="patch"]').forEach((n) => {
  if (buy || !n.textContent.includes('"buyOption"')) return;
  try {
    const c = JSON.parse(n.textContent).collections;
    if (c && c.buyOption) buy = Object.values(c.buyOption)[0];
  } catch (e) {}
});
if (!buy || !buy.offerId || !buy.feeShow)
  return fail("not_found", "no buyOption with feeShow on the card page");
const sk = await getSk();
if (!sk) return fail("not_signed_in", "no sk");
await sleep(1100);
const r = await fetch(
  "/api/web/market.front.purchaseCore.PurchaseCore/prepareCartModelAddItems",
  {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      sk,
      "x-market-apphost-target": "ACTUALIZER",
      "x-market-page-id": "market:cart",
      "x-market-core-service": "mf-search-desktop",
      "x-requested-with": "XMLHttpRequest",
    },
    body: JSON.stringify({
      path: "/my/cart",
      params: {
        items: [{ offerId: buy.offerId, feeShow: buy.feeShow }],
        settings: {
          buttonType: "FLAT",
          isSins: false,
          isSeparatedDomainSins: false,
        },
      },
    }),
  }
);
if (/showcaptcha|captcha/.test(r.url) || r.status === 429)
  return fail("captcha", "cart add");
const j = await r.json();
const cm = j.result && j.result.collections && j.result.collections.cartModel;
if (!cm)
  return fail(
    "add_failed",
    "status " + r.status + " " + JSON.stringify(j.error || j).slice(0, 200)
  );
const mine = cm.items[buy.offerId];
return {
  ok: true,
  offerId: buy.offerId,
  title: buy.title,
  count: mine ? mine.count : null,
  cartItemId: mine ? mine.cartItemId : null,
  cartPositions: cm.carts.market ? cm.carts.market.count : null,
  ms: Math.round(performance.now() - T0),
};
```

**Ответ:** `{ok, offerId, title, count, cartItemId, cartPositions}` — количество этой позиции и
число позиций в корзине после добавления.

**Фикстура:** `cart_add.json`: запрос, ответ 200, ответ 500 «без feeShow».

**Сбои:** нет `buyOption/feeShow` на странице → `not_found`; ответ без `cartModel` →
`add_failed` с текстом (`status 500 {"name":"ResolveCartModelAddItemsResponseError"…`);
раздел 0.

**Замер** (добавление дешёвого кабеля владельцу; цикл «добавить → убрать» ×3 прошёл,
корзина вернулась к исходной): 2441, 2252, 2916 мс (включают загрузку карточки и паузу
1,1 с), медиана **2441**.

**Устойчивость.** Имена `PurchaseCore.prepareCartModelAddItems` — часть внутреннего
API (`market.front.<сервис>.<Класс>/<метод>`), стабильнее CSS, но может смениться. Заново:
`cdp.py record` на поиске с кликом `[data-auto="cartButton"]` (в записи нужен `type`
`Fetch` и POST `/api/web/…/prepareCartModelAddItems`); обратите внимание: страница сама
вызывает `fetch(new Request(...))` — тело читать из `request.clone().text()`.

## 5. `market.cart_remove` — убрать позицию / задать количество (запись)

**Зачем человеку.** «Убери это из корзины».

**Запрос.** Сначала `GET /my/cart` (нужен `cartItemId` из `cartModel`), затем

`POST /api/web/market.front.purchaseCore.PurchaseCore/prepareCartModelChangeAmount`, те же
заголовки, тело `{"path":"/my/cart","params":{"items":[{"offerId":"…","cartItemId":"…","count":0}]}}`.
`count: 0` удаляет позицию (проверено); `count` > 0 по смыслу задаёт количество
(**не проверено**, кроме нуля). Ответ — вся корзина после изменения.

**JS:**

```js
const args = { offerId: "uGdX3w9c5mASBYDfYQutVw", count: 0 }; // count 0 removes the position; 1..maxCount sets the quantity
const pg = await getPage("/my/cart");
if (pg.error) return pg.error;
const html = pg.html;
let model = {};
const at = html.indexOf('"cartModel":{');
if (at >= 0) {
  let depth = 0,
    end = -1;
  for (let i = at + 12; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  try {
    model = JSON.parse(html.slice(at + 12, end)).items || {};
  } catch (e) {}
}
const it = model[args.offerId];
if (!it) return fail("not_in_cart", args.offerId + " is not in the cart");
const sk = await getSk();
if (!sk) return fail("not_signed_in", "no sk");
await sleep(1100);
const r = await fetch(
  "/api/web/market.front.purchaseCore.PurchaseCore/prepareCartModelChangeAmount",
  {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      sk,
      "x-market-apphost-target": "ACTUALIZER",
      "x-market-page-id": "market:cart",
      "x-market-core-service": "mf-search-desktop",
      "x-requested-with": "XMLHttpRequest",
    },
    body: JSON.stringify({
      path: "/my/cart",
      params: {
        items: [
          { offerId: it.offerId, cartItemId: it.cartItemId, count: args.count },
        ],
      },
    }),
  }
);
if (/showcaptcha|captcha/.test(r.url) || r.status === 429)
  return fail("captcha", "cart change");
const j = await r.json();
const cm = j.result && j.result.collections && j.result.collections.cartModel;
if (!cm)
  return fail(
    "change_failed",
    "status " + r.status + " " + JSON.stringify(j.error || j).slice(0, 200)
  );
const left = cm.items[args.offerId];
return {
  ok: true,
  offerId: args.offerId,
  count: left ? left.count : 0,
  cartPositions: cm.carts.market ? cm.carts.market.count : 0,
  ms: Math.round(performance.now() - T0),
};
```

**Ответ:** `{ok, offerId, count (остаток), cartPositions}`.

**Фикстура:** `cart_remove.json`.

**Сбои:** позиции нет в корзине → `not_in_cart` (проверено); `change_failed`; раздел 0.

**Замер:** 2703, 2090, 2371 мс, медиана **2371**.

**Устойчивость.** Как у `cart_add`. Страничная кнопка «−» у позиции при количестве 1
вызывает тот же `prepareCartModelChangeAmount` (в части запусков запрос ушёл позже окна
записи; прямой вызов надёжнее).

## 6. `market.orders` — заказы (чтение)

**Зачем человеку.** «Где мой заказ», «что я заказывал».

**Запрос.** `GET /my/orders` — активные, `GET /my/orders?filter=COMPLETED` — завершённые и
отменённые. Список лежит в `<noframes data-apiary="patch">` как JSON
`widgets["@mf-offline/OrdersListPage"]["/content/page"].ordersList.ordersGroups`; операция
ищет по структуре (массив, у элементов которого есть `orders[]` и `onClick.name ==
"show_order"`), а не по пути. Группа = один заказ или консолидированная поставка:
`title[].value` — статус и дата («Получен 28 мая», «Отменён 5 июля»), `subtitle1[].value` —
способ доставки и адрес, `orders[].items[].title` — товары. Заказов в странице 16, дальше
подгрузка (**не исследовано**, последних 10 достаточно). Суммы в списке **нет**.

**JS:**

```js
const args = { status: "completed", limit: 10, withTotals: false }; // status: 'active' | 'completed'
const pg = await getPage(
  args.status === "active" ? "/my/orders" : "/my/orders?filter=COMPLETED"
);
if (pg.error) return pg.error;
// the list is a widget patch (JSON in <noframes>): find the array of groups instead of trusting its path
let groups = null;
const walk = (o) => {
  if (groups) return;
  if (Array.isArray(o)) {
    if (
      o.length &&
      o.every(
        (x) =>
          x &&
          typeof x === "object" &&
          x.onClick &&
          x.onClick.name === "show_order" &&
          Array.isArray(x.orders)
      )
    ) {
      groups = o;
      return;
    }
    o.forEach(walk);
  } else if (o && typeof o === "object") for (const k in o) walk(o[k]);
};
pg.doc.querySelectorAll('noframes[data-apiary="patch"]').forEach((n) => {
  if (groups || !n.textContent.includes("show_order")) return;
  try {
    walk(JSON.parse(n.textContent).widgets);
  } catch (e) {}
});
if (!groups) {
  if (pg.doc.querySelector('[data-auto="ordersEmptyList"]'))
    return {
      ok: true,
      status: args.status,
      count: 0,
      orders: [],
      note: "empty list",
      ms: Math.round(performance.now() - T0),
    };
  return fail(
    "bad_response",
    "orders list widget not found (page layout changed)"
  );
}
const val = (a) => (a || []).map((x) => x.value).filter(Boolean);
const orders = groups.slice(0, args.limit).map((g) => ({
  orderIds: g.orders.map((o) => o.id),
  status: val(g.title).join(" "),
  delivery: val(g.subtitle1).join(" · "),
  items: g.orders.flatMap((o) => o.items.map((i) => val(i.title).join(" "))),
}));
if (args.withTotals) {
  for (const o of orders) {
    await sleep(1100);
    const d = await getPage("/my/order/" + o.orderIds[0]);
    if (d.error) return d.error;
    const m = (d.doc.querySelector('[data-auto="total-price"]') || {})
      .textContent;
    const mm = m && m.match(/Итого\s*([\d\s ]+)/);
    o.total = mm ? Number(mm[1].replace(/\D/g, "")) : null;
  }
}
return {
  ok: true,
  status: args.status,
  count: orders.length,
  orders,
  ms: Math.round(performance.now() - T0),
};
```

**Ответ:** `orders[]`: `orderIds[]`, `status`, `delivery`, `items[]` (названия); с
`withTotals: true` — ещё `total` (₽) из страницы заказа. Пустой список — `note: 'empty list'`
(проверено: у аккаунта нет активных заказов, блок `[data-auto="ordersEmptyList"]`).

**Что не видел.** Форму **активного** заказа в пути (у владельца их нет): ожидается та же
структура групп со статусом вроде «Едет к вам»/«Привезём 12 октября» и пунктом выдачи в
`subtitle1`; проверить при первом настоящем заказе. Статус отмены и получения — видел.

**Фикстура:** `orders.json`: поле `html` (3 заказа) и `html_empty` (пустой список).

**Замер:** без сумм 626, 708, 663 мс, медиана **663**; `withTotals` для 10 заказов — 17,7 с
(10 запросов страниц заказа через 1,1 с) — вызывайте только для одного-двух заказов или
берите суммы через `market.order`.

**Устойчивость.** Хрупко: `ordersGroups`/`show_order` (ищется по структуре), `ordersEmptyList`.
Если `bad_response` — открыть `/my/orders?filter=COMPLETED`, взять в DevTools
`<noframes data-apiary="patch">` с текстом `show_order`.

## 7. `market.order` — один заказ (чтение)

**Зачем человеку.** «Когда приедет заказ №…», «что в нём и сколько заплатил».

**Запрос.** `GET /my/order/<orderId>` (SSR, 1,6 МБ). Разбор DOM по `data-auto`/`data-zone-name`:
`order-page`, `order-number`, `orderDetailsView` (`h4` — статус, следующий `span` —
пояснение), `orderDeliveryInfoItem` (пары метка/значение: «Пункт выдачи», «Постамат», «Доставка
экспресс», «Дата отмены»), `order-item`, `total-price`, `payment-info`.

**JS:**

```js
const args = { orderId: "111222333" };
if (!/^\d{5,12}$/.test(args.orderId))
  return fail("bad_argument", "orderId must be digits");
const pg = await getPage("/my/order/" + args.orderId);
if (pg.error) return pg.error;
const { doc } = pg;
const root = doc.querySelector('[data-auto="order-page"]');
if (!root || !root.querySelector('[data-auto="order-number"]'))
  return fail("not_found", "order page missing (wrong id or not your order)");
root.querySelectorAll("script,style,noframes,svg").forEach((x) => x.remove());
const t = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : null);
const rub = (s) => {
  const m = s && s.match(/(–\s*)?(\d[\d\s ]*)\s*₽/);
  return m ? (m[1] ? -1 : 1) * Number(m[2].replace(/\D/g, "")) : null;
};
const view = root.querySelector('[data-zone-name="orderDetailsView"]');
const head = view && view.querySelector("h4");
// delivery block: label/value pairs; the recipient row (name, phone, e-mail) is deliberately not returned
const info = {};
root
  .querySelectorAll('[data-zone-name="orderDeliveryInfoItem"]')
  .forEach((row) => {
    const spans = [...row.querySelectorAll("span")]
      .map((s) => t(s))
      .filter(Boolean);
    if (spans.length >= 2 && spans[0] !== "Получатель")
      info[spans[0]] = spans
        .slice(1)
        .join(" ")
        .replace(/\s+Подъезд.*$/, "");
  });
const items = [...root.querySelectorAll('[data-auto="order-item"]')].map(
  (el) => {
    const box = el.parentElement;
    const spans = [...box.querySelectorAll("span")]
      .map((s) => t(s))
      .filter(Boolean);
    const qty = spans.find((s) => /^\d+ шт/.test(s));
    const prices = spans
      .filter((s) => /^\d[\d\s]*$/.test(s))
      .map((s) => Number(s.replace(/\s/g, "")));
    return {
      title: spans[0],
      price: prices[0] || null,
      oldPrice: prices[1] || null,
      qty: qty ? Number(qty.match(/\d+/)[0]) : 1,
    };
  }
);
const lines = {};
const txt = t(root);
for (const [key, label] of [
  ["discount", "Скидка на товары"],
  ["delivery", "Доставка"],
  ["total", "Итого"],
]) {
  const m = txt.match(
    new RegExp(label + "\\s*(–\\s*)?(\\d[\\d\\s\\u00a0]*)\\s*₽")
  );
  lines[key] = m ? (m[1] ? -1 : 1) * Number(m[2].replace(/\D/g, "")) : null;
}
return {
  ok: true,
  orderId: args.orderId,
  number: t(root.querySelector('[data-auto="order-number"]')),
  created: (txt.match(/от (\d{1,2} [а-я]+ \d{4})/) || [])[1] || null,
  status: head ? t(head) : null,
  statusNote: head ? t(head.parentElement.nextElementSibling) : null,
  delivery: info,
  items,
  totals: lines,
  payment: t(
    (root.querySelector('[data-zone-name="payment-info"]') || {})
      .querySelector &&
      root.querySelector('[data-zone-name="payment-info"] span')
  ),
  url: "/my/order/" + args.orderId,
  ms: Math.round(performance.now() - T0),
};
```

**Ответ:** `{number, created, status, statusNote, delivery{метка: значение}, items[{title,
price, oldPrice, qty}], totals{discount, delivery, total}, payment, url}`.

**Персональные данные.** Блок «Получатель» (имя, телефон, почта) операция **не читает** и не
возвращает. Из адреса курьерской доставки срезается «Подъезд…, этаж…, домофон…» (код домофона
в память Бро попадать не должен).

**Фикстура:** `order.json` (`html`, выдуманный адрес и заказ).

**Сбои:** нечисловой id → `bad_argument`; чужой/несуществующий заказ → `not_found`
(проверено: страница рендерится без `order-number`); раздел 0.

**Замер:** 618, 538, 571 мс, медиана **571**.

**Устойчивость.** Хрупко: порядок `span` внутри `order-item` (название, цена, зачёркнутая цена, «N шт»), метки «Скидка
на товары»/«Доставка»/«Итого» (по тексту). Заново: сохранить HTML своего заказа и сверить
текст.

## 8. Сводка замеров

| Операция                   | Запросов | Медиана в странице, мс |
| -------------------------- | -------- | ---------------------- |
| `market.search` (≤ 8)      | 1        | 1180                   |
| `market.search` (10)       | 2        | 4588                   |
| `market.product`           | 1        | 889                    |
| `market.cart`              | 1        | 577                    |
| `market.cart_add`          | 2        | 2441                   |
| `market.cart_remove`       | 2        | 2371                   |
| `market.orders`            | 1        | 663                    |
| `market.order`             | 1        | 571                    |
| открытие вкладки + главная | —        | 4200–4400              |

Часть измерений снята до того, как сеть браузера пула замедлилась (повторные запуски шли
3–5 с на тех же запросах): при планировании таймаутов закладывайте 3–5-кратный запас.

## 9. Что не удалось и что оставить `browser_task`

- **Оформление заказа и оплата.** Не исследовались по условию (не нажимал). Это обычный
  `POST` через `PurchaseCore`/кассу со страницы `/my/checkout` с выбором адреса, способа
  оплаты и подтверждением; оставить `browser_task` с «да» человека.
- **Активные заказы** (форма и статусы «в пути») — на аккаунте их нет, структура выведена
  по завершённым; перепроверить на первом настоящем заказе.
- **Продавцы товара.** В модели «карточка = продавец» вариантов нет; сопоставление идёт
  поиском.
- **Цена доставки в выдаче.** В `market.search` не приходит; есть в `market.product`.
- **Второй вход/капча.** Не воспроизводились (аккаунт нельзя выводить).
- **Повторное добавление** уже лежащей позиции и **установка количества > 0** не
  проверялись, чтобы не менять корзину владельца.
- **Корзина владельца не пуста** (одна позиция) — исходная корзина записана до проверок и
  восстановлена точно после (проверено повторным чтением: тот же `cartItemId` и количество).
