# Аудит тестов (14.10)

Владелец считал, что тестов слишком много и многие не нужны. Здесь — что проверили, что удалили, что
оставили и почему. Правило, по которому тесты пишутся дальше, — в `docs/dev-notes.md` («Тесты»).

## Итог

|                                                           |                       было |            стало |
| --------------------------------------------------------- | -------------------------: | ---------------: |
| файлов vitest                                             |                        385 |              383 |
| тестов vitest (кейсов, строка `it.each` — отдельный кейс) |                       5728 |             4981 |
| время `vitest run`, 4 CPU, облачная сессия                |                      622 с |            465 с |
| тестов Python (`python -m unittest` наборов CI)           |                        686 |              657 |
| тестов Go (`sandbox/sandboxd`)                            |                         48 |               48 |
| покрытие продового кода vitest, строки                    | 78,43 % (24 105 из 30 732) | 78,08 % (23 996) |
| покрытие продового кода vitest, ветки                     | 72,44 % (19 436 из 26 828) | 72,16 % (19 361) |

Сокращение vitest — 13 % (−747 тестов), прогон быстрее на 25 %; это не ориентир «больше трети». Это сознательно: каждый удалённый тест должен
попадать в категорию ниже, а при сомнении тест оставался. Большая часть набора оказалась не мусором, а
защитой денег, согласия, кода из письма, хода человека, сети песочницы и регрессий из `docs/dev-notes.md`;
в таких файлах резались только дубли одного пути кода. Что ещё можно убрать по решению владельца — в
разделе «Нужно решение владельца».

Покрытие продового кода упало на 0,35 п. п. строк (109 строк) и 0,28 п. п. веток (75), почти всё —
первый проход, который ещё не мерил покрытие: компонент ввода чата `prompt-input.tsx` (удалены тесты
CSS-классов и разметки), ветки правила oxlint `no-known-value-widening`, загрузка модуля окна входа
`viewer.tsx` (тест вводного текста), тексты исходов привязки Telegram, разбор ошибок Photon при отправке
кода. Потери в фильтре секретов и в лимите чтений Диска найдены этим сравнением и возвращены (замер
«после» сделан до этих двух возвратов). Из оставшихся потерь к проверкам данных относится лишь проверка
email в `loginIdentifierSchema` (`shared/vault/schema.ts`): её тест был `trivial`, сама схема — zod.

## Как проверяли

1. **Первый проход.** 13 исполнителей прочитали все тесты (12 пачек vitest по ~11 тыс. строк и все
   Python и Go) и разложили каждый тест: оставить или удалить по категории.
2. **Ревью первого прохода.** Отдельный ревьюер прошёл весь дифф и нашёл 5 удалений, снявших
   единственную проверку поведения; они возвращены (см. «Возвращено»).
3. **Второй проход** по 121 самому крупному файлу (3800 тестов) с объективным критерием дубля —
   покрытием продового кода (`@vitest/coverage-v8`, ставился во временный каталог, в зависимости не
   добавлен). Тест удалялся как дубль, только если без него не терялась ни одна строка и ни одна ветка
   прода и тот же исход проверял оставшийся тест. Всё, что показывало потерю покрытия, вернули.
   Исключения, где покрытие дубля не доказывает: табличные тесты матчеров и фильтров (секреты, коды,
   «да/нет», телефоны, адреса) — там оставлено по 1–2 представителя на каждый класс входа; SQL в PGlite,
   код в eve и функции страницы (`runInPage`) покрытие V8 не видит — там удалялись лишь явные повторы.
4. **Ревью второго прохода** — тем же способом.
5. **Сравнение покрытия всего набора** «до» и «после» по строкам и веткам: по нему возвращены ещё
   два теста.
6. Итог: весь vitest, `pnpm check` (lint, типы, тесты, формат, knip), все Python-наборы и Go из CI.

## Категории удалённого

- **dup** — основная масса: строки `it.each` одного класса (перефразы одной просьбы, одинаковые
  статусы HTTP одной ветки, одинаковые форматы телефона), повтор одного сценария в двух файлах
  (`tests/` и `agent/lib/**/tests`), тесты, идущие тем же путём к тому же итогу; в Python — семь тестов
  `test_hostd.py`, которые от среды не зависят, но наследовались в классы gVisor и шли дважды.
- **wording** — проверки дословного текста промпта и сообщений вне правил денег, согласия,
  безопасности и кодов: картинки, ссылки, домашний город, бюджет поиска в тексте поручения
  (`browser-task.test.ts`, `instructions.test.ts`), тексты лендинга, подписи полей формы входа.
  Там, где текст — правило (оплата, «да», лимит трат, недоверенные данные сайта, Госуслуги), осталась
  ключевая проверка на правило.
- **impl** — тесты, проверявшие лишь аргументы мока (URL запроса, `AbortSignal.timeout`, CSS-классы),
  поиск строк в исходнике `scripts/dev.ts`, тест тестового хелпера.
- **trivial** — константы лимитов, значения по умолчанию env, список имён таблиц и SQL-типы колонок,
  «обработчик существует», отрицательные пары к позитивным тестам.
- **stale** — кнопка «Deploy with Vercel» в README и подобное, чего больше нет.
- Удалены файлы целиком: `chat-session.test.tsx` (проверял, что компонент передаёт мок детям),
  `tests/agent/subscriptions-pilot.test.ts` (обёртка над `listsWorkspaceRemembered`, у которой свои
  тесты).

## По областям (vitest)

| область                              | файлов было |   стало | тестов было |    стало |               Δ |
| ------------------------------------ | ----------: | ------: | ----------: | -------: | --------------: |
| `tests/agent/tools`                  |          35 |      35 |         897 |      752 |     -145 (-16%) |
| `agent/lib/delivery`                 |          11 |      11 |         425 |      336 |      -89 (-21%) |
| `tests/agent/browser-use`            |          19 |      19 |         409 |      367 |      -42 (-10%) |
| `tools/oxlint`                       |           3 |       3 |         324 |      256 |      -68 (-21%) |
| `tests/agent/yandex`                 |          19 |      19 |         282 |      250 |      -32 (-11%) |
| `tests/agent (корень)`               |          22 |      21 |         280 |      269 |       -11 (-4%) |
| `tests/agent/browser-vm`             |          12 |      12 |         260 |      227 |      -33 (-13%) |
| `db/tests`                           |          29 |      29 |         221 |      213 |        -8 (-4%) |
| `scripts/tests`                      |          13 |      13 |         194 |      149 |      -45 (-23%) |
| `tests/agent/channels`               |          17 |      17 |         184 |      154 |      -30 (-16%) |
| `agent/lib/model`                    |          12 |      12 |         181 |      155 |      -26 (-14%) |
| `tests/agent/hooks`                  |          10 |      10 |         142 |      122 |      -20 (-14%) |
| `tests/agent/browser-pool`           |           6 |       6 |         137 |      133 |        -4 (-3%) |
| `agent/lib/inbound-media`            |           7 |       7 |         131 |      105 |      -26 (-20%) |
| `agent/lib/google-workspace`         |          12 |      12 |         130 |      125 |        -5 (-4%) |
| `tests/agent/schedules`              |          10 |      10 |         120 |      105 |      -15 (-12%) |
| `shared/memory`                      |           1 |       1 |         108 |      108 |          0 (0%) |
| `tests/agent/sandbox`                |           9 |       9 |         106 |      103 |        -3 (-3%) |
| `agent/lib/skills`                   |           3 |       3 |          89 |       56 |      -33 (-37%) |
| `tests/agent/skills`                 |           5 |       5 |          70 |       67 |        -3 (-4%) |
| `agent/lib/proactive`                |           5 |       5 |          70 |       64 |        -6 (-9%) |
| `app/(authenticated)`                |          16 |      15 |          66 |       54 |      -12 (-18%) |
| `tests/agent/instructions`           |           8 |       8 |          53 |       42 |      -11 (-21%) |
| `tests/agent/agency`                 |           7 |       7 |          52 |       48 |        -4 (-8%) |
| `agent/lib/subscriptions`            |           5 |       5 |          51 |       50 |        -1 (-2%) |
| `tests/agent/compaction`             |           1 |       1 |          47 |       47 |          0 (0%) |
| `tests/agent/login-handoff`          |           7 |       7 |          46 |       44 |        -2 (-4%) |
| `shared/spending`                    |           1 |       1 |          43 |       41 |        -2 (-5%) |
| остальные (области меньше 40 тестов) |          80 |      80 |         610 |      539 |      -71 (-12%) |
| **итого vitest**                     |     **385** | **383** |    **5728** | **4981** | **-747 (-13%)** |

Удалённые файлы целиком: `app/(authenticated)/chat/[sessionId]/_components/chat-session.test.tsx`, `tests/agent/subscriptions-pilot.test.ts`

Python по наборам CI: `browser-vm/host` 213 → 202, `browser-vm/firecracker` 8 → 6,
`browser-vm/image` 44 → 36, `browser-vm/worker` 198 → 192 (55 пропускаются без Chrome),
`tg-egress` 30 → 28; `sandbox/host`, `cloudru-code-host`, app-host, tg-bridge, selectel,
sandbox-probe не менялись. Go не менялся: явных дублей нет, а `TestDrainKillsOpenExecs` и соседи —
регрессии из dev-notes.

## Оставлено сознательно

- **Не трогались вовсе:** `tests/agent/skills/core.test.ts`, `flag-off.test.ts`, `bodies.test.ts`
  (бюджет и неизменность промпта), тесты миграций, `WipeSqlTest`, стенды с настоящим Chrome и runsc,
  `shared/memory/schema.test.ts` (все 108 образцов фильтра кодов памяти: dev-notes велит гонять правку
  фильтра на сотне образцов — второй проход сократил его до 89, это откачено),
  `tests/agent/compaction/compacted.test.ts` (кто открыл ход и «да» после сжатия: по покрытию 30 тестов
  лишние, но исходы у всех разные), `said.ts`, `mail-code`, `secrets`, `spend` в браузерных поручениях.
- **Резались только дубли:** согласие и «Оплачиваю?», лимит трат и постоянные разрешения, вырезание
  контактов человека, коды из письма и AgentMail, приватные адреса (`fetchPublic`, `web_fetch` eve),
  сеть песочницы с файлами человека, лимиты кодов входа, `adminProcedure`, охрана телефонии, покупки
  Яндекса и общая защита платежей, approval-карточки.
- **Регрессии с датой или инцидентом** в имени или комментарии и все тесты, на которые ссылается
  `docs/dev-notes.md`. Дубли без даты рядом с ними удалялись.
- **Дословные тексты, которые — единственная защита правила:** по dev-notes текст поручения браузеру
  и отчёта не покрыт эвалами, поэтому фразы о деньгах, согласии и безопасности остались.

## Возвращено после ревью

- `tests/agent/sandbox/backend.test.ts` — «asks for the memory it was given…»: единственная проверка,
  что `memoryMb` доходит до хоста песочниц.
- `db/tests/proactive.test.ts` — «keeps a connection made during the very first probe»: вторая половина
  правила `deferProactiveWatch` из dev-notes (аренда **и** `google_state`).
- `browser-task.test.ts` — строка «a live run, 739204»: единственная на ветку голого выдуманного кода в
  живом запуске.
- `web-fetch.test.ts` — `192.168.1.1`: отдельный частный диапазон в отказе eve по приватным адресам
  (удалялся в обоих проходах, возвращён оба раза).
- `tests/agent/yandex/ready.test.ts` — 401 Go → `signed_out` и «карты не прочитаны — не гадать».
- `lifecycle.test.ts` — строка «past its stop time» в остановке простаивающей VM.
- Второй проход, после его ревью: `policy.test.ts` — платный номер `+7803` (отдельное условие, которое
  покрытие строк не отличает); в `browser-task.test.ts` — «asks again after a run that placed the order»
  (повторная оплата после `Order:`), «keeps a free errand's card from binding the card» и «holds nothing
  for a free errand» (бесплатное поручение не привязывает карту и не резервирует), «carries an errand's
  reservation into its follow-up run» (перенос резерва на продолжение), «carries the stop into an
  unapproved follow-up», «cuts them from an errand a report turn starts» и «cuts them from a message a
  busy session queues» (контакты человека); `forged-tag.test.ts` — подделка тега символами вне BMP;
  `conversation-log.test.ts` — два упоминания «пароль» в одной строке.
- После сравнения покрытия «до/после»: `conversation-log.test.ts` — «пароль … и логин …» (ветка
  `nextNamePattern` фильтра секретов), `turn-reads.test.ts` — «stops Drive reads once Google refused for
  quota» (лимит чтений Диска за ход из dev-notes).

## Нужно решение владельца

- **Бэкенд отдельной VM Cloud.ru на workspace** (`tests/agent/browser-vm/cloudru.test.ts`, большая часть
  `lifecycle.test.ts`, `idle.test.ts`, `private-route.test.ts`, `backend.test.ts`, Cloud.ru-часть
  `browser-pool/hosts.test.ts` и `sandbox.test.ts`) — около 100 тестов. По dev-notes Cloud.ru — история,
  но код жив и выполняется, поэтому как `stale` не удалены. Если код уберут — тесты уйдут вместе с ним.
