# Исполнительная песочница Бро

Аналог «Execution sandbox» Instinct (`docs/instinct.md`, разделы 2 и 5.7) на
Cloud.ru: одноразовый компьютер для кода и файлов, постоянные файлы — в Object
Storage. Цикл агента остаётся на бэкенде; в песочнице нет ни модели, ни
секретов. Языки — как у Instinct: сервер исполнения на Go, CLI инструментов на
Rust, внутри — shell, Python и файлы; маршрутизатор инструментов — GraphQL на
бэкенде Бро (TypeScript).

```
 Бро (eve, TS)                      хост Cloud.ru (VM ru.AZ-1)                    песочница (gVisor)
 ─────────────                      ──────────────────────────                    ──────────────────
 SandboxBackend "bro-cloudru" ──HTTPS──▶ Caddy ──▶ sandboxd (Go) ──runsc──▶  /workspace, bash, python3
   (agent/lib/sandbox/)                  (sslip.io, LE)   │                       tools (Rust CLI)
                                                          │ ◀──── unix socket ────  /run/bro/tools.sock
 POST /eve/v1/sandbox-tools ◀──HTTPS── токен песочницы ───┘   (sandboxd добавляет токен: в песочнице его нет)
   toolExecute(name, input)
```

| Каталог     | Что это                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `sandboxd/` | Go: песочницы на `runsc`, exec и файлы через `runsc exec`, снимки `/workspace` в S3, брокер инструментов |
| `tools/`    | Rust: CLI `tools` внутри песочницы — GraphQL-клиент к маршрутизатору через сокет брокера                 |
| `image/`    | Сборка корня песочницы (Ubuntu 22.04, Python, офисные библиотеки, шрифты, `tools`)                       |
| `host/`     | Установка хоста: `provision.sh`, cloud-init, Caddy, `runsc`                                              |

## Изоляция

- Каждая песочница — контейнер `runsc` (gVisor, `--platform=systrap`): код
  модели не видит ядро хоста. Корень — общий каталог только на чтение
  (`/srv/sandboxd/rootfs/<версия>`) с оверлеем в памяти
  (`--overlay2=root:memory`): всё записанное, включая `/workspace`, лежит в
  памяти песочницы и считается в её лимите cgroup — это и квота диска.
