# Яндекс Карты: разведка веб-API (10.10.2026)

Спецификация для кода операций `maps.search` и `maps.org` инструмента `yandex`.
Сняты запросы `yandex.ru/maps` из браузера пула Бро, вошедшего в аккаунт владельца
(только чтение, ничего не бронировалось). Фикстуры — `tests/fixtures/yandex/maps/*.json`,
значения выдуманы, структура настоящая.

## Общее

|                           |                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| origin вкладки            | `https://yandex.ru/maps/` (подойдёт и `/maps/org/<id>/`)                                                                              |
| загрузка (`cdp.py check`) | ≈ 3,7 с                                                                                                                               |
| «не вошёл»                | `signedIn: false` в `check`. Для поиска и карточки вход **не нужен**; нужен лишь для личного (закладки, «мои брони»), его мы не берём |
| капча                     | не встретилась; ждать `/showcaptcha` или ответ 4xx с HTML                                                                             |

### Защита запросов: `csrfToken`, `sessionId`, подпись `s`

Все запросы `/maps/api/*` и `/web-maps/api/*` идут GET с тремя служебными параметрами:

1. **`csrfToken`** и **`sessionId`** — из JSON-скрипта страницы. Это `<script type="application/json">`
   (≈ 0,35–8 МБ), в начале которого `{"config":{…"csrfToken":"<40 hex>:<unix>","sessionId":"<…>-BAL"…}}`.
   Достаём регэкспом `/"csrfToken":"([^"]+)"/` и `/"sessionId":"([^"]+)"/` по `textContent` скрипта,
   в котором есть `"csrfToken"`. Если скрипта нет (страница ещё не прогрузилась) — запасной путь:
   `fetch("/maps/")` и тот же регэксп по HTML. Токен живёт часы, привязан к cookie `yandexuid`.
2. **`s`** — подпись: 32-битный хэш строки запроса **без** самого `s`:
   `h = 5381; для каждого байта UTF-8: h = ((h << 5) + h) ^ b` (беззнаковое 32 бита).
   Проверено на записанном трафике (сошлось до цифры). Хэш считается по **уже
   закодированной** строке запроса.
3. **Порядок параметров — по алфавиту ключей** (`ajax, csrfToken, …, s, …, sessionId`) и
   кодирование `encodeURIComponent` для ключей **и** значений (в том числе `serviceIds%5B0%5D`).
   Без этого в первых пробах приходило `400 Bad Request`. `s` дописываем в конец строки — сервер
   принимает; хэш — от всего остального.

Остальное (`x-maps-internal-data`, `rearr`, `test-buckets`, десятки `snippets`) сервер не требует:
минимальный запрос выше отвечает полным списком.

Общий префикс для всех JS ниже (подставляется перед телом операции):

```js
const ctxText = [...document.scripts]
  .map((s) => (s.type === "application/json" ? s.textContent : ""))
  .find((t) => t.includes('"csrfToken"'));
let csrfToken, sessionId;
if (ctxText) {
  csrfToken = ctxText.match(/"csrfToken":"([^"]+)"/)[1];
  sessionId = ctxText.match(/"sessionId":"([^"]+)"/)[1];
} else {
  const html = await (await fetch("/maps/")).text();
  csrfToken = html.match(/"csrfToken":"([^"]+)"/)[1];
  sessionId = html.match(/"sessionId":"([^"]+)"/)[1];
}
const sign = (t) => {
  let h = 5381;
  for (const b of new TextEncoder().encode(t)) h = (((h << 5) + h) ^ b) >>> 0;
  return h;
};
const call = async (path, params) => {
  const p = [
    ["ajax", "1"],
    ["csrfToken", csrfToken],
    ["sessionId", sessionId],
    ...params,
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const qs = p
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
  const r = await fetch(path + "?" + qs + "&s=" + sign(qs));
  if (r.status !== 200) return { error: "http_" + r.status };
  const j = await r.json();
  return j.error ? { error: "api_" + j.error.code } : j.data;
};
```

Вызов с протухшим токеном (или без cookie): HTTP 200 и тело `{"csrfToken":"<новый>"}` без `data`
(фикстура `csrf-retry.json`). Код операции в этом случае берёт новый токен и повторяет запрос один раз.

## maps.search — организации по запросу и району

**Зачем:** «найди пиццерию рядом, открытую сейчас»; чтение.

