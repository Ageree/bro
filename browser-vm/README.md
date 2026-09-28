# Браузерная VM Бро в Cloud.ru

Своя среда браузера для каждого воркспейса вместо Browser Use Cloud: VM Cloud.ru
Evolution с Chrome (окно в Xvfb, постоянный профиль), агентом browser-use
0.13.10 и типизированным сервисом `worker/worker.py`. Общий Бро на Vercel
создаёт, включает, гасит и удаляет VM через Compute API и говорит с worker по
HTTPS. План и итоги замеров — `docs/browser-cloud-migration.md`.

| Путь                    | Что это                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `worker/worker.py`      | Сервис на VM (`127.0.0.1:8080` за Caddy): поручения агента, сессии, файлы, прямые действия, CDP, прокси-форвардер |
| `worker/jev_segment.py` | Короткий отрезок jev-ultrafast для движка `jev-then-agent`: вкладку jev дальше ведёт агент                        |
| `worker/test_worker.py` | Юнит-тесты worker (`python -m unittest`, нужен aiohttp); вектор токена общий с тестами Бро                        |
| `image/provision.sh`    | Установка образа: Caddy, Chrome с политиками, Xvfb, firewall, uv, browser-use, jev, systemd-юниты                 |
| `image/build.py`        | Сборка образа: VM-сборщик → запечатывание → образ `bro-browser-<версия>` → удаление сборщика                      |

## Как устроено

- Одна VM на воркспейс, id среды = id воркспейса. Персональные данные (профиль
  Chrome, файлы сессий) — только на диске этой VM; ключей в образе нет.
- Ключ worker: `HMAC-SHA256(BROWSER_VM_SIGNING_KEY, "bro-browser-vm:" + workspace)`,
  попадает на VM один раз через cloud-init (`/etc/bro/worker.json`, 600).
  Бро подписывает каждый вызов коротким токеном `v1.<payload>.<sig>` с полями
  `env` (чужой VM не годится), `gen` (поколение: старый контроллер получает
  отказ), `exp` (не дольше 15 минут) и необязательным `ses` — область одной
  сессии для ссылок CDP и скачивания, где заголовка нет.
- Ключ модели (RouterAI), логин прокси и секреты сайтов приходят с запросом и
  живут в памяти worker; на диск не пишутся. После перезапуска worker их
  присылают заново (`POST /v1/session`, `POST /v1/runs`).
- Chrome ходит в сеть только через форвардер worker на `127.0.0.1:3128`; пока Бро
  не задал резидентский прокси, форвардер отвечает 502, так что профиль ни разу
  не видит сайт с адреса Cloud.ru. WebRTC закрыт политикой
  `WebRtcIPHandling: disable_non_proxied_udp`.
- Пользователь `bro` (Chrome и worker) не достаёт до metadata-сервиса и частных
  сетей (`bro-firewall`): user data VM не утечёт через страницу.
- Одна вкладка — один управляющий: пока идёт поручение, второе и прямые
  действия получают 409, и Бро ставит их в очередь.
- Поручение переживает падение: после каждого шага worker пишет контрольную
  точку (`AgentState`); после падения Chrome, рестарта worker или VM запуск
  помечен `failed` с номером шага, а продолжение в той же сессии поднимает
  память агента из контрольной точки.
- Успех не берётся из ответа агента: агенту закрыты веб-архивы и кэши
  (`PROHIBITED_DOMAINS`), итоговый адрес страницы возвращается в `finalUrl`.

## API worker

Все пути, кроме `/v1/health`, требуют `Authorization: Bearer <token>` (в `cdp` и
`dl` токен стоит в пути). Формы ответов — докстринг `worker/worker.py`; клиент
Бро — `agent/lib/browser-vm/worker.ts`.

| Метод и путь                                                      | Что делает                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /v1/health[?machine=1]`                                      | версия, Chrome, занятость, прокси, стадия; с `machine` — память, нагрузка   |
| `POST /v1/session`                                                | прокси воркспейса → проверка выхода (ipinfo) → `{exit, vmAddress, traffic}` |
| `POST /v1/runs`, `GET /v1/runs[/<id>]`, `POST …/cancel`           | поручение агента: идемпотентно по id, 409 при занятом браузере              |
| `GET /v1/sessions/<id>`, `POST …/messages`, `POST …/release`      | продолжение в той же вкладке с памятью агента; закрыть вкладку              |
| `POST …/open`, `GET …/state`, `POST …/action`, `GET …/screenshot` | прямой режим без агента: открыть, состояние, действие, снимок               |
| `GET /v1/files`, `GET /v1/files/<ses>/<path>`, `GET /v1/dl/…`     | файлы сессии (`report/`, `downloads/`)                                      |
| `PUT /v1/uploads/<name>`                                          | файл для загрузки на сайт (агенту доступен в `available_file_paths`)        |
| `POST /v1/tabs`, `DELETE /v1/tabs/<id>`                           | пустая вкладка для визита продления входа                                   |
| `POST /v1/browser/{start,stop,restart}`, `POST /v1/profile/reset` | Chrome; стоп пишет cookie на диск перед выключением VM                      |
| `POST /v1/admin/worker`                                           | новая версия worker (sha256 в заголовке, только без поручения)              |
| `GET /v1/cdp/<token>/json`, `WS /v1/cdp/<token>/devtools/…`       | CDP через worker: `agent/lib/browser-use/cdp.ts` работает без правок        |

## Образ

```sh
CLOUDRU_KEY_ID=… CLOUDRU_KEY_SECRET=… python browser-vm/image/build.py --version 2026-09-28-2 --disk 10
```

Сборщик ставит всё за ≈ 5 минут и выключается сам; образ из его диска — ещё
≈ 10 минут. Образ создаётся только из отсоединённого диска, зона в запросе —
объект `{availability_zone_name}`, состояние образа — в
`availability_zones[].state`. Имя образа Бро берёт из `CLOUDRU_BROWSER_IMAGE`.
Существующим VM новый код worker выкатывается через `POST /v1/admin/worker`
(их диски хранят профили, их не пересоздают ради кода).

Проверка worker локально:

```sh
python -m unittest browser-vm/worker/test_worker.py
```
