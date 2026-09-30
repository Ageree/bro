# Браузерная инфраструктура: заметки для агентских сессий

Продолжение `docs/dev-notes.md` для тех, кто трогает `browser-vm/`,
`agent/lib/browser-vm/`, `agent/lib/browser-pool/`, Cloud.ru или стенды
(`scripts/cloudru-browser-pilot/`, `scripts/cloudru-sandbox-probe/`). Правила
ведения — те же, что в `docs/dev-notes.md`: неочевидный факт, почему так, путь;
устаревшее правьте или удаляйте. Этот файл в каждую сессию не загружается.

Планы и итоги проверок: VM на воркспейс — `docs/browser-cloud-migration.md`
(раздел 12), пул песочниц на общих хостах — `docs/browser-pool.md`. Сторона VM —
`browser-vm/` (worker, образ, хост пула), пилотный стенд —
`scripts/cloudru-browser-pilot/`.

## Cloud.ru: ключи, Compute API, квоты, выход в сеть

- Ключ Cloud.ru — `CLOUDRU_KEY_ID`/`CLOUDRU_KEY_SECRET` (облачное окружение
  сессий и Vercel `bro-next`, prod и preview). Из облачной сессии наружу только
  HTTPS:443, и её прокси показывает сбой TLS апстрима (нет сертификата,
  самоподписанный) как таймаут: VM — только за Caddy с Let's Encrypt.
- Compute API: `POST /api/v1.1/vms` — массив, `cloud_init` — base64; v1.1
  требует новый диск, VM с существующего загрузочного — только `POST /api/v1/vms`,
  и cloud-init на таком диске заново не отрабатывает. Образ — только из
  отсоединённого диска, зоны — объекты, состояние образа — в
  `availability_zones[].state`. Полная схема — ссылка в README стенда.
- STOP не освобождает vCPU/RAM квоты (8 vCPU по умолчанию — 4 VM `gen-2-4`),
  освобождает только удаление. `DELETE` VM всегда удаляет загрузочный диск, а
  публичный IP — только если он назван в `delete_attachments.external_ips`.
  Отпущенный IP Cloud.ru сразу отдаёт другой VM, и её worker отвечает на
  неподписанный `/v1/health`: поэтому перед поручением Бро сверяет с Cloud.ru,
  что VM из записи жива и на том же адресе (`readyForErrand` в `lifecycle.ts`).
- Первая загрузка новой VM иногда встаёт в `(initramfs)` (порт 443 молчит) —
  лечит `set-power reboot`; изредка VM зависает в `creating`, и её нельзя
  удалить (`vm_can_not_be_deleted_from_current_state`). Первые VM из нового
  образа готовятся ≈ 6 минут, дальше ≈ 1 минута: `build.py` прогревает образ.
- Горячее подключение диска, который ещё восстанавливается из бэкапа (он
  `available` раньше, чем кончилась задача), кончается `error`, но диск
  остаётся подключён, и VM может загрузиться с него: загрузочные диски вторыми
  не подключайте. Профиль с другой VM Chrome не откроет из-за `SingletonLock`
  со старым именем хоста — юнит Chrome в образе снимает его перед стартом.
- Фильтр `name` у `GET /api/v1/vms` ищет подстроку (`bro-x-1` находит
  `bro-x-10`): точное совпадение — в `findCloudRuVmByName`.
- VM без публичного IP в интернет не выходит, а sNAT подключается ко всей зоне
  сразу: в зоне с продовыми VM не создавать. S3: ключ —
  `<CLOUDRU_S3_TENANT_ID>:<CLOUDRU_KEY_ID>`, регион `ru-central-1`; без
  верного tenant — `NoSuchTenant`; скачивание частями в 4 потока в 3–4 раза
  быстрее одного.
- `set-password` Compute API без гостевого агента (стоковый образ) — 422;
  в консоль пробной VM входить с паролем из cloud-init (`console.py` стенда).