- **Датированные строки эвристики новизны** в `agent/lib/delivery/tests/turn-sends.test.ts` (202 теста):
  у 143 нет своего покрытия, но почти все — регрессии бенчмарков (d02…d18, review #N, 24.09/25.09).
- **Длинные сверки абзацев промпта** в `tests/agent/browser-use/completion.test.ts` и `toBe` целых фраз в
  `tests/agent/memory.test.ts` (регрессии d01/d13): можно ослабить до ключевых фраз.
- Удалённый дословный тест о сборах продавцов билетов сверх тарифа (`web-search-tool.test.ts`): правило
  «билеты ищет браузер» проверяется, формулировку о сборах — уже нет.
- `db/tests/database-schema.test.ts` «orchestrates the native migration through Turbo» сверяет запрет
  миграций из превью Vercel; Vercel больше не путь отката, но конфиг в репозитории.

## Замечено попутно

- Несколько PGlite-тестов идут почти 5 с (порог vitest): `db/tests/browser-runs.test.ts` «are taken once
  at a time…» в одном полном прогоне не уложился (5,1 с), отдельно проходит 3 из 3. Так было и до правок;
  под нагрузкой машины так же падают `route-time`, `lifecycle`, `runs`, `credits`, `memory-digest`,
  `workstreams`, первые тесты файлов с `vi.resetModules()`.
- В `no-object-parameters` (oxlint) ветка `TSParenthesizedType` при текущем парсере не исполняется:
  парсер снимает скобки.

## Подробно по пачкам

Ниже — отчёты исполнителей как есть: каждый удалённый тест с категорией и причиной, оставленное и
сомнения. Числа «было/стало» в отчётах первого прохода — до второго прохода и до возвратов.

### b00

| файл                                                          | тестов было | стало   |
| ------------------------------------------------------------- | ----------- | ------- |
| agent/lib/telegram-format/html.test.ts                        | 18          | 17      |
| app/artifacts/[artifactId]/_tests/browser-image-route.test.ts | 11          | 11      |
| tests/agent/costs/turns.test.ts                               | 12          | 12      |
| tests/agent/tools/browser-task.test.ts                        | 429         | 394     |
| **итого**                                                     | **470**     | **434** |

#### Удалено

- `html.test.ts`: «keeps a short message as one part». Категория trivial: короткий текст без разбиения.
- `browser-task.test.ts`: «honours an overridden ceiling» слит с «creates every run with the deployment's ceiling». Категория dup: обе проверки остались в одном тесте.
- `browser-task.test.ts`: «starts as usual on a site whose name resolves». Категория impl: обычный старт проверяет любой тест со `startErrand`, а аргумент `siteHostMissing` уже проверяет тест с несуществующим сайтом.
- `browser-task.test.ts`: «records the site the errand was pointed at». Категория impl/dup: в тесте только `toHaveBeenCalledWith`; запись `site` в строке поручения проверяют тесты продолжения, очереди и вырезания контактов.
- `browser-task.test.ts`: «always asks a run for a screenshot…» слит с «asks for pictures of the items…». Категория dup: оба варианта (`collectImages` выключен и включён) проверяются в одном тесте.
- `browser-task.test.ts`: в «search discipline» 4 теста на одном и том же `startErrand("")` (вид объявления, резервные сайты, бюджет, гостевой вход) слиты в один. Категория dup: все фразы сохранены.
- `browser-task.test.ts`: два теста «leaves the budget out…» (код; ответ на остановку перед оплатой) слиты в один. Категория dup.
- `browser-task.test.ts`: «treats paying for an errand as asking for it to be done». Категория dup: ту же фразу на том же входе проверяет «lets an approved errand finish the purchase past the search budget», и в нём проверок больше.
- `browser-task.test.ts`: «keeps an errand not approved to submit from acting…» и «records no confirmation for an errand that only looks» влиты в «stops an unapproved errand…». Категория dup: тот же вход, все проверки сохранены.
- `browser-task.test.ts`: «tells the run the permission is in roubles only» влит в «pays within the limit without asking…». Категория dup: та же подготовка, фразы о рублях сохранены.
- `browser-task.test.ts`: в it.each «keeps the address out of «%s»» убраны 2 строки из 6 («ресторан на четверых», «таксидермисты»). Категория dup: оставлены ложные совпадения подстрок (Купер, курьер, продукт, Лавка).
- `browser-task.test.ts`: «asks the run when a later step of the errand opens». Категория wording: дословная строка о метке NEXT, не правило безопасности.
- `browser-task.test.ts`: «keeps the page of a confirmed errand that stops on the way». Категория wording: дословная фраза, не правило безопасности или денег.
- `browser-task.test.ts`: в it.each «passes on the person's code with the order it is for» 4 строки сокращены до 2. Категория dup: тот же класс «номер заказа + код».
- `browser-task.test.ts`: в it.each «gives no earlier turn's code to «попробуй ещё раз»» 4 строки (2×2) сокращены до 2. Категория dup: оставлены живой запуск с «попробуй ещё раз» и остановленный запуск с голым кодом.
- `browser-task.test.ts`: в it.each «continues on «%s» after the person confirmed in the app» убрана строка «ок». Категория dup: «Готово» проверяется отдельным it.each.
- `browser-task.test.ts`: в it.each «takes «%s» as the yes» 5 строк сокращены до 3 (да, Оплачивай, go ahead). Категория dup.
- `browser-task.test.ts`: в it.each «pays nothing and asks nothing again on «%s»» 3 строки сокращены до 2. Категория dup.
- `browser-task.test.ts`: в it.each «knows the phone written as «%s»» 12 строк сокращены до 6: +7, 8 со скобками, слитно, разделители «/», полноширинные цифры, 007. Категория dup.
- `browser-task.test.ts`: в it.each «reads the phone field «%s»…» 4 строки сокращены до 2. Категория dup: строка `7999000000184951234567` слово в слово повторяет тест «takes every ten digits…», а подчёркивания покрывает «/».
- `browser-task.test.ts`: в it.each «reads a phone field … with a long country code whole» убрана строка `+90`. Категория dup: тот же класс, что `+375`.
- `browser-task.test.ts`: «says nothing of Госуслуги on another site» влит в «promises no code for a run that will not sign in through Госуслуги». Категория dup.
- `browser-task.test.ts`: «says nothing about a code to a follow-up without one». Категория dup: то же отрицание (`not.toContain("Enter this one-time code first")`) проверяет «passes on a pickup point named by the person's postal index».

#### Оставлено сознательно

- `browser-task.test.ts`, почти весь файл: согласие и «Оплачиваю?», лимит трат и резервы (`reserveAutoPayment`, `reserveConsentPayment`, `settle/moveSpendReservation`), постоянные разрешения, фоновые работники против хода человека, `said.ts` (выдуманные коды, `personSaid`, слова прошлых ходов), вырезание контактов (`withoutOwnContacts`, сайт с телефоном, очередь), код из письма и AgentMail, логин, присланный человеком, Госуслуги и ЕСИА, отменённые и оставленные открытыми запуски. Многие тесты связаны с инцидентами (RU 24.09–04.10, 10.10, 12.10, 14.10).
- `browser-task.test.ts`, дословные фразы в тексте поручения о безопасности и деньгах (нет согласия на оплату, нельзя действовать от имени человека, правило NEEDS при сетевой ошибке, телефон как секрет, номера документов): по `docs/dev-notes.md` текст `composeBrowserTask` защищают только тесты по дословным фразам, эвалов нет. Удалены лишь две фразы без отношения к безопасности.
- `browser-task.test.ts`, тест схемы без `pattern` для OpenAI: регрессия из dev-notes.
- `browser-image-route.test.ts`: всё оставлено. Это приватные заголовки, одинаковый 404 для чужого и несуществующего, сверка типа и размера, 502 и ошибка базы; каждый тест про свою ветку.
- `turns.test.ts`: всё оставлено. Это источник хода (человек, отчёт, фон, task) и учёт стоимости; тест реэкспорта хука task-агента прямо упомянут в dev-notes («task-агент пишется сам, реэкспортом хука»).
- `html.test.ts`: остальное оставлено, у каждого теста свой случай экранирования или разбиения.

#### Сомнения

- Тест «starts an errand that only searches in flash mode, and only in the pilot» падал по таймауту 5 с ещё до правок: 4 `startErrand` с `vi.resetModules()`, около 1,2 с каждый. Я поставил ему таймаут 20 с; тем же таймаутом защищены два слитых теста с двумя `startErrand` (2,6–2,7 с). Продовый код не трогал.
- В файле ещё много тестов текста промпта без отношения к безопасности (картинки, ссылки, домашний город, `SIGNED_IN`, «stage the best option», билеты, госуслуги). Я их оставил, потому что dev-notes называет такие тесты единственной защитой текста поручения. Если владелец согласен терять эту защиту, это следующий резерв: примерно 15–20 тестов.

#### Возможно мёртвые экспорты

- нет (все импорты удалённых тестов используются в оставшихся).

### b01

Итого по пачке: **770 → 686** (−84). Числа — из vitest JSON до и после правок.

| файл                                                                                  | тестов было           | стало |
| ------------------------------------------------------------------------------------- | --------------------- | ----- |
| agent/lib/google-workspace/tests/calendar-availability.test.ts                        | 22                    | 21    |
| agent/lib/google-workspace/tests/client.test.ts                                       | 9                     | 9     |
| agent/lib/google-workspace/tests/drive-search.test.ts                                 | 4                     | 3     |
| agent/lib/google-workspace/tests/gmail-attachments.test.ts                            | 6                     | 6     |
| agent/lib/google-workspace/tests/gmail-compose.test.ts                                | 9                     | 9     |
| agent/lib/google-workspace/tests/gmail-update.test.ts                                 | 4                     | 3     |
| agent/lib/google-workspace/tests/gmail-voice.test.ts                                  | 16                    | 16    |
| agent/lib/google-workspace/tests/google-requests.test.ts                              | 9                     | 9     |
| agent/lib/google-workspace/tests/google-workspace.test.ts                             | 12                    | 11    |
| agent/lib/google-workspace/tests/rate-limit.test.ts                                   | 7                     | 7     |
| agent/lib/google-workspace/tests/tool-schemas.test.ts                                 | 11                    | 11    |
| agent/lib/google-workspace/tests/turn-reads.test.ts                                   | 21                    | 19    |
| agent/lib/image-artifact/delivery.test.ts                                             | 7                     | 7     |
| scripts/tests/bench/account.test.ts                                                   | 19                    | 16    |
| scripts/tests/bench/approvals.test.ts                                                 | 24                    | 17    |
| scripts/tests/bench/cases.test.ts                                                     | 14                    | 12    |
| scripts/tests/bench/cli.test.ts                                                       | 6                     | 4     |
| scripts/tests/bench/clock.test.ts                                                     | 3                     | 3     |
| scripts/tests/bench/conversation.test.ts                                              | 35                    | 34    |
| scripts/tests/bench/cookies.test.ts                                                   | 7                     | 7     |
| scripts/tests/bench/journal.test.ts                                                   | 11                    | 10    |
| scripts/tests/bench/media.test.ts                                                     | 4                     | 3     |
| scripts/tests/bench/personal-data.test.ts                                             | 17                    | 11    |
| scripts/tests/bench/retry.test.ts                                                     | 33                    | 20    |
| scripts/tests/bench/tracker.test.ts                                                   | 17                    | 16    |
| scripts/tests/migrate-from-convex.test.ts                                             | 4 (3 skipped без env) | 4     |
| shared/schedules/timing.test.ts                                                       | 25                    | 23    |
| tests/agent/login-handoff/exact-link.test.ts                                          | 7                     | 6     |
| tests/agent/login-handoff/open.test.ts                                                | 7                     | 7     |
| tests/agent/login-handoff/pilot.test.ts                                               | 4                     | 4     |
| tests/agent/login-handoff/report.test.ts                                              | 5                     | 4     |
| tests/agent/login-handoff/settle.test.ts                                              | 11                    | 11    |
| tests/agent/login-handoff/site.test.ts                                                | 5                     | 5     |
| tests/agent/login-handoff/tool.test.ts                                                | 7                     | 7     |
| tests/agent/tools/route-time.test.ts                                                  | 35                    | 34    |
| tools/oxlint/anti-slop/tests/anti-slop-plugin.test.ts (с импортируемыми `*.cases.ts`) | 322                   | 287   |
| tools/oxlint/architecture/tests/oxlint-architecture-plugin.test.ts                    | 1                     | 1     |
| tools/oxlint/next/tests/oxlint-next-plugin.test.ts                                    | 1                     | 1     |
| web/auth/tests/proxy.test.ts                                                          | 9                     | 8     |

#### Удалено

- `calendar-availability.test.ts` — строка it.each `titleNamesEvent` «Созвон с командой»/«Созвон с командой» — dup — точное совпадение покрыто строкой с кавычками и регистром.
- `drive-search.test.ts` — «returns the files newest first» — dup — сортировку проверяет «sorts every page of a word search…».
- `gmail-update.test.ts` — «searches Google's own notices and alert subjects in the inbox» — wording/trivial — подстроки константы запроса; поведение «не архивировать оповещение» осталось.
- `google-workspace.test.ts` — «maps reversible Gmail actions» — trivial/dup — таблица меток; тело `batchModify` для archive проверяет `gmail-update.test.ts`.
- `turn-reads.test.ts` — «stops Drive reads once Google refused for quota» — dup — тот же путь `rate_limited`, что у Gmail.
- `turn-reads.test.ts` — «gives a background worker more empty searches» — dup — фоновый бюджет уже проверяет «gives a background worker more reads».
- `scripts/tests/bench/account.test.ts` — «leaves Thursday afternoon…», «marks the Drive passport as a specimen», «describeFixtures lists what a dry run would insert» — wording/dup — подстроки текстов фикстур; specimen проверяет и «uploads and names the Drive specimen», вывод dry-run — `cli.test.ts`.
- `approvals.test.ts` — 3 строки it.each «cancels %s» (slack, spend_limit, google_connect) — dup — один путь отказа, остались browser_task и gmail-send.
- `approvals.test.ts` — «cancels the same tool as before when it is not held», «still approves an own-data tool that is not held», «confirms a payment under the cap», «leaves a plain question unanswered even with a cap set» — dup — граница «равно потолку», «выше потолка», «сумма неизвестна» и «нет потолка» остались.
- `cases.test.ts` — «reads both published suites» — trivial — число кейсов 78/67; «keeps a dimension's whole script» — dup — тот же сценарий d13 проверяет «opens a new conversation…».
- `cli.test.ts` — «refuses an unknown command», «wants seed, clean or list after fixtures» — dup — разбор аргументов (код 2 и текст) уже ловит «refuses a stray word…».
- `conversation.test.ts` — «remembers past codes on from where a cut read stopped» — dup — дочитывание после обрыва с курсора проверяют 4 соседних теста (catch-up, observe, принятый ход, фоновый ход).
- `journal.test.ts` — «refuses a record that breaks the published format» — trivial — одна проверка схемы zod.
- `media.test.ts` — «sends plain text as a string» — trivial.
- `personal-data.test.ts` — 6 строк it.each — dup — 2 формы паспорта, 2 адреса (Ленина 5к2, пр. Победы), ISO-дата и UUID запуска; осталось по 2–4 разных строки на группу.
- `retry.test.ts` — 8 строк «is sent again even as a POST» (connect timeout — дубль первого теста, 503/504, EHOSTUNREACH/ENETUNREACH/ETIMEDOUT connect, EAI_AGAIN, «все адреса refused») — dup; остались туннель 502, TLS handshake, ECONNREFUSED connect, ENOTFOUND getaddrinfo, смешанный everyAddress.
- `retry.test.ts` — строка 407 (остались 403 и сертификат), POST «a reset» (остался socket closed), GET «other side closed» (остался reset), «failed lookup without its syscall» (остался ECONNREFUSED без syscall) — dup.
- `retry.test.ts` — «Composio looks the account up again after a reset» — dup — повтор GET через Composio проверяет «reads a Google read through the proxy again».
- `tracker.test.ts` — «takes a report from a background retry for the errand it continues» — dup — «accepts an unknown retry» в тесте superseded.
- `timing.test.ts` — «keeps a monthly run at 10:00 local across the DST change» — dup — DST проверяет daily New York; «follows the person to a new timezone…» — dup — зону правила проверяет «takes the calendar date of the rule's own timezone».
- `exact-link.test.ts` — «keeps the attachments of a message it rewrites» — impl — проверяет лишь, что spread не теряет поле.
- `login-handoff/report.test.ts` — «says what each ending was» — wording — подстроки текстов отчёта.
- `route-time.test.ts` — «marks a destination it could not find and measures the rest» — dup — «not on the map» с замером остальных есть в «gives no time to a house the map knows only as its street», «stops looking places up…», «never measures to a city…».
- `web/auth/tests/proxy.test.ts` — «does not match public fonts» слит с «brand assets» в один тест — dup — тот же matcher, все три URL проверяются.
- `tools/oxlint/anti-slop/tests/no-known-value-widening.cases.ts` — 15 кейсов RuleTester — dup — близнецы по синтаксису: accessor и поле класса, стрелка и function, `<T>x` и `as`, `as const satisfies`, type и interface, алиасы и Readonly у Diet, mapped и index-сигнатура, PropertyKey и string, `string | unknown` и стрелка у isString.
- `no-unsafe-dictionary-type.cases.ts` — 18 кейсов — dup — повторы NonNullable/Partial/Required (оставлены Readonly и по одной NonNullable), readonly mapped рядом с readonly-индексом, Omit (Pick остался), `type Dict` (= первый кейс), обратный порядок merge интерфейса, 2 из 4 форм `T extends Record<…>`, локальное переопределение Record/NonNullable (import-тень осталась).
- `require-safety-comment-for-type-assertion.cases.ts` — 2 кейса — dup — «SAFETY: + пробелы» (пустой маркер остался) и второй export без маркера.

#### Оставлено сознательно

- Google: подтверждения и отказы записи (`google-workspace.test.ts`), «ответ только в тред, названный карточкой», ID событий из карточки, удаление серии — approval/карточки; 403 insufficient scopes и квота 429/403 (`client.test.ts`, `rate-limit.test.ts`) — dev-notes; IANA-зоны Календаря, Drive без `orderBy` у `fullText` — dev-notes; голос из SENT + sendAs и плюс-адреса (`gmail-voice.test.ts`) — dev-notes; header injection, лимит размера вложений, regex lookaround во всех 9 схемах (`tool-schemas`) — регрессия OpenAI из dev-notes; лимиты чтений хода (`turn-reads`) — dev-notes.
- Bench: отказ на оплату и потолок `--confirm-payment-up-to`, `--hold`, сохранение настроек после follow/next (деньги на аккаунте владельца); маскирование кодов, OTP и персональных данных (секреты); «не повторять POST после обрыва», повтор только того, что не ушло (dev-notes `retry.ts`, «past a background turn»); регрессии с датой (d13 24.09, «26.09 live bug», сброс сети в CLI).
- login-handoff: всё про хэш устройства, токен окна, домены провайдеров, Госуслуги, «сайт только из слов человека», «ход, открытый отчётом» — безопасность; exact-link — dev-notes 10.10.
- route-time: почти все тесты — регрессии живых сбоев (25.09 d03/d13, Тверская 7) и правило `pick` из dev-notes.
- proxy: исключения webhook и сессии — права.
- timing: праздники по постановлению № 1466 (dev-notes), 31-е, високосный год, разрыв весеннего перевода часов.
- `architecture`/`next` oxlint: «exports …» оставлены — единственный vitest-тест файла, RuleTester там не регистрирует тесты vitest, без него файл упал бы «No test suite found».

#### Сомнения

- `tests/agent/tools/route-time.test.ts`: падает и **до правок** — первый тест (холодный `import("@agent/tools/route_time")`) не укладывается в 5 с под нагрузкой полного прогона пачки, и за ним сыплются соседние (общие фейковые часы и `requestTimes`). Отдельно с `--testTimeout=30000` все 34 зелёные; при общем прогоне это может проявиться и в CI. Координатору стоит решить, поднимать ли таймаут этому файлу.
- `*.cases.ts` anti-slop нет в списке пачки, но они импортируются её тестом и дают 322 из 770 кейсов — правил их как часть `anti-slop-plugin.test.ts`. Резать сильнее можно (каждое правило держит десятки обходных путей), но каждый кейс там — отдельная лазейка правила; срезал только явные синтаксические близнецы. Эти файлы с табами, oxfmt их не трогает.
- `scripts/tests/migrate-from-convex.test.ts`: 3 из 4 тестов skip без env (Convex) — не трогал.
- `rate-limit.test.ts` «tells the model why a search found nothing» — дословный текст, но с пометкой инцидента (RU 25.09, d14) — оставил.

#### Возможно мёртвые экспорты

- `agent/lib/google-workspace/gmail.ts:gmailUpdateLabels` — после удаления теста используется только внутри своего модуля (строка 744); экспорт был нужен лишь `google-workspace.test.ts`. knip может пометить.

### b02

| файл                                                | тестов было | стало   |
| --------------------------------------------------- | ----------- | ------- |
| tests/agent/browser-use/abandoned-notice.test.ts    | 2           | 2       |
| tests/agent/browser-use/captcha-retry.test.ts       | 38          | 34      |
| tests/agent/browser-use/cdp.test.ts                 | 26          | 24      |
| tests/agent/browser-use/checkout-rules.test.ts      | 4           | 4       |
| tests/agent/browser-use/client.test.ts              | 18          | 14      |
| tests/agent/browser-use/code-entry.test.ts          | 6           | 6       |
| tests/agent/browser-use/completion.test.ts          | 82          | 77      |
| tests/agent/browser-use/files.test.ts               | 41          | 39      |
| tests/agent/browser-use/host.test.ts                | 5           | 4       |
| tests/agent/browser-use/images.test.ts              | 11          | 10      |
| tests/agent/browser-use/mail-code.test.ts           | 34          | 34      |
| tests/agent/browser-use/outcome.test.ts             | 37          | 35      |
| tests/agent/browser-use/report-supersession.test.ts | 3           | 3       |
| tests/agent/browser-use/said.test.ts                | 27          | 27      |
| tests/agent/browser-use/secrets.test.ts             | 24          | 24      |
| tests/agent/browser-use/sign-in-rules.test.ts       | 7           | 7       |
| tests/agent/browser-use/sign-ins.test.ts            | 20          | 19      |
| tests/agent/browser-use/sign-up.test.ts             | 14          | 13      |
| tests/agent/browser-use/spend.test.ts               | 10          | 10      |
| tests/agent/tools/schedules.test.ts                 | 26          | 23      |
| **итого**                                           | **435**     | **409** |

Проверка: vitest по всем 20 файлам — зелёный (409 passed); oxfmt и oxlint --deny-warnings по 11 изменённым файлам чисты.
Примечание: первый прогон «до» под нагрузкой параллельных исполнителей дал 11 падений по таймауту (images, report-supersession, sign-ins и др., PGlite-миграции); с `--maxWorkers=4` всё зелёное, это не регрессии.

#### Удалено

- `completion.test.ts` — «says nothing about pictures when the run saved none» — trivial — отрицательная проверка «/artifacts/ нет в промпте», позитивный случай покрыт соседним тестом.
- `completion.test.ts` — «says nothing about a later step the run did not report» — trivial — отрицательная пара к тесту про NEXT/schedules-create.
- `completion.test.ts` — «says nothing about unread messages for a run that ended with none» — trivial — отрицательная пара к тесту про непрочитанные сообщения.
- `completion.test.ts` — «keeps no browser VM up for a reply to a finished run» — trivial — только `not.toHaveBeenCalled`; позитивный случай («keeps the page for a code…») проверяет вызов.
- `completion.test.ts` — «leaves one line per delivery attempt with its outcome and session» — impl — дословная форма лог-строки; поведение доставки (pending/accepted/timeout) покрыто соседними тестами.
- `captcha-retry.test.ts` — «writes the line a later claim looks for into the retry's task» — dup — то же видно в тестах усыновления запуска по строке (it.each «keeps the attempt's line…», «keeps one browser through an outage»).
- `captcha-retry.test.ts` — «starts a hosted retry in a new session» — dup — `sessionId` undefined уже проверяет «starts the next attempt in a fresh browser on the same profile».
- `captcha-retry.test.ts` — строка it.each «…lookup after an unclear start gets a 503» — dup — остались сетевой обрыв и 429.
- `captcha-retry.test.ts` — «stays on the hosted pool, which gives a new browser a new address» — trivial — значение по умолчанию; `customProxy` undefined на чётной попытке проверяет и «alternates a fixed proxy…».
- `cdp.test.ts` — «scores every frame before it types into any of them» — dup — тот же фикстур, `applied === [3]` в предыдущем тесте уже доказывает единственную вставку.
- `cdp.test.ts` — «reports a one-character box that swallowed only the first digit» — impl — лишь пробрасывает ответ мок-инъекции; настоящая программа проверена в «puts only the first digit into a lone one-character box».
- `client.test.ts` — «reads a run status, queues a session message and stops a session» — dup/impl — те же запросы проверяет тест сроков (deadlines); остальное — URL-формы.
- `client.test.ts` — «reports no endpoint when this session has no browser up» — trivial.
- `client.test.ts` — «lists a run's saved pictures with their download links» — impl — параметры URL; захват картинок покрыт `images.test.ts`.
- `client.test.ts` — «reads the workspace a finished run saved its files into» — trivial — разбор двух полей JSON.
- `files.test.ts` — 2 строки it.each «does not turn an approval-response transport into a new request» (`scheduled-worker`, `scheduled-report`) — dup — эти виды хода уже отказываются в таблице «denies transfers outside the allowed turn boundary»; оставлены `web` и `proactive-worker`.
- `host.test.ts` — «reads the host of an origin or of a bare domain» — trivial/dup — `siteHostname` проходит через тест `siteHostMissing` (lookup зовётся с хостом).
- `images.test.ts` — «captures nothing without a private store to keep it in» — trivial — проверка выключенного конфига.
- `outcome.test.ts` — «reads none from a report without charges» — trivial.
- `outcome.test.ts` — «preserves multiline report facts beyond the one-line metadata fields» — dup — сохранение многострочного отчёта проверяет `completion.test.ts` «persists and delivers a complete option report…» и «preserves a useful unlabelled response».
- `sign-ins.test.ts` — «still fails when the current profile has a real (retryable) failure» — dup — тот же исход (`failed`, ничего не забыто) у «forgets nothing when the cloud keeps the profile».
- `sign-up.test.ts` — «lets only a fresh login be taken out for a form never sent» — dup — то же проверяют последние строки «reads the run's word on the account from its footer» (startTask/followUpTask).
- `schedules.test.ts` — 2 строки it.each «promises map time without traffic only for travel» (англ. Drive и англ. drive to work) — dup — оставлены рус. Drive, driver's licence и «сколько ехать».
- `schedules.test.ts` — «owns web schedules by their Eve session» — dup — проверка `create` с `conversationChannel: "eve"` перенесена в «names the web chat when the person has no messenger» (тот же сценарий).

#### Оставлено сознательно

- `said.test.ts`, `mail-code.test.ts`, `secrets.test.ts`, `spend.test.ts` — целиком: коды из слов человека (dev-notes: «Код и согласие уходят в запуск только из слов человека», письмо 14.10), DMARC/DKIM, трекеры и приватные адреса, привязка секретов к доменам, Госуслуги, лимит трат.
- `files.test.ts` — таблицы границ хода (кто открыл ход, approval-транспорт, чужой workspace, HTTPS-сайт, байты оригинала) — безопасность файлов человека; сокращены лишь дублирующие строки.
- `completion.test.ts` — почти всё: оплата и «да» на сумму, никогда не повторять запуск, который мог действовать (dev-notes, `captcha-retry.ts`), недоверенные данные отчёта и небезопасные URL, входы/выходы, регрессии с датами (25.09, 26.09, 24.09, 12.10, 14.10) в формулировках промпта отчёта.
- `captcha-retry.test.ts` — идемпотентность ретраев (один браузер на поручение, усыновление запуска, outage), flash mode только для поиска.
- `checkout-rules.test.ts`, `sign-in-rules.test.ts` — дословные фразы `composeBrowserTask`: по dev-notes это единственная защита (эвалов нет, кейс — платный прогон), регрессии 04.10/05.10.
- `report-supersession.test.ts` — атомарность связи с преемником (PGlite), отчёт не теряется.
- `schedules.test.ts` — кто может ответить на вопрос расписания (только ход человека), отсутствие `send_message`-инструментов в фоновых ходах, регрессии d12/d15.
- `abandoned-notice.test.ts`, `code-entry.test.ts` — малы, проверяют поведение (что сообщение доставлено/не отмечено, распознавание кода).

#### Сомнения

- `abandoned-notice.test.ts` «names the errand by its site…» — дословный текст уведомления (wording), но заодно единственная проверка «ozon.ru из URL»; оставлен.
- `completion.test.ts` — многие `toContain` на длинные фразы промпта отчёта (например, тест «has the basket read back…» сверяет абзац целиком). Это хрупко, но фразы — правила денег/оплаты и регрессии с датами; оставлено. Возможный резерв для координатора, если решит ослабить до ключевых подфраз.
- `client.test.ts` «creates a run with the v4 field names…» — частично impl (форма тела), но держит обрезку пробелов в ключе и передачу секретов в теле; оставлен.

#### Возможно мёртвые экспорты

- нет (`siteHostname`, `listBrowserUseWorkspaceFiles`, `stopBrowserUseSession`, `retryProxySettings` используются в продовом коде или скриптах).

### b03

| файл                                                 | тестов было | стало   |
| ---------------------------------------------------- | ----------- | ------- |
| agent/lib/imessage-text/tests/bubbles.test.ts        | 6           | 6       |
| agent/lib/imessage-text/tests/compile.test.ts        | 11          | 9       |
| agent/lib/model/routerai/tests/fallback.test.ts      | 18          | 15      |
| agent/lib/model/routerai/tests/fetch.test.ts         | 14          | 14      |
| agent/lib/model/routerai/tests/runinfra.test.ts      | 10          | 9       |
| agent/lib/model/tests/compaction.test.ts             | 14          | 13      |
| agent/lib/model/tests/credits.test.ts                | 13          | 11      |
| agent/lib/model/tests/forged-tag.test.ts             | 45          | 37      |
| agent/lib/model/tests/history-trim.test.ts           | 4           | 4       |
| agent/lib/model/tests/output-cap.test.ts             | 5           | 4       |
| agent/lib/model/tests/selection.test.ts              | 26          | 23      |
| agent/lib/model/tests/skill-blocks.test.ts           | 10          | 10      |
| agent/lib/model/tests/step-context.test.ts           | 11          | 10      |
| agent/lib/model/tests/stream-watchdog.test.ts        | 11          | 11      |
| app/api/auth/[...all]/_tests/auth-route.test.ts      | 1           | 1       |
| app/api/health/_tests/health-route.test.ts           | 5           | 5       |
| app/api/pay/_tests/pay-route.test.ts                 | 3           | 3       |
| app/api/phone/ingress.test.ts                        | 4           | 4       |
| app/api/usage-costs/_tests/usage-costs-route.test.ts | 4           | 4       |
| app/api/yookassa/_tests/yookassa-route.test.ts       | 5           | 5       |
| shared/chat/approval-card.test.ts                    | 11          | 11      |
| shared/costs/prices.test.ts                          | 4           | 4       |
| shared/google-workspace/connection.test.ts           | 9           | 8       |
| tests/agent/instructions/acquaintance.test.ts        | 3           | 3       |
| tests/agent/instructions/autonomy.test.ts            | 9           | 8       |
| tests/agent/instructions/creative.test.ts            | 5           | 5       |
| tests/agent/instructions/follow-through.test.ts      | 6           | 4       |
| tests/agent/instructions/local-time.test.ts          | 5           | 5       |
| tests/agent/instructions/public-services.test.ts     | 8           | 6       |
| tests/agent/instructions/recommendations.test.ts     | 6           | 3       |
| tests/agent/instructions/task-files.test.ts          | 11          | 8       |
| tests/agent/sandbox/backend.test.ts                  | 14          | 13      |
| tests/agent/sandbox/files.test.ts                    | 3           | 3       |
| tests/agent/sandbox/inbox.test.ts                    | 26          | 26      |
| tests/agent/sandbox/keys.test.ts                     | 5           | 5       |
| tests/agent/sandbox/person-sends.test.ts             | 10          | 10      |
| tests/agent/sandbox/pilot.test.ts                    | 20          | 20      |
| tests/agent/sandbox/public-fetch.test.ts             | 5           | 5       |
| tests/agent/sandbox/router.test.ts                   | 21          | 21      |
| tests/agent/sandbox/share-file.test.ts               | 2           | 2       |
| tests/agent/tools/connected-apps.test.ts             | 38          | 37      |
| tests/agent/tools/phone-contacts.test.ts             | 4           | 4       |
| tests/agent/tools/telegram-link.test.ts              | 5           | 5       |
| **итого**                                            | **450**     | **414** |

#### Удалено

- `compile.test.ts` — «leaves plain text alone» — trivial — неизменность текста и так проверяет идемпотентность в тесте сводки почты.
- `compile.test.ts` — «shows the word and the address of a link, escaping nothing» — dup — тот же путь, что «flattens a markdown link…».
- `fallback.test.ts` — 2 из 4 строк it.each 500/502/503/504 (оставлены 500, 504; 503 есть в других тестах) — dup.
- `fallback.test.ts` — строка 401 в it.each отказов (оставлены 400 и 402: 402 — правило dev-notes) — dup.
- `runinfra.test.ts` — строка «a gateway failure» (503) it.each — dup — не-2xx уже покрыт строкой «a refusal» (400).
- `compaction.test.ts` — «goes to the errand of a browser report's turn» — impl — только `toHaveBeenCalledWith` с проброшенными полями.
- `credits.test.ts` — «stays quiet above the rouble threshold» — dup — тот же код порога, что у OpenRouter; 425 ₽ не отличает рубли от долларов.
- `credits.test.ts` — «repeats a balance that fell by half…» (RouterAI) — dup — логика «вдвое» общая и проверена тестом OpenRouter.
- `forged-tag.test.ts` — 8 строк it.each: invisible separator, vowel separator (остались soft hyphen и grapheme joiner), en dash (остался Unicode hyphen), Cyrillic dze (осталась Cyrillic o), 4 строки скобок (angle/mathematical/left-pointing/vertical — те же символы есть во втором it.each look-alike скобок) — dup.
- `output-cap.test.ts` — «gives a reasoning step room for its thinking» — dup — тот же путь «рассуждение включено → 32768», что и тест по умолчанию.
- `selection.test.ts` — «still disables reasoning when explicitly set to off» — dup — `reasoning.enabled:false` проверяют fast-reply тест и output-cap.
- `selection.test.ts` — «keeps a host pinned for DeepSeek even when it is on the skip list» (OpenRouter) — dup — то же правило проверяет тест RouterAI «pins the configured order…».
- `selection.test.ts` — «leaves an OpenRouter step's metadata as it was» — trivial.
- `step-context.test.ts` — «keeps the note a last system message outside the pilot» — dup — то же в selection «ends every step's prompt with the reply note»; порядок инструментов вне пилота — в «offers a group's tools…».
- `connection.test.ts` — «connects each level under its own Composio auth config» — trivial — чтение id конфигов из env.
- `autonomy.test.ts` — «acts on explicit requests instead of confirming them» — wording (не про деньги).
- `autonomy.test.ts` — из «tells the model to act on a stated default…» убраны 14 `toContain` с не-денежными фразами и повторами (оставлены все правила оплаты/согласия/лимита/фона) — wording.
- `follow-through.test.ts` — «sets up a later step of the person's goal at once», «answers «ну что там?» from the outcome» — wording.
- `public-services.test.ts` — «reads meter photos by tariff…», «does without Госуслуги what it can…» — wording; в оставшихся тестах убраны не-защитные фразы (ЕМИАС, «Висит 500 ₽», календарь, «дойди до кнопки»), тест Госуслуг сведён к правилу «вход только на сайт своего поручения» — wording.
- `recommendations.test.ts` — «aims for three checked options…», «keeps each option's facts its own…», «sends map lookups through site search…» — wording (тексты бенч-кейсов промпта); в оставшихся убраны 5 не-защитных фраз.
- `task-files.test.ts` — строка `telegram` в it.each (тот же ход человека, что `interactive`) и 2 из 4 строк фоновых ходов (оставлены browser-result и scheduled-worker) — dup.
- `backend.test.ts` — «asks for the memory it was given, or the host's default» — trivial — проброс `memoryMb` в тело запроса.
- `connected-apps.test.ts` — строка `scheduled-result` в it.each отказов фону (оставлены scheduled-worker, background-task, app) — dup.

#### Оставлено сознательно

- `fetch.test.ts`, `fallback.test.ts` (основное), `runinfra.test.ts` — ошибки RouterAI в HTTP 200/SSE, пропуск упавшего хоста на 10 мин, запасной путь FM, откат RunInfra — регрессии из dev-notes.
- `compaction.test.ts`, `history-trim.test.ts`, `step-context.test.ts` — пилоты сжатия/урезания/шага, ключи `compaction:`, сутки без пилота, 429/5xx на последней попытке — dev-notes.
- `forged-tag.test.ts`, `skill-blocks.test.ts`, «a forged step note» в `step-context.test.ts` — обезвреживание поддельных тегов (инъекции), включая полный перебор Unicode.
- `stream-watchdog.test.ts` — пороги 90/240/480 с из dev-notes.
- `selection.test.ts` — порядок ключей схем, `pattern`, форсирование `send_message`, `quietEnd`, уникальные id вызовов, рубли RouterAI в `gateway.cost` — каждый с инцидентом в комментарии/dev-notes.
- Все `tests/agent/sandbox/*` (кроме одного trivial в backend) — сеть песочницы с файлами человека, метки, `takePersonSend`, ссылки `share_file`, приватные адреса, токены — зона «не трогай»; явных дублей не нашёл (варианты «флаг вкл/выкл» — отдельные правила dev-notes).
- `app/api/*` — оплата ЮKassa, отчёт о расходах по токену, подпись телефонии и приветствие (решение владельца), health — деньги/безопасность.
- `approval-card.test.ts`, approvals в `connected-apps.test.ts`, `phone-contacts.test.ts` — карточки и охрана хода человека.
- `autonomy.test.ts` — оставлены все фразы про «Оплачиваю?», «да», лимит, постоянные разрешения, фон и подписки.
- `credits.test.ts` — алерт о балансе (без него Бро молчит всем).