**Запрос:** `GET /maps/api/search?ajax=1&csrfToken=…&lang=ru_RU&ll=<lon>,<lat>&origin=maps-form&results=<1..25>&sessionId=…&snippets=businessrating/1.x,bookings/1.x&spn=<dlon>,<dlat>&text=<запрос>&z=<масштаб>&s=<подпись>`.
Без `snippets=businessrating/1.x` рейтинг приходит нулями, без `bookings/1.x` нет объекта `booking`.
`ll` — центр **[долгота, широта]**, `spn` — размер окна (≈ 0,06×0,03 — район). Для поиска
«рядом с адресом» Бро сначала получает координаты адреса (например, через `go.estimate` suggest или
`maps.search` по адресу — первый `items[0].coordinates`). Фильтр «открыто сейчас» в ответе
по полям (`openNow`), отдельного параметра не требуется.

**JS:**

```js
const args = {
  query: "пиццерия",
  ll: [37.6177, 55.755863],
  spn: [0.06, 0.03],
  limit: 10,
};
const d = await call("/maps/api/search", [
  ["lang", "ru_RU"],
  ["ll", args.ll.join(",")],
  ["spn", args.spn.join(",")],
  ["origin", "maps-form"],
  ["results", String(args.limit)],
  ["snippets", "businessrating/1.x,bookings/1.x"],
  ["text", args.query],
  ["z", "14"],
]);
if (d.error) return d;
const places = (d.items || [])
  .filter((i) => i.type === "business")
  .slice(0, args.limit)
  .map((i) => ({
    id: i.id,
    name: i.title,
    address: i.fullAddress || i.address,
    rating: i.ratingData
      ? Math.round(i.ratingData.ratingValue * 10) / 10
      : null,
    ratingCount: i.ratingData ? i.ratingData.ratingCount : null,
    category: (i.categories || [])[0] ? i.categories[0].name : null,
    hours: i.workingTimeText || null,
    openNow: i.currentWorkingStatus ? i.currentWorkingStatus.isOpenNow : null,
    openText: i.currentWorkingStatus ? i.currentWorkingStatus.text : null,
    phone: (i.phones || [])[0] ? i.phones[0].number : null,
    site: (i.urls || [])[0] ? i.urls[0].split("?")[0] : null,
    bookable: !!i.booking,
    coordinates: i.coordinates,
    url: "https://yandex.ru/maps/org/" + i.seoname + "/" + i.id + "/",
  }));
return { total: d.totalResultCount, places };
```

**Ответ (ужатый):** `{total: number, places: [{id, name, address, rating: number|null, ratingCount: number|null,
category: string|null, hours: string|null (напр. «ежедневно, 10:00–22:00»), openNow: boolean|null,
openText: string|null («Открыто до 22:00»), phone: string|null, site: string|null (без utm),
bookable: boolean (есть онлайн-бронь), coordinates: [lon, lat], url}]}`. Не больше 10 мест.
Первым в списке нередко идёт рекламная организация (порядок меняется от запроса к запросу).
Сырой ответ — `search.json` (в нём есть не-`business` элементы вроде подборок `collection` — код отбрасывает).

**Сбои:** устаревший токен — см. выше; неверная подпись/порядок — `{error:"http_400"}`; пустая
выдача — `totalResultCount: 0`, `items: []`.
**Замер:** 661 / 695 / 1055 → медиана **695 мс**.
**Устойчивость:** версия сборки в самих запросах не нужна; `snippets` — перечень имён, при их
переименовании рейтинг снова станет нулевым (проверять, что `ratingCount > 0` у заведомо
популярного места). Алгоритм `s` — часть JS фронтенда Карт, при смене ответ будет 400.

## maps.org — карточка организации, отзывы, брони

**Зачем:** «часы работы, отзывы, можно ли забронировать столик и на когда»; только чтение.

**Запросы (три, последовательно, с паузой ≥ 1 с):**

1. Карточка: `GET /maps/api/search?mode=uri&uri=ymapsbm1://org?oid=<id>&lang=ru_RU&origin=maps-bookmark&snippets=businessrating/1.x,bookings/1.x` (+ служебные). `<id>` — число из ссылки
   `…/maps/org/<seoname>/<id>/`. Ссылку разбирают регэкспом `/org/(?:[^/]+/)?(\d+)/`.
2. Отзывы: `GET /maps/api/business/fetchReviews?businessId=<id>&locale=ru_RU&page=1&pageSize=3&ranking=by_relevance_org`
   (`ranking=by_time` — свежие). Поля отзыва: `rating`, `text`, `updatedTime`, `author.name`,
   `businessComment` (ответ заведения). Имя автора **не** берём в ужатый ответ.
