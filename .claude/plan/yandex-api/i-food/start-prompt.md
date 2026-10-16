# Единица `i-food`: операции Яндекс Еды и Лавки в инструменте `yandex`

Ты добавляешь операции Еды и Лавки в готовый каркас инструмента `yandex`, и
только их. Каркас (транспорт, реестр, флаг) уже в `bro-next` (PR #355),
спецификация — `docs/yandex-api/food.md` с фикстурами
`tests/fixtures/yandex/food/` (PR #354).

Координатор — сессия `session_01NEromtYDiw5mtYrLKHCiwU` (сообщения ей —
`send_message`). Параллельно могут идти другие `i-*`: они добавляют свои
файлы в `agent/lib/yandex/<сервис>/` и по строке в `registry.ts`. Чужие файлы
не трогай; конфликт в `registry.ts` при слиянии решает координатор.

## Прочитай сначала

- `PROTOCOL.md` из служебной ветки
  (`git fetch origin claude/eager-pasteur-hb6lvn && git show origin/claude/eager-pasteur-hb6lvn:.claude/plan/yandex-api/PROTOCOL.md`).
- `agent/lib/yandex/operations.ts` (`defineYandexOperation`, его комментарий —
  контракт), `agent/lib/yandex/status.ts` (образец операции),
  `agent/lib/yandex/registry.ts`, `agent/tools/yandex.ts`.
- `docs/yandex-api/food.md` целиком: в нём JS каждой операции, проверенный на
  живом аккаунте, схемы ответов и сбои.

## Что сделать

Файлы `agent/lib/yandex/food/` (нижний регистр, по роли: например
`orders.ts`, `search.ts`, `menu.ts`, `cart.ts`, `addresses.ts`), каждый
экспортирует операции через `defineYandexOperation`; одна строка в
`registry.ts` подключает их все.

Операции (id — как ниже; все `access: "read"`):

- `food.orders` — последние заказы Еды и Лавки. Это два origin, а функция
  страницы ходит только на свой origin, поэтому две операции:
  `food.eda_orders` (origin `https://eda.yandex.ru/`) и `food.lavka_orders`
  (`https://lavka.yandex.ru/`).
- `food.lavka_addresses` — сохранённые адреса из Лавки (подпись и
  улица с домом, координаты): их берут для поиска в Еде, сама Еда адреса не
  знает. В `about` скажи модели, что координаты для `food.eda_search` брать
  отсюда.
- `food.eda_search` (args: `query`, `lat`, `lon`, `limit` ≤ 10) и
  `food.lavka_search` (args: `query`, `limit`; Лавка берёт выбранный адрес сама).
- `food.eda_menu` (args: `slug` заведения из поиска; до 30 позиций).
- `food.eda_cart`, `food.lavka_cart` — корзины на чтение.
- `food.lavka_active` — активные заказы Лавки (`tracked-orders`); у Еды
  эндпоинта не нашли — операцию для Еды не делай.

Правила:

- `run` — строка с async-функцией `(args) => ответ`, перенеси JS из спецификации:
  аргументы — параметром, не константой; ответ — `{status: "ok", data}`,
  `{status: "signed_out"}` при 401/редиректе на вход, `{status: "captcha"}` при
  капче. Ужимание (только поля для человека, лимиты) — внутри функции, как в
  спецификации. CSRF Лавки — из `__PAGE_PROPS__` внутри функции.
- `result` — zod-схема ужатого ответа. Телефон курьера, id пользователя,
  полный адрес доставки заказа в результат не включай.
- Юнит-тесты: для каждой операции — разбор фикстуры: выполни `run` в
  `node:vm` (или `new Function`) против фейкового `fetch`, который отдаёт
  фикстуру, и проверь, что ответ проходит `result`; плюс один тест на
  `signed_out` (401). Транспорт и CDP не мокай — их тестирует каркас.
- oxlint `anti-slop`: без `unknown`-параметров, `typeof`-ветвлений и
  `Record<string, unknown>` в TypeScript (в строке `run` — обычный JS).

## Заметки координатора

- Ничего не придумывай сверх спецификации: где она говорит «не удалось»,
  операции нет.
- Живьём операции проверит координатор после выката; если хочешь, прогони свой
  `run` через `cdp.py eval` (см. `PROTOCOL.md`) — только чтение.

## Проверки

`pnpm check`, `pnpm build`, `pnpm build:eve` (обходы облачной сессии — в
dev-notes). Результат — PR в `bro-next` по `PROTOCOL.md`, сообщение координатору
и стоп.
