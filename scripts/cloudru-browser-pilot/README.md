# Пилот браузера Бро на Cloud.ru

Этап 1 из `docs/browser-cloud-migration.md`: свой Chrome на VM Cloud.ru
Evolution, два self-host-исполнителя — `jev-ultrafast` и open-source
`browser-use` — без Browser Use Cloud. Скрипты — тестовый стенд, не код Бро.

| Файл               | Что делает                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `vm.py`            | Сторона оператора: группа безопасности, VM, ожидание готовности, ключи, раннеры, команды, питание                |
| `cloud-init.yaml`  | Шаблон user data: хеш управляющего токена, `control.py` и `provision.sh` (ключей в нём нет)                      |
| `provision.sh`     | Первая загрузка: эндпоинт, Caddy на `<ip>.sslip.io`, Chrome в Xvfb как сервис, uv, jev, browser-use              |
| `control.py`       | Эндпоинт на `127.0.0.1:8080` за Caddy: `/health`, `/exec`, `/jobs`, `/files`; bearer-токен, на VM — лишь его хеш |
| `suite.py`         | Набор на каждую загрузку VM: готовность CDP, сеть из РФ, профиль, задачи; JSON в `$RESULTS_DIR/boot-<n>.json`    |
| `jev_run.py`       | Один ограниченный запуск jev-ultrafast (venv репозитория jev, commit `1231850`)                                  |
| `bu_agent_run.py`  | Автономный `browser_use.Agent` 0.13.10 на локальном Chrome через CDP                                             |
| `bu_direct.py`     | Прямой режим: `BrowserSession.get_browser_state_summary()` без `Agent.run()`                                     |
| `persist.py`       | Метка в cookie и localStorage: следующий запуск читает метку прошлого (проверка stop/start)                      |
| `bu_remote_run.py` | Агент browser-use вне VM на её Chrome через CDP (`vm.py cdp`); `--skill` дописывает скилл в системный промпт     |
| `skill_ab.py`      | Задачи на выгрузку списков без скилла и со скиллом через `bu_remote_run.py`                                      |

Состояние оператора (токен, id VM, IP) — в `$PILOT_STATE_DIR` вне репозитория.
Порядок: `vm.py create` → `vm.py secrets` → `vm.py runners` →
`vm.py job suite '<source /etc/bro/secrets.env; suite.py>'` → `vm.py power off|on`
→ второй прогон `suite.py` (метка профиля и короткие задачи).

Модели OpenRouter из VM не ответят (403): `vm.py cdp` открывает CDP через Caddy по
секретному пути, и агент `bu_remote_run.py` работает там, где OpenRouter доступен.

Всё только на чтение: поиск без входа, без отправки форм и оплаты.

## Окружение раннеров

- Chrome с `--remote-debugging-port=9222 --user-data-dir=<постоянный профиль>`
  (на VM — Xvfb и `google-chrome`, не headless; `provision.sh`), `BU_CDP_URL=http://127.0.0.1:9222`,
  `BH_UPDATE_CHECK=0`, `ANONYMIZED_TELEMETRY=false`, `BROWSER_USE_CLOUD_SYNC=false`.
- jev: `TYPESAFE_API_KEY` (ключ JEV), `TYPESAFE_MODEL=jev-latest`,
  `TEXT_MODEL_API_KEY` = ключ OpenRouter, `TEXT_MODEL_BASE_URL=https://openrouter.ai/api/v1`,
  `TEXT_MODEL=inception/mercury-2.5`, `TEXT_MODEL_REASONING=none`.
- browser-use: `OPENROUTER_API_KEY`, модель `openai/gpt-5.6-luna` (та же, что у
  Бро в Browser Use Cloud). На `deepseek/deepseek-v4.1-flash` через OpenRouter
  шаг агента не укладывался в 90 с.
- С VM OpenRouter недоступен (403): `ROUTERAI_API_KEY` у `vm.py secrets` задаёт
  на VM `TEXT_MODEL_*` и `BU_LLM_BASE_URL`/`BU_LLM_API_KEY` для RouterAI
  (`PILOT_TEXT_MODEL`, по умолчанию `deepseek/deepseek-v4.1-flash`). Полный
  повтор набора — `SUITE_FULL=1`, модели агента — `BU_AGENT_MODELS` через
  запятую; расход модели за шаг — `llm_spent`.

## Cloud.ru Evolution API (проверено 28.09.2026)

- Токен: `POST https://iam.api.cloud.ru/api/v1/auth/token` с
  `{"keyId": CLOUDRU_KEY_ID, "secret": CLOUDRU_KEY_SECRET}`.
- Проект: `GET https://organization.api.cloud.ru/v1/customers`, затем
  `GET /v1/projects?customer_ids=<id>` (без фильтра API отвечает ошибкой).
- VM: `POST https://compute.api.cloud.ru/api/v1.1/vms`, тело — **массив**.
  Поля: `project_id`, `name`, `availability_zone_name` (`ru.AZ-3`),
  `flavor_name` (`gen-2-4` — 2 vCPU/4 ГБ 1:1), `image_name` (`ubuntu-22.04`),
  `disks: [{name, size, disk_type_name: "SSD"}]`,
  `interfaces: [{type: "regular", subnet_name: "Default_ru.AZ-3", new_external_ip: true, security_group_names: [...]}]`,
  `cloud_init` — строка **в base64** (сырой YAML — 422 «Cannot decode cloud init
  template from base64»). Лишние поля API отвергает с `extra_forbidden` — так
  удобно узнавать схему.
- Группа безопасности: `POST /api/v1/security-groups` без правил, правила —
  отдельно в `/api/v1/security-groups/{id}/rules` (`port_range: "443:443"`).
- Питание: `POST /api/v1/vms/{id}/set-power` с `{"state": "power_off" | "power_on" | "reboot"}`
  (ответ 204; состояния `stopping` → `stopped`); удаление: `DELETE /api/v1/vms/{id}`.
- Расход: `GET https://organization.api.cloud.ru/v1/consumption?agreement_id=…` с
  `start_date=…T00:00:00Z&end_date=…` **и** `start_date_msk.year/month/day`,
  `end_date_msk.…` (без любой из пар — 400). `agreement_id` —
  `GET /v1/agreements?customer_id=…`. Баланса в API нет; расход отстаёт на
  десятки минут.

## Итоги

На VM Cloud.ru (28.09.2026) — `docs/browser-cloud-migration.md`, раздел 12:
OpenRouter, OpenAI и Anthropic отвечают адресам Cloud.ru 403; через RouterAI jev
прошёл поиск в Википедии за 3–5 с, агент browser-use на DeepSeek V4.1 Flash —
4 из 5 задач (Ozon не пускает адрес Cloud.ru); TypeSafe ≈ 0,3 с на решение;
прямой режим работает везде, кроме Ozon. Создание → готовый браузер
231 с, включение → готовый браузер 47 с, профиль переживает stop/start.

До VM, на локальной форме «Откуда/Куда/Найти» в песочнице: jev — 2,7 с
(3 действия, 4 решения TypeSafe, 2 вызова helper); browser-use Agent на luna —
14 с (5 шагов); снимок состояния в прямом режиме — 30–50 мс.
