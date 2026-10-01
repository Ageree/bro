# sandboxd

Сервис хоста исполнительных песочниц Бро (контракт — [`../README.md`](../README.md)):
песочница — контейнер gVisor (`runsc`) без сети, команды и файлы — через
`runsc exec` от пользователя `sandbox`, снимки `/workspace` — в Object Storage
по presigned-ссылкам, брокер инструментов — HTTP на unix-сокете в каждой
песочнице. Решений о людях не принимает: какую песочницу поднять, решает Бро.

Go 1.24, только стандартная библиотека.

```sh
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o sandboxd .   # статический, ~7 МБ
go vet ./... && go test ./...                                     # на поддельном runsc, root не нужен
sudo SANDBOXD_REAL_ROOTFS=/srv/sandboxd/rootfs/<версия> go test ./...   # те же тесты на настоящем runsc
```

Поддельный `runsc` — сам тестовый бинарник по симлинку с именем `runsc`
(`fake_runsc_test.go`): контейнер — копия rootfs в каталоге, `exec` запускает
`bash` на хосте и переносит под этот каталог `cwd` и значения окружения,
похожие на абсолютные пути. Поэтому `sandboxd` передаёт пути только в
окружении (`$P`, `$W`), а не в тексте скрипта. С `SANDBOXD_REAL_ROOTFS`
тесты идут на `runsc` из `PATH`; заглядывающие в подделку — пропускаются.

## Конфигурация

`/etc/bro/sandboxd.json` (пишет cloud-init, 0600); неизвестный ключ — ошибка
старта. Флаги `-config`, `-listen`, `-root`, `-runsc`, `-runsc-root`,
`-rootfs-version`, `-platform`, `-idle-minutes`, `-max-sandboxes` перекрывают
файл для ручных запусков.

| Ключ                | По умолчанию          | Что это                                                             |
| ------------------- | --------------------- | ------------------------------------------------------------------- |
| `host`, `key`       | —                     | id хоста и его ключ (64 hex): ими проверяются токены API            |
| `listen`            | `127.0.0.1:8091`      | адрес API; снаружи — Caddy                                          |
| `root`              | `/srv/sandboxd`       | `rootfs/<версия>/`, `sandboxes/<id>/`, `staging/`, `state.json`     |
| `runsc`             | `/usr/bin/runsc`      | бинарник из пакета `runsc` (пакет целиком: `/usr/bin/gvisor-bin/`)  |
| `runsc_root`        | `/run/sandboxd/runsc` | `runsc --root`: в `/run`, перезагрузка забывает контейнеры          |
| `platform`          | `systrap`             | платформа gVisor (KVM на VM Cloud.ru нет)                           |
| `rootfs_version`    | `current`             | корень новых песочниц; симлинк разрешается при старте песочницы     |
| `idle_minutes`      | `20`                  | простой, после которого песочница снимается и останавливается       |
| `reserve_mb`        | `1024`                | память хоста вне песочниц: лимит — `MemTotal − reserve_mb`          |
| `memory_limit_mb`   | `0`                   | явный лимит суммы `memoryMb` вместо `MemTotal − reserve_mb`         |
| `max_sandboxes`     | `16`                  | живых песочниц на хосте                                             |
| `memory_mb`         | `1536`                | `memoryMb` песочницы, если `PUT` его не назвал                      |
| `exec_ping_seconds` | `15`                  | тишина в потоке `exec`, после которой идёт строка `{"type":"ping"}` |

## Песочница

Каталог хоста `/srv/sandboxd/sandboxes/<id>/` (0700): `bundle/config.json`
(OCI), `run/` (root, 0755; только на чтение в `/run/bro`) с `tools.sock`
(0666) и `runtime.log` — потоки `runsc run` и песочницы, только в файл:
песочница держит их, пока живёт.

```
runsc --root=/run/sandboxd/runsc --platform=systrap --network=none --overlay2=root:memory,size=<memoryMb/2>m \
  --host-uds=open run --detach --bundle=/srv/sandboxd/sandboxes/<id>/bundle <id>
runsc <флаги> update --memory=<(memoryMb + запас) МиБ в байтах> <id>   # сразу после run
runsc <флаги> exec --user=1000:1000 --cwd=<cwd> --env=K=V … <id> /bin/bash -lc <команда>
runsc <флаги> delete --force <id>      # остановка; kill, state, list --format=json — те же флаги
```

- Корень — каталог rootfs только на чтение под оверлеем в памяти
  (`--overlay2=root:memory`, `root.readonly: false`: с `true` gVisor монтирует
  корень на чтение и под оверлеем). Всё записанное — в памяти песочницы.
- PID 1 — `sh`, который только ждёт. Процессы — от `1000:1000`, без
  capabilities (gVisor отдаёт наборы из spec и процессам `exec`) и с
  `noNewPrivileges`.
- Лимиты — `linux.resources`: память `memoryMb` и 1024 pids. cgroup —
  `/sandboxd/<id>` драйвером cgroupfs (у `runsc` он по умолчанию; флаг
  `--cgroupfs` устарел и ничего не делает). Там и sentry, и gofer, так что
  перезапуск `sandboxd` песочниц не трогает.