#### Сомнения

- `backend.test.ts` «asks for the memory…» — `memoryMb` реально используется в `agent/sandbox.ts` (`attachmentsMemoryMb`); удалённый тест был единственной проверкой проброса. Если это важно — вернуть.
- `connected-apps.test.ts` «shows what a read would open on its card» — тексты карточек чтений, хотя чтения идут без карточек; оставил из-за зоны карточек.
- `credits.test.ts` — beforeAll с миграцией PGlite имеет свой таймаут 20 с и под нагрузкой машины падает (до и после правок); отдельно проходит.
- Базовый прогон под нагрузкой (load ~50) дал 40 падений по таймаутам; после правок с `--testTimeout=120000 --maxWorkers=2` все зелёные, credits — отдельным прогоном.

#### Возможно мёртвые экспорты

- нет (проверил `googleWorkspaceAuthConfigId`, `memoryMb` — используются в проде).

### b04

| файл                                                       | тестов было | стало   |
| ---------------------------------------------------------- | ----------- | ------- |
| shared/spending/limit.test.ts                              | 43          | 42      |
| agent/lib/memory/rule-approval.test.ts                     | 7           | 6       |
| agent/lib/memory/supermemory.test.ts                       | 3           | 3       |
| agent/lib/monitoring/tests/digest.test.ts                  | 4           | 4       |
| agent/lib/tests/principal-scope.test.ts                    | 2           | 2       |
| agent/lib/tests/profile-memory.test.ts                     | 6           | 6       |
| agent/lib/tests/workspace-list.test.ts                     | 3           | 2       |
| tests/agent/browser-vm/backend.test.ts                     | 17          | 15      |
| tests/agent/browser-vm/cloudru.test.ts                     | 18          | 16      |
| tests/agent/browser-vm/idle.test.ts                        | 14          | 14      |
| tests/agent/browser-vm/ids.test.ts                         | 7           | 6       |
| tests/agent/browser-vm/lifecycle.test.ts                   | 96          | 85      |
| tests/agent/browser-vm/pilot.test.ts                       | 2           | 2       |
| tests/agent/browser-vm/private-route.test.ts               | 10          | 10      |
| tests/agent/browser-vm/proxy.test.ts                       | 5           | 4       |
| tests/agent/browser-vm/rollout.test.ts                     | 16          | 15      |
| tests/agent/browser-vm/runs.test.ts                        | 50          | 48      |
| tests/agent/browser-vm/token.test.ts                       | 5           | 4       |
| tests/agent/browser-vm/worker.test.ts                      | 20          | 16      |
| tests/agent/compaction/compacted.test.ts                   | 47          | 47      |
| tests/agent/tools/checkout-harness-tasks.test.ts           | 1           | 1       |
| tests/agent/tools/generate_image.test.ts                   | 25          | 20      |
| tests/agent/tools/gmail-attachment.test.ts                 | 6           | 6       |
| web/components/ai-elements/tests/message-response.test.tsx | 3           | 2       |
| web/components/ai-elements/tests/prompt-input.test.tsx     | 3           | 1       |
| **итого**                                                  | **413**     | **377** |

#### Удалено

- `shared/spending/limit.test.ts` — «asks for any paid purchase when no limit is set» — dup — тот же `decideAutoPayment(undefined, …) → no_limit` проверяет первая строка «never binds the card for a free booking…».
- `agent/lib/memory/rule-approval.test.ts` — «does not add a card to an allowed follow-through from a browser report» — dup — без сохранённых правил ответ `not-applicable` при любом authenticator (уже первый тест); случай «browser-result с правилом» остаётся.
- `agent/lib/tests/workspace-list.test.ts` — «asks once per turn of a session» — dup — «один запрос на ход» проверяет тест «keeps a running turn's verdict…» (`lookup` вызван 1 раз).
- `tests/agent/browser-vm/backend.test.ts` — «needs the gVisor release only for hosts that run runsc» — dup — то же поведение для незаданного runtime проверяет «takes runc only when named…».
- `tests/agent/browser-vm/backend.test.ts` — «takes the owner from the caller's scope when it has one» — impl — проверяет лишь, что не вызван `readWorkspaceScope` (оптимизация).
- `tests/agent/browser-vm/backend.test.ts` — внутри «reads the pool's settings…» (кейс оставлен): убраны проверки значений по умолчанию (trivial) и 6 из 12 плохих значений env (dup одного класса); тест падал по таймауту из-за 14 повторных разборов env.
- `tests/agent/browser-vm/cloudru.test.ts` — «releases an address that outlived its VM» — impl — только URL одного DELETE.
- `tests/agent/browser-vm/cloudru.test.ts` — «asks nothing for no disks» — trivial — ранний выход на пустом списке.
- `tests/agent/browser-vm/ids.test.ts` — «are new for every session and run» — trivial — уникальность UUID.
- `tests/agent/browser-vm/proxy.test.ts` — «is not configured without the setting» — trivial — текст ошибки при отсутствии env.
- `tests/agent/browser-vm/token.test.ts` — «are not signed without a signing key» — trivial — текст ошибки при отсутствии env.
- `tests/agent/browser-vm/worker.test.ts` — «reads a run with no unread messages, from a worker that omits the field» — trivial — необязательное поле схемы.
- `tests/agent/browser-vm/worker.test.ts` — «opens and closes a keep-alive tab, and controls Chrome and its profile» — impl — только пары method/URL; keep-alive и сброс профиля покрыты в runs/lifecycle.
- `tests/agent/browser-vm/worker.test.ts` — «looks a VM's private address up before its call's timeout starts» — dup — то же проверяет `private-route.test.ts` («looks the address up ahead of a request…»).
- `tests/agent/browser-vm/worker.test.ts` — «calls nothing for a sandbox that is on no host» + «…VM whose address is not known yet» — слиты в один тест (все проверки сохранены).
- `tests/agent/browser-vm/rollout.test.ts` — «does not start without the bucket to fetch from» — dup — тот же «нет конфигурации → ничего» проверяет «does nothing at all without BROWSER_VM_WORKER».
- `tests/agent/browser-vm/lifecycle.test.ts` — «asks nothing of the worker without BROWSER_VM_WORKER» — dup — то же в `rollout.test.ts`.
- `tests/agent/browser-vm/lifecycle.test.ts` — 1 строка it.each «keeps the VM up while an errand used it within the window» — dup — то же окно проверяет следующая таблица и `idle.test.ts`.
- `tests/agent/browser-vm/lifecycle.test.ts` — 4 из 6 строк it.each «decides the idle stop by who woke the VM» — dup — граничные случаи `browserVmIdleStopDue` уже в таблице `idle.test.ts`; оставлены по одной строке «останавливает»/«не останавливает».
- `tests/agent/browser-vm/lifecycle.test.ts` — «settles a VM that finished powering off as stopped» — dup — переход в `stopped` проверяет «records the hour a VM was on once it settles as stopped».
- `tests/agent/browser-vm/lifecycle.test.ts` — «starts the VM's clock when it powers the VM on» — dup — `poweredOnAt` при включении проверяет «stops the VM as before when its time cannot be recorded…».
- `tests/agent/browser-vm/lifecycle.test.ts` — «finishes a deletion that was left half done» — dup — тот же финал удаления (адрес, бэкапы, запись) в «deletes the VM with its disk and address…».
- `tests/agent/browser-vm/lifecycle.test.ts` — «still finds an exit inside the turn's share» — dup — ротацию до RU проверяет «rotates the sticky session…», бюджет хода — «leaves the rest of the search… to the queue».
- `tests/agent/browser-vm/lifecycle.test.ts` — «re-arms the proxy alert once the proxy takes the login again» — impl — только вызов мока `clearOwnerAlert`.
- `tests/agent/browser-vm/runs.test.ts` — «runs an errand that only searches in flash mode, and any other as before» — dup — ровно это ожидание (`[flash+vmTuning, vmTuning, vmTuning]` с follow-up) есть в «serves the fast browser's pilot…» (строка чужого пилота), байты — в «sends the worker byte for byte…».
- `tests/agent/browser-vm/runs.test.ts` — «answers [] for unread messages once the worker no longer reports any» — dup — `unreadMessages: []` проверяет «mirrors the worker's answer into the record…».
- `tests/agent/tools/generate_image.test.ts` — «tells the model when there are no photos to draw from» — wording — та же фраза проверяется в «fails with a reason the model can act on».
- `tests/agent/tools/generate_image.test.ts` — 4 из 10 строк it.each «reads «%s» as a picture request» — dup — оставлены рус./англ. просьба, «imagine» да/нет, «хочу» без картинки, «рисовую» (ложное совпадение корня).
- `web/components/ai-elements/tests/message-response.test.tsx` — «uses the synchronous renderer…» + «keeps incremental rendering…» — слиты в один (проверки сохранены).
- `web/components/ai-elements/tests/prompt-input.test.tsx` — «leaves non-compact submit buttons in normal flow», «adds scale correction around compact textareas only» — impl — проверки CSS-классов и data-атрибутов мока motion; оставлен один тест компакт-кнопки и детей футера.

#### Оставлено сознательно

- `shared/spending/limit.test.ts` — деньги: лимит трат, постоянные разрешения, `policyWidens` — всё, кроме одного дубля.
- `agent/lib/memory/rule-approval.test.ts` — запреты сохранённых правил, fail-closed, `reasoning.enabled=false` классификатора (dev-notes).
- `agent/lib/memory/supermemory.test.ts`, `agent/lib/tests/principal-scope.test.ts`, `agent/lib/tests/profile-memory.test.ts` — недоверенный текст провайдера, чужой workspace, память только в ходе человека.
- `tests/agent/compaction/compacted.test.ts` — целиком: «кто открыл ход» и слова человека после сжатия (`said`, вопрос об оплате, «да»), подробно описано в dev-notes.
- `tests/agent/tools/checkout-harness-tasks.test.ts` — упомянут в dev-notes.
- `tests/agent/tools/gmail-attachment.test.ts` — отказ без авторизованного пользователя, 401, частичные сбои.
- `tests/agent/browser-vm/rollout.test.ts`, `lifecycle.test.ts` — регрессии с датами (10.10 «401 expired token», 14.10 медленные выходы, 09.10 бюджет хода, 01.10 407 прокси), подпись и sha256 кода worker, логи без логина прокси; «keeps a Russian exit whose speed could not be measured» сначала удалил, затем вернул — это единственная проверка старого формата worker (`error` рядом с адресом).
- `tests/agent/browser-vm/token.test.ts`, `worker.test.ts` — векторы подписи, общие с `test_worker.py`; токены, привязанные к сессии; 2Captcha-ключ в `runs.test.ts`.
- `tests/agent/browser-vm/idle.test.ts`, `private-route.test.ts` — окно простоя по тому, кто открыл ход; SNI/Host при приватной маршрутизации.
- `web/.../message-response.test.tsx` — чужие картинки не показываются (только `/artifacts/`).
- `agent/lib/monitoring/tests/digest.test.ts` — единственная проверка форматирования сводки владельца (суммы, округление) и окна повторной отправки (ревью U3a).

#### Сомнения

- Cloud.ru-половина пачки (`cloudru.test.ts`, большая часть `lifecycle.test.ts` — создание, ребут, отказ, удаление VM, учёт часов VM, — `private-route.test.ts`, `idle.test.ts`, `token.test.ts` cloud-init) проверяет бэкенд отдельной VM Cloud.ru на workspace. По dev-notes аккаунт Cloud.ru приостановлен 10.10, «всё про Cloud.ru — история», `CLOUDRU_PRIVATE_ROUTING=off`, но код живой (`BROWSER_BACKEND=cloudru` ещё разбирается). Если владелец подтвердит, что этот бэкенд не вернётся, это ~80 тестов в категории `stale`; без подтверждения я их не трогал.
- В `lifecycle.test.ts` и `runs.test.ts` первые тесты describe под нагрузкой (load average ~38 от параллельных исполнителей) падают по таймауту 5 с — так было и до правок; с `--testTimeout=60000` все 148 тестов трёх файлов зелёные. Сбой «queues the errand of a sandbox not up within the turn's wait» (`retryAfterMs` 180000 вместо 15000) — следствие таймаута предыдущего теста: его фейковые часы и мок продолжают работать. В обычном CI не воспроизводится.

#### Возможно мёртвые экспорты

- нет (`openBrowserVmWorkerTab`, `closeBrowserVmWorkerTab`, `controlBrowserVmWorkerChrome`, `deleteCloudRuFloatingIp`, `PromptInputTextarea` используются в продовом коде).

### b05

| файл                                            | тестов было               | стало           |
| ----------------------------------------------- | ------------------------- | --------------- |
| tests/agent/agency-pilot.test.ts                | 2                         | 2               |
| tests/agent/agent.test.ts                       | 35                        | 34              |
| tests/agent/approval-memory-recall.test.ts      | 4                         | 4               |
| tests/agent/bug-bot.test.ts                     | 15                        | 14              |
| tests/agent/capabilities.test.ts                | 10                        | 10              |
| tests/agent/dynamic-tool-rebind.test.ts         | 3                         | 3               |
| tests/agent/first-contact.test.ts               | 4                         | 4               |
| tests/agent/form-of-address.test.ts             | 5                         | 5               |
| tests/agent/instructions.test.ts                | 23                        | 19              |
| tests/agent/memory-digest.test.ts               | 29                        | 29              |
| tests/agent/memory-documents.test.ts            | 3                         | 2               |
| tests/agent/memory-namespace.test.ts            | 11                        | 11              |
| tests/agent/memory-tools-attachments.test.ts    | 9                         | 9               |
| tests/agent/memory.test.ts                      | 47                        | 47              |
| tests/agent/mode.test.ts                        | 7                         | 7               |
| tests/agent/owner-alert.test.ts                 | 9                         | 9               |
| tests/agent/phone-report-delivery.test.ts       | 4                         | 4               |
| tests/agent/phone.integration.test.ts           | 28 (пропускается без env) | 28              |
| tests/agent/reply-targets.test.ts               | 5                         | 5               |
| tests/agent/step-context.test.ts                | 12                        | 12              |
| tests/agent/subscriptions-pilot.test.ts         | 1                         | 0 (файл удалён) |
| tests/agent/tools/google-workspace.test.ts      | 17                        | 15              |
| tests/agent/tools/non-purchase-approval.test.ts | 9                         | 7               |
| tests/agent/tools/tool-block.test.ts            | 4                         | 4               |
| tests/agent/workstreams.test.ts                 | 14                        | 14              |
| **итого**                                       | **310**                   | **298**         |

#### Удалено

- `tests/agent/agent.test.ts` — «adds no note outside the pilot» — dup — то же `replyNote === note("ru")` вне пилота уже проверяет «requires a tool call until the person's message is answered».
- `tests/agent/instructions.test.ts` — «computes numbers with a tool and takes changing facts from a fresh search» — wording — дословные фразы промпта, не безопасность.
- `tests/agent/instructions.test.ts` — «forwards mail attachments as private artifacts» — wording.
- `tests/agent/instructions.test.ts` — «keeps Bro masculine, on «ты» by default, and free of calques» — wording; род и обращение держит `replyDirective` (покрыто form-of-address.test.ts и agent.test.ts).
- `tests/agent/instructions.test.ts` — «greets a first-contact turn briefly…» — wording; текст знакомства стережёт хэш в `tests/agent/skills/flag-off.test.ts`, контекст — first-contact.test.ts.
- `tests/agent/instructions.test.ts` — в «explains browser_task once Browser Use is configured» срезано ~35 дословных проверок (хостелы, местные площадки, капча, ссылки, картинки и т. п.) — wording; оставлены строки о недоверенных данных сайта, телефоне-секрете, оплате («да», «Оплачиваю»-вопрос, согласие поручения, `allowSubmit`/`allowPayment` в фоне, `NEEDS: payment`).
- `tests/agent/memory-documents.test.ts` — «treats a version it never issued as a conflict» — dup — слит в «creates once…» (проверка сохранена, минус одна сборка PGlite с миграциями).
- `tests/agent/tools/non-purchase-approval.test.ts` — 2 строки it.each «denies sends and updates from %s» (`scheduled-result`, `app`) — dup — тот же отказ `ownTurnApproval`, все авторизаторы перебирает mode.test.ts; оставлены `scheduled-worker`, `background-task`.
- `tests/agent/tools/google-workspace.test.ts` — «is not a policy's own refusal…», «changes nothing once sent», «is not saved twice» — dup — слиты в один тест «is not saved after a policy's own refusal, once sent, or twice» с теми же тремя проверками.
- `tests/agent/bug-bot.test.ts` — «stays off with Bro's own token, which tg-bridge reads» — dup — слит в «stays off and never reads updates with Bro's token…» (проверка `bugBotTarget()` сохранена).
- `tests/agent/subscriptions-pilot.test.ts` — файл целиком — trivial/dup — `subscriptionsPilot` лишь оборачивает `listsWorkspaceRemembered` (покрыт `agent/lib/tests/workspace-list.test.ts`, `tests/agent/login-handoff/pilot.test.ts`).

#### Оставлено сознательно

- `agent.test.ts` — принудительная доставка, отчёты браузера, карточки до итога, задача на Gateway (инъекция), аренда воркера: регрессии с датами и ревью; dev-notes требует сверять опции `modelSelection` целиком.
- `memory.test.ts`, `workstreams.test.ts`, `memory-digest.test.ts`, `memory-namespace.test.ts` — забывание и история без текста, правила только из хода человека, вырезание кодов, изоляция воркспейсов, перенос namespace (потеря памяти 02.10).
- `capabilities.test.ts`, `dynamic-tool-rebind.test.ts`, `memory-tools-attachments.test.ts`, `approval-memory-recall.test.ts` — названы в dev-notes (хунки патча eve, матрица инструментов воркера).
- `mode.test.ts`, `reply-targets.test.ts`, `non-purchase-approval.test.ts`, `form-of-address.test.ts` (инъекция в имени) — кто открыл ход, approval, чужой разговор.
- `phone.integration.test.ts`, `phone-report-delivery.test.ts` — охрана телефонии и отчёт звонка (dev-notes).
- `instructions.test.ts` — оставлены тесты выбора роли и все проверки правил оплаты/недоверенных данных; тесты с бенчмарк-регрессиями (d09, d12, d14, d18) оставлены.
- `bug-bot.test.ts`, `owner-alert.test.ts`, `first-contact.test.ts`, `step-context.test.ts`, `tool-block.test.ts`, `agency-pilot.test.ts` — поведение из dev-notes (409, токены, условия бета-строки, кэш блока инструментов, отказ email в `AGENCY_WORKSPACES`).

#### Сомнения

- `memory.test.ts` — «shows preferences apart…», «applies none of them…», «applies the diet…» сверяют целые фразы промпта через `toBe`; это регрессии d01/d13, поэтому не тронуты, но их можно ослабить до `toContain` ключевых меток.
- `instructions.test.ts` — «describes Bro as a hosted service…», «answers mail in the person's voice…», «collects unanswered mail…» — тоже дословные фразы, но с пометками бенчмарка; оставлены.
- `tests/agent/tools/tool-block.test.ts` «follows the skills of the conversation in both pilots…» падал ещё ДО моих правок (хэш блока после `load_skill` отличается) — файл я не менял; два других теста там же упали по таймауту из-за нагрузки машины (load ~40).
- PGlite-файлы (bug-bot, memory-documents и др.) под нагрузкой падают на жёстких таймаутах beforeAll 20 с / теста 30 с; при load < 10 зелёные.

#### Возможно мёртвые экспорты

- нет: `subscriptionsPilot` используется в `agent/schedules/subscriptions.ts` и `agent/schedules/proactive.ts`.

### b06

Всего по vitest: 257 → 243 (−14). Пачка почти целиком из интеграционных тестов PGlite (настоящая база, настоящие сервисы), плюс много денег и безопасности, поэтому резерв небольшой.

| файл                                      | тестов было | стало |
| ----------------------------------------- | ----------- | ----- |
| db/tests/agency.test.ts                   | 8           | 7     |
| db/tests/billing.test.ts                  | 8           | 8     |
| db/tests/browser-hosts.test.ts            | 4           | 4     |
| db/tests/browser-images.test.ts           | 2           | 2     |
| db/tests/browser-payment-handoff.test.ts  | 6           | 5     |
| db/tests/browser-runs.test.ts             | 34          | 32    |
| db/tests/browser-vms.test.ts              | 16          | 15    |
| db/tests/channel-identities.test.ts       | 4           | 4     |
| db/tests/contacts.test.ts                 | 6           | 6     |
| db/tests/conversation-log.test.ts         | 6           | 5     |
| db/tests/database-migration.test.ts       | 5           | 5     |
| db/tests/database-schema.test.ts          | 7           | 5     |
| db/tests/drive-files.test.ts              | 1           | 1     |
| db/tests/generated-images.test.ts         | 1           | 1     |
| db/tests/gmail-attachments.test.ts        | 1           | 1     |
| db/tests/health.test.ts                   | 4           | 4     |
| db/tests/installation-secrets.test.ts     | 6           | 6     |
| db/tests/introductions.test.ts            | 3           | 3     |
| db/tests/login-handoffs.test.ts           | 7           | 7     |
| db/tests/photon-users.test.ts             | 3           | 3     |
| db/tests/proactive.test.ts                | 23          | 22    |
| db/tests/scheduled-agent-jobs.test.ts     | 10          | 10    |
| db/tests/services.test.ts                 | 1           | 1     |
| db/tests/spending.test.ts                 | 12          | 12    |
| db/tests/subscriptions.test.ts            | 13          | 13    |
| db/tests/turn-log.test.ts                 | 7           | 7     |
| db/tests/usage-costs.test.ts              | 5           | 5     |
| db/tests/yandex-purchases.test.ts         | 14          | 14    |
| db/tests/yookassa.test.ts                 | 4           | 4     |
| tests/agent/tools/drive.test.ts           | 5           | 3     |
| tests/agent/tools/form-of-address.test.ts | 12          | 12    |
| tests/agent/tools/messaging.test.ts       | 26          | 23    |

(Счёт по файлам — по `it` плюс строки `it.each`; сумма по файлам даёт 264, vitest при прогоне до правок показал 257, разница — в разметке/пропусках vitest, разница −14 совпадает.)

#### Удалено