- С VM Cloud.ru 30.09 GitHub, PyPI, openrouter.ai и Википедия принимали TCP и
  молчали (днём GitHub уже отвечал: выход непостоянен), `archive.ubuntu.com`
  не отвечал: `build.py` (uv и jev с GitHub) так не соберёт образ. Обход —
  `mirror.yandex.ru` и зеркало PyPI со сверкой хэшей (`scripts/cloudru-sandbox-probe/vm/wheels.sh`, ставит только по пинам
  `verify_wheels.py`). Молчащий адрес вешает browser-use после `done` (цены
  моделей) и на старте (проверка версии на PyPI — `BROWSER_USE_VERSION_CHECK`):
  выход песочницы — `REJECT`, не `DROP`.

## VM на воркспейс (`agent/lib/browser-vm/`)

Файлы без пути — в `agent/lib/browser-vm/`.

- Своя VM в Бро — `agent/lib/browser-vm/`; `client.ts` уводит туда всё по
  префиксу id `vm:` (профиль `vm:<ws>:p<поколение>`), так что backend закреплён
  за поручением. В id воркспейса есть двоеточие (`personal:<hex>`): id VM
  разбирайте с конца (`ids.ts`). Кому VM — `BROWSER_BACKEND` и пилотный
  `BROWSER_VM_WORKSPACES` (id или email владельца). У входа по телефону email
  служебный (`phone-…@local-vault.invalid`): такому аккаунту пишите id
  воркспейса: `personal:` + первые 32 hex SHA-256 от `better-auth:<id пользователя>`
  (`agent/channels/eve.ts`, `accessScopeForUser`). Env Vercel действует лишь со следующего
  деплоя. Своих образов в проекте — не больше двух: старые удаляйте до сборки.
- `settledFloatingIpId` (`lifecycle.ts`) ждёт адрес поллингом, только если его
  правда не с чем сравнить: `giveUpAbandoned`/`giveUp` берут уже прочитанный
  `cloud` вызывающего (`bringUp`), а не читают VM заново — повторное чтение
  без паузы отвечает тем же «ещё нет» и просто съедает попытку settle вхолостую.
- Простой VM по тому, кто разбудил: `stop_not_before` null — окно человека по
  `last_used_at`. Фоновое поручение пишет срок до старта (старт трогает
  `last_used_at` и продлил бы окно человека), но не при идущем поручении
  человека: снимок заморозил бы его окно (`idle.ts`, `stopIfIdle`).
- Код worker на живых VM Бро меняет сам: `BROWSER_VM_WORKER` (публикует
  `browser-vm/worker/publish.py`), выкат перед поручением — `rollout.ts`,
  только вперёд по `VERSION`. `/v1/admin/worker` берёт только `worker.py`, а
  его `LOAD_CHECK` не видит ленивых импортов: новый ленивый импорт —
  в `CANDIDATE_IMPORTS`. Неудачная версия пишется в `worker_failed_version` и
  на той VM не повторяется — чините новой версией.
- Вектор токена worker общий у `browser-vm/worker/test_worker.py` и
  `tests/agent/browser-vm/token.test.ts`: меняйте формат в обоих.

## Worker, модели и сайты

- Модели из РФ: OpenRouter, OpenAI и Anthropic отвечают 403, RouterAI
  (`routerai.ru/api/v1`, `GET /key` как у OpenRouter) работает; luna через
  RouterAI ломает JSON шага — агент на `deepseek/deepseek-v4.1-flash`. Ключ
  Foundation Models Cloud.ru — отдельный: ключ доступа даёт лишь список моделей.
- Steel Cloud из Cloud.ru нестабилен (Cloudflare); его капчи и прокси — только
  при ≥ $10 купленного баланса; self-host steel-browser окна не даёт и на Avito
  хуже нашего Chrome.
- Прокси Geonode: логин с любым `-session-<id>` — своя sticky-сессия,
  `lifetime` до 1440; выход меняется и внутри сессии и бывает медленным
  (Махачкала: страница WB 25–73 с) — проверяйте его перед задачей. WebRTC
  закрывает только политика Chrome `WebRtcIPHandling`.
- Ozon не пускает само окружение (Chrome на Linux в VM) — не поддерживается;
  Wildberries и Avito проходят через домашний прокси. rzd.ru — корень НУЦ,
  владелец решил ему не доверять. Агент «находил» сайт в web.archive.org —
  worker закрывает архивы и кэши и отдаёт итоговый адрес.
