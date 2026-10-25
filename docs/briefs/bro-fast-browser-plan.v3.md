# Bro: быстрые и надёжные браузерные поручения в закрытой бете. Бриф для Opus (v3)

> Статус: закрытое тестирование, платящих пользователей нет, тестируют бесплатно друзья и знакомые (слова владельца, 25.10). v1 — `bro-fast-browser-plan.v1.md`, v2 (с юнит-экономикой и A/B на трафике) — `bro-fast-browser-plan.v2.md`. Этот бриф опирается на репозиторий [Ageree/bro](https://github.com/Ageree/bro) (ветка по умолчанию, прочитано 25.10.2026) и сайт [brobro.tech](https://brobro.tech). Пометка **[допущение]** — то, чего я не нашёл в коде или доках; проверь, прежде чем строить на этом.

## 0. Контекст: что такое Bro сейчас

**Продукт.** «bro — твой последний ИИ-агент» ([brobro.tech](https://brobro.tech)). Вход через Telegram ([/sign-in](https://brobro.tech/sign-in)). Каналы, по [политике конфиденциальности](https://brobro.tech/privacy): веб-чат, Telegram, iMessage (Photon), звонки (МТС Exolve/ElevenLabs), своя почта (AgentMail). Поручения в браузере идут через Browser Use (open-source библиотека в своём worker), 2Captcha и резидентный прокси. Данные хранятся в Selectel (РФ), модели — через RouterAI/DeepInfra/RunInfra.
**Тариф (на бету не влияет)** по [оферте](https://brobro.tech/oferta): «Полный доступ» 2000 ₽ за 30 дней, до 500 сообщений в день и 60 браузерных поручений в месяц. В оферте у бесплатного режима стоит «1 000 000 сообщений/поручений», похоже на заглушку. В коде лимиты выключены (`USAGE_LIMITS=off`, README, раздел «Оплата и лимиты»), дефолты при включении: 30 сообщений в день и 5 поручений в месяц бесплатно, 500 и 60 платно. По `docs/roadmap.md` (12.10) открыта бета примерно на 10 человек. **Во время беты лимиты выключены и денег никто не платит**, поэтому оптимизируем скорость и надёжность, а не юнит-экономику.

**Архитектура (по коду):**

- Приложение: Next.js + eve (агентный рантайм) + мир Workflow в Postgres (graphile-worker) на VM `bro-app-sel-2`. Managed PG `bro-pg`, S3 `bro-bucket` (`docs/selectel-migration.md`, `docs/dev-notes.md`). **Сервер не трогать.** Бриф касается только кода и PR.
- Браузер: инструмент `browser_task` (`agent/tools/browser_task.ts`) → `agent/lib/browser-use/*` (очередь, согласия, траты, исход) → `agent/lib/browser-vm/*` (`runs.ts`, `worker.ts`, `backend.ts`, `pilot.ts`) → пул `agent/lib/browser-pool/*` → `hostd` на выделенном `bro-dedicated-3` (`BROWSER_HOST_CLOUD=static`, `BROWSER_HOST_RUNTIME=firecracker`). Каждому воркспейсу своя песочница (microVM) со своим профилем Chrome. При парковке профиль уходит в S3, зашифрованный от `BROWSER_STATE_KEY` (HKDF с id воркспейса); память восстанавливается из снимка на NVMe.
- Worker: `browser-vm/worker/worker.py`, библиотека browser-use 0.13.x (`Agent`, `ChatOpenRouter`, `Tools`), `use_vision` по умолчанию выключен. Есть свои действия (`enter_code`, `solve_captcha` через OpenCV и 2Captcha), прямой режим без агента (`/v1/sessions/<id>/open|state|action|screenshot`) и сегмент `jev-ultrafast` перед агентом (`engine: "jev-then-agent"`, `jev_segment.py`).
- Модель шага браузера: DeepSeek V4.1 Flash через RouterAI. `runTuning` (`agent/lib/browser-vm/runs.ts`) задаёт `maxActionsPerStep: 8` и `reasoning: none`; для поиска `flashMode: true`; в пилоте `fast` — Together первым и `llmTimeoutSeconds`.
- Browser Use Cloud в проде отключён (`BROWSER_USE_API_KEY` убран 15.10, `docs/dev-notes.md`). README про Cloud устарел.
- Флаги: `*_WORKSPACES` (id, email владельца или `*`) в `prod.json` через `host.py env`. Для браузера: `BROWSER_FAST_WORKSPACES`, `FLASH_SEARCH_WORKSPACES`, `ERRAND_AUTONOMY_WORKSPACES`, `BROWSER_VM_PROXY_FALLBACK`.
- Тесты и бенчмарки: `tests/agent/browser-use/*`, `tests/agent/browser-vm/*`, `browser-vm/worker/test_*.py`, `evals/agent/*.eval.ts`, `scripts/bench/*` (в том числе `errand-latency.ts`, `latency.ts`), `scripts/selectel-bench/*` (`bu_bench.py`, `steplat.py`), `scripts/cloudru-app-host/ops/browser-runs.sh` и `site-errands.sh`. Наборы `docs/benchmarks/{en,ru,files}`.

**Базовая линия скорости** (`docs/browser-speed.md`, 05–06.10):

- Поручение на проде до пилота: медиана 299 с, p90 654 с, 24 шага по 12,2 с, 2,69 ₽ на модель.
- Шаг занимает 6–12 с, из них LLM 70–85%.
- DeepSeek на Together во flash-режиме: 32–43 с на поиск, 2,9 с на шаг. Прод-настройка (DeepInfra, полный режим): медиана 121 с.
- Зависший вызов LLM ждал 75–90 с.
- Инфраструктура на прогретом хосте: около 5 с.
- Ozon блокирует окружение, Avito режет по IP, Госуслуги с IP Selectel не отвечают.

Эти цифры — исходная точка. Каждое изменение сравнивай с ними.

---

## 1. Быстрая модель на шаг и сильная для плана

**Источники.** Модель даёт около 90% скорости и стоимости ([пост](https://x.com/mamagnus00/status/2067108071089098977) (см. Приложение X-1)). BU 1.0: ~3 с на шаг ([блог](https://browser-use.com/posts/speed-matters) (см. Приложение W-1)).
**Что уже есть.** DeepSeek на шаг. Главный агент Бро планирует сам и формулирует `browser_task`. Роутер моделей task-агента (`agent/lib/model/router/`, `MODEL_ROUTER_WORKSPACES`) не включён. Замер хостов — таблица 2.1 в `browser-speed.md`.
**Пробел.** Хост и модель шага выбираются глобально. Нет эскалации внутри прогона (застряли → сильная модель на 1–2 шага). Нет сравнения конфигураций на бенчмарке по `browser_runs`.
**Что сделать.**

- В `runTuning` добавить «маршрут шага»: `primary` (DeepSeek на Together/RunInfra) и `rescue`. Rescue — GPT Luna, которая по `dev-notes` нужна для оформления заказов, или другая модель из таблицы 2.1. Worker переключает модель при N=2 подряд ошибках действий или при повторе того же URL и действия 3 раза. Это правка `worker.py`: browser-use позволяет пересоздать `Agent` с `injected_agent_state` (уже используется для продолжений).
- Добавить в `browser_runs` поля модели и хоста на каждый шаг, если их там нет **[допущение]**. Из них считать стоимость и латентность по модели.
  **Эксперименты.** Через флаг `BROWSER_STEP_ROUTE_WORKSPACES`, на бенчмарке (раздел 11) и трассах отдельных поручений: (a) прод, (b) Together+flash, (c) Together + эскалация на rescue.
  **Метрики.** p50/p95 шага, wall time поручения, success (исход в `outcome.ts`), ₽ на поручение и на пользователя, доля эскалаций.
  **Риски.** Rescue-модель дорогая (у Luna 0,08 ₽ на шаг — дёшево, но много отказов), а GPT Luna отказывается вводить карту. Rescue не должна получать платёжные шаги.
  **Готово, когда** на наборе RU-браузер медиана не больше 60 с, success не ниже прода, а стоимость не выше 0,2 ₽ на шаг.

## 2. Короткий вывод и ограниченное рассуждение

**Источники.** Выходной токен по времени примерно в 215 раз дороже входного ([блог BU](https://browser-use.com/posts/speed-matters)). `flash_mode` описан в [параметрах browser-use](https://docs.browser-use.com/open-source/customize/agent/all-parameters). Бюджет рассуждения — `thinking_token_budget` в [vLLM](https://docs.vllm.ai/en/stable/features/reasoning_outputs/) (см. Приложение W-5).
**Что уже есть.** `flashMode` только для поиска; полный режим пишет около 580 выходных токенов на шаг против 240 во flash (`browser-speed.md`). `maxActionsPerStep: 8` и `BATCH_HINT`. `reasoning: none` у DeepSeek.
**Пробел.** Flash иногда сдаётся раньше времени: на Маркете не дособрал ссылки. Для входа и оформления заказа используется полный режим. Короткий `llm_timeout` есть только в fast-пилоте.
**Что сделать.**

- Flash по умолчанию для всех шагов, кроме оформления заказа и оплаты. Признак брать из `submission` и `allowPayment` в `browser_task.ts`.
- Правило «не вызывай done, пока не выполнены критерии задачи» передавать в `EXTEND_SYSTEM` числом: например, «≥3 варианта со ссылками». Проверять в `completion.ts` и `outcome.ts` кодом.
- `llm_timeout` 25 с для всех моделей, у которых измерено, что нормальный шаг не дольше 18,5 с.
  **Эксперименты.** Flash на всё против текущего. Таймаут 25 с против 75–90 с. Одно действие за шаг против 8.
  **Метрики.** Выходных токенов на шаг, шагов на поручение, ранних `done` с `success=false`, хвост p95.
  **Готово:** p95 шага не больше 6 с, ранних отказов не больше, чем в полном режиме.

## 3. Текстовое состояние вместо скриншотов, плюс extract

**Источники.** Скриншот добавляет около 0,8 с на шаг ([блог BU](https://browser-use.com/posts/speed-matters)). [Снапшоты Playwright MCP](https://playwright.dev/mcp/snapshots) (см. Приложение W-3) с `browser_find` и поддеревом. Сериализатор DOM в browser-use: [serializer.py](https://raw.githubusercontent.com/browser-use/browser-use/HEAD/browser_use/dom/serializer/serializer.py).
**Что уже есть.** Vision выключен по умолчанию. Состояние страницы — DOM-сериализатор browser-use, около 20 тыс. токенов на маркетплейсе (`browser-speed.md` 2.1). Капчи решает worker, а не модель.
**Пробел.** 20 тыс. входных токенов на шаг на тяжёлых маркетплейсах. Сбор списков через `evaluate` занимает 6–12 шагов. Кэш префикса ломается, когда меняется история (комментарий в `worker.py` около `tuned_llm_options`).
**Что сделать.**

- Действие worker `collect_list(site)` с проверенным JS для карточек ключевых сайтов (Маркет, WB, Avito, Расписания, tutu, ostrovok): один вызов вместо 6–12 шагов. Связать с `site_guidance` (п. 26 роадмапа, см. #6 ниже).
- Скоуп состояния: на страницах поиска отдавать модели только контейнер результатов. В browser-use — свой фильтр перед сериализацией или `extract` по markdown **[допущение: надо проверить API 0.13]**.
- Порядок промпта «стабильная история → свежее состояние» и замер `prompt_cached_tokens` (поле уже собирается в worker).
  **Метрики.** Входных токенов на шаг, доля cached, шагов на поиск, success.
  **Готово:** входные токены на шаге поиска уменьшились минимум вдвое, шагов на поиск не больше 8.

## 4. Прямой CDP там, где нужна точность и скорость

**Источники.** Stagehand v3 на CDP стал на 44% быстрее ([пост](https://x.com/Stagehanddev/status/1983575368373354554) (см. Приложение X-2), [блог](https://browserbase.com/blog/stagehand-v3/)).
**Что уже есть.** browser-use и так работает через CDP. Worker сам вызывает CDP для `enter_code` (`Input.insertText` для кода WB), для 3-D Secure через фреймы (`agent/lib/browser-use/cdp.ts`, README «Browser Use Cloud»), для `closeChrome` перед парковкой. Есть прямой режим `/v1/sessions/<id>/action`.
**Пробел.** Детерминированные шаги (открыть URL поиска с фильтрами, ввести телефон, выбрать дату) всё равно проходят через LLM.
**Что сделать.** Использовать прямой режим worker как исполнитель скриптов: `initial_actions` browser-use (это параметр Agent) и `open` с готовым URL. `_extract_start_url` сейчас отдаёт `None`, если названы запасные сайты (`browser-speed.md` 3.4). Нужно открывать первый сайт без шага модели.
**Метрики.** Время до первого действия, шагов модели на поручение.
**Готово:** первый шаг без модели в 80%+ поручений с известным сайтом.

## 5. Кэш действий и путей (по намерению и хэшу DOM)

**Источники.** [Кэш Stagehand](https://browserbase.com/blog/stagehand-caching/) (см. Приложение W-2): sha256 от метода, URL, хэша DOM и параметров; переменные; промах при сомнении. [Документация v3](https://docs.stagehand.dev/v3/best-practices/caching).
**Что уже есть.** Кэша действий нет. Есть `browser_runs` с шагами, `steps.jsonl` и историей агента (`AgentState`).
**Что сделать.**

- Таблица `browser_action_cache`: `site`, `url_pattern`, `intent_template`, `var_keys`, `dom_fp`, `actions[]` (селектор, роль, имя), `hits`, `fails`, `scope = global | workspace`.
- **Мульти-юзер:** глобальные записи только для публичных страниц без логина (поиск, карточка). Для страниц за логином — только `workspace`. Значения переменных и ПДн в кэш не пишутся никогда, только ключи `%phone%` и `%date%`.
- В worker: перед вызовом LLM — `lookup` и, если похожесть выше порога T, исполнение через прямой режим и проверка результата. Иначе обычный шаг, затем запись.
- На необратимых действиях (`allowSubmit`, `allowPayment`) кэш только подсказывает: исполнение идёт через обычный путь с согласием.
  **Метрики.** Hit rate, wrong-hit rate (ожидаемый эффект не наступил), ускорение повторного поручения, отсутствие утечек между воркспейсами (тест).
  **Готово:** hit rate не меньше 50% на повторяющихся публичных сайтах, wrong-hit = 0 на отправках, есть тест, что запись одного воркспейса не видна другому.

## 6. Путь «API → HTTP → скрипт → агент» и site_guidance

**Источники.** [Browser Use Skills](https://x.com/browser_use/status/1998137713732759970) (см. Приложение X-3) и [блог о самообучении](https://browser-use.com/posts/web-agents-that-actually-learn) (см. Приложение W-6) (облачные Skills закрыты, рекомендуют перезапускаемые скрипты, см. [документацию](https://docs.browser-use.com/open-source/customize/skills/basics)). [derive-client](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/derive-client/SKILL.md) (см. Приложение W-7) (HAR → клиент). [WebMCP в Playwright](https://playwright.dev/docs/api/class-webmcp).
**Что уже есть.** Многое уже идёт через API: Яндекс Лавка, Еда и Go (`YANDEX_API_WORKSPACES`), ЮMoney, Timepad, YClients, Composio (Google и др.), посылки Почты России кодом (`subscriptions`), веб-поиск через Composio Instant. В `docs/agent-costs.md` §3.4 и `browser-speed.md` §5 отмечено, что лестницы и `site_guidance` нет (п. 26 роадмапа).
**Что сделать.**

- Таблица `site_guidance` по п. 26: вход, ловушки, URL поиска с сортировкой, селекторы карточек, путь до оплаты. В поручение передаётся только нужный сайт (`agent/lib/browser-use/guidance.ts`).
- `SkillDistiller` — фоновая задача по успешным `browser_runs`: черновик заметки или скрипта, который владелец ревьюит. Без ревью в прод не идёт.
- HTTP-скиллы только для публичных чтений (расписания, цены). С сессией пользователя — только после отдельного решения владельца: куки пользователя, ToS, CSRF.
  **Метрики.** Доля поручений без агентного браузера, шагов модели на поручение (сейчас около 60 по роадмапу), ₽ на поручение.
  **Готово:** d02, d04 и d05 RU-набора +2 балла (критерий п. 26), шагов меньше в 2 раза на сайтах с заметкой.

## 7. Параллелизм: аренда профиля и несколько вкладок

**Источники.** Субагенты Browser Use ускоряют в 3–5 раз ([пост](https://x.com/browser_use/status/2019185827969126411) (см. Приложение X-4)). Лимиты одновременных сессий как узкое место ([Steel](https://x.com/steeldotdev/status/1979340038300368922) (см. Приложение X-5)).
**Что уже есть.** Один профиль — один Chrome. Второе поручение воркспейса ждёт в очереди 60 с (`busyRetryMs`) до конца первого (`queue.ts`, `browser-speed.md` §6). «Ozon + WB + Маркет» идут по очереди. Память гостя 3 ГБ, были OOM из-за тяжёлых вкладок (`dev-notes` 24.10). Общий потолок хоста — около 19 ГБ, при превышении `hostd` отвечает 507.
**Что сделать.**

- П. 29 роадмапа: одна аренда на запись и несколько на чтение.
- Параллельные поиски — в отдельных вкладках того же Chrome (дешевле по RAM) или в эфемерной песочнице без профиля для публичных сайтов.
- Планировщик ёмкости на уровне пула: не больше K одновременных поручений на воркспейс, общий потолок по RAM хоста (`/v1/capacity`), справедливая очередь между пользователями (простой round-robin по воркспейсам; приоритетов нет, все тестеры равны).
  **Метрики.** Wall time сравнений, ожидание в очереди p95 по пользователям, OOM в журнале гостя, 507 от `hostd`.
  **Готово:** сравнение по 3 сайтам не дольше 1,3× одиночного поиска, OOM = 0 за неделю, у других пользователей p95 ожидания не вырос.

## 8. Тёплый браузер, логины, прокси, хвосты

**Источники.** Демон gstack: первый вызов около 3 с, дальше 100–200 мс ([ARCHITECTURE.md](https://github.com/garrytan/gstack/blob/main/ARCHITECTURE.md) (см. Приложение W-4)). Пулы и standby у [Kernel](https://www.kernel.sh/docs/introduction/create) (см. Приложение W-8). Профили [Steel](https://docs.steel.dev/overview/profiles-api/overview).
**Что уже есть.** Firecracker со снимком памяти (восстановление около 20 мс по `selectel-migration.md`), профиль на воркспейс в S3, `browser-prewarm` (`agent/hooks/browser-prewarm.ts`), вход по ссылке (`login-handoff`), прокси Geonode/NodeMaven с проверкой выхода (2,6 с после каждого восстановления).
**Пробел.** Проверка выхода прокси на каждом восстановлении. Шлюз Geonode во Франции (навигация 0,8–1,9 с, хвосты 35–73 с). Обнаружение конца прогона — слепое окно 15–20 с (тик раз в минуту и наблюдение раз в 4 с). Многоходовые поручения заново входят и ищут после парковки.
**Что сделать.**

- Push от worker о завершении в приложение по приватному маршруту вместо опроса (`browser-speed.md`, п. 7).
- Кэшировать результат проверки выхода на сессию прокси с TTL.
- Пилот прокси со шлюзом в РФ и прямой выход для сайтов, которые пускают IP дата-центра (Маркет, Расписания). Allowlist по домену.
- Не парковать песочницу между ходами одного поручения (код, оплата), пока ждём ответа человека, — с потолком в N минут.
  **Метрики.** Время от `browser_task` до первого действия, от `done` до сообщения человеку, навигация p95, релогины на пользователя в неделю.
  **Готово:** доставка итога не дольше 3 с после `done`, первое действие не позже 3 с.

---

## 9. Задачи, которые появляются из-за многих пользователей

- **Изоляция.** Профиль, куки, кэш действий, скиллы с сессией и HAR — строго по воркспейсу. `BROWSER_STATE_KEY` не менять. Тест: данные воркспейса A недоступны из B в кэше, `site_guidance` (только глобальные публичные заметки) и журналах.
- **Секреты.** Сейф уже устроен так: логины привязаны к origin, карта — только при одобренной оплате, worker подставляет значения, модель их не видит. Новые компоненты (кэш, скиллы, HAR) не должны сохранять значения. Добавить тест на отсутствие ПДн и секретов в `browser_action_cache` и `site_guidance`.
- **Подтверждения.** Не менять политику: платное — один вопрос «Оплачиваю?» с итогом (`ownTurnApproval`, `agent/lib/mode.ts`). Прямая покупка — только в пилоте `DIRECT_PURCHASE_WORKSPACES`. Кэш и скрипты не обходят `allowPayment` и `allowSubmit`.
- **Стоимость — метрика и потолок, а не ворота.** `usage_costs` и `spend.ts` уже есть. Отчёт «₽ на поручение» с разбивкой: модель, прокси (ГБ), капча, хост. Потолок трат одного прогона в `spend.ts` сохранить. Сравнивать с тарифом не нужно, пока нет платящих; регрессией считается только резкий рост ₽ на поручение относительно базы.
- **Антибот и лимиты сайтов.** Предел запросов к одному сайту в час на воркспейс и на весь сервис (п. 33 роадмапа). Липкая сессия прокси на воркспейс. При параллелизме — не больше 1 сессии на домен на пользователя.
- **Наблюдаемость.** OTel и evlog уже есть (`agent/instrumentation/`). Добавить спаны observe/llm/act/load на шаг, атрибуты `workspace`, `site`, `engine`, `flag_variant`. Дашборд по пользователю и сайту. Алерты в @opsalertbot1bot при росте p95 или отказов.
- **Выкатка — короткий цикл.** Каждое изменение — за флагом `*_WORKSPACES`: владелец → все тестеры (`*`), без промежуточных когорт. Тестеров около 10, поэтому A/B на трафике статистически почти ничего не скажет. Решения принимать по прогонам бенчмарка (раздел 11) до и после и по трассам конкретных поручений (`browser_runs`, `steps.jsonl`, `browser-runs.sh`). Вне пилота тело запроса к worker должно совпадать байт в байт (`runs.test.ts`), откат — убрать из списка. Цель — несколько итераций в неделю.
- **Регрессии.** `pnpm check` (unit, offline), `browser-vm/worker/test_*.py`, `evals/agent/*` (autonomy, permissions, privacy, safety), e2e пула (`pnpm test:e2e:browser-pool`), RU/EN-бенчмарки по `docs/benchmarks/README.md` с его правилами: не одобрять оплату и отправку, коды только вживую.

## 10. Фазы работ

1. **Фаза 0 — измерения (без изменений поведения).** Спаны на шаг, поля модели и хоста в `browser_runs`, отчёт `browser-runs.sh` по p50/p95, ₽ на поручение. Свежая база на Selectel и Firecracker (замеры 05.10 сняты ещё на Cloud.ru).
2. **Фаза 1 — хвосты и быстрые выигрыши.** Расширить пилот `BROWSER_FAST`: Together+flash, `llm_timeout` 25 с. Push итога, кэш проверки прокси, первый сайт без модели. Выкатка: владелец → все тестеры.
3. **Фаза 2 — меньше шагов.** `site_guidance`, `collect_list` для 6 ключевых сайтов, скоуп состояния, правило «критерии до done».
4. **Фаза 3 — эскалация модели и кэш действий** (публичные страницы глобально, остальное по воркспейсу) с тестами изоляции.
5. **Фаза 4 — параллелизм:** аренды на чтение, планировщик ёмкости и справедливости, лимиты запросов к сайтам.
6. **Фаза 5 — скиллы:** HTTP и скрипты для публичных чтений, затем решение владельца про сессии.

## 11. Бенчмарк (поверх `docs/benchmarks` и `scripts/bench`)

У каждого кейса есть `id`, текст, сайт, нужен ли логин, необратимость, программная проверка. Прогон: 3 раза холодно и 3 раза повторно. Необратимые шаги останавливаются на экране оплаты или подтверждения. Кейсы выведены из функций в роадмапе и на сайте; сверить с `ru/cases.json` **[допущение: точные id кейсов не сверял]**.

1. Поиск товара с потолком цены на Маркете (3 варианта со ссылками).
2. То же сравнение на Маркете, WB и Avito (параллелизм, антибот).
3. Ж/д билет на tutu.ru до экрана оплаты с местом у окна (п. 8 роадмапа).
4. Отель на ostrovok.ru на даты до X ₽ до экрана брони.
5. Расписание электричек и пригородных поездов (Яндекс Расписания), без логина.
6. Вход на WB по коду (shadow DOM, `enter_code`) и статус заказа.
7. Avito: открыть объявление и пройти слайдер GeeTest (`solve_captcha`).
8. Запись в салон через YClients (проверка, что выбран API, а не браузер).
9. Еда или Лавка через API (`YANDEX_API_*`) до вопроса «Оплачиваю?».
10. Услуга ЮMoney (пополнение телефона на 10 ₽) до подтверждения.
11. По письму в почте (Composio) — трек СДЭК на сайте перевозчика (браузер).
12. hh.ru: вакансии по фильтрам, 10 штук (тяжёлые вкладки, OOM-регрессия).
13. Госуслуги или mos.ru: дойти до экрана согласия ЕСИА (только с владельцем).
14. Скачать PDF-счёт из личного кабинета (`downloads.ts`).
15. Продолжение поручения после кода из SMS без повторного входа (п. 29, d18 после d05).

Метрики на прогон: wall time p50/p95, шагов, латентность шага по фазам, success по проверке, входные, выходные и cached токены, ₽ (модель, прокси, капча), hit и wrong-hit кэша, эскалации, ожидание в очереди, OOM и 507.

## 12. Открытые вопросы (то, что не решить из кода)

- Лимит одновременных поручений на одного тестера (нужен для потолка памяти хоста).
- Можно ли использовать куки пользователя для HTTP-скиллов (ToS, ответственность), или скиллы только публичные?
- Бюджет на прокси со шлюзом в РФ и на запасной хост пула если тестеров станет больше (сейчас один `bro-dedicated-3` с потолком ~19 ГБ).
- Доступ на чтение журналов и оценок бенчмарков, которые лежат вне репозитория, — нужен для сравнения с базой.
- Включать ли `jev-then-agent` шире: сравнений его скорости и success с агентом в документах я не нашёл.

_Примечание: во время беты лимиты выключены (`USAGE_LIMITS=off`); цифры «1 000 000» в оферте к работе не относятся._

---

## Приложение X. Источники из X: полное содержимое

У Opus нет доступа к X, поэтому посты приведены целиком. Получены через X API 25.10.2026. Время указано по Москве (UTC+3). Метрики — на момент получения. Видео не расшифровывались: о чём они, сказано со слов поста.

### X-1. @mamagnus00 (Magnus Müller, сооснователь Browser Use): модель — 90% скорости, vision +1 с на шаг

- URL: https://x.com/mamagnus00/status/2067108071089098977. Дата: 17.06.2026, 07:52 МСК. Метрики: 29 показов, 0 лайков, 1 ответ.
- Контекст ветки (вопрос, на который он отвечает), @Metroxe, 17.06.2026 05:05 МСК:
  > "@mamagnus00 @browser_use Been running my own benchmarks for personal use, mostly the 0.12.x Python lib on Gemini 2.5 Pro with vision off. Kept it vanilla so I'm comparing harnesses fair and not tuned. Haven't touched flash_mode or the BU models yet. What would you run for best speed/cost?"
- Промежуточный ответ @mamagnus00 (04:47 МСК): > "@Metroxe @browser_use which version do you use? We have some versions to optimize for speed + cost !"
- Пост:
  > "@Metroxe @browser_use the model makes 90% of speed and cost here.
  >
  > vision is not a big difference with google for cost, but it ads 1s in latency per step."
- Суть: на скорость и стоимость больше всего влияет выбор модели (около 90%). Включённый vision почти не меняет цену у Google, но добавляет около 1 с к каждому шагу.

### X-2. @Stagehanddev: Stagehand переписан на CDP, на 44% быстрее

- URL: https://x.com/Stagehanddev/status/1983575368373354554. Дата: 29.10.2025, 19:43 МСК. Метрики: 51 965 показов, 185 лайков, 15 репостов, 24 ответа, 92 закладки. Вложение — видео на 94 с (не расшифровывалось).
- Пост:
  > "We did a complete rewrite of Stagehand to run directly on CDP.
  >
  > By decoupling from Playwright, we're now 44% faster.
  >
  > Work with any automation framework, efficiently traverse iframes & shadow DOMs, and even auto-cache agentic workflows."
- Суть: Stagehand переписали с Playwright на прямой CDP. Заявлено ускорение на 44%, лучшая работа с iframe и shadow DOM, автокэш агентных сценариев. Подробности — в блоге v3 (Приложение W-9).
- Связанный ответ того же аккаунта про кэш (26.10.2025, https://x.com/Stagehanddev/status/1982526742809198853):
  > "Caching will work the same! Caching stores observe results, which contain the interaction method, element selector, and a description of the element."

### X-3. @browser_use: Skills — браузерные задачи превращены в API, «минуты → секунды»

- URL: https://x.com/browser_use/status/1998137713732759970. Дата: 09.12.2025, 00:08 МСК. Метрики: 13 309 показов, 144 лайка, 9 репостов, 9 ответов, 171 закладка.
- Пост:
  > "Last week, we shipped hundreds of Skills.
  >
  > Hundreds of browser tasks turned into APIs.
  > Task completion time from minutes → seconds.
  >
  > Agents are powerful but they're often slow, non-deterministic, and costly.
  > Skills fix that.
  >
  > Here are a couple of our favorites: 🧵"
- Ветка (тексты из того же API):
  > #1 "YouTube Filmography Scraper 📽️ Save thousands of YouTube videos in less than 30 seconds using this API"
  > #2 "Generate Song using Suno AI 🎤 Create a song in natural language with one API call"
  > #3 "Instagram Profile Posts Getter 📸 Generate a dataset all of a instagram profile's posts in 5 seconds using our skill"
  > #4 "YouTube Video to MP4 Downloader 🔄 Easily download whole YouTube videos using an API"
  > #5 "Spotify Playlist Exporter 🎵 For tasks you can't complete with Spotify API, you could easily create a skill for it. We created an API to get whole Spotify playlists."
- Механизм, по связанному посту @mamagnus00 (03.12.2025, https://x.com/mamagnus00/status/1996103199556862063):
  > "I stopped searching for APIs. I just generate them. This tool records the workflow once → reverse-engineers the HTTP calls → and gives me a reusable API. I built a YouTube-download API in under 1 minute. Paste URL → get the full video in 3 seconds."
- Суть: сценарий записывают один раз, восстанавливают по нему HTTP-запросы и дальше вызывают как API. Задача сокращается с минут до секунд. Сейчас облачные Skills у Browser Use закрыты для создания (Приложение W-6).

### X-4. @browser_use: субагенты дают ускорение в 3–5 раз на задачах с несколькими источниками

- URL: https://x.com/browser_use/status/2019185827969126411. Дата: 05.02.2026, 02:06 МСК. Метрики: 633 показа, 1 лайк, 1 ответ. Вложение — видео на 14 с.
- Начало ветки (https://x.com/browser_use/status/2019185824076820875; 4 589 показов, 34 лайка):
  > "We've been building the ultimate Slack bot with @openclaw and Browser Use! When a new user stars the browser-use repo, > Fetch their Github profile > Use Browser Use subagents to analyze their socials > Return a report and send an email to the user. Here's what Oracle can do 🧵👇"
- Пост (полный текст):
  > "2. OpenClaw could spin up Browser Use subagents
  >
  > Many browser tasks involve going through multiple sources and collecting data. Browser Use subagents make the process 3-5x faster!
  >
  > > Deploy multiple Browser Use subagents in parallel
  > > Easily observe their inputs, outputs, and traces from Browser Use Cloud!"
- Суть: задачи со сбором данных из нескольких источников раздаются параллельным субагентам, заявлено ускорение в 3–5 раз; входы, выходы и трассы видны в облаке. Цифра маркетинговая, методики замера нет.

### X-5. @steeldotdev: лимиты одновременных сессий — узкое место агентных нагрузок

- URL: https://x.com/steeldotdev/status/1979340038300368922. Дата: 18.10.2025, 03:13 МСК. Метрики: 3 765 показов, 25 лайков, 6 репостов, 5 ответов. Вложение — картинка (не читалась).
- Пост:
  > "Launch week → Day 05
  >
  > MORE BROWSERS
  >
  > We're doubling session concurrency limits across all Steel Cloud plans 🔥
  >
  > Run more agents in parallel without hitting rate limits.
  >
  > 🧵"
- Ветка:
  > "1/ New concurrency limits across all plans: • Hobby: 2 → 5 concurrent sessions • Starter: 5 → 10 concurrent sessions • Developer: 10 → 20 concurrent sessions • Pro/Startups: 50 → 100 concurrent sessions. More headroom to scale your agent workloads."
  > "2/ Concurrency limits are the bottleneck for agent workloads. When you hit your limit, new requests queue or fail. You're forced to build queuing logic or upgrade before you actually need the compute. Doubled limits give you more breathing room, at no extra cost."
  > "3/ Higher concurrency means: • Handle traffic spikes without queuing • Run batch jobs faster • Prototype new agents without hitting walls • Lower latency for end users in prod"
- Суть: когда лимит одновременных сессий исчерпан, запросы встают в очередь или падают. Для Бро это прямая аналогия с очередью воркспейса (`busyRetryMs` 60 с) и потолком памяти хоста.

---

## Приложение W. Ключевые выдержки из веб-источников

Цитаты дословные, на языке оригинала. Получены через exa 25.10.2026.

### W-1. Browser Use, «Speed Matters» (Gregor Zunic, 09.10.2025), https://browser-use.com/posts/speed-matters

> "In OnlineMind2Web, BU 1.0 agent completes tasks in 68 seconds on average. For context: Gemini 2.5 Computer Use: 225s; Claude Sonnet 4.5: 285s; Claude Sonnet 4: 295s; OpenAI Computer-Using Model: 330s … taking on average 3 seconds per step with our strongest model."

> "We solved this by placing agent history before the browser state in our prompt structure. This lets us cache the entire conversation history while presenting fresh browser state to the agent."

> "Most web navigation doesn't require vision … each screenshot adds ~0.8 seconds to LLM inference latency as the image encoder processes it."

> "BU 1.0 has an `extract` tool that queries page's markdown directly from the DOM … The `extract` tool runs a separate LLM call against the page markdown, retrieves only the relevant information, and returns it to the agent."

> "1,000 input tokens: 29.1ms; 10 output tokens: 62.6ms. Output tokens cost ~215x more time than input tokens per unit time … Action names and parameters are terse enough that most actions can be expressed in 10-15 tokens."

Параметры browser-use ([all-parameters](https://docs.browser-use.com/open-source/customize/agent/all-parameters)):

> "`max_actions_per_step` (default: `5`) … We execute the actions until the page changes." "`flash_mode` (default: `False`): Fast mode that skips evaluation, next goal and thinking and only uses memory."

### W-2. Browserbase, «How Caching Works in Stagehand (and Where It Breaks)» (24.02.2026), https://browserbase.com/blog/stagehand-caching/

> "Stagehand's Caching does this by caching the resolved selector for an action (not the whole agent), then validating the page still matches with high confidence before executing … performance improvements as high as ~80%, measured as % speedup across two sequential runs."

> "we take the structured cache-key components (method, normalized URL, DOM hash, project scope, plus a few method-specific fields), serialize them into a canonical string, then sha256 that string."

> "If this passive check detects drift … The request becomes a cache miss. Stagehand executes the action normally. Stagehand inserts a new cache entry … A wrong cached click is worse than a slow click."

> "What we cache: selectors, prompts, action configuration. What we do not cache: Passwords, API keys, or any other sensitive information."

> "caching breaks down on pages that do not repeat cleanly … URLs that are randomized or overly parameterized can defeat normalization."

Из [документации v3](https://docs.stagehand.dev/v3/best-practices/caching):

> "The cache key is built from the variable keys, not the values — so `{ email: "alice@example.com" }` and `{ email: "bob@example.com" }` share the same entry."
> "pass a `selector` to scope the accessibility tree snapshot to that container … changes outside the container don't affect the cache key." "Fixed viewport size … Block noisy third-party requests."

### W-3. Playwright MCP, Snapshots, https://playwright.dev/mcp/snapshots

> "Playwright MCP uses accessibility snapshots instead of screenshots. Every tool that interacts with the page returns a structured tree of accessible elements with refs for interaction."
> "`browser_find` searches the current page's snapshot and returns only the matching nodes plus a few lines of surrounding context."
> "If a ref is stale, the tool fails with `Ref not found in the current page snapshot.`"
> Вывод таблицы: снапшоты — "Token cost: Low — text only", скриншоты — "High — image tokens"; vision mode — "only when the accessibility tree doesn't cover your use case" ([vision-mode](https://playwright.dev/mcp/vision-mode)).

### W-4. gstack, ARCHITECTURE.md, https://github.com/garrytan/gstack/blob/main/ARCHITECTURE.md

> "if every command cold-starts a browser you wait 3-5 seconds per tool call, and if the browser dies between commands you lose cookies, tabs, and login sessions. So gstack runs a long-lived Chromium daemon that the CLI talks to over localhost HTTP."
> "First call starts everything (~3s). Every call after: ~100-200ms."

### W-5. vLLM, Reasoning Outputs, https://docs.vllm.ai/en/stable/features/reasoning_outputs/

> "Once the reasoning token count reaches the configured `thinking_token_budget`, vLLM forces the model to produce `reasoning_end_str`, effectively terminating the reasoning block."
> Пример запроса: `"thinking_token_budget": 10` в `/v1/chat/completions`. В `ChatCompletionRequest` также есть `reasoning_effort` ("none" … "max").

### W-6. Browser Use, «Web agents that actually learn» (05.04.2026), https://browser-use.com/posts/web-agents-that-actually-learn; документация Skills

> "Every web agent task has two phases. Exploration … Exploitation … After a task completes, a second agent reviews the full trajectory and asks: 'What would you need to know to solve this in 1-3 calls?' It extracts a skill - a URL pattern, a recipe, and the number of steps a future agent can skip."
> "We're building HTTP-level skills next. The skill agent observes HTTP traffic during a task reverse engineers the underlying API, and saves the raw request."
> Из [документации Skills](https://docs.browser-use.com/open-source/customize/skills/basics): > "Skills are retired: existing skills still run, but new ones can no longer be created … for new work use rerunnable scripts."

### W-7. vercel-labs/agent-browser, derive-client, https://github.com/vercel-labs/agent-browser/blob/main/skill-data/derive-client/SKILL.md

> "Driving a browser is the right tool for the first visit and the wrong tool for the hundredth."
> Процесс: "1. Record (HAR) 2. Identify endpoints 3. Extract shapes and auth 4. Generate the client 5. Verify."
> "If the site needs login, log in before starting the HAR so credentials don't land in the recording unnecessarily." "HAR files contain live session credentials … Treat them like secrets." "403/419 on writes — CSRF token is per-session … keep that flow browser-driven."

### W-8. Kernel, Create, https://www.kernel.sh/docs/introduction/create

> "Kernel browsers are sandboxed Chromium instances that boot in under 30ms." "A browser pool holds browsers that are already booted with your configuration applied, so `acquire` hands you one that's ready to drive." "After five seconds with none of those active, it enters standby — state is preserved, billing stops."

### W-9. Browserbase, «Stagehand v3: Faster AI Automation, No Playwright» (29.10.2025), https://browserbase.com/blog/stagehand-v3/

> "v3 now automatically caches discovered elements and actions that you can reuse without any additional LLM inference cost or time, and intelligently involves AI when workflows break … Its new context builder reduces token waste by feeding models only what's essential."

### W-10. Steel, Profiles, https://docs.steel.dev/overview/profiles-api/overview

> "Profiles work by storing a snapshot of the browser's User Data Directory." "the strongest setup is usually one profile plus one dedicated IP per account." Из [cookbook](https://docs.steel.dev/cookbook/profiles): "One profile per identity … Sharing a profile across accounts means one session's writes overwrite another's state on release."