3. Свободное время (только если `item.booking.slotsWidgetAvailable`):
   `GET /web-maps/api/slow/booking/getTimeslots?date=<YYYY-MM-DD>&permalink=<id>&serviceIds[0]=guests:<N>`
   (+ служебные); даты, на которые есть слоты, — `GET /web-maps/api/slow/booking/getDates?from=<дата>&permalink=<id>&serviceIds[0]=guests:<N>&to=<дата>`
   (окно ≈ 14 дней; `to` обязателен, иначе 500). Ответ — `{"data":[{"datetime":"2026-10-12T12:00:00+03:00"},…]}`
   (шаг ≈ 40 минут). Сервис-партнёр брони (`booking.partner.name`, например «Яндекс Еда») отдаёт слоты
   сам; сама **бронь не отправлялась и не описана** — это `browser_task` с «да» человека.

**JS:**

```js
const args = { id: "1000000000001", date: "2026-10-12", guests: 2 };
const card = await call("/maps/api/search", [
  ["lang", "ru_RU"],
  ["mode", "uri"],
  ["origin", "maps-bookmark"],
  ["snippets", "businessrating/1.x,bookings/1.x"],
  ["uri", "ymapsbm1://org?oid=" + args.id],
]);
if (card.error) return card;
const i = (card.items || [])[0];
if (!i) return { error: "not_found" };
const rv = await call("/maps/api/business/fetchReviews", [
  ["businessId", args.id],
  ["locale", "ru_RU"],
  ["page", "1"],
  ["pageSize", "3"],
  ["ranking", "by_relevance_org"],
]);
const reviews = rv.error
  ? []
  : (rv.reviews || []).slice(0, 3).map((r) => ({
      rating: r.rating,
      text: (r.text || "").split(/(?<=[.!?])\s/)[0].slice(0, 160),
      date: (r.updatedTime || "").slice(0, 10),
    }));
let booking = null;
if (i.booking && i.booking.slotsWidgetAvailable) {
  const slots = await call("/web-maps/api/slow/booking/getTimeslots", [
    ["date", args.date],
    ["permalink", args.id],
    ["serviceIds[0]", "guests:" + args.guests],
  ]);
  booking = {
    partner: i.booking.partner ? i.booking.partner.name : null,
    type: i.booking.bookingType,
    date: args.date,
    guests: args.guests,
    slots: slots.error
      ? slots
      : (slots || []).map((s) => s.datetime.slice(11, 16)),
  };
}
return {
  id: i.id,
  name: i.title,
  address: i.fullAddress,
  category: (i.categories || [])[0] ? i.categories[0].name : null,
  rating: i.ratingData ? Math.round(i.ratingData.ratingValue * 10) / 10 : null,
  ratingCount: i.ratingData ? i.ratingData.ratingCount : null,
  hours: i.workingTimeText || null,
  week: (i.workingTime || []).map((d) =>
    d
      .map(
        (x) =>
          `${x.from.hours}:${String(x.from.minutes).padStart(2, "0")}-${x.to.hours}:${String(x.to.minutes).padStart(2, "0")}`
      )
      .join(",")
  ),
  openNow: i.currentWorkingStatus ? i.currentWorkingStatus.isOpenNow : null,
  phone: (i.phones || [])[0] ? i.phones[0].number : null,
  site: (i.urls || [])[0] ? i.urls[0].split("?")[0] : null,
  reviews,
  booking,
};
```

**Ответ (ужатый):** `{id, name, address, category, rating, ratingCount, hours (текст), week: string[7]
(«12:00-0:00» по дням, пн первый; вместе «0:00» — полночь), openNow, phone, site, reviews: [{rating, text
(первая фраза, ≤160 знаков), date (YYYY-MM-DD)}] (≤3), booking: null | {partner, type, date, guests, slots: string[] («HH:MM»)
| {error}}}`. Фикстуры: `org.json`, `reviews.json`, `booking-dates.json`, `booking-timeslots.json`.

**Сбои:** неверный `id` — `items` пуст → `{error:"not_found"}`; нет онлайн-брони — `booking: null`; на дату
без слотов — `slots: []`; без `to` в `getDates` — `{"error":{"code":500,…}}` (внутри HTTP 200).
**Замер:** 1609 / 791 / 816 → медиана **816 мс** (три запроса подряд, без пауз между ними в
замере; в коде нужна пауза ≈ 1 с, реально ≈ 3 с).
**Устойчивость:** `ranking`-значения и `pageSize` брать из сети страницы отзывов (`fetchReviews`), если сервер
начнёт отвечать 400; `permalink` в брони равен `oid`.

## Не удалось / что отдать `browser_task`

- **Бронь столика** (отправка, ввод телефона, подтверждение) — не описана, по правилам не отправлялась.
- Личное (избранное, «мои отзывы», история маршрутов) не снималось.
- Запросы без cookie проверены лишь по границе: старый токен → `{"csrfToken":…}`; поиск без входа
  с новым токеном вероятно работает, но полноценно не проверялся.