- Вход WB — на `id.wb.ru` (WB ID) в shadow DOM: телефон, привязанный к
  `wildberries.ru`, туда не подставлялся; код, набранный по ячейкам, путался
  (365578 → 336655). Работает фокус на `autocomplete=one-time-code` и один
  `Input.insertText` (действие `enter_code` worker).
- browser-use проверяет срок запуска только между шагами: запуск, застрявший
  в шаге, держал worker занятым часами. Предел держит worker (`bounded`,
  `cut_off` в `worker.py`), а не browser-use.
- Стена Avito — слайдер GeeTest v4 за кнопкой «Продолжить»: его решает worker
  (`solve_captcha`: вырез по картинкам пазла в OpenCV, запасной — 2Captcha с
  `BROWSER_VM_TWOCAPTCHA_API_KEY`). Модели со зрением через RouterAI мажут
  (qwen 1 из 6), DeepSeek там картинку не получает вовсе.
- «Доступ ограничен: проблема с IP» Avito — счётчик запросов с адреса, не
  среда: gVisor вердикт WB и Avito не менял.

## gVisor и стенд песочниц

- В VM Evolution виден `/dev/kvm` (`nested=Y`), но поддержка (30.09):
  вложенной виртуализации нет, пользоваться нельзя — Firecracker только на
  Bare Metal. Без KVM замораживает Chrome gVisor (`runsc checkpoint`), но не в
  сети хоста: только свой netns. Потоки `runsc restore` — в файл, не в пайп,
  иначе ждёт вечно. Стенд — `scripts/cloudru-sandbox-probe/`.
- Снимок gVisor с нашим образом встаёт на другой VM и в netns с другим
  адресом, но `runsc` забирает адреса netns себе: netns — новый на каждый
  старт и restore. `root.readonly` в OCI — `false` (с ним `--overlay2` не
  спасает), закрепляется пакет `runsc` целиком (`/usr/bin/gvisor-bin`).
  Итоги этапа 1 и решение «обычные контейнеры» — `docs/browser-pool.md`.

## Хост пула (`browser-vm/host/`)

- Хост пула — `browser-vm/host/`. Его тестам нужен cryptography, а системный
  пакет облачной сессии падает паникой pyo3: ставьте свой
  (`pip install --ignore-installed cryptography cffi`). `nftables.service`
  Ubuntu делает `flush ruleset`: на хосте он выключен, таблицу ставит `hostd`.
  aiohttp перекодирует presigned URL (`%2F` → `/`, `%3A` → `:`), и подпись S3
  не сходится: только `yarl.URL(url, encoded=True)` (`sets.transfer`).
- Хост пула не ходит на GitHub и PyPI: Caddy и колёса `hostd` едут в бандле
  (`boot.py vendor`), пины — `vendor.json` и `requirements.txt` (колёса под
  Python 3.10 Ubuntu 22.04; `pip download --python-version` не видит маркеров
  3.10 — `async-timeout` вписан руками). Новая зависимость — перепин с sha256.
- Worker на хосте пула живёт за Caddy под `/g/<id>/`: адреса CDP-сокетов он
  строит с префиксом из `X-Forwarded-Prefix` (`browser-vm/host/caddy.py`),
  без него они вели в 404. `oomScoreAdj` `runc` — пол для всех процессов
  песочницы: при 500 Chrome не мог дать рендерерам свои 300+ (EACCES), теперь 200. Публичный IP своего хоста из песочницы — таймаут, не отказ: Cloud.ru не
  разворачивает трафик на свой плавающий IP, поэтому `provision.sh` кладёт его
  в `egress_blocked`. Итоги этапа 2 — `docs/browser-pool.md`.
- `hostd` не делает `runc exec` в песочницу (вход побегов `runc`): парковка —
  SIGTERM init, «Chrome убит по таймауту» init пишет в `runtime.log`. Профиль
  Docker для seccomp не годится (режет user namespace песочницы Chrome) — свой
  `browser-vm/host/seccomp.json`. `kernel.unprivileged_userns_clone` у ядра
  Ubuntu нет, `sysctl -e` молча его пропускает. Запуски и память агента
  worker парковку `runc` не переживают: в наборе только профиль.
