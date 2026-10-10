# Единица `i-market`: операции Яндекс Маркета в инструменте `yandex`

Ты добавляешь операции Маркета в готовый каркас инструмента `yandex`, и
только их. Каркас (транспорт, реестр, флаг) уже в `bro-next` (PR #355),
спецификация — `docs/yandex-api/market.md` с фикстурами
`tests/fixtures/yandex/market/` (PR #357).

Координатор — сессия `session_01NEromtYDiw5mtYrLKHCiwU` (сообщения ей —
`send_message`). Параллельно идёт `i-food` (`agent/lib/yandex/food/` и одна
строка в `registry.ts`). Чужие файлы не трогай; конфликт в `registry.ts` при
слиянии решает координатор.

## Прочитай сначала

- `PROTOCOL.md` из служебной ветки
  (`git fetch origin claude/eager-pasteur-hb6lvn && git show origin/claude/eager-pasteur-hb6lvn:.claude/plan/yandex-api/PROTOCOL.md`).
- `agent/lib/yandex/operations.ts` (`defineYandexOperation`, его комментарий —
  контракт), `agent/lib/yandex/status.ts` (образец), `agent/lib/yandex/registry.ts`,
  `agent/tools/yandex.ts`.
- `docs/yandex-api/market.md` целиком: пролог (раздел 0.1), JS каждой операции,
  проверенный на живом аккаунте, схемы, сбои и раздел 9.

## Что сделать

Файлы `agent/lib/yandex/market/` (нижний регистр, по роли: `prologue.ts` с
общим прологом-строкой, `search.ts`, `product.ts`, `cart.ts`, `orders.ts`),
одна строка в `registry.ts`. Origin всех операций — `https://market.yandex.ru/`
(или лёгкая страница, которую называет спецификация).

Операции (id — как в спецификации):

- `market.search`, `market.product`, `market.cart`, `market.orders`,
  `market.order` — `access: "read"`.
- `market.cart_add`, `market.cart_remove` — `access: "cart"` (каркас сам
  требует от модели `personAskedToChangeCart` и пускает только ход человека).
  В `about` скажи модели: менять корзину — только когда человек попросил;
  оформление и оплата — `browser_task`, не этот инструмент.

Правила:

- `run` — строка с async-функцией `(args) => ответ`: пролог спецификации +
  тело операции, аргументы — параметром, не константой. Ответ —
  `{status: "ok", data}`, `{status: "signed_out"}` (нет `uid` в состоянии
  страницы / 401), `{status: "captcha"}` (`showcaptcha`). Ужимание — внутри
  функции, как в спецификации (до 10 элементов, только поля для человека).
- Аргумент-ссылка (`url` товара) — только путь `market.yandex.ru` (`/card/…`,
  `/product--…`), проверка — в схеме zod `args` и ещё раз в `run`, как в
  спецификации: чужой хост не принимается.
- `result` — zod-схема ужатого ответа. Адрес доставки, получатель, телефон,
  почта, `uid`, `sk` в результат не включай.
- Юнит-тесты: для каждой операции — выполнение `run` в `node:vm` против
  фейкового `fetch`/`document`, который отдаёт фикстуру, и проверка `result`;
  тест на `signed_out`; тест, что `cart_add` без `personAskedToChangeCart`
  отвергается схемой инструмента. Транспорт и CDP не мокай — их тестирует каркас.
- Если `i-food` уже слит и в нём есть общий помощник для тестов `run` в
  `node:vm` — переиспользуй его, не дублируй.
- oxlint `anti-slop`: без `unknown`-параметров, `typeof`-ветвлений и
  `Record<string, unknown>` в TypeScript (в строке `run` — обычный JS).

## Заметки координатора

- Ничего не придумывай сверх спецификации: где она говорит «не удалось»
  (несколько продавцов на карточке, форма заказа «в пути»), операции или поля нет.
- Живьём операции проверит координатор после выката. Сам корзину владельца не
  меняй; чтение через `cdp.py eval` (см. `PROTOCOL.md`) — можно.

## Проверки

`pnpm check`, `pnpm build`, `pnpm build:eve` (обходы облачной сессии — в
dev-notes). Результат — PR в `bro-next` по `PROTOCOL.md`, сообщение координатору
и стоп.