- `db/tests/browser-runs.test.ts` — «keeps one Browser Use profile per workspace» — dup — то же (первый профиль не заменяется, у bob свой) проверяет «replaces the workspace's browser profile when it moves to its VM».
- `db/tests/browser-runs.test.ts` — «scopes a run to the workspace that started it» — dup — изоляцию `readBrowserRunForScope` по воркспейсу уже проверяет первый тест файла (и `readLatestBrowserRunForScope` в тесте ретраев).
- `db/tests/proactive.test.ts` — «keeps a connection made during the very first probe» — dup — тот же путь (wake во время пробы → `deferProactiveWatch` отказывает), что «keeps a connection made while a probe of a parked watch was in flight».
- `db/tests/agency.test.ts` — «accepts agent_mail as a proactive signal source» — dup — сигнал `agent_mail` в очереди проактивной проверки проверяет `proactive.test.ts` («keeps the agent inbox watermark apart from Google's…»). Убраны ставшие ненужными `telegram`, `now` и импорт `proactive` в фикстуре.
- `db/tests/browser-payment-handoff.test.ts` — строка `released` из `it.each` — dup — тот же класс «резерв не в состоянии reserved», что и `charged`; оставлены missing/charged/foreign.
- `db/tests/conversation-log.test.ts` — «refuses a text the table does not hold» — trivial — голый CHECK на пустой текст; что сервис не пишет пустую строку, проверяет первый тест.
- `db/tests/database-schema.test.ts` — «owns the application and Better Auth tables» — trivial — список имён таблиц (константы схемы).
- `db/tests/database-schema.test.ts` — «uses native PostgreSQL types for structured application values» — trivial — SQL-типы колонок, повтор определения схемы. Импорты схемы сокращены.
- `db/tests/browser-vms.test.ts` — «mirrors the unread messages a settled run leaves…» — trivial — запись и чтение одной колонки.
- `tests/agent/tools/drive.test.ts` — «forwards the query and limit and returns the files it found» — impl — проверка аргументов мока и проброс результата. Убран мок `searchDrive`.
- `tests/agent/tools/drive.test.ts` — «returns metadata for a file it does not download» — trivial — проброс результата `readDriveFile` без логики.
- `tests/agent/tools/messaging.test.ts` — строка `channel:photon` из `it.each` «never tells the model … delivers an attachment as a link» — dup — оставлены eve и telegram.
- `tests/agent/tools/messaging.test.ts` — «still explains that a quoted reply is delivered unquoted» — dup/wording — та же фраза «Native quoted replies are unavailable» проверяется в тесте пилота early reply.
- `tests/agent/tools/messaging.test.ts` — «delivers the first message of a turn as written» — dup — доставку без изменений проверяют тесты языка ответа и «keeps attachments… in the person's own turn».

#### Оставлено сознательно

- Деньги и согласие: `billing`, `spending`, `yandex-purchases`, `yookassa`, `browser-payment-handoff` (кроме одной строки-дубля), `usage-costs` — целиком.
- Безопасность и права: `channel-identities` (одноразовые токены, Better Auth), `login-handoffs`, `installation-secrets`, изоляция артефактов по владельцу (`drive-files`, `generated-images`, `gmail-attachments`, `browser-images`), ссылки и вложения в отчёте task-агента в `messaging` (сеть файлов человека), метка `DELIVERY_COMPLETE` (инцидент 04.10).
- dev-notes: `proactive.test.ts` (PGlite и `vi.resetModules`), `health.test.ts` (необработанный отказ `end()`), `contacts.test.ts` (Маша/Мама, «Саше»).
- Миграции: `database-migration.test.ts`, тесты-миграции в `proactive` («recovers the messenger…») и `introductions` («predates the column»), `database-schema` «orders migrations by the timestamps» и «adopts existing tables without request-time DDL».
- `form-of-address.test.ts` — все 12: защита «вы» в письме от сохранения как обращения к Бро, сжатие (RU d09); списки фраз внутри одного теста не трогал (на счёт тестов не влияют).
- `messaging` «keeps each fact with its option (RU d03, 25.09)» — дословная фраза, но с датой регрессии бенчмарка.
- `scheduled-agent-jobs`, `subscriptions`, `browser-vms`, `browser-hosts`, `turn-log`, `browser-runs` (основное) — каждый тест — свой сценарий аренды/гонки/повтора в настоящей базе, дублей не нашёл.

#### Сомнения

- `db/tests/database-schema.test.ts` «orchestrates the native migration through Turbo» — сверяет `vercel.json`/`turbo.json` и запрет миграции из превью Vercel; Vercel больше не путь отката (dev-notes, 09.10), так что тест, возможно, stale. Оставил: конфиг ещё в репозитории, а превью с прод-базой — реальный риск, если его кто-то вернёт.
- Прогон до правок под нагрузкой (параллельные исполнители) дал 17 падений по таймаутам (spending, billing, channel-identities, database-migration и др., 20–125 с на тест) и одно `agency` «counts planned and done…» — сравнение по `Date.now()` при медленном прогоне. Это шум нагрузки, к правкам не относится; изменённые файлы проверены отдельно с `--maxWorkers=2 --testTimeout=180000`.

#### Возможно мёртвые экспорты

- нет (`driveSearch` — инструмент агента, `searchDrive` используется им же).

### b07

| файл                                                 | тестов было | стало   |
| ---------------------------------------------------- | ----------- | ------- |
| agent/lib/compaction/tests/pilot.test.ts             | 3           | 3       |
| agent/lib/compaction/tests/turn-start.test.ts        | 6           | 6       |
| agent/lib/conversation/tests/recap.test.ts           | 13          | 13      |
| agent/lib/subscriptions/tests/check.test.ts          | 7           | 7       |
| agent/lib/subscriptions/tests/delivery.test.ts       | 3           | 3       |
| agent/lib/subscriptions/tests/flight.test.ts         | 12          | 12      |
| agent/lib/subscriptions/tests/page.test.ts           | 5           | 5       |
| agent/lib/subscriptions/tests/price.test.ts          | 24          | 23      |
| shared/memory/schema.test.ts                         | 108         | 108     |
| tests/agent/schedules/any-chat.test.ts               | 4           | 4       |
| tests/agent/schedules/browser-poller.test.ts         | 44          | 43      |
| tests/agent/schedules/browser-runs.test.ts           | 2           | 2       |
| tests/agent/schedules/dynamic.test.ts                | 15          | 10      |
| tests/agent/schedules/memory-history.test.ts         | 3           | 1       |
| tests/agent/schedules/proactive.test.ts              | 24          | 22      |
| tests/agent/schedules/subscriptions.test.ts          | 6           | 5       |
| tests/agent/schedules/switch.test.ts                 | 7           | 7       |
| tests/agent/schedules/telegram-conversations.test.ts | 5           | 4       |
| tests/agent/schedules/web-delivery.test.ts           | 10          | 10      |
| tests/agent/skills/slot.test.ts                      | 21          | 19      |
| tests/agent/skills/tools.test.ts                     | 9           | 9       |
| tests/agent/subagents/task/agent.test.ts             | 3           | 2       |
| tests/agent/subagents/task/instructions.test.ts      | 2           | 2       |
| tests/agent/subagents/task/person-files.test.ts      | 30          | 30      |
| tests/agent/tools/apps.test.ts                       | 23          | 21      |
| tests/agent/tools/schedule-approval.test.ts          | 4           | 4       |
| tests/agent/tools/site-sign-ins.test.ts              | 4           | 4       |
| tests/agent/tools/web-fetch.test.ts                  | 25          | 23      |
| **итого**                                            | **422**     | **402** |

`tests/agent/skills/core.test.ts`, `flag-off.test.ts`, `bodies.test.ts` не трогал и не считал.

#### Удалено

- `price.test.ts` — «refuses a catalogue of several products» — dup — тот же `several-products` для нескольких товаров проверяют «tells products … apart by SKU» и первый тест JSON-LD.
- `browser-poller.test.ts` — «reports a basket and hotels as a list of what the run found» — dup/wording — разбор `ITEMS` в нумерованный список уже покрыт в `tests/agent/browser-use/outcome.test.ts` и `completion.test.ts`; остальное — дословная фраза guidance.
- `memory-history.test.ts` — «expires the cross-channel log whatever the pilot» — dup — оставшийся «expires the log even when a memory pass failed» проверяет тот же вызов.
- `memory-history.test.ts` — «expires the log with schedules off, and leaves memory history alone» — dup — то же самое проверяет `switch.test.ts` («memoryHistory only expires the cross-channel log»), правило 14 дней из dev-notes этим покрыто.
- `telegram-conversations.test.ts` — «stores telegram alongside the existing conversation channels» — trivial — проверка enum схемы drizzle (константа); убраны импорты `getTableConfig`, `scheduledAgentJobs`.
- `proactive.test.ts` — «does not rank mail that fits one run» — impl — только «мок не вызван», без поведения.
- `proactive.test.ts` — «keeps a run outside the agency pilot a proactive one, with the prompt it had» — dup — слит: проверки промпта («worth writing first about», нет «report it.») перенесены в «dispatches a claimed run as a proactive worker», kind `proactive` там уже проверялся.
- `dynamic.test.ts` — «delivers recoverable iMessage reports through the schedule channel handle» — dup — путь тика к отчёту покрыт «delivers a web chat report through the schedule's own session handle», доставка iMessage — «routes iMessage reports to the stored conversation».
- `dynamic.test.ts` — «hands a stored answer to the waiting worker session» — dup — то же сквозным путём на настоящей схеме: `any-chat.test.ts` «resumes a waiting run with the answer given in the chat that asked» (respond, auth `scheduled-input`, состояние прогона, однократность).
- `dynamic.test.ts` — «routes web chat reports to the stored session» — dup — повтор теста тика про веб-чат и `web-delivery.test.ts` «delivers a scheduled task's result into the web chat».
- `dynamic.test.ts` — «suppresses reports for a web chat session that has ended» — dup — `web-delivery.test.ts` «suppresses the report only once every chat it could go to has ended» (на настоящей БД, статус `suppressed`).
- `dynamic.test.ts` — «retries a web chat report while its session is still starting» — dup — `web-delivery.test.ts` «waits for a web chat that is still starting instead of skipping it».
- `subscriptions.test.ts` — «counts a read that threw as a failed check» — dup — слит в «keeps going past one watch that throws» (бросает `TypeError`, проверяется `unreachable: TypeError`).
- `slot.test.ts` — «names the skills for a name that is none of them» — dup/wording — ответ на неизвестное имя и список навыков проверяет «names the files among the skills only where they reach the task agent».
- `slot.test.ts` — «takes a short name, trimmed» — trivial — проверка zod-схемы параметра (trim, длина).
- `subagents/task/agent.test.ts` — «refuses the steps of a message whose checks could not be read» — dup — слит с «refuses every step while its sandbox owes…» циклом по `owed`/`unchecked`; все проверки сохранены.
- `web-fetch.test.ts` — «returns a missing page as it is» — dup — строку «Request failed with status code» проверяет тест с 401.
- `web-fetch.test.ts` — строка it.each `https://192.168.1.1/` — dup — частный диапазон RFC1918 уже представлен `10.0.0.5`; остальные 8 строк (loopback, порт eve, IPv6, mapped, metadata, hex) оставлены.
- `apps.test.ts` — «tells the turn a write went through» — dup — слит в «writes what the person asked at once…» (`wrote: true` проверяется там).
- `apps.test.ts` — «allows delegated writes in browser follow-through while identifying writes regardless of tags» — dup — тот же `browser-result` + `TODOIST_DELETE_TASK` → `not-applicable` проверяет «runs delegated writes without approval-card length restrictions».

#### Оставлено сознательно

- `shared/memory/schema.test.ts` — вся таблица (108 строк) фильтра кодов/паролей/карт памяти: безопасность (секреты и коды), п. 31, и dev-notes требует гонять правку фильтра «на сотне образцов» (домофоны, счета, полисы сохраняются). Почти-дубли строк (разные регистры, двоеточие, длина цифр) — это границы регулярок.
- `person-files.test.ts`, `subagents/task/instructions.test.ts`, `agent.test.ts` (кроме слияния) — сеть песочницы с файлами человека.
- `apps.test.ts` — approval-политика, отказы фоновым работникам (it.each 4 аутентификатора), карточки, read-only Google, `composioToolReadsOnly` (единственное место покрытия).
- `schedule-approval.test.ts` — approval/карточки расписаний, кто открыл ход.
- `site-sign-ins.test.ts` — права (только ход человека), забывание входов.
- `web-fetch.test.ts` — приватные адреса/редиректы/DNS (dev-notes ссылается на этот файл), память отказов по разговору (dev-notes).
- `skills/tools.test.ts` — dev-notes ссылается (`body-only`): списки фраз — гарантия, что снятое из коротких описаний правило осталось в теле навыка.
- `skills/slot.test.ts` «comes before the profile's records» — правило из dev-notes про порядок слотов.
- `browser-poller.test.ts` — интеграция на PGlite: очередь, аренды, Госуслуги по одному (RU 25.09), маскированный телефон в SMS-отчёте (RU 25.09), оплата «Оплачиваю?»/allowSubmit (единственная проверка фразы «only their plain yes»), live watch.
- `recap.test.ts` — инъекции/недоверенные данные: сводка другого канала не даёт кода, согласия, first-contact, подделки отчёта, тегов Бро.
- `compaction/*` — регрессии из dev-notes (порог ≥100k валит env, сжатие только на шаге 0).
- `subscriptions/*` (check/delivery/flight/page/price) — плотные тесты поведения; `page.test` — `fetchPublic` и редирект в metadata; `price` — линейность парсера на враждебной странице (dev-notes), цена только из слов человека.
- `web-delivery.test.ts`, `any-chat.test.ts`, `browser-runs.test.ts` — сквозные сценарии на настоящей схеме; именно на них опираются удаления дублей в `dynamic.test.ts`.

#### Сомнения

- `browser-poller.test.ts` «tells Bro … Госуслуги errand …» и «… person's own VM …» — дословные фразы `queuedStatusNote`, но других проверок этой функции нет; оставил.
- Полный прогон пачки параллельно с другими исполнителями (load ~25–30) даёт ложные падения: таймауты загрузки PGlite-наборов (`any-chat`, `browser-poller`, `web-delivery`), `slot.test` «keeps one scope…» и тест линейности `price.test`. До правок падали так же; каждый файл по отдельности зелёный (402 теста).

#### Возможно мёртвые экспорты

- нет: всё, что импортировали удалённые тесты (`readPrice`, `dispatchScheduledReport`, `scheduledAgentJobs`, `composioToolReadsOnly` и др.), используется дальше.

### b08

Итого по пачке: **507 → 458** (−49). Пачка тяжёлая по зонам «не трогай» (покупки Яндекса, забор платежей, согласие, охрана хода, fetchPublic), поэтому сокращение умеренное.

| файл                                                                                         | тестов было | стало           |
| -------------------------------------------------------------------------------------------- | ----------- | --------------- |
| agent/lib/outbound-media/attachments.test.ts                                                 | 26          | 25              |
| agent/lib/web-search/tests/search.test.ts                                                    | 24          | 22              |
| agent/lib/web-search/tests/web-search-tool.test.ts                                           | 11          | 10              |
| app/(authenticated)/chat/(new)/_components/new-chat.test.tsx                                 | 1           | 1               |
| app/(authenticated)/chat/[sessionId]/_components/chat-session.test.tsx                       | 1           | 0 (файл удалён) |
| app/(authenticated)/chat/[sessionId]/_components/conversation/index.test.tsx                 | 3           | 3               |
| app/(authenticated)/chat/[sessionId]/_components/conversation/message/index.test.tsx         | 5           | 4               |
| app/(authenticated)/chat/[sessionId]/_components/conversation/message/input-request.test.tsx | 12          | 10              |
| app/(authenticated)/chat/[sessionId]/_lib/message-events.test.ts                             | 9           | 7               |
| app/(authenticated)/chat/[sessionId]/_lib/session-history.test.ts                            | 2           | 2               |
| app/(authenticated)/chat/[sessionId]/_lib/turn-failure.test.ts                               | 2           | 2               |
| app/(authenticated)/chat/_lib/chat-usage.test.ts                                             | 4           | 2               |
| app/(authenticated)/chat/_lib/message-input.test.ts                                          | 3           | 3               |
| app/(authenticated)/vault/_tests/section.test.ts                                             | 3           | 3               |
| app/(authenticated)/workspace/(overview)/_tests/connected-app-action.test.tsx                | 3           | 2               |
| app/(authenticated)/workspace/(overview)/_tests/google-workspace-action.test.tsx             | 3           | 2               |
| app/(authenticated)/workspace/(overview)/_tests/spend-limit-section.test.ts                  | 4           | 4               |
| app/(authenticated)/workspace/(overview)/_tests/workspace-photon.test.ts                     | 7           | 5               |
| app/(authenticated)/workspace/admin/_tests/pages.test.ts                                     | 4           | 4               |
| app/_lib/subagent-sessions.test.ts                                                           | 9           | 8               |
| shared/identity/phone-number.test.ts                                                         | 2           | 2               |
| shared/user-profile/schema.test.ts                                                           | 5           | 5               |
| tests/agent/composio/authorization.test.ts                                                   | 2           | 2               |
| tests/agent/composio/proxy.test.ts                                                           | 7           | 6               |
| tests/agent/phone/alert.test.ts                                                              | 3           | 3               |
| tests/agent/phone/elevenlabs-outbound.test.ts                                                | 6           | 6               |
| tests/agent/phone/exolve.test.ts                                                             | 8           | 8               |
| tests/agent/phone/lifecycle.test.ts                                                          | 3           | 3               |
| tests/agent/tools/agency-control.test.ts                                                     | 8           | 7               |
| tests/agent/tools/privacy.test.ts                                                            | 27          | 23              |
| tests/agent/tools/vault.test.ts                                                              | 2           | 2               |
| tests/agent/tools/watch.test.ts                                                              | 16          | 15              |
| tests/agent/yandex/afisha-direct.test.ts                                                     | 3           | 3               |
| tests/agent/yandex/afisha.test.ts                                                            | 6           | 5               |
| tests/agent/yandex/browser-fence.test.ts                                                     | 53          | 51              |
| tests/agent/yandex/eda-purchase.test.ts                                                      | 6           | 6               |
| tests/agent/yandex/food/operations.test.ts                                                   | 16          | 15              |
| tests/agent/yandex/go-booking.test.ts                                                        | 23          | 23              |
| tests/agent/yandex/go.test.ts                                                                | 8           | 7               |
| tests/agent/yandex/instructions.test.ts                                                      | 7           | 6               |
| tests/agent/yandex/lavka-purchase.test.ts                                                    | 68          | 60              |
| tests/agent/yandex/maps.test.ts                                                              | 7           | 6               |
| tests/agent/yandex/market/cart.test.ts                                                       | 7           | 6               |
| tests/agent/yandex/market/orders.test.ts                                                     | 6           | 4               |
| tests/agent/yandex/market/product.test.ts                                                    | 4           | 3               |
| tests/agent/yandex/market/search.test.ts                                                     | 5           | 5               |
| tests/agent/yandex/pilot.test.ts                                                             | 3           | 2               |
| tests/agent/yandex/purchase.test.ts                                                          | 24          | 24              |
| tests/agent/yandex/ready.test.ts                                                             | 10          | 8               |
| tests/agent/yandex/tool.test.ts                                                              | 13          | 11              |
| tests/agent/yandex/transport.test.ts                                                         | 13          | 12              |

#### Удалено

- `attachments.test.ts` — «keeps a file the host refused as a link» — dup — HTTP-ошибка → ссылка уже проверена в «delivers the attachments it could fetch and links the rest» (http 500).
- `search.test.ts` — «retries when OpenRouter could not be reached» — dup — тот же путь повтора сетевого сбоя, что и тест с TimeoutError.
- `search.test.ts` — «uses the configured search model instead of the inference default» — trivial — чтение env; тот же механизм для RouterAI проверяет «leaves another reading model to RouterAI's routing».
- `web-search-tool.test.ts` — «asks a ticket search for fallback sellers, what failed and every fee» — wording — только дословные фразы подсказки; правило «билеты ищет браузер» держит тест «sends a search for tickets…». Из «reminds a pick…», «marks a chain…», «surfaces a failed search…» убраны дословные абзацы промпта, оставлено по одной фразе-правилу и все проверки пометок результатов.
- `chat-session.test.tsx` — файл целиком (1 тест) — impl — проверял лишь, что компонент передаёт один и тот же мок детям; всё вокруг замокано.
- `message/index.test.tsx` — «renders ordinary assistant text without a delivery tool result» — trivial.
- `input-request.test.tsx` — 2 строки it.each «hides historical requests in $state» (output-available, output-error) — dup — одна ветка «не pending → скрыть», оставлены approval-responded и output-denied. Из «renders legacy pending approval…» убраны проверки CSS-классов/`data-variant` (impl), оставлены текст, кнопки и отсутствие `disabled`.
- `message-events.test.ts` — «treats reply association as transport metadata» — dup базовой проекции; строка `rejected` из «ignores %s send_message results» — dup `failed` (тест стал обычным `it`).
- `chat-usage.test.ts` — по паре тестов слиты в один для `summarizeChatUsage` и `combineChatUsage` (−2), все проверки сохранены.
- `connected-app-action`, `google-workspace-action` — тесты «подключить»/«отключить» слиты в один (−1 каждый), проверки те же.
- `workspace-photon.test.ts` — «does not advertise a phone-number override without its connector» — dup «disables iMessage…»; «keeps the web chat as a text action» — wording/trivial.
- `subagent-sessions.test.ts` — «sorts the most recently called children first» — dup — порядок «свежий первым» проверяет «moves a continued child back to the front».
- `proxy.test.ts` — строка `500` в «does not retry %s» — dup строки 429 (любой не-голый 403 не повторяется).
- `agency-control.test.ts` — «names the action to undo» — trivial — проверка обязательного аргумента.
- `privacy.test.ts` — 3 строки `restrictsSending` (true) и 1 строка (false) — dup — тот же класс фраз; из большого теста убраны дословные проверки стиля ответа («3-5 short sentences» и т. п.), правило «Do not ask whether to delete» оставлено.
- `watch.test.ts` — «says a price exactly at the threshold has already come» слит с «already below» в один тест (обе цены, 7490 и 8000).
- `afisha.test.ts` — «answers an empty list as an empty list» — trivial.
- `food/operations.test.ts` — «counts the active Lavka orders» — trivial (фикстура → 0); убран ставший лишним импорт.
- `go.test.ts` — «go.rides answers the sign-in wall» — dup — стена входа общая (`go/session.ts`), проверена в go.estimate.
- `instructions.test.ts` — «sends Yandex errands to the API first…» — wording.
- `maps.test.ts` — «agrees with the reference hash on a known example» — trivial — тест тестового хелпера; сама подпись сверяется в «lists the places…».
- `market/orders.test.ts` — «answers an empty list with no orders» — trivial; «answers signed_out on the sign-in redirect» — dup (общий `market/prologue.ts`, проверено в cart).
- `market/product.test.ts` — «answers signed_out when the card redirects» — dup (тот же prologue).
- `market/cart.test.ts` — «refuses a change of the cart the person did not ask for» — dup — отметку `personAskedToChangeCart` для любой cart-операции проверяет `transport.test.ts` («take no site but Yandex's own, and a cart change only with the attestation»).
- `pilot.test.ts` — третий тест слит во второй (−1), строки те же.
- `ready.test.ts` — «answers signed_out when Go says nobody is signed in» — dup (общая стена Go); «does not guess when the cards could not be read» — wording.
- `tool.test.ts` — «describes the operations…» — wording; «says no card is linked only when Yandex ID has the person signed in» — dup `ready.test.ts` («explains where to link a card…»).
- `transport.test.ts` — «never changes a cart on a different Yandex service origin» — dup — тот же `runOn`, что в тесте покупки, с подмножеством проверок.
- `lavka-purchase.test.ts` — сокращены таблицы: «blocks invalid money» 6→4 (убраны NaN, «55,50»), «blocks unsupported payment» 4→2 (cash, split), «invalid wrapped order id» 4→2, «rejects changed snapshot identity» 4→2 (cartVersion, deliveryConditionsId) — dup строк одного класса.
- `browser-fence.test.ts` — в двух it.each по HTTP-статусу оставлены 400 и 404, убран 409 (−2) — dup: любой отказ create после dispatch ведёт тем же путём; 400 оставлен из-за dev-notes, 404 — из-за fallback сессии.
- `elevenlabs-outbound.test.ts` — без удаления тестов; убраны 3 дословные проверки манеры речи (не правила безопасности).

#### Оставлено сознательно

- `browser-fence`, `lavka-purchase`, `purchase`, `eda-purchase`, `go-booking` — деньги, согласие «Оплачиваю?», неоднозначные `unknown`/`submitting`, отсутствие повтора submit/create, вторая поездка (dev-notes: Лавка 13.10 скидка, `create_orders_disabled`, HTTP 400, Go `launch`, Trust `integrationProfileId`).
- `attachments.test.ts` — приватные адреса, DNS-rebind, редирект на заблокированный хост (fetchPublic), лимиты размера.
- `watch.test.ts`, `tool.test.ts` (границы user/workspace/session), `instructions.test.ts` (it.each по authenticator), `agency-control` (ход человека), `privacy.test.ts` (dev-notes: тексты о данных совпадают со страницей) — кто открыл ход и раскрытие обработчиков.
- `phone/*` — охрана телефонии и покупка номера (dev-notes 13–14.10: preflight, Exolve retry, end_call, приветствие).
- `admin/_tests/pages.test.ts` — права владельца; `spend-limit-section` — лимит трат и постоянные разрешения; карточки approval в `message/index.test.tsx`/`input-request.test.tsx`.
- `search.test.ts` — RouterAI ошибки под HTTP 200, `error: null`, хосты (dev-notes RouterAI).
- `web-search-tool.test.ts` — списки запросов классификатора «билеты/отели» оставлены целиком: каждая строка — отдельный ложный случай из ревью 25.09.

#### Сомнения

- `web-search-tool.test.ts` «asks a ticket search for fallback sellers…» — удалён как чистый wording; правило о сборах продавца сверх тарифа (деньги) теперь не проверяется дословно нигде.
- Сокращение строк в `lavka-purchase`/`browser-fence` — в денежной зоне, но строки одного класса; при желании вернуть 409 и NaN.
- Первые тесты в `search.test.ts`/`web-search-tool.test.ts` при параллельном прогоне падали по таймауту 5 с (холодный импорт после `vi.resetModules()`), и до, и после правок; с `--testTimeout=30000` зелёные. Это не регрессия правок, но флейк набора.

#### Возможно мёртвые экспорты

- нет (проверены `ChatSession`, `lavkaActiveOperation` — используются в проде).

### b09

| файл                                               | тестов было | стало   |
| -------------------------------------------------- | ----------- | ------- |
| agent/lib/delivery/links.test.ts                   | 12          | 12      |
| agent/lib/delivery/tests/amounts.test.ts           | 29          | 18      |
| agent/lib/delivery/tests/early-reply.test.ts       | 38          | 30      |
| agent/lib/delivery/tests/fallback.test.ts          | 20          | 15      |
| agent/lib/delivery/tests/fast.test.ts              | 6           | 5       |
| agent/lib/delivery/tests/holds.test.ts             | 2           | 2       |
| agent/lib/delivery/tests/language.test.ts          | 36          | 28      |
| agent/lib/delivery/tests/pending.test.ts           | 22          | 19      |
| agent/lib/delivery/tests/pilot.test.ts             | 6           | 6       |
| agent/lib/delivery/tests/questions.test.ts         | 7           | 7       |
| agent/lib/delivery/tests/turn-sends.test.ts        | 247         | 209     |
| agent/lib/history/tests/eligible.test.ts           | 12          | 12      |
| agent/lib/history/tests/pilot.test.ts              | 5           | 4       |
| agent/lib/history/tests/trim.test.ts               | 16          | 16      |
| agent/lib/phone/tests/policy.test.ts               | 17          | 14      |
| app/(public)/_tests/landing.test.tsx               | 9           | 5       |
| app/(public)/handoff/[id]/_tests/intro.test.tsx    | 5           | 2       |
| app/(public)/oferta/_tests/oferta.test.tsx         | 2           | 2       |
| app/(public)/privacy/_tests/privacy.test.tsx       | 3           | 3       |
| shared/model/id.test.ts                            | 9           | 6       |
| shared/model/provider.test.ts                      | 10          | 8       |
| tests/agent/hooks/browser-prewarm.test.ts          | 6           | 6       |
| tests/agent/hooks/browser-run-report.test.ts       | 8           | 8       |
| tests/agent/hooks/conversation-log.test.ts         | 57          | 45      |
| tests/agent/hooks/evlog.test.ts                    | 1           | 1       |
| tests/agent/hooks/phone-report.test.ts             | 10          | 10      |
| tests/agent/hooks/proactive-target.test.ts         | 7           | 7       |
| tests/agent/hooks/scheduled-run-completion.test.ts | 17          | 14      |
| tests/agent/hooks/session-owner.test.ts            | 2           | 2       |
| tests/agent/hooks/task-files.test.ts               | 20          | 20      |
| tests/agent/hooks/turn-log.test.ts                 | 14          | 14      |
| tests/agent/tools/ask-question.test.ts             | 16          | 11      |
| tests/agent/tools/contacts.test.ts                 | 4           | 3       |
| tests/agent/tools/find_images.test.ts              | 19          | 19      |
| tests/agent/tools/google-connect.test.ts           | 22          | 21      |
| web/trpc/admin.test.ts                             | 5           | 5       |
| web/trpc/http-context.test.ts                      | 3           | 3       |
| web/trpc/router.test.ts                            | 16          | 14      |
| **итого**                                          | **740**     | **626** |

#### Удалено

- `turn-sends.test.ts` — 38 кейсов. Строки `it.each` одного класса: «drops %s as a repeat» (тот же текст, другая пунктуация); «delivers %s right after it» (второй вариант отеля, следующий вопрос викторины); повторный адрес «Артур/Артура» (одна из двух почти одинаковых строк); «another person, not another case» (Эмилия/Эмиль, Виктория внутри предложения); «verbs say a man and a woman» (Евгения); «still reads %s as the same name» (Профсоюзная, Шереметьеве); «names the turn never used» (Евгении); «ran before the errand started» (list_orders); «picked from a search» (барбершоп, тот же класс, что ресторан в два шага; вместе с фикстурами `barberSearch`/`barberBooking`); «not about the errand» (успею ли к 10:00); deferredSteps (2 из 5 формулировок «как придёт…»); отчёт браузера (переформулированный итог, вопрос перед итогом, `needs_approval`); declined-карточка Slack (тот же глагол, что и у письма); «asked for and no call made» (напоминание); «the memory the turn saved»; «залез в кабинет»; review #6 (одна из двух); review #30 (одна русская из двух); «judges %s» (напоминание = письмо); «nothing found yet» (дубль d13); таблица «delivers %s» про варианты (строки на отдельных строках, после тире, present tense); «delivers the answer to» (вторые строки «Сравни…» и «Что приготовить…»); «returns %s for a rewrite» (обещание ответа позже); «delivers an answer with» (просьба). `it.each(secondStatuses)` (3) свёрнут в один тест с циклом — dup. «tells the model the rewritten draft was never seen» — wording (дословный текст подсказки).
- `amounts.test.ts` — 11 строк `it.each`: группировка (повтор «₽ после числа», «рубля», скобки, время рядом, второй диапазон) и «leaves alone» без знака ₽ вовсе (код, телефон, номер заказа, время) и дубли (неразрывные пробелы, fenced block при наличии code span) — dup.
- `fallback.test.ts` — 5 строк: пустые значения (`undefined`, `""`, голый `DELIVERY_COMPLETE` при оставленных `null`, пробелах и маркере с пробелами) и статусы 429/500 (оставлены 402 и 503) — dup.
- `language.test.ts` — 7 строк `it.each` messageLanguage (одноязычные дубли, эмодзи, время, ответы карточки «Approve/Подтвердить/Отмена») — dup; «leaves requested translations in the language asked for» — wording.
- `early-reply.test.ts` — 2 строки «delivers «%s» as written»; «goes out in the same step as the search» — dup (то же утверждение, что и первая строка); по одной строке в «drops «%s» before any work», «drops a bare status», «keeps a short result»; «keeps a status that carries a result» — dup «short result»; «tells the model to do the work, not to end the turn» — wording.
- `pending.test.ts` — строка `react_to_message` (покрыто «thank-you»), строка `execution-denied`, одна из двух строк review #5 — dup.
- `fast.test.ts`, `history/tests/pilot.test.ts` — «names a workspace by its owner's email» — dup: та же общая `listsWorkspaceRemembered`, проверка оставлена в `delivery/tests/pilot.test.ts`.
- `phone/tests/policy.test.ts` — 3 строки номеров: второй код Кавказа (+7872), 911 при оставленном 112, второй казахстанский (+76) — dup.
- `landing.test.tsx` — «sizes the film…» (атрибуты разметки, impl), «stands the film on a page with nothing…» (отсутствие старых текстов, stale/wording), «names the page once» и «carries the old title and Open Graph card» (константы metadata, trivial).
- `intro.test.tsx` — «opens on a loading line», «speaks of the sign-in page…», «tells the person what to do next in every dead end» — wording (дословные строки `copy.ts`).
- `id.test.ts` — 3 строки (ещё два валидных id, `/gpt`) — dup.
- `provider.test.ts` — «rejects an output cap…», «rejects an unsupported reasoning effort» — trivial (одна строчка zod-схемы).
- `conversation-log.test.ts` — 12 строк: 8 форм «пароль <слово> qwerty» одного класса (оставлены «поменял на», «теперь», «тот же», «смени на»), 2 «пароль от <чего> …» (оставлены wifi и «личного кабинета», «кабинета мтс»), «пароль qwerty» (дубль «логин ivan, пароль qwerty»); в «keeps «%s»» — «какой пароль от wifi?» и «пароль не помню» (тот же класс, что «поменяли?»/«не подходит») — dup.
- `scheduled-run-completion.test.ts` — 2 из 3 строк «nothing to report» и «keeps a handover that only leaves the rest out» — dup: классификацию исхода проверяет `agent/lib/schedules/tests/outcome.test.ts` теми же текстами, в хуке оставлена одна строка проводки.
- `ask-question.test.ts` — «tells the model not to confirm…» (wording описания), 3 строки «no card» (пробелы, одна буква — её проверяет следующий тест, буква с пробелом), строка «Какой отель?» (покрыта последним тестом) — dup.
- `contacts.test.ts` — «returns a contact's phone numbers» — dup первого теста (тот же `toEqual` с телефоном).
- `google-connect.test.ts` — строка `channel:photon` в «offers the tool on an interactive» — dup.
- `router.test.ts` — «rejects a model id that names no provider» (схему проверяет `shared/model/id.test.ts`), «rejects invalid chat writes» (trivial zod).

#### Оставлено сознательно

- `turn-sends.test.ts` — 209 кейсов: почти все — регрессии бенчмарков с датами (24.09, 25.09, d02…d18, review #N), правила отказов по отклонённой карточке и одобренному вызову (approval), лимит сообщений хода; оставлены по 2–4 разных по сути строки в каждой таблице.
- `conversation-log.test.ts`, `turn-log.test.ts` — фильтр секретов (`agent/lib/privacy/secrets.ts`, своего теста у него нет): коды, карты, CVV, паспорт, СНИЛС, граница 500 знаков, производительность; ход человека vs фоновый.
- `task-files.test.ts` (сеть песочницы с файлами человека, кто открыл ход), `phone/tests/policy.test.ts` (охрана телефонии), `find_images.test.ts` (приватные адреса, редиректы), `google-connect.test.ts` (approval: смена доступа только по просьбе человека), `admin.test.ts` (`adminProcedure`), `http-context.test.ts`, `links.test.ts` (видимые ссылки — защита от выноса данных через картинки).
- `history/tests/eligible.test.ts`, `trim.test.ts` — правила пачек по 8 ходов и недоверенная метка отчёта (dev-notes, пилот HISTORY_TRIM).
- `browser-run-report`, `phone-report`, `browser-prewarm`, `proactive-target`, `session-owner`, `evlog`, `holds`, `questions` — разные ветки поведения, ссылки в dev-notes (лиз отчёта, 14.10).
- `oferta.test.tsx` (юридический текст дословно), `privacy.test.tsx` (dev-notes: страница и `facts.ts` называют одни сервисы).

#### Сомнения

- `turn-sends.test.ts` можно сокращать и дальше (≈200 кейсов эвристики новизны), но каждая строка таблиц имён/падежей ловит свою ветку стемминга; без знания истории каждой не резал.
- `conversation-log.test.ts` — оставшиеся ~25 строк фильтра секретов: зона «секреты», резал только явные дубли.
- До правок 3 файла (`admin`, `conversation-log`, `turn-log`) падали по таймауту 5 с при параллельной нагрузке машины (PGlite/`vi.resetModules`); с `--testTimeout=60000` весь набор зелёный (626 passed). Это не связано с правками.

#### Возможно мёртвые экспорты

- нет (проверены `goneText`, `problemText`, `startingText`, `noticeText` — используются в `viewer.tsx`).

### b10

Итого по пачке: 450 → 402 (−48). Остальные 29 файлов пачки без изменений.

| файл                                                     | тестов было | стало |
| -------------------------------------------------------- | ----------- | ----- |
| `tests/agent/channels/telegram-message-delivery.test.ts` | 50          | 41    |
| `tests/agent/channels/photon-message-delivery.test.ts`   | 49          | 40    |
| `tests/agent/tools/calculate.test.ts`                    | 26          | 19    |
| `shared/environment/environment.test.ts`                 | 26          | 22    |
| `agent/lib/proactive/tests/signals.test.ts`              | 35          | 32    |
| `agent/lib/schedules/tests/outcome.test.ts`              | 23          | 20    |
| `tests/agent/agency/approval.test.ts`                    | 13          | 10    |
| `tests/agent/channels/telegram-inbound-auth.test.ts`     | 14          | 12    |
| `tests/agent/channels/photon-inbound-auth.test.ts`       | 12          | 11    |
| `tests/agent/channels/photon-webhook-secret.test.ts`     | 2           | 1     |
| `agent/lib/proactive/tests/quiet-hours.test.ts`          | 6           | 5     |
| `tests/agent/agency/disclosure.test.ts`                  | 7           | 6     |
| `tests/agent-evals.test.ts`                              | 8           | 7     |
| `tests/local-development.test.ts`                        | 6           | 5     |
| `tests/turbo-config.test.ts`                             | 2           | 1     |
| `shared/vault/payload.test.ts`                           | 7           | 6     |
| остальные 29 файлов                                      | 164         | 164   |

#### Удалено

- `telegram-message-delivery` — «replaces eve's default assistant text delivery» — trivial — проверял только, что обработчик есть (его вызывают все соседние тесты).
- `telegram-message-delivery` — 4 строки it.each «sets the %s reaction» (оставлены thumbs_up, exclamation) — dup — одна таблица соответствия, тот же путь.
- `telegram-message-delivery` — «keeps the generic apology for other turn failures» — dup — слит с «keeps the apology for a model call the provider rejected…» в один тест с обоими случаями; все проверки сохранены.
- `telegram-message-delivery` — «uploads a document attachment with sendDocument» — dup — sendDocument уже проверяет «uploads a picture and a document of one message separately».
- `telegram-message-delivery` — «retries a photo Telegram refused as a document» — dup — переход sendPhoto→sendDocument проверяет «links a photo neither upload could deliver».
- `telegram-message-delivery` — «sends two image artifacts of one reply as one album» — dup — альбом проверен на URL-вложениях, загрузка артефакта — отдельным тестом.
- `photon-message-delivery` — «does not register automatic assistant text posting» — trivial — только `toBeTypeOf("function")`.
- `photon-message-delivery` — «delivers a requested reply as an ordinary message» — dup — то же, что «posts send_message output as raw iMessage text».
- `photon-message-delivery` — 2 строки it.each «uploads a %s attachment» (image, audio; оставлены video, file) — dup — изображение с текстом проверяет «uploads an attachment alongside the message text».
- `photon-message-delivery` — 4 строки it.each «adds the native %s Tapback» (оставлены thumbs_up, question) — dup.
- `photon-message-delivery` — «requires a native link preview to be its own send_message call» — dup — проверка слита в «discriminates native links from message content».
- `calculate` — 7 строк it.each «rejects %s» (constructor, toString(), globalThis, require('fs'), [1, 2], eval('1'), Function(...)) — dup — тот же класс «неизвестное имя/вызов/не арифметика»; оставлены process.exit, **proto**, this.constructor.constructor(...), шаблонная строка, `;`, стрелка.
- `environment` — «exports the validated environment» — trivial.
- `environment` — «leaves Composio and iMessage off when they are not set» — trivial — значения по умолчанию.
- `environment` — «rejects a missing required DATABASE_URL value during import» — dup — «keeps DATABASE_URL required in local development».
- `environment` — «accepts a Photon project without a copied phone number» — trivial — необязательное поле.
- `signals` — «tells the worker where home is…» — wording — дословные фразы промпта, не правило безопасности/денег.
- `signals` — «gives a follow-up signal its own id» — trivial — конструктор объекта; использование проверено в `tests/agent/agency/follow-up.test.ts`.
- `signals` — «hands over mail since the watermark…» (describe «agent mail») — impl — внутренняя `agentMailSignals`, то же поведение публично проверяет `agent/lib/proactive/tests/agent-mail.test.ts`.
- `outcome` — 3 строки it.each (`"  <eve-empty-delivery/>\n"`, `"передавать нечего"`, повтор «Разряды… Передавать нечего.\n\n<eve-empty-delivery/>») — dup — те же случаи без пробелов/в другом регистре/другая рассылка.
- `approval` — «does not even read the details of a turn that is not the agentic worker's» — impl — только «мок не вызван»; результат (null) проверен соседним тестом.
- `approval` — «denies a call in the person's quiet hours too» — dup — слит в «denies a send or a call in the person's quiet hours…».
- `approval` — «checks no text for a detail when the action has no text» — impl — только «readUserProfile не вызван»; разрешение календаря проверено отдельно.
- `telegram-inbound-auth` — 2 строки it.each «reports the %s outcome» (unknown, already_linked_other_account) — dup/wording — та же ветка, разный текст.
- `photon-inbound-auth` — «onboards a first-time number through the verified phone account» — dup — principal известного номера и нового человека уже проверяют «scopes a known handle…» и «tells the model when it is answering a brand new person».
- `photon-webhook-secret` — «does not resolve project credentials until the adapter needs them» — trivial — `toBeTypeOf("function")`; значения проверяет «resolves Photon project credentials lazily» в `photon-inbound-auth`.
- `quiet-hours` — «reads the hour in the person's zone, not the server's» — dup — зону уже проверяют тесты с America/New_York.
- `disclosure` — «lets through text that gives out no detail of the home» — dup — отрицательных случаев и так несколько.
- `agent-evals` — строка it.each «different eval path» — dup — тот же отказ «Unsupported agent eval argument».
- `local-development` — «owns the PostgreSQL lifecycle around the application process» — impl — `indexOf` по исходнику `scripts/dev.ts` и строкам compose; порядок up→port→migrate→app→down проверяет живой прогон «passes the assigned PostgreSQL port…».
- `turbo-config` — «provisions required one-click deployment configuration» — stale — кнопка Deploy with Vercel/Neon в README; прод не на Vercel (dev-notes: Vercel как путь отката закончился 09.10).
- `payload` — «uses the shared identifier schema to reject invalid login emails» — trivial — проверка `z.email()`.

#### Оставлено сознательно

- `spend-limit.test.ts`, `report-cards.test.ts` (есть в dev-notes), `browser-errand`, `phone-call`, `journal`, `budget` — деньги, согласие, карточки, бюджет и журнал агентного работника, ход человека vs фоновый.
- Карточки подтверждения в Telegram/Photon (что уйдёт от имени человека, сумма, постоянное разрешение, лимит трат, перевод строки в поле) — approval.
- Ссылки без превью в разговоре с файлами человека, отказ артефакта, область (`rootSessionId`) артефактов — сеть с файлами человека и права.
- `eve-channel-auth`, `eve-session-ownership`, `login-handoff`, `sandbox`, `browser-use-webhook`, `photon-webhook-secret` (оставшийся), inbound-auth обоих каналов — права, подписи, владение сессиями (202 до `session.started` — dev-notes).
- `environment`: все 5 строк обхода входа по телефону (`localPhoneAuthBypassEnabled`) — безопасность; ключ шифрования, worker с sha256.
- `probe.test.ts` целиком — повтор голого 403 Composio и пустая строка 26.09 (dev-notes, регрессии).
- `outcome.test.ts`: маркеры `<eve-empty-delivery/>`/«передавать нечего» (dev-notes), фикстура 26.09.
- `signals`: запрос `in:inbox -from:me` (dev-notes), промпт агентного работника про «данные, не инструкции», снимок промпта вне пилота агентности (страж байтов при выключенном пилоте).
- DELIVERY_COMPLETE в обоих каналах (dev-notes, `withoutBookkeeping`), «скоро вернусь» только при 402/429/5xx (dev-notes), язык ответа.
- `payload`: «rejects an invalid login origin without throwing» — регрессия `URL.parse` в `.refine()` (dev-notes).
- Медиа (Telegram/Photon): пилот файлов, голосовые, незнакомый отправитель — оставлены целиком.
- `source-layout`, `channel-compatibility`, `scheduled-run`, `eve-*`, `follow-up`, `agent-mail`, `delivery`, `enabled`, vault — короткие поведенческие тесты без дублей.

#### Сомнения

- `tests/agent/agency/browser-errand.test.ts` — первый тест («is granted a free booking…») падает по таймауту при общем прогоне пачки (загрузка модуля под нагрузкой), отдельно проходит; так было и до правок, файл не менялся.
- `signals` — «keeps a check outside the agency pilot's prompt as it was» — дословный снимок промпта; оставлен как страж байтов вне пилота, но по сути wording.
- `telegram-message-delivery` — после удаления «retries a photo Telegram refused as a document» не проверяется, что при успешном sendDocument ссылку не шлют (тот тест этого и не проверял).

#### Возможно мёртвые экспорты

- `shared/vault/schema.ts:loginIdentifierSchema` — снаружи файла его импортировал только удалённый тест `payload.test.ts`; внутри `schema.ts` используется (knip может отметить как неиспользуемый экспорт).

### b11

| файл                                           | тестов было | стало   |
| ---------------------------------------------- | ----------- | ------- |
| agent/lib/inbound-media/caf-opus.test.ts       | 10          | 10      |
| agent/lib/inbound-media/download.test.ts       | 8           | 8       |
| agent/lib/inbound-media/media-type.test.ts     | 39          | 23      |
| agent/lib/inbound-media/photon.test.ts         | 15          | 13      |
| agent/lib/inbound-media/telegram.test.ts       | 22          | 19      |
| agent/lib/inbound-media/transcription.test.ts  | 26          | 24      |
| agent/lib/inbound-media/turn-content.test.ts   | 11          | 11      |
| agent/lib/skills/tests/catalog.test.ts         | 15          | 11      |
| agent/lib/skills/tests/tools.test.ts           | 12          | 12      |
| agent/lib/skills/tests/triggers.test.ts        | 62          | 42      |
| app/sign-in/_tests/phone-auth-form.test.ts     | 7           | 6       |
| db/services/auth/tests/code-limit.test.ts      | 6           | 6       |
| db/services/auth/tests/phone-user.test.ts      | 3           | 3       |
| db/services/auth/tests/photon-delivery.test.ts | 4           | 4       |
| db/services/auth/tests/photon.test.ts          | 10          | 5       |
| db/services/auth/tests/session.test.ts         | 1           | 1       |
| shared/object-storage/artifacts.test.ts        | 15          | 13      |
| shared/object-storage/upload-timeout.test.ts   | 1           | 1       |
| tests/agent/billing/limits.test.ts             | 4           | 3       |
| tests/agent/billing/quota.test.ts              | 6           | 4       |
| tests/agent/browser-pool/host.test.ts          | 11          | 11      |
| tests/agent/browser-pool/hosts.test.ts         | 38          | 38      |
| tests/agent/browser-pool/keys.test.ts          | 4           | 4       |
| tests/agent/browser-pool/s3.test.ts            | 7           | 7       |
| tests/agent/browser-pool/sandbox.test.ts       | 64          | 62      |
| tests/agent/browser-pool/static-hosts.test.ts  | 13          | 13      |
| tests/agent/tools/flag-off.test.ts             | 3           | 3       |
| tests/agent/tools/list-orders.test.ts          | 1           | 1       |
| tests/agent/tools/phone-call.test.ts           | 4           | 4       |
| tests/agent/tools/standing-permission.test.ts  | 23          | 22      |
| tests/agent/turn-kind/kind.test.ts             | 10          | 10      |
| tests/agent/turn-kind/memory.test.ts           | 2           | 2       |
| **итого**                                      | **457**     | **396** |

#### Удалено

- `media-type.test.ts` — «reads %s from the magic bytes»: 6 из 13 строк (gif, pdf, ogg, ID3, второй кадр mpeg, второй aac) — dup — оставлены jpeg/png, RIFF webp/wav, caf, mpeg- и aac-кадр.
- `media-type.test.ts` — «takes %s declared as %s»: 4 из 8 строк — dup — один класс (расширение → тип).
- `media-type.test.ts` — «leaves %s declared as %s a note»: 5 из 11 строк — dup — оставлены zip, exe, xlsx как msdownload, csv как zip, «.xlsx», без имени.
- `media-type.test.ts` — «strips media type parameters» — dup — то же покрывает `resolveMediaType("Image/PNG; foo=bar")`.
- `photon.test.ts` (inbound) — «gives a document … a minute to download, a photo 15 s» — impl — только шпион `AbortSignal.timeout`.
- `photon.test.ts` (inbound) — «hands over a text file that begins with «ID3»» — dup — `textDocumentLooksLikeAudio` покрыт в media-type, путь канала — тестом UTF-16.
- `photon.test.ts` (inbound) — проверка подделанного имени внутри «describes a file…» — dup — `fileNote` против подделки покрыт в turn-content.
- `telegram.test.ts` — «keeps a sender's file name to one line of its note» — dup — тот же `fileNote`, покрыт в turn-content.
- `telegram.test.ts` — «gives a document for the task agent a minute to download» — impl — только шпион `AbortSignal.timeout`.
- `telegram.test.ts` — «remuxes a CAF audio file before transcription» — dup — перепаковку CAF→Ogg проверяет transcription.test.
- `transcription.test.ts` — «rejects %s as %s»: 2 из 7 строк (« », "null") — dup — тот же класс, что zero-width и «not json».
- `catalog.test.ts` — «fails to load on %s»: 4 из 9 строк (close of nothing, mismatched close, two digits, misspelt layout) — dup — оставлены unknown skill, open region, nested, unreadable marker, skill in task-agent.
- `triggers.test.ts` — «attach what %s needs»: 19 из 43 синтетических строк — dup — перефразы одного класса: 9 вариантов «больше не присылай сводку» → 2 + отрицательный, напоминания и календарь → по одному, photos-only/photos-vot (дубль теста «meter readings for photos»), permission-revoke (дубль tools.test), license/top-up/troika/privacy-en/product-pick-short.
- `triggers.test.ts` — «come out the same for the same turn» — trivial — детерминизм чистой функции, golden уже сверяет точно.
- `phone-auth-form.test.ts` — «asks for the phone and offers to open Messages» — wording — дословные подписи формы.
- `db/services/auth/tests/photon.test.ts` — «opens the conversation and posts the code as plain text» — impl/dup — только `toHaveBeenCalledWith`; отправку кода проверяет photon-delivery «sends the sign-in code over iMessage».
- `db/services/auth/tests/photon.test.ts` — «preserves the provider's failure classification», «does not disguise an unrelated failure…» — dup — то же сквозным путём проверяют photon-delivery «preserves provider diagnostics» и «reports an unreachable Photon project…».
- `db/services/auth/tests/photon.test.ts` — «maps %s to actionable OTP copy»: 2 из 6 строк (Connection, RateLimit) — dup — та же таблица соответствий.
- `artifacts.test.ts` — «gives an upload a deadline that grows with its body» — impl — шпион `AbortSignal.timeout`, формулу проверяет upload-timeout.test.
- `artifacts.test.ts` — «is configured only with the bucket and its key» — trivial — проверка конфигурации; S3_* вариант остался.
- `limits.test.ts` — «separates the free and paid allowances» — trivial — константы лимитов.
- `quota.test.ts` — три теста «allows every … without touching usage counters» слиты в один — dup — те же проверки.
- `standing-permission.test.ts` — «allows a higher monthly ceiling without a card» — dup — расширение без карточки уже в «allows new or wider permissions».
- `sandbox.test.ts` — «has the reconcile hand a gone %s VM over»: 2 из 4 строк (starting, stopping) — dup — оставлены failed и stopped со сбросом входов.

#### Оставлено сознательно

- `code-limit.test.ts`, `phone-user.test.ts`, `session.test.ts`, `photon-delivery.test.ts` — лимиты кодов входа и проверенный телефон (безопасность); «resolves project credentials lazily» — упомянут в dev-notes.
- `download.test.ts`, `turn-content.test.ts` (подделка строк файла, base64 для durable-замыканий), `s3.test.ts`, `keys.test.ts`, `host.test.ts` (закреплённые подписи/HKDF/токен, сверенные с Python) — безопасность и межъязыковые контракты.
- `phone-call.test.ts`, `kind.test.ts`, `memory.test.ts`, `standing-permission.test.ts` (кроме одного дубля), `list-orders.test.ts` — охрана телефонии, кто открыл ход, наборы инструментов воркера, постоянные разрешения, регрессия EN D4.
- `flag-off.test.ts` — по правилам не трогается (dev-notes: байты блока инструментов).
- `skills/tests/tools.test.ts` — dev-notes ссылается на тест о `load_skill <группа>`; остальное — поведение групп инструментов.
- `triggers.test.ts` — golden по бенчмарку и `required` (страховка recall на случай правки golden), денежные и госуслужные перефразы.
- `artifacts.test.ts` — 304 без ETag, NoSuchKey vs NoSuchBucket, срок на каждое чтение тела (dev-notes).
- `telegram.test.ts` — DOC002.pdf, лимит 20 МиБ, пилот файлов браузера (dev-notes); `caf-opus.test.ts` — разбор формата.
- `browser-pool/*` — интеграционные PGlite-тесты с инцидентами (per-boot вместо runcmd 02.10, ожидание сети AZ-1 30.09, сон хоста, откат, файлы пилота); сокращены только явные строки it.each.

#### Сомнения

- `sandbox.test.ts` «handing a pool workspace's gone VM over» и большая часть `hosts.test.ts` — путь Cloud.ru (собственные VM воркспейсов, Compute API). По dev-notes Cloud.ru — история, прод на static-хостах Selectel, но код жив и выполняется — не считал stale. Если владелец решит удалить ветку Cloud.ru, это ~25 тестов.
- `hosts.test.ts` «writes the files boot.py writes» частично дублирует «is byte for byte what boot.py writes», но несёт комментарий инцидента 02.10 и проверку, что секрет не уходит в cloud-init — оставил.
- `host.test.ts` «looks a host's private address up before its call's timeout starts» — по сути impl (порядок вызовов), но для `CLOUDRU_PRIVATE_ROUTING`, похоже, регрессия — оставил.

#### Возможно мёртвые экспорты

- нет (`messageAllowance`, `browserRunAllowance`, `imageGenerationAllowance`, `baseMediaType`, `artifactStorageConfigured` используются в продовом коде).

### py-go

Прогоны — как в CI (`python -m unittest` в каждом каталоге, `go vet ./... && go test ./...` в `sandbox/sandboxd`), до и после правок, всё зелёное. Для `scripts/cloudru-app-host/host` нужен `zstd` (поставлен `apt-get install zstd`; без него `ReleaseTest.setUpClass` падает и до правок).

#### Наборы (как считает unittest / go test)

| набор                                             | тестов было      | стало            |
| ------------------------------------------------- | ---------------- | ---------------- |
| browser-vm/host                                   | 213              | 202              |
| browser-vm/firecracker                            | 8                | 6                |
| browser-vm/image                                  | 44               | 36               |
| browser-vm/worker                                 | 198 (55 skipped) | 192 (55 skipped) |
| scripts/cloudru-app-host/tg-egress                | 30               | 28               |
| sandbox/host                                      | 22               | 22               |
| scripts/cloudru-code-host                         | 6                | 6                |
| scripts/cloudru-app-host/host                     | 102              | 102              |
| scripts/cloudru-app-host/tg-bridge                | 42               | 42               |
| scripts/selectel                                  | 18               | 18               |
| scripts/cloudru-sandbox-probe                     | 3                | 3                |
| **Python итого**                                  | **686**          | **657**          |
| sandbox/sandboxd (Go, `=== RUN`, верхний уровень) | 48 (3 skip)      | 48 (3 skip)      |

#### По файлам (только изменённые)

| файл                                                 | тестов было | стало |
| ---------------------------------------------------- | ----------- | ----- |
| browser-vm/firecracker/test_pins.py                  | 8           | 6     |
| browser-vm/host/test_hostd.py                        | 92          | 81    |
| browser-vm/image/test_image.py                       | 29          | 26    |
| browser-vm/image/test_sandbox.py                     | 15          | 10    |
| browser-vm/worker/test_publish.py                    | 7           | 5     |
| browser-vm/worker/test_worker.py                     | 121         | 117   |
| scripts/cloudru-app-host/tg-egress/test_tg_egress.py | 30          | 28    |

#### Удалено

- `browser-vm/firecracker/test_pins.py` — «test_top_level_and_fields» — trivial — набор ключей JSON, каждое поле и так читается и сверяется остальными тестами.
- `browser-vm/firecracker/test_pins.py` — «test_keys_live_under_firecracker_prefix» — dup — `test_key_names_carry_version_and_hash` сверяет ключи целиком (префикс, без `..`, версия по регулярке).
- `browser-vm/host/test_hostd.py` — «TokenTest.test_host_key_derivation_is_pinned_for_bro» — dup — сверял константу, которую тест сам считает; верный `KEY` уже доказывает вектор TS в `test_accepts_the_token_bro_signs`, а `boot.host_key` закреплён тем же hex в `test_boot.py`.
- `browser-vm/host/test_hostd.py` — «NetworkTest.test_a_microvm_sandbox_namespace_is_a_bridge_with_a_tap_and_a_fixed_router_mac» — impl — то же (tap, мост, MAC роутера, без адреса и маршрута) проверяет сквозной `FirecrackerTest.test_the_sandbox_namespace_holds_a_bridge_with_the_vms_tap_and_no_address`.
- `browser-vm/host/test_hostd.py` — «FirecrackerTest.test_a_failed_start_says_what_the_jailer_and_the_guest_said» — dup — тот же сценарий `fail_spawn`, что у `test_a_jailer_that_dies_…`; его проверка («jailer output» в ошибке) перенесена туда.
- `browser-vm/host/test_hostd.py` — «UpdateTest.test_public_status_of_nothing_is_nothing» — impl — внутренняя `selfupdate.public_status`; что наружу уходят только `state/version/at`, проверяет `test_health_shows_an_updates_state_but_not_its_error_or_hash…`.
- `browser-vm/host/test_hostd.py` — 7 повторных прогонов под runsc (`GvisorSandboxTest`/`GvisorParkTest` наследовали их у `SandboxTest`/`ParkTest`) — dup — тесты не зависят от среды: `test_sandbox_ids_are_validated`, `test_a_rootfs_the_host_lacks_is_refused…`, `test_memory_limits_never_add_up…`, `test_the_runsc_log_is_cut…`, `test_image_and_staging_of_two_ids_never_meet` (синхронный), `test_stand_host_ports_open_only_those_ports_of_the_host` (синхронный, только `network`), `test_urls_go_out_exactly_as_presigned` (только `sets.transfer`). Сами тесты оставлены и идут один раз: первые пять и последний — в новом классе `SandboxApiTest(HostTest)` (runc), stand-ports — в `NetworkTest`.
- `browser-vm/image/test_image.py` — «test_create_aborts_when_a_resource_with_the_name_already_exists» — dup — тот же отказ через `main()` проверяет `test_build_aborts_before_creating_a_builder_with_an_already_taken_name`; туда перенесена проверка id старого ресурса в ошибке и комментарий.
- `browser-vm/image/test_image.py` — «ApiTransientErrorTest.test_iam_5xx_raises_a_connection_error_not_an_assertion_error» — impl — внутренний `build.api`; то же поведение снаружи видно в `test_read_shrugs_off_an_iam_outage…` и `test_cleanup_logs_every_resource…` (503 IAM при уборке).
- `browser-vm/image/test_image.py` — «SealTest.test_the_builder_timeline_does_not_survive_into_the_shipped_image» — dup — `test_every_per_builder_path_stage_writes_to_is_purged` проверяет тот же `/var/lib/bro/timeline` (и `status`); смысл комментария перенесён туда.
- `browser-vm/image/test_sandbox.py` — `HungChromeInitTest`: 4 унаследованных теста (`units_start_in_order`, `stop_keeps_it_down…`, `a_unit_that_dies…`, `the_shim_takes_only…`) и заглушка `test_a_chrome_that_exits_on_sigterm_is_logged_stopped` с `pass` — dup / trivial — тот же init повторно с Chrome, игнорирующим SIGTERM; своё у этого класса — только `test_a_killed_chrome_is_logged_killed`. Настройка вынесена в базовый `InitCase` без тестов, оба класса от него.
- `browser-vm/worker/test_publish.py` — «test_reads_the_committed_worker_from_git» — trivial — условная проверка (`if head is not None`), в чекауте без git ничего не проверяет; `committed` подменяется и проверяется по поведению в `test_refuses_changed_code_under_the_committed_version`.
- `browser-vm/worker/test_publish.py` — «test_prints_the_env_value» — dup — формат `version:key:sha256` сверяет `test_reads_the_version_the_worker_reports` по `describe()`.
- `browser-vm/worker/test_worker.py` — «TokenTest.test_vm_key_derivation_matches_bro» — dup — hex константы теста; верность `KEY` доказывает вектор Bro в `test_accepts_bro_token_and_session_scope`.
- `browser-vm/worker/test_worker.py` — CdpTest: «test_json_list_keeps_its_own_full_listing_for_an_unscoped_token», «test_json_version_allows_an_unscoped_token», «test_devtools_socket_refuses_the_browser_level_socket_for_a_scoped_token» — dup (слиты) — та же настройка, их проверки дописаны в соседние тесты (`test_json_list_hides_another_sessions_tab…`, `test_json_version_refuses_a_session_scoped_token_and_answers_an_unscoped_one`, `test_devtools_socket_refuses_another_sessions_tab_and_the_browser_for_a_scoped_token`); все проверки сохранены.
- `scripts/cloudru-app-host/tg-egress/test_tg_egress.py` — «test_an_ipv6_address_keeps_its_brackets» — impl — `authority()` со скобками проверяет сквозной `test_the_proxy_is_asked_for_an_ipv6_target_in_brackets`, разбор IPv6 — `test_addresses`.
- `scripts/cloudru-app-host/tg-egress/test_tg_egress.py` — «test_default_upstream_is_the_address_that_answers_from_cloudru» — trivial — значение по умолчанию (адрес, отвечавший с Cloud.ru, который теперь история).

#### Оставлено сознательно

- `scripts/cloudru-app-host/host/test_host.py` целиком — deployd, watchdog (Keystone, баланс Selectel), бэкапы, `WipeSqlTest`, env прода, `update-host`/VNC: регрессии из dev-notes и охрана прода; явных дублей не нашёл.
- `scripts/cloudru-app-host/tg-bridge/test_tg_bridge.py` целиком — доставка без потерь и повторов, offset, 409, рестарт моста (dev-notes: мост останавливается вокруг рестарта eve).
- `scripts/selectel/test_vnc.py` целиком — пароль root/NP, `asks_password`, регрессия 13.10 (вывод без перевода строки).
- `browser-vm/host/test_boot.py` целиком — ключ обновлений (`updateKey`, не выводится из ключа Бро), `update.sh`/`rollback.sh`, per-boot скрипт (02.10), pipefail и runc (02.10).
- `browser-vm/host/test_hostd.py` — токены и scope `update`, `ArchiveTest` (распаковка от root), `EncryptionTest`, сеть и nft (изоляция песочниц), seccomp, `UpdateTest` (подпись оператора, ожидание тишины), снимки Firecracker; прогон `SandboxTest`/`ParkTest` под обеими средами для того, что от среды зависит.
- `browser-vm/worker/test_worker.py` — загрузки файлов (пилот `BROWSER_VM_FILES_WORKSPACES`, происхождение поля), секреты и их забывание при park, правила окна входа (`handoff_url_allowed`, `handoff_input`), CDP-скоупы, капчи (без прокси для v2, 05.10), карта (`fill_card`, 04.10/05.10), `SiteErrors`, след шагов без секретов, сообщения/отмена/обновление worker; `test_the_agent_types_a_phone_after_the_fields_own_country_code` — правило промпта с регрессией 04.10/05.10.
- `browser-vm/image/test_image.py` — HTTP-повторы (POST не повторяется), сторож первой загрузки, `ChromeUnitTest` (`<-loopback>` — страница не достаёт CDP).
- `sandbox/host/test_boot.py`, `scripts/cloudru-code-host/test_host.py`, `scripts/cloudru-sandbox-probe/test_s3.py` — проверки имён перед shell от root, sha256 и отсутствие query в ошибке, пины.
- Стенды с настоящим Chrome (`test_card_forms`, `test_code_boxes`, `test_file_uploads`, `test_handoff`, `test_site_errors`, `test_captcha_tokens`, `test_checkout_harness`) — не трогал.
- Go (`sandbox/sandboxd`) — не трогал: 48 компактных тестов, почти все — токены, шифрование снимков, изоляция и убийство exec (`TestDrainKillsOpenExecs` и соседние `…WithoutMarker` — регрессия из dev-notes), лимиты памяти/CPU (с runsc); дублей не нашёл.

#### Сомнения

- `SandboxApiTest`: `test_memory_limits_never_add_up…` теперь только под runc. Под runsc учёт памяти тот же код (накладные расходы добавляет лишь Firecracker, у него свой `test_a_microvm_counts_the_firecracker_process…`), но если runsc когда-то получит свою надбавку, этот прогон надо вернуть в `SandboxTest`.
- Удалённый сетевой юнит-тест microVM ещё проверял, что у обычной песочницы нет `br0`; сквозные тесты этого не утверждают явно.

#### Возможно мёртвые экспорты

- нет: `selfupdate.public_status`, `tg_egress.authority`, `build.api`/`build.create`, `publish.committed` используются продовым кодом.

### p2-A

| файл                                   | тестов было | стало |
| -------------------------------------- | ----------- | ----- |
| tests/agent/tools/browser-task.test.ts | 395         | 337   |

Покрытие прода: метки covfile `p2A-0` (до) и `p2A-5` (после). `covdiff p2A-0 p2A-5`: потеряно 0 строк и 0 веток (2970/1898 до и после). Копия файла до правок: `p2A-orig.test.ts`.

#### Удалено

Везде covdiff 0. Для тестов из зон безопасности и денег отдельно указано, какой оставшийся тест проверяет тот же итог.

**continuation / quota**

- «does not charge a continuation as a new errand». dup, covdiff 0. Что квота не считается на продолжении, проверяет «gives the reservation back when the month's errands are used up» (`browserRunQuotaGate` не вызван).
- «queues a code into a confirmed live run without restating the card». dup, covdiff 0. Тот же префикс очереди проверяет «queues the message while the tracked run is still live»; что подтверждение не записывается заново, видно по тестам consent.
- «says nothing about a sign-in when none is bound». wording: только отрицание фразы в заметке.
- «treats a settled row as terminal without asking the cloud again». dup, covdiff 0. Завершённую строку без опроса облака проходит каждый `continueErrand({ completedAt })`.

**текст поручения (не безопасность)**

- «asks for a screenshot always, and for pictures…», «carries a later request for pictures into the follow-up run». wording, covdiff 0 (ветки `collectImages` покрывают тесты «names no address but the Site»).
- «carries the same rule into a follow-up run» (капча). wording.
- «stays in the same browser for every other outcome». dup: `sessionId` той же сессии проверяют «starts a follow-up run in the same session…» и «continues on the checkout page…».
- «requires actual observed option destinations…», «carries the same link contract into a follow-up run». wording: контракт LINKS, не правило денег или безопасности.
- «tells the run where the person lives from Personal Info», «names the country alone…», «says nothing about a home the profile does not have», «leaves the home line out of a follow-up on the same site». wording, covdiff 0. Строку дома держит тест инъекции «keeps a multi-line city inside its sentence».
- «holds a started errand to the kind asked for, a bounded search…», «keeps the budget but not the site hopping…», «leaves the budget out of a code and of an answer to a payment stop». wording, без даты. describe «search discipline» удалён целиком.
- «tells a search for something to buy to stage the best option». wording, без даты.
- «tells the coordinator the Госуслуги login is bound, not missing». wording заметки.
- «types no document number into a site without the person's confirmation». dup формулировки: то же правило о номерах документов, полным предложением, проверяет «types no document number, and picks one the account saved».

**деньги и согласие (везде covdiff 0)**

- «lets an approved errand finish the purchase past the search budget», «drops the stop once the follow-up carries the approval». dup: ту же фразу «answered yes when asked to pay its total» и отсутствие «Nothing has been approved» на том же пути (continue после «да») проверяют «pays within the total the person said yes to» и «pays once the next message is a plain yes…».
- «carries the stop into an unapproved follow-up». dup: «Nothing has been approved to pay for» на продолжении проверяют «lets a follow-up on a paid ride only look…» и consent-тесты.
- «keeps a free errand's card from binding the card». dup: `paymentAllowed: false` для бесплатной записи проверяют «lets an errand the person asked for submit exactly that» и «stops an unapproved errand…».
- «does the errand on a standing permission without a card and says so». dup: тот же итог (`paymentAllowed: true`, `paymentCapRub: 900`, фраза о «да») у «pays within the total…».
- «holds nothing for a free errand». dup: `reserveConsentPayment` не вызывается на бесплатном пути, как в тестах «books a named table at once» и standing.
- «holds a standing permission's payment against its month». dup: резерв `source: "card"` на 900 ₽ проверяет «holds the ceiling of the yes for the run…».
- «carries an errand's reservation into its follow-up run». dup: перенос резерва на продолжение (`moveSpendReservation`) проверяют «replaces the old reservation once the follow-up run exists» и «releases a standing-limit reservation…».
- «asks again after a run that placed the order». dup: тот же отказ «Оплачиваю?» после `Order:` проверяет «asks anew once the run reported the order placed».
- it.each «takes «%s» as the yes»: убрана строка «да». dup: «pays once the next message is a plain yes…» гоняет тот же «да» с бо́льшим числом проверок.

**кто открыл ход / фоновые работники (covdiff 0)**

- «never lets a scheduled worker start an errand in the person's name». dup: та же ошибка «cannot act in the user's name» у «never lets a standing permission act from the background» (execute) и «refuses scheduled, proactive and background workers outright» (approval).
- «lets a scheduled worker look without the person's details». dup: та же фраза у «does not act on the person's confirmation from a scheduled worker».
- «carries the existing consent through a report follow-up without steering approval». dup: «does not ask again for the same previously approved payment after a report» проходит тот же путь отчёта с согласием и проверяет больше.
- «still lets a report look at an errand that acts for nobody». dup: «lets the run's own report turn continue it».
- «withdraws a waiting background retry when the person steps in». dup: `stopBrowserRunErrand` для ждущего повтора и новый браузер проверяют «stops the pending retry…» и «opens a fresh browser when the run ended against an anti-bot check».

**VM / очередь / страницы**

- «leaves the VM's idle window alone for a Browser Use errand», «keeps the VM's current profile without writing it again», «moves a follow-up of a forgotten VM profile to the next generation» (тот же итог у «moves a Browser Use errand's follow-up to the VM once the sign-ins were forgotten…»), «says the browser is unavailable for a forgotten errand's follow-up…» (тот же `unavailable` у соседнего теста без Browser Use). dup, covdiff 0.
- «still starts while the turn is under the limit». dup: старт без лимита проходит каждый `resolvedBrowserTask` + start.
- «stays in the same tab while the last run's page was kept». dup: «in the same browser» проверяет «finds a staged option again…» (отрицание) и тесты продолжения в той же сессии.
- «goes through once the person has heard the outcome». dup: «goes through once a message told them…».
- «starts at once beside an errand on another account». dup: старт без занятого аккаунта есть в каждом тесте Госуслуг.

**коды и вход по телефону (covdiff 0)**

- «types into the page only the code the person sent». impl/dup: только `toHaveBeenCalledWith`; ввод кода человека в страницу проверяют «types the person's own code into the page as before» и «passes on the code the person answered, and only it».
- «writes no phone paragraph when no phone was bound». wording, отрицание.
- it.each «passes an order number on where a code is only mentioned»: 2 строки → 1. dup: перефраз того же класса («оформи заказ 48213 без SMS»).

**вырезание контактов (covdiff 0)**

- «cuts them from an errand a report turn starts». dup: тот же старт из хода-отчёта с вырезанием у «cuts them though the person picked an option that names them».
- «tells Bro what it cut, so the person hears why». dup: заметку «were cut… ask them whether to do it in their name» проверяет «cuts them from a report turn's follow-up…».
- «cuts them from a message a busy session queues». dup: «cuts what Bro adds to a live run's message…» тем же путём очереди сообщения.

**адрес доставки, известные данные, staging**

- «names no address the profile and the vault do not have», «leaves a confirmed errand with the details the card allowed». dup, covdiff 0. Отсутствие «Delivery address:» проверяют it.each «keeps the address out of «%s»» и «holds a confirmed basket to its lines».
- «falls back to the account's sign-in phone when nothing else has one». dup: «Phone: +79990000001» из аккаунта проверяют «hands a live run the person's approval…» и «gives a run staged in the person's turn their details to fill in».
- it.each «leaves «%s» a search…»: 3 строки → 1. it.each «stages «%s»…»: 2 строки → 1. dup: код слова не читает (комментарий теста: «the model's to read, not a word list's»), строки отличаются только `said`. Оставлены «почём… возьми только оригинал» и «хочу эти кроссовки».
- «leaves a search a search in a report turn». dup: отсутствие staging при `look` проверяет оставшаяся строка it.each.
- «asks the run to stay signed in and to name where it is signed in». wording.

#### Возвращено после covdiff

- «says in the logs when the person finds an ended run the poller left open». Без него теряется `console.warn` в `browser_task.ts:5174`, а этот warn — инцидент 25.09 из комментария кода.
- «says a code is unlikely where the sign-in is kept, without promising». Без него теряются `sign-ins.ts:287–298` и ветка `browser_task.ts:1202` (`signin_phone` без digits).
- «tracks the run an idle session drained the queued message into». Без него теряется `browser_task.ts:4698`.
- «gives no outcome on status while the report is being put together». Без него теряются `browser_task.ts:5198–5202`.
- «keeps the account phone out of the known details once one is known». covdiff 0, но этот итог (телефон аккаунта не попадает в данные при карточке сейфа) больше никто не проверяет.

#### Оставлено сознательно

- Регрессии с датой и инцидентом (RU 24.09–04.10, 10.10, 12.10, 14.10, QA 12.10, bench 01.10) и тест схемы без `pattern` из dev-notes.
- Approval и согласие целиком: `browserTaskApproval`, «Оплачиваю?», потолок «да», постоянные разрешения, отчёт против хода человека, работник, возобновлённый ответом.
- `said.ts` (выдуманные коды, `personSaid`, слова прошлых ходов), включая строку «a live run, 739204», которую вернул ревьюер первого прохода. Здесь табличные строки — разные классы входа.
- `withoutOwnContacts`: таблицы телефонов и почты, вырезание из сайта, очереди и продолжений.
- Код из письма и AgentMail, логин от человека, Госуслуги и ЕСИА, лимит трат и резервы, отмены и незавершённые stop VM.
- Правила текста о деньгах и безопасности (нет согласия, нельзя действовать от имени человека, сетевая ошибка у запуска, который мог действовать, номера документов, выход через Госуслуги): по одной проверке на правило.

#### Сомнения

- «tells a started errand to solve a CAPTCHA and carry on» оставлен. В нём, кроме капчи, правило NEEDS: captcha при сетевой ошибке для поиска, а оно связано с фоновым повтором.
- Таблицы `openSubmissionTerms` («tells one concrete option…», «tells one place…») — это один тест с циклом. Строки не сокращал: счёт тестов это не меняет, а это матчер.

#### Возможно мёртвые экспорты

- нет: все импорты удалённых тестов используются в оставшихся (oxlint чистый).

### p2-B

| файл                                                                   | тестов было | стало   |
| ---------------------------------------------------------------------- | ----------- | ------- |
| tools/oxlint/anti-slop/tests/anti-slop-plugin.test.ts (с `*.cases.ts`) | 287         | 254     |
| agent/lib/delivery/tests/turn-sends.test.ts                            | 209         | 202     |
| agent/lib/delivery/tests/early-reply.test.ts                           | 30          | 28      |
| agent/lib/delivery/tests/language.test.ts                              | 28          | 26      |
| agent/lib/delivery/tests/pending.test.ts                               | 19          | 17      |
| agent/lib/delivery/tests/amounts.test.ts                               | 18          | 18      |
| agent/lib/delivery/tests/fallback.test.ts                              | 15          | 13      |
| agent/lib/delivery/links.test.ts                                       | 12          | 12      |
| **итого**                                                              | **618**     | **570** |

Метод: покрытие по каждому тесту (V8 precise coverage на тест, временный probe — удалён), группировка тестов
с одинаковым набором покрытых блоков прода. Затем общий `covfile.sh`/`covdiff.py` до и после:
anti-slop — covdiff 0 (793/792 до и после), delivery — covdiff 0 (907/770 до и после).

#### Удалено

anti-slop (33 кейса RuleTester, все dup: тот же путь в коде правила и та же синтаксическая форма; формы из
списков visitor-ов / `||`-цепочек правила оставлены по представителю):

- `no-chained-type-assertions` — valid `<User>input`, `[1, 2] as const` (одиночное утверждение, как `input as User`), `{ value: input as Source } as Container` (то же, что утверждение внутри вызова).
- `no-conditional-empty-object-spread` — valid `{ value }` (тривиальный объект; остались `{ ...values }` и тернарник без spread).
- `no-known-value-widening` — valid `{ start: startCommand }` без аннотации (остался тот же объект с `satisfies`).
- `no-module-mocking` — `jest.mock(...)` (глобальный `jest` покрыт `jest.unstable_mockModule`, метод `mock` — `vi.mock`).
- `no-object-parameters` — valid `f<Value>`, `f<Value extends Owner, Owner extends …>`, `type Owner…; f<Value extends Owner>` (остался `f<Value extends object>`), `consume<Identity>` (затенение — остался `consume<Alias>`); invalid `type Alias = (object)` — парсер скобки в типе снимает, ветка `TSParenthesizedType` не исполнялась и этим кейсом.
- `no-reflect-apply` / `no-reflect-get` — затенение `Reflect` параметром (осталось затенение `const`), `owner[key]`.
- `no-runtime-typeof` — `!== "undefined"` и `if (typeof globalThis.crypto === "undefined")` (осталась проба `===` и обратный порядок операндов); `asserts value is string` с allowInTypeGuards (тот же `TSTypePredicate`, что `value is`; функция и стрелка остались).
- `no-shape-in-symbol-names` — valid `outer.inner.shape`, `schema.shape.id.parse()` (остался `schema.shape.id`), `#value`, `<Panel />` (нет «shape» — тривиально); invalid `const shape = 1` (остались `shapeOf`, `PayloadShape`, ключ `shape:`, private и JSX).
- `no-unknown-parameters` — `asserts value is string` (функция, стрелка, тип функции, declare, метод остались).
- `no-unknown-returns` — `(): ImportedValue` (то же, что `(): User`).
- `no-unknown-type-aliases` — `type Current = unknown` (= `type Alias = unknown`).
- `no-unsafe-dictionary-type` — valid `Record<PropertyKey, JsonValue>`, `Child extends Owner { __brand }`; invalid `Readonly<Record<string, unknown>>` (покрыт цепочкой `Readonly<Partial<Required<(Record…)>>>`), `Record<string, NonNullable<unknown>>` (класс «обёртка над unknown» — остался `Readonly<unknown>`).
- `require-safety-comment-for-type-assertion` — custom valid с одним маркером (остался список маркеров и `SAFE+`), комментарий перед `return` в функции, многострочный блок-комментарий у export, `// SAFETY:` пустой строчный (остались пустой маркер `INVARIANT:` и пустой блочный `/* SAFETY: */`).

delivery (15, все dup, covdiff 0):

- `turn-sends.test.ts` — «lets the first message of a turn through» (базовый случай, покрыт всеми «delivers»); строки таблиц без даты: «Виктория after Виктор» (тот же класс, что Александр/Александра по глаголам), «Александре after Александру» (класс Иванову/Ивановой), ресторан «in two steps» (остался «in one step»), «a heading» в таблице сравнения (заголовок — в review #0), «the same result with a detail added» в отчёте браузера (класс d08), «Запустил поиск поездов.\nПо ужину…» (двухстрочное — то же, что кейс d13).
- `early-reply.test.ts` — «waits after a heads-up sent alone» (= «waits with a quoted reply's note», тоже без работы); «leaves the turn open after a bare status is dropped» (те же `turnMustEnd`/`awaitsDelivery` после сброшенного статуса, что в «drops … without ending the turn»).
- `language.test.ts` — «makes Bro speak of himself in the masculine» (wording; мужской род проверяет «holds the Russian voice», начало «Язык ответа…» — тест d18); «keeps the language through a reply without one» (= вторая проверка d18 «Подтвердить» после английского).
- `pending.test.ts` — «waits on a person's message nothing has answered yet», «keeps waiting while the turn only ran work tools» (оба покрыты «stops forcing after ten steps» — 9 шагов работы = true — и «waits again …»).
- `fallback.test.ts` — «delivers text the model wrote instead of calling send_message» (возврат текста покрыт «drops a delivery marker»), строка `"   "` в «delivers nothing for» (обрезка покрыта `" DELIVERY_COMPLETE\n"`).

#### Оставлено сознательно

- `turn-sends.test.ts` — 143 из 209 тестов не дают уникального покрытия, но это табличный матчер текста (новизна, падежи имён, глаголы-претензии): по п. 2 покрытие дубль не доказывает. Оставлены строки с датой/бенчмарком (d02…d18, review #N, P2–P7, 24.09/25.09), отказы по отклонённым/одобренным карточкам (approval), разные лексические классы (время, отрицание, придаточное, совет, другой субъект, порядок частей).
- `amounts.test.ts` — каждая строка — свой класс входа (₽ с пробелом/слитно, «руб.»/«рублей», диапазон, «от…до», копейки, жирный, год рядом, ссылки/код).
- `links.test.ts` — защита видимых ссылок (вынос данных через картинки) и QA 12.10; одинаковое покрытие у разных классов (скобки, markdown-цель).
- `early-reply.test.ts` — пилот heads-up с инцидентами 11.10 и 14.10.
- `anti-slop-plugin.test.ts` — оба собственных теста (регистрация всех правил, отсутствие fix).
- anti-slop: формы, перечисленные в visitor-ах или `||` правил (стрелка/функция/TSFunctionType/declare/метод, `as`/`<T>`, скобки выражений, private/JSX-идентификаторы, порядок объявления алиаса, глубина алиасов, `as const`/`<const>`), — по представителю, даже при одинаковом покрытии (V8 не различает операнды `||`).

#### Сомнения

- `no-object-parameters`: ветка `TSParenthesizedType` в правиле при текущем парсере не исполняется вовсе (скобки снимаются) — кейс `(object)` удалён как не дающий покрытия; если парсер начнёт хранить скобки, ветку ничто не проверит.
- `turn-sends.test.ts` можно резать дальше только с решением владельца по каждой датированной строке.

#### Возможно мёртвые экспорты

- нет.

### p2-C

| файл                                                 | тестов было | стало   |
| ---------------------------------------------------- | ----------- | ------- |
| shared/memory/schema.test.ts                         | 108         | 89      |
| tests/agent/memory.test.ts                           | 47          | 47      |
| shared/spending/limit.test.ts                        | 42          | 41      |
| tests/agent/browser-use/files.test.ts                | 39          | 35      |
| tests/agent/browser-use/outcome.test.ts              | 35          | 33      |
| tests/agent/agent.test.ts                            | 34          | 32      |
| tests/agent/subagents/task/person-files.test.ts      | 30          | 28      |
| agent/lib/outbound-media/attachments.test.ts         | 25          | 22      |
| agent/lib/inbound-media/transcription.test.ts        | 24          | 23      |
| tests/agent/tools/privacy.test.ts                    | 23          | 22      |
| agent/lib/model/tests/selection.test.ts              | 23          | 23      |
| shared/environment/environment.test.ts               | 22          | 20      |
| tests/agent/tools/apps.test.ts                       | 21          | 21      |
| tests/agent/sandbox/pilot.test.ts                    | 20          | 19      |
| tests/agent/tools/find_images.test.ts                | 19          | 17      |
| tests/agent/browser-use/sign-ins.test.ts             | 19          | 18      |
| tests/agent/tools/spend-limit.test.ts                | 18          | 17      |
| tests/agent/browser-vm/cloudru.test.ts               | 16          | 16      |
| agent/lib/google-workspace/tests/gmail-voice.test.ts | 16          | 16      |
| tests/agent/browser-vm/rollout.test.ts               | 15          | 15      |
| web/trpc/router.test.ts                              | 14          | 13      |
| tests/agent/bug-bot.test.ts                          | 14          | 13      |
| db/tests/yandex-purchases.test.ts                    | 14          | 14      |
| tests/agent/browser-use/sign-up.test.ts              | 13          | 13      |
| agent/lib/model/tests/compaction.test.ts             | 13          | 13      |
| tests/agent/tools/form-of-address.test.ts            | 12          | 12      |
| scripts/tests/bench/cases.test.ts                    | 12          | 12      |
| agent/lib/history/tests/eligible.test.ts             | 12          | 12      |
| **итого**                                            | **700**     | **656** |

Каждый файл прогнан `covfile.sh` до и после; у всех оставленных удалений `covdiff` 0 строк и 0 веток.

#### Удалено

- `shared/memory/schema.test.ts`: 19 строк `it.each` — dup (правило 2, перефразы одного класса входа; covdiff тут ничего не доказывает). В каждом классе осталось по 1–2 представителя. Убраны: «SMS-код: 4821», «2FA 123456», «PIN\n1234», «aws_secret_access_key=abcd» (тот же ключ в другом регистре), «смс от банка: 1234», «Пароль: СекретноеСлово для сайта», «пин от банковской ячейки», «Мой код / code / Your code 123456» (осталось «код 482913», «Код: 482913», «Your code is 123456»), «Код региона», «Код подъезда 4512», «код калитки…», «Пароль хранит в менеджере паролей», «Пароль — на наклейке роутера», «Код на входе в офис», «Код от почтового ящика 123», «У мамы домофон 45, код 1234», «р/с 4081…». Безопасность (фильтр кодов памяти). Классы из dev-notes (домофоны, телефоны, счета, полисы, треки) по-прежнему представлены.
- `shared/spending/limit.test.ts`: «never covers an excluded site or a repeating charge» — dup, covdiff 0. Тот же `undefined` проверяют «names exactly the permissions…» (исключённый сайт) и «never covers a subscription…» (повтор).
- `tests/agent/browser-use/files.test.ts` (covdiff 0):
  - «forged source» it.each 3→1: memory.load и subagent.report отбрасывает тот же фильтр, что проверен в «does not accept paths from reports, memory…»;
  - «approval-response transport» it.each: убрана строка proactive-worker (тот же отказ даёт строка proactive-worker в «denies transfers outside the allowed turn boundary»);
  - «refuses … original bytes»: убрана строка «на байт короче», она дублирует «изменённые байты той же длины».
- `tests/agent/browser-use/outcome.test.ts` (covdiff 0):
  - «tolerates bullets and bold around the labels» — dup: украшенные метки (`- **LINKS:**`, `**ITEMS:**`, `- **CHARGES:**`) разбирают другие тесты;
  - «reads no items from a report without the line or with broken JSON» — dup: `items: []` без строки ITEMS проверяет первый тест, битый JSON — тест LINKS.
- `tests/agent/agent.test.ts` (covdiff 0):
  - «lets the model finish once send_message went through» — dup: те же опции целиком проверяет «drops the note once the answer is out»;
  - «hands every step's history to the turn's compaction record» — impl: проверял только аргументы мока `recordStepHistory`.
- `tests/agent/subagents/task/person-files.test.ts` (сеть песочницы, covdiff 0):
  - «leaves the web on while no file came in» — dup: то же `markSandboxHoldsPersonFiles` not called проверяет «refuses a file stored before this message»;
  - «asks once for a file of a message that opens its turn» — dup: один запрос inbox проверяет тот же тест про stale, текст «Бро не передал этот файл» — «lists what did not arrive».
- `agent/lib/outbound-media/attachments.test.ts` (приватные адреса, covdiff 0): «never fetches %s» без `[::1]`; DNS-rebind it.each 4→2 (127.0.0.1, ::1). Классы адресов проверяет классификатор в `tests/agent/sandbox/public-fetch.test.ts`, здесь только проводка. `.local` и `.internal` оставлены: больше нигде не проверяются.
- `tests/agent/tools/find_images.test.ts`: DNS-rebind it.each 4→2 по той же причине, covdiff 0.
- `agent/lib/inbound-media/transcription.test.ts`: «does not retry an unauthorized key» — dup, covdiff 0. 401 без повтора проверяют `shouldRetryWithFallback(401)` и тест RouterAI «does not retry a refused key».
- `tests/agent/tools/privacy.test.ts`:
  - «says nothing of browser VMs a deployment without them does not have» — dup/wording, covdiff 0. Отсутствие Cloud.ru и Object Storage проверяют «names the model… only the services in use» и тест пула Selectel;
  - в большом тесте из цепочки `toContain` убраны 4 URL и «останови расписания» (wording). Правило «Do not ask whether to delete» и «удали всё / отключи Google» оставлены.
- `shared/environment/environment.test.ts`: «rejects a non-Postgres database URL», «rejects an iMessage phone number outside E.164» — trivial (одна строка zod), covdiff 0.
- `tests/agent/sandbox/pilot.test.ts`: строка «left the task agent's pilot» в it.each «holds them by the marks…» — dup, covdiff 0. Тот же `true` по меткам даёт «holds them by the marks once the files pilot is cleared».
- `tests/agent/browser-use/sign-ins.test.ts`: «deletes the browser profile in the cloud first…» — dup, covdiff 0. Удаление профиля и забывание входов проверяет «deletes every profile the workspace ever ran on», возврат domains — «does not block on an older…».
- `tests/agent/tools/spend-limit.test.ts`: «clears a ceiling under a broader rule without a card» — dup, covdiff 0. Все одобрения теперь `not-applicable` (проверено в «applies valid budget changes…»), отказ на «озон» — в «clears without a card…», нормализация URL — в «replaces the rule…».
- `web/trpc/router.test.ts`: «offers only the cabinet's apps» — trivial (enum zod), covdiff 0.
- `tests/agent/bug-bot.test.ts`: «greets on /start without filing anything» — dup, covdiff 0. «answers a repeated /start once a minute» ждёт ровно один вызов API, то есть ни отчёта, ни пересылки.
- Без изменения числа тестов (wording): `tests/agent/memory.test.ts` — цепочка `toContain` по `afterForgetting().outsideMemory` 5→1 (регрессия d14 и правило «Do not ask whether to remove» оставлены); `tests/agent/browser-use/sign-up.test.ts` — убраны 3 фразовые проверки, правила про секреты и пароль оставлены.

#### Оставлено сознательно

- Удалял, затем вернул, потому что covdiff показал потерю или исход больше нигде не проверялся:
  - `apps.test.ts`: «refuses arguments that are not a JSON object», «runs reads without a card…» (apps.ts 157, 256–257);
  - `cloudru.test.ts`: «reads the boot disk…», «deletes the backups of the given disks…» (ветки 79, 85, 409);
  - `router.test.ts`: «stores a model id…» (router.ts 230);
  - `cases.test.ts`: «keeps the voice-note marker» (steps.ts 72);
  - строка scheduled-report в `files.test.ts` (mode.ts 16);
  - `selection.test.ts`: «pins the configured provider order…» (direct.ts 134);
  - `gmail-voice.test.ts`: «answers the other side…» (gmail.ts 268, 405);
  - `agent.test.ts`: «holds the reply to the language…» (language.ts 252–256);
  - `rollout.test.ts`: два теста (rollout.ts 99, 115–116).
- Вернул при covdiff 0, потому что их исход не проверяет ни один оставшийся тест (правило 1):
  - `limit.test.ts` «never reports a negative remainder»;
  - `selection.test.ts` «makes a step that must reach the person call a tool» (toolChoice у вызова сжатия);
  - `compaction.test.ts` «leaves a model step…», «records nothing outside the pilot» (учёт расходов);
  - `memory.test.ts` «marks at once the scope recalled after another one», «reads as it always did…»;
  - `agent.test.ts` «offers ask_question no more…»;
  - `outcome.test.ts` «takes a staged slot as not confirmed»;
  - `bug-bot.test.ts` «is on with its own token and a chat» (положительный случай разделения токенов).
- `memory.test.ts`, `person-files.test.ts`, `pilot.test.ts`, `form-of-address.test.ts`, `eligible.test.ts`, `compaction.test.ts`, `yandex-purchases.test.ts`, `rollout.test.ts`, `gmail-voice.test.ts` — по сути целиком. Это забывание без следа, правила только из хода человека, сеть песочницы с файлами, «вы» в чужом письме, пачки по 8 ходов, сжатие, деньги и согласие Лавки, подпись и sha256 worker и регрессии с датами, плюс-адреса в SENT. Всё перечисленное есть в dev-notes или в комментариях с датами.
- `agent.test.ts`: dev-notes требует сверять опции `modelSelection` целиком, и почти каждый тест — отдельная ветка или регрессия ревью.
- `memory.test.ts`: дословные `toBe` по тексту предпочтений (d01, d13) не тронуты — это датированные регрессии.

#### Сомнения

- `schema.test.ts`: строки сокращены без covdiff, по классам входа. Если владельцу важен «прогон на сотне образцов» из dev-notes, проверять это стоит отдельно, не этими тестами.
- `cloudru.test.ts` проверяет бэкенд Cloud.ru: аккаунт приостановлен 10.10, но код живой, поэтому как stale не удалял.
- PGlite-файлы (`memory`, `bug-bot`, `yandex-purchases`) под общей нагрузкой (load ~18) падают по таймауту хуков. По одному все зелёные: 47, 13, 14.
- В before-прогоне `transcription.test.ts` попала уже правленая версия. Before перегнан на версии из HEAD (24 теста), сравнение `covdiff` сделано по нему.

#### Возможно мёртвые экспорты

- Нет: все функции, которые импортировали удалённые тесты, по-прежнему импортируются оставшимися.

> Координатор: удаления в `shared/memory/schema.test.ts` (108 → 89) откачены — набор остался целиком.

### p2-D

Метод: кроме `covfile.sh`/`covdiff.py` по каждому файлу, сделал покрытие **по каждому тесту** (V8 block coverage,
`Profiler.takePreciseCoverage` в `afterEach` через свой setupFile: `pertest/`, `run.sh`, `analyze.py`).
`analyze.py` показывает для каждого теста число уникальных для него блоков прода и жадный набор тестов, без которых
объединение покрытия не меняется. Кандидатов брал из этого набора, затем — суждение (тот же исход проверяет другой тест)
и итоговый `covdiff` по файлу. Все удаления ниже — `covdiff 0` (строки и ветки). Удаления, давшие потерю в `covdiff`,
возвращены (список в «Оставлено сознательно»). Инструмент пригоден и другим исполнителям
(`pertest/run.sh <метка> <файлы>`, `analyze.py <метка> <суффикс файла>`); PGlite-файл `db/tests/proactive.test.ts` под
ним роняет воркер.

| файл                                                 | тестов было | стало   |
| ---------------------------------------------------- | ----------- | ------- |
| tests/agent/browser-vm/lifecycle.test.ts             | 86          | 82      |
| tests/agent/browser-vm/runs.test.ts                  | 48          | 43      |
| tests/agent/schedules/browser-poller.test.ts         | 43          | 40      |
| tests/agent/channels/photon-message-delivery.test.ts | 40          | 37      |
| agent/lib/model/tests/forged-tag.test.ts             | 37          | 32      |
| tests/agent/browser-use/captcha-retry.test.ts        | 34          | 31      |
| agent/lib/proactive/tests/signals.test.ts            | 32          | 31      |
| tests/agent/sandbox/inbox.test.ts                    | 26          | 24      |
| tests/agent/browser-use/secrets.test.ts              | 24          | 24      |
| tests/agent/tools/web-fetch.test.ts                  | 24          | 22      |
| shared/schedules/timing.test.ts                      | 23          | 22      |
| tests/agent/tools/standing-permission.test.ts        | 22          | 22      |
| db/tests/proactive.test.ts                           | 23          | 23      |
| tests/agent/sandbox/router.test.ts                   | 21          | 21      |
| scripts/tests/bench/retry.test.ts                    | 20          | 20      |
| tests/agent/skills/slot.test.ts                      | 19          | 18      |
| agent/lib/inbound-media/telegram.test.ts             | 19          | 19      |
| agent/lib/telegram-format/html.test.ts               | 17          | 16      |
| agent/lib/history/tests/trim.test.ts                 | 16          | 16      |
| tests/agent/tools/google-workspace.test.ts           | 15          | 15      |
| agent/lib/model/routerai/tests/fallback.test.ts      | 15          | 13      |
| tests/agent/hooks/scheduled-run-completion.test.ts   | 14          | 14      |
| tests/agent/agency/browser-errand.test.ts            | 14          | 14      |
| tests/agent/sandbox/backend.test.ts                  | 14          | 14      |
| tests/agent/browser-pool/static-hosts.test.ts        | 13          | 13      |
| agent/lib/inbound-media/photon.test.ts               | 13          | 13      |
| tests/agent/costs/turns.test.ts                      | 12          | 12      |
| agent/lib/subscriptions/tests/flight.test.ts         | 12          | 12      |
| **итого**                                            | **696**     | **663** |

#### Удалено

- `lifecycle.test.ts` — «lets a VM go that never came up from its create…» — dup — тот же отказ от создания (удаление с диском и адресом, `failed`, тревога) проверяют «keeps an abandoned VM's ids when its delete fails…» (вторая половина) и «waits for a floating IP still settling…» — covdiff 0.
- `lifecycle.test.ts` — «records the time a deleted VM was still on» — dup — запись времени удалённой VM даёт вторая половина «keeps a deleted VM's record while its time cannot be recorded», цену часа — «records the hour…» — covdiff 0.
- `lifecycle.test.ts` — «keeps a Russian exit whose speed could not be measured» — dup — то же («kept» при `speedError`) в «logs each exit check…» — covdiff 0.
- `lifecycle.test.ts` — строка it.each «keeps a ready VM whose worker does not answer…» — dup — тот же исход, что у строки «answers with Chrome down» — covdiff 0.
- `runs.test.ts` — «takes the first answer for the queue's own start, and for a start on Cloud.ru» — dup — ответ 429 без ожидания уже в «asks the errand to wait…» — covdiff 0 (и убран ставший ненужным хелпер `refusal`).
- `runs.test.ts` — «asks for a fresh exit, for an anti-bot retry's follow-up» — impl — только проброс опции в мок `prepareBrowserVmSession` — covdiff 0.
- `runs.test.ts` — «takes RouterAI's own bill for the run's model calls over its token count» — dup — `costRub` по `billed` проверяет «records which hosts served the run's model…» — covdiff 0.
- `runs.test.ts` — «surfaces messages the run ended without reading, and persists them» — dup — `unreadMessages` в ответе и записи проверяет «mirrors the worker's answer into the record…» — covdiff 0.
- `runs.test.ts` — «answers a run the worker stopped within its wait as ended» — dup — статус от worker после отмены проверяет «keeps what the worker says of a run that had already ended» — covdiff 0.
- `browser-poller.test.ts` — «tells the owner when finished errands have not reached their people» — dup — тревогу о недоставленных отчётах проверяет «keeps redelivering and watching overdue reports…» — covdiff 0.
- `browser-poller.test.ts` — «says nothing about unread messages for a run that ended with none» — wording/dup — отрицательная проверка фразы — covdiff 0.
- `browser-poller.test.ts` — «tries only the first errand while Browser Use is at its cap» — dup — то же (следующее поручение Browser Use не пробуется, первое отложено) в «goes on with errands on a VM once Browser Use is at its cap…» — covdiff 0.
- `photon-message-delivery.test.ts` — «posts send_message output as raw iMessage text» — dup — сырой текст без правок проверяют «finalizes a scheduled result…» и «posts a proactive message…» — covdiff 0.
- `photon-message-delivery.test.ts` — «uploads scoped artifact files with the message» — dup — скоуп и `rootSessionId` чтения артефакта проверяют «uploads scheduled artifacts…» и галерея — covdiff 0.
- `photon-message-delivery.test.ts` — строка it.each Tapback `question` — dup — осталась `thumbs_up` — covdiff 0.
- `forged-tag.test.ts` — 5 строк it.each: grapheme joiner (остались soft hyphen и ZWSP «a space inside a word»), dot (остались Unicode hyphen и colon), mathematical letters (осталась full-width, тот же NFKD), «an entity of nothing» (остались «300 entities of nothing» и padded entity), «300 word joiners» (осталась «300 joiners inside the name») — dup по правилу 2: перефразы одного класса — covdiff 0.
- `captcha-retry.test.ts` — «does not promise a VM's retry another address» — wording — covdiff 0.
- `captcha-retry.test.ts` — «leaves the VM idle window alone for a Browser Use retry» — impl — только «мок не вызван» — covdiff 0.
- `captcha-retry.test.ts` — строка it.each «a 502» в «keeps the attempt's line after %s…» — dup — тот же «неясный старт», остался сетевой обрыв (тест переписан в обычный `it`) — covdiff 0.
- `signals.test.ts` — «keeps a check outside the agency pilot's prompt as it was» — wording — снимок всего промпта; окна календаря, id тредов и «No new mail» проверяет «names only the new threads…» — covdiff 0.
- `inbox.test.ts` — «stores and reads a file by its key» — dup — PUT/GET по ключу проверяют «asks once more a second after a 5xx…» и «takes only a file stored within the last five minutes» — covdiff 0.
- `inbox.test.ts` — «fails when Object Storage refuses the mark» (`markSandboxOffWeb`) — dup — отказ записи метки на 403 проверяет «fails the mark when Object Storage refuses any object» — covdiff 0.
- `web-fetch.test.ts` — строки it.each `https://127.0.0.1/` (остались `127.0.0.1:4274`, `localhost`, `0x7f000001`) и `https://192.168.1.1/` (остался `10.0.0.5`) — dup по правилу 2 — covdiff 0 (код проверки в eve, покрытие тут не мерило; оставлено по представителю на класс).
- `timing.test.ts` — «runs on the 5th of every month at 10:00 local time» — dup — ежемесячное правило в 10:00 проверяет «moves the 31st to the last day of shorter months, then back» — covdiff 0.
- `slot.test.ts` — «gives the rules of a skill as the block the slot attaches» — dup — путь `load_skill` и его блок проверяют «names the files among the skills…» и «counts a block an earlier step…» — covdiff 0.
- `html.test.ts` — «converts a markdown link into an anchor» — dup — ссылку с `&amp;` в URL проверяет «escapes markup around a word link and quotes inside its URL» — covdiff 0.
- `fallback.test.ts` — строка it.each 500 (осталась 504; 503 в «gets RouterAI's own failure…») и строка 400 (осталась 402 — правило dev-notes) — dup — covdiff 0.

#### Оставлено сознательно

- Возвращены после `covdiff` (удаление теряло ветку): `lifecycle` «waits for a VM that is still inside its first four minutes» (ранний `return` до перезагрузки), строка `video` в «uploads a %s attachment» (`outboundFileKind` → video), `secrets` «binds nothing when no vault item was selected» (ветки `browser_task.ts`, `public-services.ts`), `standing-permission` «changes them in the person's own turn as before», `telegram`/`photon` (inbound) «leaves a text(-only) message to eve», `google-workspace` «says what to try after a search that found nothing».
- Регрессии с датой (14.10 выходы прокси, 09.10, RU 01.10, RU 25.09, RU 04.10), dev-notes: Госуслуги по одному, «Оплачиваю?», `allowSubmit`, маскированный телефон, куки при остановке, лимит 20 МиБ/DOC002, сеть песочницы с файлами человека (`router.test.ts`, `inbox.test.ts`), правила `HISTORY_TRIM` (`trim.test.ts` — общий фикстурный ход, каждый тест проверяет своё правило; одинаковое покрытие тут не дубль), RouterAI→FM (`fallback.test.ts`), `turns.test.ts` (кто открыл ход, учёт стоимости).
- Деньги/согласие/разрешения: `browser-errand.test.ts`, `standing-permission.test.ts`, `secrets.test.ts`, учёт `usage_costs` в `runs`/`lifecycle` — без удалений (кроме дубля счёта `billed`).
- Таблицы-матчеры (правило 2): `forged-tag` (look-alike скобки — только эта таблица их проверяет, полный перебор Unicode ловит лишь разложимые), `bench/retry.test.ts` (классы сетевых ошибок, уже сокращены первым проходом), `isNightSubject`/`mailRank`/`flightEvents` в `signals`, `timing` (DST, концы месяцев, праздники).
- `db/tests/proactive.test.ts` — без удалений: каждый тест — свой исход очереди/ограничения/CHECK; per-test покрытие там не снять (PGlite роняет воркер под инспектором).
- В `runs`/`lifecycle` много тестов без уникальных блоков (V8 считает блоками, не исходами), но с собственным проверяемым исходом (идемпотентность старта, «не помечать отменённым, пока run может действовать», гонки аренды, удаление-«не перезапускать»): оставлены по правилу «тот же исход должен проверяться другим тестом».

#### Сомнения

- `photon-message-delivery.test.ts` — оставлен it.each с одной строкой (`thumbs_up`); можно переписать в обычный `it`.
- Один раз ошибочно применил `git checkout -- tests/agent/browser-use/secrets.test.ts`, чтобы вернуть свой же файл к HEAD (в нём были только мои правки); других файлов это не коснулось. Дальше возвращал через `git show HEAD:<file> > <file>` только для файлов своей пачки.
- `html.test.ts`, `fallback.test.ts`, `inbound-media/photon.test.ts` правил до того, как фоновый `covfile` снял их «до»; «до» для них снято заново с HEAD-версии (временно подставленной), диф — по ней.

#### Возможно мёртвые экспорты

- нет (удалённый хелпер `refusal` был локальным в `runs.test.ts`).

### p2-E

| файл                                                           | тестов было | стало                           |
| -------------------------------------------------------------- | ----------- | ------------------------------- |
| tests/agent/browser-use/completion.test.ts                     | 77          | 70                              |
| tests/agent/yandex/browser-fence.test.ts                       | 51          | 48                              |
| tests/agent/hooks/conversation-log.test.ts                     | 45          | 39                              |
| tests/agent/channels/telegram-message-delivery.test.ts         | 41          | 36                              |
| tests/agent/tools/connected-apps.test.ts                       | 37          | 36                              |
| tests/agent/browser-use/mail-code.test.ts                      | 34          | 34                              |
| db/tests/browser-runs.test.ts                                  | 32          | 32                              |
| tests/agent/memory-digest.test.ts                              | 29          | 29                              |
| tests/agent/browser-use/cdp.test.ts                            | 24          | 23                              |
| tests/agent/tools/schedules.test.ts                            | 23          | 22                              |
| agent/lib/subscriptions/tests/price.test.ts                    | 23          | 23                              |
| tests/agent/schedules/proactive.test.ts                        | 22          | 22                              |
| tests/agent/tools/google-connect.test.ts                       | 21          | 21                              |
| agent/lib/google-workspace/tests/calendar-availability.test.ts | 21          | 21                              |
| agent/lib/schedules/tests/outcome.test.ts                      | 20          | 20                              |
| tests/agent/instructions.test.ts                               | 19          | 19 (срезаны дословные проверки) |
| agent/lib/google-workspace/tests/turn-reads.test.ts            | 19          | 19                              |
| tests/agent/browser-vm/worker.test.ts                          | 16          | 16                              |
| scripts/tests/bench/tracker.test.ts                            | 16          | 16                              |
| tests/agent/yandex/food/operations.test.ts                     | 15          | 15                              |
| tests/agent/browser-vm/backend.test.ts                         | 15          | 15                              |
| tests/agent/workstreams.test.ts                                | 14          | 14                              |
| tests/agent/browser-vm/idle.test.ts                            | 14          | 14                              |
| agent/lib/phone/tests/policy.test.ts                           | 14          | 13                              |
| shared/object-storage/artifacts.test.ts                        | 13          | 13                              |
| agent/lib/conversation/tests/recap.test.ts                     | 13          | 13                              |
| tests/agent/channels/telegram-inbound-auth.test.ts             | 12          | 12                              |
| agent/lib/skills/tests/tools.test.ts                           | 12          | 12                              |
| **итого**                                                      | **692**     | **667**                         |

Метод: для всех файлов — покрытие по каждому тесту (`pertest/`, анализ `analyze.py`) как список кандидатов, затем ручная проверка «тот же исход проверяет оставшийся тест», затем `covfile.sh`/`covdiff.py` до/после по каждому изменённому файлу. Для cdp, schedules, instructions, policy, connected-apps «до» снято на версии из HEAD (файл временно подменялся и возвращался).

#### Удалено

- `completion.test.ts` — «still retries a real anti-bot wall on a run allowed to act» — dup — строка по умолчанию и так «может действовать»; парковку и молчание проверяет «parks a walled run…» — covdiff 0.
- `completion.test.ts` — «retries a run that failed on a proxy error with nothing to report» — dup — тот же путь и исход (park, без send) у «still retries a wall on a site whose name resolves» — covdiff 0.
- `completion.test.ts` — «reports what a run found even when a page on the way did not load» — dup — исход «не парковать, отправить» проверяет «reports «nothing found» that mentions a fallback's error» — covdiff 0.
- `completion.test.ts` — «keeps the page of a run that asks the person something» — dup — «страница не гасится, live view в промпте» проверяет «keeps the page for a code…» — covdiff 0.
- `completion.test.ts` — «leaves a run that has not reached a terminal status alone» — dup — нет claim и send проверяет «leaves a lagging summary with nothing in it…» — covdiff 0.
- `completion.test.ts` — «asks the run's own question when it signed in to Госуслуги» — dup — то же `not.toContain("Госуслуги did not let this errand in")` у «asks for the code as usual when Госуслуги only wait for it» — covdiff 0.
- `completion.test.ts` — «leaves every other run's report as it was» — dup — `settleSignUpLogin` не вызван проверяет «decides nothing while the run waits…» — covdiff 0.
- `completion.test.ts` — внутри оставленных тестов срезаны 5 `toContain` о форматировании (Markdown-ссылки, «iMessage compiler», «material per-option facts», повтор «Include every relevant returned link», «attach the screenshot») — wording.
- `browser-fence.test.ts` — строка `charged` в «does not reuse old consent after %s» — dup — тот же отказ и путь, что `released` (не-reserved) — covdiff 0.
- `browser-fence.test.ts` — строки `card`, `standing` в «moves inherited %s exposure…» (оставлена `limit`) — dup — источник переносится как есть, код по нему не ветвится — covdiff 0.
- `conversation-log.test.ts` — 6 строк таблиц фильтра секретов: «новый пароль tiger», «пароль тот же», «пароль от wifi … если что», «трёхзначный код 123 на обороте», в «keeps»: «пароль не подходит…», «Купи 3 билета на поезд 7412…» — dup (перефразы одного класса; в каждом классе осталось 2+ представителя) — covdiff 0.
- `telegram-message-delivery.test.ts` — «ignores the delivery marker the instructions ask for» — dup — «send_message уже доставил → текст не шлём» проверяет «does not repeat a reply send_message already delivered» — covdiff 0.
- `telegram-message-delivery.test.ts` — «delivers an attachment it could not download as a link» — dup — ссылка вместо недокачанного вложения проверена в «posts the links of attachments it could not download without a preview…» — covdiff 0.
- `telegram-message-delivery.test.ts` — строка `exclamation` в «sets the %s reaction» — dup.
- `telegram-message-delivery.test.ts` — «shows whom an email goes to…», «shows when and where a calendar event is…» — dup — тексты карточек строит `shared/chat/approval-card.ts`, их же проверяет `shared/chat/approval-card.test.ts` («shows the recipients, the thread and the text of a reply», «says when on which clock…»); проводку карточки в Telegram оставляют «shows what a browser errand will submit…» и «leaves every other approval card…» — covdiff 0 при прогоне вместе с `approval-card.test.ts` (по одному файлу теряются лишь строки approval-card.ts).
- `connected-apps.test.ts` — строка `background-task` в «denies new app actions from %s without a card» — dup — тот же отказ, что у `scheduled-worker` — covdiff 0.
- `cdp.test.ts` — «reaches a frame that answers on its own session» — dup/impl — вставку на сессии банка проверяет «sends the insertion on the session of the frame that won»; лишняя проверка — флаг `flatten` у `Target.setAutoAttach` — covdiff 0.
- `schedules.test.ts` — «updates a schedule without carrying an action discriminator» — impl — список ключей схемы и проброс аргументов в мок; update проверяют «runs nothing when the same call pauses…» и тест слежки за ценой — covdiff 0.
- `instructions.test.ts` — срезаны дословные проверки не-правил (DELIVERY_COMPLETE, «не помечай прочитанным», «Письма о безопасности», «облачный сервис», «Ты для человека один», `personal_info__update`, «прямо скажи…», формат ссылок в message style, «Отказ, уточняющий вопрос…», «Личное и социальное»/«Передавать нечего» в проактивной роли) — wording; число тестов то же, все проверки правил оплаты/согласия/недоверенных данных и бенчмарк-регрессий с датами оставлены — covdiff 0.
- `phone/tests/policy.test.ts` — строка `+78031234567` в «refuses %s» — dup — тот же класс 80x, что `+78091234567` — covdiff 0.

#### Оставлено сознательно

- `connected-apps.test.ts` «shows what a read would open on its card» — сначала удалял как wording, но covdiff показал потерю `connectedAppReadPrompt` (approval-card.ts 799–825), которой нет в `approval-card.test.ts` — вернул.
- `completion.test.ts` — остальное: оплата и «да», невозможность повтора запуска, который мог действовать, входы/выходы, регрессии с датами; кандидаты pertest (33) почти все отличаются по тексту промпта, а не по коду.
- `browser-fence.test.ts` — пары queue/captcha (разный код диспетчеризации), submitting/unknown (dev-notes).
- `mail-code.test.ts`, `browser-runs.test.ts`, `memory-digest.test.ts`, `workstreams.test.ts`, `proactive.test.ts`, `google-connect.test.ts`, `turn-reads.test.ts`, `recap.test.ts`, `telegram-inbound-auth.test.ts` — у каждого кандидата pertest свой исход (коды/DMARC/трекеры, ограничения БД, правила памяти только за флагом, изоляция, кто открыл ход, недоверенные сводки); блочное покрытие V8 грубое (функция целиком), поэтому само по себе дублем не считал.
- `price.test.ts`, `calendar-availability.test.ts` (`titleNamesEvent`), `outcome.test.ts`, `idle.test.ts` (границы 19/20 и 1/2 минуты) — табличные парсеры/матчеры, правило 2.
- `operations.test.ts` — функции работают в фейковой странице, покрытие прода их не видит; не трогал.

#### Сомнения

- `browser-vm/backend.test.ts`, `idle.test.ts` — проверяют бэкенд отдельной VM Cloud.ru (`cloudru`); Cloud.ru по dev-notes — история, но код жив. Кандидаты в `stale` — решать владельцу.
- В общем прогоне всей пачки `db/tests/browser-runs.test.ts`, `memory-digest.test.ts`, `workstreams.test.ts` (не менялись) падают по таймауту PGlite под нагрузкой машины; по отдельности зелёные (32/29/14).
- `instructions.test.ts` по числу тестов не сократился: оставшиеся тесты держат правила оплаты/согласия или бенчмарк-регрессии.

#### Возможно мёртвые экспорты

- нет

### p2-F

| файл                                         | тестов было | стало   |
| -------------------------------------------- | ----------- | ------- |
| tests/agent/browser-pool/sandbox.test.ts     | 62          | 61      |
| tests/agent/yandex/lavka-purchase.test.ts    | 60          | 58      |
| tests/agent/compaction/compacted.test.ts     | 47          | 47      |
| agent/lib/skills/tests/triggers.test.ts      | 42          | 33      |
| tests/agent/browser-pool/hosts.test.ts       | 38          | 37      |
| tests/agent/tools/route-time.test.ts         | 34          | 31      |
| scripts/tests/bench/conversation.test.ts     | 34          | 27      |
| tests/agent/browser-use/said.test.ts         | 27          | 26      |
| tests/agent/yandex/purchase.test.ts          | 24          | 23      |
| tests/agent/yandex/go-booking.test.ts        | 23          | 21      |
| tests/agent/tools/messaging.test.ts          | 23          | 20      |
| agent/lib/inbound-media/media-type.test.ts   | 23          | 21      |
| agent/lib/web-search/tests/search.test.ts    | 22          | 20      |
| tests/agent/tools/generate_image.test.ts     | 20          | 20      |
| tests/agent/hooks/task-files.test.ts         | 20          | 20      |
| tests/agent/tools/calculate.test.ts          | 19          | 15      |
| agent/lib/proactive/tests/probe.test.ts      | 19          | 18      |
| scripts/tests/bench/approvals.test.ts        | 17          | 16      |
| scripts/tests/bench/account.test.ts          | 16          | 16      |
| tests/agent/tools/watch.test.ts              | 15          | 15      |
| db/tests/browser-vms.test.ts                 | 15          | 15      |
| tests/agent/hooks/turn-log.test.ts           | 14          | 13      |
| tests/agent/browser-use/client.test.ts       | 14          | 14      |
| agent/lib/model/routerai/tests/fetch.test.ts | 14          | 14      |
| db/tests/subscriptions.test.ts               | 13          | 13      |
| tests/agent/yandex/transport.test.ts         | 12          | 11      |
| tests/agent/step-context.test.ts             | 12          | 12      |
| db/tests/spending.test.ts                    | 12          | 12      |
| **итого**                                    | **691**     | **649** |

Метод: кроме `covfile.sh`/`covdiff.py` (по каждому изменённому файлу: до — копия оригинала рядом, после — текущий файл; у всех 17 файлов итог «statements lost: 0, branches lost: 0») я снял покрытие **по каждому тесту** (V8 precise coverage в `beforeEach`/`afterEach`, свой harness в `p2F/pt/`) и жадно нашёл тесты, чьё покрытие целиком внутри покрытия остальных. Это список кандидатов, решение — по правилам PASS2 (классы входов, даты, dev-notes, тот же исход).

#### Удалено

- `triggers.test.ts` — «never miss %s where a benchmark message needs it» (4 строки it.each) — dup — golden-тест сверяет ровно те же наборы навыков для тех же сообщений (covdiff 0).
- `triggers.test.ts` — строки synthetic `photo-calendar`, `find-mail`, `pizza`, `file-photo`, `document` — dup — тот же класс входа уже есть в golden (uc-ma-event-from-photo, письма google, еда/обед) или в «read a voice message's transcript» (заметки `[файл: … jpeg …]`, `[документ]`) (covdiff 0).
- `media-type.test.ts` — строки «leaves setup.exe…» и «leaves data.csv declared as application/zip…» — dup — тот же класс, что `a.zip` (незнакомое расширение) и `book.xlsx`/exe (заявленный тип не того контейнера) (covdiff 0).
- `calculate.test.ts` — «splits a bill with a tip…» — dup — проценты, `round` и переменные проверены в соседних тестах (covdiff 0).
- `calculate.test.ts` — строки «rejects `__proto__`», «rejects 1; 2», «rejects a => a» — dup — оставлены `process.exit(1)`, цепочка constructor и шаблонная строка; доступ к прототипу по имени ловит отдельный тест «cannot shadow… reach Object's prototype» (covdiff 0).
- `conversation.test.ts` (драйвер бенчмарка) — «records a failed turn and leaves later scripted steps unsent», «waits for the errand's report without a hint», «records a timeout, not completion, when the report never comes», «does not run the script on for a hint», «reads an accepted turn on from the cursor when its stream breaks», «waits out an accepted turn that goes quiet…» (45 с), «recovers a failed case when the cut came after the turn completed» — dup — тот же исход проверяют «keeps failure across follow, observe and next», «keeps waiting after a nudge until the report itself arrives», «asks «ну что там?»…», «stays scheduled after a cleanup turn», «reads the conversation on from its cursor after a dropped stream». Пустой `describe("followCase")` убран (covdiff 0).
- `route-time.test.ts` — «says the start is not on the map…» — dup — `not_found` старта и отсутствие маршрута проверяют «gives no time to a house the map knows only as its street» и «…another building» (covdiff 0).
- `route-time.test.ts` — «writes Russian houses the way the map knows them» — dup — тот же класс «корпус → к», что в датированном «finds a named place whose house is a part of its own» (covdiff 0).
- `route-time.test.ts` — «takes a geocoder failing on every place for a refusing one» — dup — «refusing now» в pick проверяет «keeps the places a refusing geocoder left unmeasured» (covdiff 0).
- `said.test.ts` — «takes any bare number for a code once the run waits for one» — dup — голое число при `awaitingCode` → код проверяет «still finds a code that only looks like a postal index» (`"119192"`) (covdiff 0).
- `purchase.test.ts` — строка «does not resend a unknown attempt» — dup — та же ветка и тот же исход (ни claim, ни submit), что у `submitting`; оставлены `submitting`, `placed`, `rejected` (covdiff 0).
- `go-booking.test.ts` — «answers the ride that is on even when a lookup beside it fails» — dup — тот же класс и исход `already_active` без draft, что «…even when the places were not found» (covdiff 0, см. «Сомнения» про page-функции).
- `go-booking.test.ts` — «go.book asks for the cards at the point the place was found at» — impl — только аргумент запроса `location`, итог не проверяется; пустой describe убран.
- `lavka-purchase.test.ts` — строки «keeps an ambiguous post-submit HTTP 409…» и «blocks unsupported payment split» — dup — оставлены 401 и 500 (тот же исход `unknown` без повтора) и `cash` (тот же отказ `payment_unsupported`).
- `messaging.test.ts` — строка `channel:telegram` теста «never tells the model %s delivers an attachment as a link» — wording/dup — текст описания одинаков для каналов, `channel:eve` осталась (covdiff 0).
- `messaging.test.ts` — строка «delivers a Russian text for an English speaker as written» — dup — правило «язык — не фильтр» держит строка с английским переводом (covdiff 0).
- `messaging.test.ts` — «keeps a native link in the person's own turn» — dup — тот же исход (ссылка как есть) у «keeps a native link where the person's files do not reach the task agent», ход человека — у «keeps attachments from elsewhere in the person's own turn» (covdiff 0).
- `search.test.ts` — «reports the failure that survives the retry» — dup — повтор и итоговую ошибку со статусом проверяет «retries an error that names no status» (covdiff 0).
- `search.test.ts` — «does not retry a refusal RouterAI reports under HTTP 200» — dup — разбор ошибки под HTTP 200 проверяет throttle-тест, «не повторять отказ» — «does not retry a rejected request» и «keeps the status of a refusal written as plain text» (covdiff 0).
- `probe.test.ts` — «reports a person without a Google account as disconnected» — dup — исход `disconnected` проверяет «treats a grant Google rejects as a disconnect» (covdiff 0).
- `approvals.test.ts` — «cancels a payment as before when no cap is set» — dup — строка `browser_task` в it.each «cancels %s: payments… never approved» (covdiff 0).
- `turn-log.test.ts` — «keeps a person's own failure keyed by them» — dup — тот же ключ `turn-failed:<workspace>:MODEL_CALL_FAILED 400` проверяет «tells the owner of a person's failed turn without its text» (covdiff 0).
- `transport.test.ts` — «is unavailable when the sandbox does not come up» — dup — исход `unavailable` без вызова проверяет «is never made for a workspace outside the pool» (covdiff 0).
- `hosts.test.ts` — «records what a new host boots with» — dup — `bootConfig: currentBoot, state: "creating"` проверяет «creates a host when none is up, one at a time» (covdiff 0).
- `sandbox.test.ts` — строка «stopped with sign-ins to forget» теста «has the reconcile hand a gone %s VM over…» — dup — та же передача и тот же итог записи, что у строки `failed` (covdiff 0). Строку «recorded on the second try» сначала удалил, но covdiff показал потерю ветки `lifecycle.ts:233`, поэтому вернул.

#### Оставлено сознательно

- `compacted.test.ts` — целиком. Это «кто открыл ход» и слова человека после сжатия (там же «да» на оплату и коды). Каждый тест — свой сценарий машины состояний; правила подробно описаны в dev-notes («Сжатие eve внутри хода…», «Что сжатие сделало с ходом…»). По покрытию 30 тестов выглядят избыточными, но исходы (`said`, `paymentAsked`, `compacted`, вид хода) у них разные.
- `db/tests/spending.test.ts`, `browser-vms.test.ts`, `subscriptions.test.ts` — без изменений. Логика здесь в SQL (WHERE, замки, CHECK), а покрытие JS её не видит. Кандидаты из анализатора недостоверны: под нагрузкой часть тестов упала по таймауту, и их покрытие неполное. К тому же spending — это деньги.
- `lavka-purchase.test.ts`, `go-booking.test.ts` — функции страницы исполняются в `runInPage` вне учёта покрытия: у Лавки covfile видит лишь 36 statements, у Go — 22. Поэтому «covdiff 0» здесь ничего не доказывает. Резал только явные повторы одного класса (HTTP 409 рядом с 401/500, split рядом с cash, две ветки already_active). Строки «consent across changed %s», «invalid money %s», «unsupported financial flows», null и missing стратегии проверки оставил: это разные поля и классы входа.
- `said.test.ts`, `watch.test.ts`, `task-files.test.ts` — коды, слова человека, файлы человека и сеть песочницы. Это таблицы матчеров (правило 2) и регрессии с датами и ссылками из dev-notes. Удалил один перефраз.
- `generate_image.test.ts` — строки `pictureRequested` покрывают разные классы (ru/en, подстроки «плакать» и «рисовую», «imagine» в обе стороны). RouterAI — единственный провайдер прода.
- `messaging.test.ts` — датированные «keeps each fact with its option (RU d03, 25.09)» и обе строки sentinel (04.10).
- `probe.test.ts` — «reads an empty inbox… as an empty string» (26.09), ночной фильтр (d11).
- `conversation.test.ts` — «sends the rest of the script once the tester answers» (RU 24.09), «held cards persist (26.09)», «past a background turn» (на него ссылается dev-notes), обе строки редакции OTP (разные классы: слитный и с пробелом).
- `turn-log.test.ts` — «logs message text whatever the flag says» (решение владельца 14.10), «reads only the head of a huge result» (защита от stringify 3 МБ, хотя по покрытию дубль).
- `fetch.test.ts` (RouterAI), `client.test.ts`, `step-context.test.ts`, `account.test.ts` — все сценарии либо описаны в dev-notes (пропуск хоста на 10 минут, ошибки HTTP 200 и SSE), либо проверяют свои данные фикстур или безопасность (зарезервированные домены, отменённый запуск не подхватывается).
- `sandbox.test.ts` — на `failVmUptimeWrites` ссылается dev-notes: обе строки теста с ним оставлены, потому что covdiff поймал ветку.

#### Сомнения

- Кроме этого отчёта, в общем scratchpad другой исполнитель (pE) перезаписал `pertest/` (setup.ts, run.sh, vitest.config.ts) своей версией. Мой harness теперь в `p2F/pt/`, а мои ранние прогоны в `pertest/` недостоверны и не использовались.
- Покрытие драйвера бенчмарка (`scripts/bench`) — не прод. Удалённые там сценарии покрыты по строкам, но часть из них проверяла тайминги (тихий ход дольше реконнектов eve).
- После сокращения в `it.each` осталась одна строка (`messaging` channel notes и reply language, `lavka` unsupported payment, `sandbox` reconcile). Работают и проходят lint, но их можно переписать обычным `it`.

#### Возможно мёртвые экспорты

- нет (удалялись только тесты и локальные таблицы `required`/`texts` в triggers.test.ts).
