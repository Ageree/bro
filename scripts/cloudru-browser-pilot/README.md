# Пилот браузера Бро на Cloud.ru

Этап 1 из `docs/browser-cloud-migration.md`: свой Chrome на VM Cloud.ru
Evolution, два self-host-исполнителя — `jev-ultrafast` и open-source
`browser-use` — без Browser Use Cloud. Скрипты — тестовый стенд, не код Бро.

| Файл              | Что делает                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `suite.py`        | Набор на каждую загрузку VM: готовность CDP, сеть из РФ, профиль, задачи; JSON в `$RESULTS_DIR/boot-<n>.json`             |
| `jev_run.py`      | Один ограниченный запуск jev-ultrafast (venv репозитория jev, commit `1231850`)                                           |
| `bu_agent_run.py` | Автономный `browser_use.Agent` 0.13.10 на локальном Chrome через CDP                                                      |
| `bu_direct.py`    | Прямой режим: `BrowserSession.get_browser_state_summary()` без `Agent.run()`                                              |
| `persist.py`      | Метка в cookie и localStorage: следующий запуск читает метку прошлого (проверка stop/start)                               |

Всё только на чтение: поиск без входа, без отправки форм и оплаты.

## Окружение раннеров

- Chrome с `--remote-debugging-port=9222 --user-data-dir=<постоянный профиль>`
  (на VM — Xvfb и `google-chrome`, не headless), `BU_CDP_URL=http://127.0.0.1:9222`,
  `BH_UPDATE_CHECK=0`, `ANONYMIZED_TELEMETRY=false`, `BROWSER_USE_CLOUD_SYNC=false`.
- jev: `TYPESAFE_API_KEY` (ключ JEV), `TYPESAFE_MODEL=jev-latest`,
  `TEXT_MODEL_API_KEY` = ключ OpenRouter, `TEXT_MODEL_BASE_URL=https://openrouter.ai/api/v1`,
  `TEXT_MODEL=inception/mercury-2.5`, `TEXT_MODEL_REASONING=none`.
- browser-use: `OPENROUTER_API_KEY`, модель `openai/gpt-5.6-luna` (та же, что у
  Бро в Browser Use Cloud). На `deepseek/deepseek-v4.1-flash` шаг агента не
  укладывался в 90 с.

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
  `cloud_init` (строка). Лишние поля API отвергает с `extra_forbidden` — так
  удобно узнавать схему.
- Группа безопасности: `POST /api/v1/security-groups` без правил, правила —
  отдельно в `/api/v1/security-groups/{id}/rules` (`port_range: "443:443"`).
- Питание: `POST /api/v1/vms/{id}/set-power`; удаление: `DELETE /api/v1/vms/{id}`.

## Итоги на локальной форме (песочница, не Cloud.ru)

Форма «Откуда/Куда/Найти»: jev — 2,7 с (3 действия, 4 решения TypeSafe,
2 вызова helper); browser-use Agent на luna — 14 с (5 шагов); снимок состояния
в прямом режиме — 30–50 мс. На VM прогон ещё не делался.