- Память (`memory.go`). gVisor не держит гостя ни в своём `--total-memory`
  (его `runsc` берёт из лимита cgroup, гость видит это как `MemTotal`), ни в
  `RLIMIT_DATA`; страницы гостя ничьи в RSS, и OOM-killer cgroup убивал
  `gvisor_sentry` — вместе со всей песочницей. Теперь: лимит в spec —
  `memoryMb` (`MemTotal` гостя), после `run` — `runsc update --memory` на
  `max(256, memoryMb/8)` МиБ больше; всем потомкам sentry (шаблон stub-ов
  systrap и stub-ы процессов гостя, новые наследуют) — `oom_score_adj` 1000:
  повышать можно без прав. OOM-killer убивает stub, gVisor — этот процесс
  гостя (137), песочница живёт. Файлы в памяти ограничены, вместе ≤
  `memoryMb`: оверлей — `size=` в `--overlay2`, `/tmp` и `/dev/shm` — tmpfs с
  `size=` в spec (иначе gVisor сам монтирует на `/tmp` tmpfs в полпамяти хоста).
- Умерший контейнер: sentry (pid и время старта из `runsc state`) проверяется
  перед каждым запросом, `runsc state` — при `GET` и `PUT`, после сбоя `runsc
exec` (код 128) — тоже; не бежит — запись `stopped` с причиной «the container
  exited», работа в ней — 409 `sandbox_stopped`, `PUT` поднимает её заново.
- `--network=none` держит netns в `<runsc_root>/null-netns` (bind mount
  `nsfs`): каталог `runsc_root` не чистят, пока живут песочницы.
- Убийство команды: у каждого `exec` своя метка `BRO_EXEC_ID` в окружении;
  отдельный `runsc exec` от `sandbox` читает `/proc/*/environ` и убивает всех
  с этой меткой, затем клиент `runsc exec`. Сам `runsc exec` при SIGKILL
  процесс в песочнице не убивает.

## Состояние и простой

- `state.json` (0600) — записи песочниц, включая секреты (`tools.token`,
  ключ и ссылку снимка): после рестарта `sandboxd` подхватывает живые
  контейнеры (`runsc list`), их брокер и простой. Пропавший контейнер —
  `stopped`, секреты стираются; контейнер без записи удаляется; запись
  `starting` (рестарт посреди старта) — контейнер удаляется.
- Раз в минуту: песочница без запросов дольше `idle_minutes` и без открытых
  `exec` — снимок и остановка; неудачный снимок — песочница живёт до
  следующей минуты. Там же замечаются умершие сами контейнеры (OOM).
- Снимок шифруется во временный файл в `staging/` (на диске, не в памяти) и
  уходит одним `PUT` с `Content-Length`; восстановление расшифровывается
  потоком прямо в `tar -x` в песочнице.

## Хост

Юнит — [`../host/sandboxd.service`](../host/sandboxd.service):
`KillMode=process` (песочницы переживают рестарт сервиса) и без
`RuntimeDirectory=` (systemd опустошал бы `/run/sandboxd` на каждой
остановке). Логи — JSON по строке в stderr (journald): без токенов и без
query presigned-ссылок.

Проверено 01.10 в облачной сессии (root, cgroup v1, ядро 6.18, `runsc`
release-20260928.0, ubuntu-base 22.04.5 с пользователем `sandbox`): полный
набор тестов на настоящем `runsc`, включая убийство процессов в песочнице,
брокер изнутри песочницы через сокет на привязке только для чтения, снимок и
восстановление, и бинарник демоном с рестартом посреди живой песочницы. Там
же выход гостя за память (разом, постепенно, двумя процессами, файлами в
`/tmp`, `/dev/shm`, `/workspace`) и убитый sentry: `TestMemoryOverrun`,
`TestDeadContainer`. На cgroup v2 (VM) механизм тот же — memcg OOM ядра;
`TestMemoryOverrun` сверяет там `memory.max`.

| Файл                         | Что это                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `main.go`                    | флаги, конфиг, старт: `runsc --version`, сверка с `runsc list`, API    |
| `config.go`                  | `/etc/bro/sandboxd.json` и пути на хосте                               |
| `token.go`                   | проверка токена API (формат `hostd`)                                   |
| `api.go`                     | маршруты, авторизация, журнал запросов, `PUT`/`GET`/`DELETE` песочницы |
| `sandboxes.go`               | записи, жизненный цикл, лимиты хоста                                   |
| `runsc.go`                   | интерфейс `Runtime`, команды `runsc`, OCI spec                         |
| `exec.go`                    | поток NDJSON, таймаут, реестр процессов, убийство по метке             |
| `files.go`                   | чтение, запись, удаление файлов через `runsc exec`                     |
| `snapshot.go`                | формат `BROSNAP1`, снимок в S3 и восстановление                        |
| `broker.go`                  | брокер инструментов на unix-сокете, ведро на 120 запросов в минуту     |
| `state.go`                   | `state.json` и сверка с `runsc` после рестарта                         |
| `memory.go`                  | бюджет памяти, запас cgroup, `oom_score_adj` stub-ов, живость sentry   |
| `reaper.go`                  | простой, умершие контейнеры, старые записи                             |
| `log.go`                     | URL и ошибки HTTP без query для журнала                                |
| `testdata/token-vector.json` | общий с TypeScript вектор токена (`TestTokenVector`)                   |