- SIGTERM Chrome считает концом сеанса (`exit_type: SessionEnded`): cookie
  последних 30 с не пишет и оставляет `BrowserMetrics/*.pma` по 4 МиБ.
  Поэтому перед парковкой `runc` worker закрывает Chrome через CDP
  (`closeChrome`), а `hostd` не пакует `BrowserMetrics` (`LEFT_OUT_OF_SETS`).
- Код пула на настоящих хостах — `pnpm test:e2e:browser-pool`
  (`tests/e2e/`, `vitest.e2e.config.ts`, вне `pnpm check`; команда —
  `docs/browser-pool.md`, раздел 10). vitest без TTY печатает вывод теста
  только при падении: ход прогона — в файле итогов. Выкат worker на VM из
  образа — `tests/e2e/worker-rollout.e2e.ts` (команда — в его шапке).

## Пул в Бро (`agent/lib/browser-pool/`)

- 30.09 вечером зона `ru.AZ-3` в проекте Cloud.ru выключена (`enabled: false`;
  в `/v1/availability-zones` её уже нет): создание любой VM с умолчаниями
  `CLOUDRU_ZONE`, `CLOUDRU_SUBNET` (`Default_ru.AZ-3`) и группой `bro-browser`
  (тоже в AZ-3) — 422 `wrong_az_by_name`. Пока не заведены подсеть и группа
  безопасности в `ru.AZ-1`/`ru.AZ-2` и три env Vercel, ни хост пула, ни VM
  пилота не создаются.

- Пул в Бро — `agent/lib/browser-pool/` (S3-подпись, ключи, клиент `hostd`,
  хосты); включается только `BROWSER_POOL_WORKSPACES` или `BROWSER_BACKEND=pool`
  (`browserPoolConfigured`); `runc` — только явным `BROWSER_HOST_RUNTIME`, без
  него пул как до настройки (`runsc` с выпуском). Хосты — слоты `bro-host-1…<BROWSER_HOST_MAX>`
  (префикс — `BROWSER_HOST_NAME_PREFIX`): первичный ключ `browser_hosts` не
  даёт создать лишний. Cloud-init хоста в TS байт в байт как
  `boot.py cloud-init`: тест `hosts.test.ts` запускает `python3 boot.py` и
  сравнивает весь документ — правка `boot.py` без правки TS валит `pnpm check`.
  Под `runc` набор без снимка (`format: null`) поднимается как `profile`.
  Сторож пула не ждёт `browserPoolConfigured`: хосты стоят денег, пока не
  удалены, и убираются, пока есть хоть один. Набор отбрасывается только при
  вине самого набора (`setFaultPattern` в `sandbox.ts`): 502 Caddy или runsc
  раньше стирали входы человека.
- Песочница пула — та же запись `browser_vms`: `state` зеркалит
  `sandbox_state`, чтобы запуски и очередь читали её как VM; «есть машина» —
  `vm_id` или `host_id` (`runs.ts`). Воркспейс со своей VM остаётся на ней
  (`inBrowserPool`); VM, которой нет в Cloud.ru ни по id, ни по имени,
  передаётся пулу (`handOverGoneVm`): пилот мог остаться с записью удалённой
  VM, а прежний путь создал бы ему новую. Запись с `sandbox_state`, но без `host_id` worker не зовёт:
  адрес удалённого хоста уже чужой (`origin` в `worker.ts`).
- Presigned S3 Cloud.ru (PUT, GET, листинг, DELETE) работают из облачной
  сессии.
- `BROWSER_STATE_KEY` не меняйте никогда: наборы в S3 шифруются ключом от него
  (HKDF с id воркспейса), и после смены все запаркованные наборы нечитаемы.
- Env пула в Vercel `bro-next` (prod и preview) задан 30.09:
  `BROWSER_STATE_BUCKET`, `BROWSER_STATE_KEY`, `CLOUDRU_S3_TENANT_ID`,
  `BROWSER_HOST_BUNDLE`, `BROWSER_SANDBOX_ROOTFS`, `BROWSER_HOST_RUNTIME=runc`,
  там же `BROWSER_VM_WORKER`. Пул выключен, пока не задан
  `BROWSER_POOL_WORKSPACES` (id воркспейса или email владельца); включается со
  следующего деплоя.