- Память: `memoryMb` — бюджет гостя (его `MemTotal`); cgroup хоста — на
  `max(256, memoryMb/8)` МиБ больше (sentry, gofer, таблицы страниц). Гость,
  вышедший за память, теряет процесс, а не песочницу: убитая команда
  кончается кодом 137, как от OOM в Linux. Это держится на `oom_score_adj`
  процессов гостя: если `sandboxd` не смог его выставить (в журнале —
  предупреждение «guest processes are not the OOM killer's first choice»),
  OOM может убить всю песочницу, и файлы после последнего снимка пропадут
  (дальше — 409 `sandbox_stopped`, `PUT` поднимает её из снимка). Файлы в
  памяти ограничены размерами: оверлей корня (`/workspace`, `/home`) — `memoryMb/2`, `/tmp` и
  `/dev/shm` — по `memoryMb/4`; запись дальше — `ENOSPC`. gVisor сам свой
  `MemTotal` не держит, поэтому без этого OOM-killer хоста убивал
  `gvisor_sentry`, и вся песочница пропадала (`sandboxd/memory.go`).
- Сеть — `--network=none`: только loopback (`deny-all`). Внешний мир песочница
  видит лишь через `tools` → сокет брокера → маршрутизатор Бро, где действуют
  те же правила, что и для инструментов агента.
- Пользователь команд — `sandbox` (uid 1000) без sudo; `HOME=/home/sandbox`.
- Секретов в песочнице нет: токен маршрутизатора держит `sandboxd` и
  добавляет сам, как `transform` сетевой политики Vercel Sandbox.

## API `sandboxd`

Слушает `127.0.0.1:8091` за Caddy (`https://<ip с дефисами>.sslip.io`).
Токен — формат `hostd` (`browser-vm/host/hostd.py`, `verify_token`):
`Authorization: Bearer v1.<payload>.<sig>`, payload — base64url JSON
`{"env": "<id хоста>", "exp": <unix-секунды>}` (ключи в этом порядке), подпись —
base64url HMAC-SHA256 ключа хоста от `v1.<payload>`; срок не дальше 15 минут.
Ключ хоста — 32 байта hex в `/etc/bro/sandboxd.json` (`{"host", "key"}`),
у Бро — `HMAC(SANDBOX_SIGNING_KEY, "bro-sandbox-host:" + id хоста)`.

Id песочницы — `[a-z0-9][a-z0-9-]{0,62}` (Бро: `sb-` + 40 hex SHA-256 ключа
сессии eve; с `-` в начале id `runsc` принял бы за флаг). Ответы — JSON,
ошибки `{"error": "<код>", "message": "…"}`; `lastUsedAt` — ISO 8601 UTC.

| Метод и путь                                                | Что делает                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /v1/health`                                            | без токена: `{version, runsc, rootfs, sandboxes}`                                   |
| `PUT /v1/sandboxes/{id}`                                    | создать или подхватить живую; тело ниже; ответ `{id, state, created, restored, ms}` |
| `GET /v1/sandboxes/{id}`                                    | `{id, state, lastUsedAt, memoryMb}`; 404 — нет живой (и если её контейнер умер)     |
| `POST /v1/sandboxes/{id}/exec`                              | команда; ответ — поток NDJSON (ниже)                                                |
| `POST /v1/sandboxes/{id}/procs/{pid}/kill`                  | убить процесс из `exec` (идемпотентно, и в неживой песочнице), 204                  |
| `GET /v1/sandboxes/{id}/files?path=`                        | байты файла (`application/octet-stream`); 404 `not_found`, если нет или это не файл |
| `PUT /v1/sandboxes/{id}/files?path=`                        | записать байты тела (каталоги создаются), 204; оборванное тело файл не меняет       |
| `DELETE /v1/sandboxes/{id}/files?path=&recursive=1&force=1` | удалить; без `force` — 404 на отсутствующий путь                                    |
| `POST /v1/sandboxes/{id}/network`                           | `{"policy": "deny-all"}` — 204; `allow-all` и списки — 409 `unsupported_policy`     |
| `POST /v1/sandboxes/{id}/snapshot`                          | снимок `/workspace` в S3 без остановки: `{bytes, ms}`                               |
| `POST /v1/sandboxes/{id}/stop`                              | снимок, затем остановка контейнера: `{bytes, ms}`                                   |
| `DELETE /v1/sandboxes/{id}`                                 | остановить и стереть без снимка, 204 (объект в S3 Бро удаляет сам)                  |

Пути `path` — абсолютные внутри песочницы (Бро сам приводит относительные к
`/workspace`). Файлы читаются и пишутся через `runsc exec` от `sandbox`:
`sandboxd` не открывает пути песочницы на хосте, поэтому символические ссылки
из песочницы не выводят наружу. Отказ самой файловой операции (нет прав,
каталог вместо файла) — 409 `write_failed` / `delete_failed` и 500
`read_failed` с текстом `stderr`; тело записи — до 512 МиБ (дальше 413).

Работа в неживой песочнице (`exec`, файлы, `network`) — 409 `sandbox_stopped`,
не 404: для файла 404 значит «нет файла». Так же — если умер её контейнер
(например, OOM sentry): `sandboxd` замечает это по процессу sentry до запроса,
по `runsc state` при `GET`/`PUT` или по сбою `runsc exec` (тогда уже идущий
поток `exec` кончается строкой `{"type":"error","message":"sandbox_stopped: …"}`).
Файлы после последнего снимка тогда потеряны; `snapshot` и `stop` такой
песочницы — 404 (сохранять нечего), следующий `PUT` поднимает её заново.

### `PUT /v1/sandboxes/{id}`

```json
{
  "workspace": "personal:…",
  "memoryMb": 1536,
  "tools": {
    "url": "https://brobro.tech/eve/v1/sandbox-tools",
    "token": "v1.…",
    "headers": {}
  },
  "snapshot": {
    "get": "<presigned GET или null>",
    "put": "<presigned PUT>",
    "key": "<64 hex>"
  }
}
```

- `snapshot` (`put` и `key`) обязателен: без него простой стёр бы работу;
  `tools` можно не передавать — тогда брокер отвечает 503.
- Живая песочница: обновить `tools` и `snapshot` (ссылки свежие на каждый
  ход), `created: false`. Если её контейнер умер — она новая (ниже):
  `created: true` и восстановление из последнего снимка.
- Новая: старт контейнера; если `snapshot.get` отвечает 200 — расшифровать и
  распаковать в `/workspace` внутри песочницы (`tar -xz` от `sandbox`),
  `restored: true`; 404 — пустой `/workspace`.
- Снимок: `tar -cz -C /workspace .` внутри песочницы → AES-256-GCM кадрами по
  1 МиБ (кадр: 4 байта длины шифртекста с тегом big-endian, 12 байт nonce,
  шифртекст с тегом; nonce — 8 случайных байт префикса снимка и 4 байта
  номера кадра big-endian с нуля; дополнительные данные кадра — `BROSNAP1` и
  байт `1` у последнего кадра, `0` у остальных) → один `PUT` с
  `Content-Length` по ссылке. Первые 8 байт объекта — магия `BROSNAP1`.
  Файл, который `tar` не может прочитать (владелец снял себе права), — 502
  `snapshot_failed` с его именем, а не пропуск: песочница живёт дальше.
  Предел — 512 МиБ. Ключ у сессии один на все её снимки: 4 случайных байта
  давали повтор nonce GCM с шансом ~10⁻⁴ уже за тысячу снимков, 8 — нет; метка
  последнего кадра не даёт снимку, обрезанному по границе кадра, сойти за целый.
- Простой: песочницу без запросов `idle_minutes` (20) `sandboxd` снимает и
  останавливает сам по последней ссылке `put` (Бро подписывает её на 7 дней).
- Лимиты хоста: сумма `memoryMb` живых песочниц вместе с запасом cgroup
  (`max(256, memoryMb/8)` каждой) ≤ `MemTotal − reserve_mb` (1024), иначе 507
  `host_full`; до `max_sandboxes` (16).

### `POST /v1/sandboxes/{id}/exec`

Тело: `{"command": "…", "cwd": "/workspace", "env": {"K": "V"}, "timeoutMs": 600000, "stdin": "<base64>"}`.
Команда идёт как `bash -lc <command>` от `sandbox`. Ответ — `200`,
`Content-Type: application/x-ndjson`, по строке на событие, поток не
буферизуется:

```
{"type":"start","pid":"p7"}
{"type":"stdout","data":"<base64>"}
{"type":"stderr","data":"<base64>"}
{"type":"exit","code":0}
```

Пока команда молчит, каждые 15 с тишины в потоке идёт `{"type":"ping"}`
(`exec_ping_seconds`; не до `start` и не после последней строки): undici
обрывает тело ответа после 300 с без байт, прокси режут молчащие потоки.
Клиенты пропускают `ping`.

При сбое до старта — обычная ошибка JSON; после — `{"type":"error","message":…}`
последней строкой. Таймаут — `exit` с кодом 124. Если клиент закрыл поток,
процесс убивается: долгий `spawn` живёт, пока его держит вызывающий. Без
`stdin` в запросе у команды пустой (закрытый) stdin. `timeoutMs` — до
3 600 000. Убитая (`procs/{pid}/kill`) команда кончается кодом 137; `cwd`,
которого нет, — кодом 128 и сообщением `runsc` в `stderr`. Убивается всё,
что запустила команда (метка `BRO_EXEC_ID` в окружении), фоновые процессы
завершившейся команды живут дальше; её поток закрывается через 2 с после
выхода, даже если они держат stdout.

## Брокер инструментов и GraphQL

В песочнице `/run/bro/tools.sock` — сокет `sandboxd` (каталог хоста
`/srv/sandboxd/sandboxes/<id>/run`, привязан только на чтение;
`runsc --host-uds=open`, проверено на runsc 20260928.0). Доступность —
`GET /health` по тому же сокету. По нему CLI
шлёт обычный HTTP/1.1: `POST /graphql` с телом GraphQL. `sandboxd` пересылает
его на `tools.url` с `Authorization: Bearer <tools.token>` и `tools.headers`,
тело ответа — как есть. Предел тела — 25 МиБ, не больше 120 запросов в минуту
на песочницу (дальше 429) и 4 разом (остальные ждут до 30 с, дальше 429
`busy`), таймаут — 120 с.

Схема маршрутизатора (`agent/lib/sandbox/router.ts`, маршрут канала eve
`/eve/v1/sandbox-tools` — `app/` не импортирует `agent/`):

```graphql
scalar JSON
type Tool {
  name: String!
  description: String!
  inputSchema: JSON!
}
type ToolResult {
  ok: Boolean!
  output: JSON
  error: String
}
type Query {
  tools: [Tool!]!
}
type Mutation {
  toolExecute(name: String!, input: JSON!): ToolResult!
}
```

Токен маршрутизатора — `v1.<payload>.<sig>`, payload
`{"sb": "<id песочницы>", "ws": "<воркспейс>", "exp": …}`, ключ —
`HMAC(SANDBOX_SIGNING_KEY, "bro-sandbox-tools")`, срок — до 6 часов.
Инструменты — только без личных данных и действий от имени человека:
`web_search`, `web_fetch`, `download`.

## CLI `tools`

```
tools                      # список инструментов (query tools)
tools <name> --help        # описание и JSON-схема входа
tools <name> '<json>'      # вызов; вход — JSON аргументом или в stdin
tools web-search "запрос"  # короткие формы: позиционные аргументы → поле по схеме
```

Вывод — `output` как JSON (строка — как есть), код 0; ошибка — текст в stderr,
код 1; нет сокета или брокер не отвечает — код 2; HTTP 429 (лимит) — код 3.
`download` пишет файл сам: `tools download <url> <путь>`.
