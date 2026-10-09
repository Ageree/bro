# Хост пула браузеров

Этап 2 [`docs/browser-pool.md`](../../docs/browser-pool.md): общая VM Cloud.ru, на
которой браузер каждого воркспейса живёт своей песочницей, а между поручениями
хранится зашифрованным набором в Object Storage. `hostd` — сервис хоста: поднять,
припарковать, восстановить и удалить песочницу, отчитаться о ёмкости. Решений о
людях не принимает: хост выбирает Бро, он же перед парковкой зовёт
`POST /v1/park` worker (секреты из памяти) и проверяет, что запуска нет.

Среда — `runtime` в `/etc/bro/hostd.json` (из `boot.json`):

- **`runc`** (по умолчанию, решение этапа 1): обычный контейнер. Парковка —
  мягкий стоп песочницы (SIGTERM init: cookie и localStorage ложатся в
  профиль), удаление контейнера и архив одного профиля; восстановление — свежий
  старт с этим профилем (`path: cold`). Открытая страница парковку не
  переживает: песочницу, ждущую код, Бро держит живой до срока кода. Не
  переживает её и всё, что worker хранит вне профиля: запуски
  (`/var/lib/bro/runs`), сессии с памятью агента (`agentState`), вкладки —
  они в оверлее на tmpfs; worker после подъёма пуст, как после перезапуска.
- **`runsc`** (gVisor, запасной путь): заморозка со страницей
  (`runsc checkpoint`) и восстановление со снимком, откат на профиль, если
  снимок не подходит. Логика снимков и `fits` остаётся рабочей и под тестами.
- **`firecracker`** (выделенный сервер Selectel, 09.10): песочница — microVM
  Firecracker под `jailer`; парковка — полный снимок памяти на локальном диске
  хоста плюс профиль в Object Storage. Раздел «Firecracker» ниже.

Тесты — на поддельных `runc`, `runsc`, `firecracker`/`jailer` (поддельный API на
unix-сокете), `mount`, `mkfs.ext4`, `debugfs`, `ip`, `nft`, `zstd`, `caddy` и S3; `runc` проверен и на настоящих VM (этап 2, 30.09, ниже и раздел 2
`docs/browser-pool.md`), `runsc` на хосте пула — нет.

| Файл                  | Что это                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `hostd.py`            | HTTP API на `127.0.0.1:8090` за Caddy (`/h/…`), жизненный цикл песочниц, один `Runner` для команд              |
| `network.py`          | Сеть песочниц: netns, veth, транзитные адреса, правила nftables хоста и роутера — единственный модуль          |
| `sets.py`             | Наборы: zstd-части, AES-256-GCM по чанкам, манифест с HMAC, параллельные PUT/GET по presigned URL              |
| `firecracker.py`      | Firecracker: запросы к API, argv `jailer`, командная строка ядра, образ корня, локальные снимки и бюджет       |
| `guest/`              | `bro-fc-init` (PID 1 гостя до `bro-sandbox-init`) и `bro-fc-clock` (часы гостя по PTP): кладутся в образ корня |
| `selfupdate.py`       | `POST /v1/admin/update`: скачать бандл, сверить sha256, подменить код, `update.sh`, рестарт `hostd`            |
| `units.sh`            | Юниты `caddy` и `bro-hostd`: их пишут `provision.sh` и `update.sh`                                             |
| `update.sh`           | Идемпотентная часть `provision.sh` для обновления кода: проверка нового кода, venv, юниты, бинарники, сторож   |
| `rollback.sh`         | Сторож отката: таймер systemd, который возвращает прежний код, если новый `hostd` не поднялся за ~90 с         |
| `caddy.py`            | Caddyfile хоста: `/g/<id>/*` → worker (префикс — в `X-Forwarded-Prefix`), `/h/*` → `hostd`, admin — unix-сокет |
| `seccomp.json`        | seccomp песочницы `runc`: всё, кроме путей побега из контейнера; user namespace для Chrome разрешены           |
| `provision.sh`        | Установка хоста на стоковой Ubuntu 22.04: apt с зеркала, runc (или runsc), Caddy и venv из бандла              |
| `boot.py`             | Сбор вендора (Caddy, колёса), бандл кода хоста и cloud-init одного хоста                                       |
| `vendor.json`         | Закреплённый Caddy: URL релиза, sha256 архива и бинарника; платформа колёс                                     |
| `requirements.txt`    | Колёса `hostd` под Python 3.10 x86_64 с sha256 каждого (сверены с PyPI)                                        |
| `test_hostd.py`       | Тесты `hostd`, сети, шифрования под обеими средами (нужны aiohttp и cryptography, root не нужен)               |
| `test_firecracker.py` | Тесты `firecracker.py` и гостевых скриптов; настоящий образ корня, если есть `mkfs.ext4` и `debugfs`           |
| `test_boot.py`        | Тесты cloud-init, бандла и пинов, скрипта загрузки и инвариантов `provision.sh` (только stdlib)                |

## Песочница

Контракт с корнем песочницы (его собирает `browser-vm/image/sandbox/`):

- Корень — каталог `/srv/bro/rootfs/<версия>/`, хост его не меняет. PID 1 —
  `/usr/local/sbin/bro-sandbox-init` (Xvfb, Chrome, worker от `bro`); worker
  слушает `0.0.0.0:8080` (`BRO_WORKER_BIND`). Свой netns — новый на каждый старт
  и восстановление.
- `runc`: оверлея у `runc` нет, его монтирует `hostd`: tmpfs
  `<каталог>/overlay` (`overlay_mb`, 2 ГБ) с `upper` и `work`, overlayfs
  `lowerdir=<корень>` в `<каталог>/root` — это `root.path` bundle
  (`readonly: false`). Свои pid-, ipc-, uts-, mount-, cgroup- и сетевой
  namespace; `maskedPaths`/`readonlyPaths` как у `runc spec`; устройства — только
  стандартные; `noNewPrivileges: false` и `CAP_SETUID`/`CAP_SETGID` (sudo
  worker), без `SYS_ADMIN`, `MKNOD`, `NET_RAW`; `oomScoreAdj` 200 (ниже оценок
  рендереров Chrome). Seccomp — `seccomp.json` (`seccomp_profile`; `""` — без
  него, только для опытов стенда): разрешено всё, кроме путей побега (ключи
  ядра, `bpf`, `userfaultfd`, `perf_event_open`, `mount` и новый API
  монтирования, `pivot_root`, `setns`, `io_uring`, модули, `kexec`, сокеты
  `AF_PACKET` и `NETLINK_NETFILTER`), только x86_64. Профиль Docker не подходит:
  он запрещает `unshare`/`clone` с новым user namespace, на чём стоит
  собственная песочница Chrome (она работает без `--no-sandbox`; Ubuntu 22.04
  разрешает такие namespace и так). Переназначения uid нет: root контейнера —
  root хоста, `bro` у всех песочниц — один uid хоста (inotify на uid поднят в
  `provision.sh`). AppArmor нет.
- `runsc`: `--overlay2=root:memory --platform=systrap`, `root.path` — сам
  каталог корня, `readonly: false` (с `true` gVisor монтирует корень только на
  чтение, init падает на `/run`).
- Каталог хоста `/srv/bro/sandboxes/<id>/`: `profile/` (rw в
  `/var/lib/bro/profile`, владелец — `bro` из `/etc/passwd` корня; это
  смонтированный `profile.img` — ext4 на `profile_mb`, 2 ГБ, разреженный,
  `nodev,nosuid`: песочница не забьёт диск хоста),
  `worker.json` (ro в `/etc/bro/worker.json`, 0600, `{"environment", "key"}` из
  запроса, в логи не пишется), `resolv.conf` (публичные резолверы, не
  `127.0.0.53`), `bundle/config.json` (OCI), `runtime.log` — потоки среды и
  песочницы только в файл: восстановленная gVisor-песочница держит их, и чтение
  пайпа ждёт вечно.
- Имя хоста в песочнице всегда `bro-sandbox`: `SingletonLock` Chrome помнит имя.
- Caddy снимает `/g/<id>` и передаёт worker `X-Forwarded-Prefix: /g/<id>`:
  адреса сокетов CDP в `/v1/cdp/<токен>/json` worker строит с ним (другой вид
  заголовка worker не берёт).
- Своя cgroup (`/bro-sandboxes/<id>`, лимит памяти — `memoryMb` запроса или
  `memory_mb` конфига, 3 ГБ; до 4096 процессов) и `KillMode=process` у
  `bro-hostd`: перезапуск `hostd` песочниц не гасит. Страницы tmpfs оверлея
  считаются в той же cgroup. После перезапуска записи из `sandbox.json`
  сверяются с `state` среды; потерянная песочница — `failed`, её профиль
  остаётся до `DELETE`; живая, застрявшая в `starting`/`restoring`/`parking`, —
  `running`, если worker отвечает, иначе `failed`.
- Сумма лимитов памяти песочниц не больше `MemTotal − reserve_mb` (или
  `memory_limit_mb`): иначе `POST /v1/sandboxes` — 507. CPU — `cpu.max` на
  `cpus` (2) vCPU; квоты ввода-вывода нет; свободное место диска видно в
  `capacity`.
  `runtime.log` раз в минуту урезается до новой половины, если перерос
  `log_max_bytes` (8 МБ).
- Если среда не удалила контейнер или оверлей не размонтировался, `DELETE` и
  парковка отвечают 502, а запись остаётся `failed` со своим слотом и каталогом:
  песочница не живёт невидимкой, и `rmtree` не идёт в смонтированный корень.
- tar, zstd и загрузки — на диске, в `/srv/bro/staging/<id>/`; в `/dev/shm` —
  только снимок gVisor (`/dev/shm/bro-<id>`). Распаковка и удаление больших
  деревьев идут в потоке, не в цикле событий.
- Все пути и программы — в `Config` (`/etc/bro/hostd.json` переопределяет).
  `stand_host_ports` — **только для стенда**, в проде пусто: TCP-порты самого
  хоста, до которых песочницам можно достучаться (прокси-заглушка стенда
  вместо резидентского); любой другой порт хоста отвергается, а 22, 80, 443,
  2019 и порт `hostd` конфиг не примет.

## API

Токен хоста — формат worker (`v1.<payload>.<sig>`, HMAC-SHA256), ключ
`HMAC(BROWSER_VM_SIGNING_KEY, "bro-browser-host:" + id хоста)` приходит один раз
в cloud-init (`/etc/bro/host.json`, 0600), payload `{env: <id хоста>, exp}` (не
дольше 15 минут). Id песочницы — `[a-z0-9-]{1,63}`: он идёт в пути и маршруты.

Ручки оператора (лог песочницы, самообновление; в таблице ниже помечены `*`) требуют токен с `scope: "update"`, подписанный
**другим ключом**: `updateKey` из `host.json` = `HMAC(BRO_HOST_UPDATE_SIGNING_KEY, "bro-browser-host-update:" + id хоста)`.
Бро знает `BROWSER_VM_SIGNING_KEY`, а значит и ключ любого хоста, но не `BRO_HOST_UPDATE_SIGNING_KEY`: утечка env приложения
не даёт root на хосте. Обычные ручки проверяют ключ хоста и отвергают токен с любым `scope`; ручки оператора проверяют только
`updateKey` и отвечают `403 updates are not enabled on this host`, если его в `host.json` нет.

| Метод и путь                            | Что делает                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                        | без токена: версия `hostd`, `runtime` и `runtimeVersion`, `runsc` (только под gVisor), стадия загрузки, `update`: лишь `state`, `version`, `at` |
| `GET /v1/capacity`                      | память (и сумма лимитов), `/dev/shm`, диск, песочницы (состояние, лимит и занятая память), CPU, среда, `snapshotFormat` (runc — null)           |
| `POST /v1/sandboxes`                    | `{id, workspace, generation, memoryMb?, workerKey, rootfsVersion, restore? \| profile?}` — старт, восстановление или холодный старт             |
| `GET /v1/sandboxes/<id>`                | запись песочницы (`state`, `runtime`, `path`: `fresh`, `restored`, `cold`, `adopted`; `fallback` — почему не снимок)                            |
| `DELETE /v1/sandboxes/<id>?generation=` | остановить, размонтировать корень, стереть каталог хоста, снимок, netns и маршрут (502, если не вышло)                                          |
| `POST /v1/sandboxes/<id>/park`          | `{generation, dataKey, upload: {chunkUrls, manifestUrl}}` → размеры, время, среда, формат снимка (507 — нет места)                              |
| `GET /v1/sandboxes/<id>/log` \*         | конец `runtime.log` песочницы (`?bytes=`, до 64 КиБ)                                                                                            |
| `GET /v1/admin/update` \*               | полный итог последнего обновления (`update.json`: ошибка, sha256 бандла), версия, `updating`                                                    |
| `POST /v1/admin/update` \*              | `{url, sha256}` — самообновление (ниже)                                                                                                         |

Пока идёт обновление (`draining`), новые `POST /v1/sandboxes` и park отвечают `503` (Бро повторит на перезапущенном `hostd`);
повтор старта уже работающей песочницы и `DELETE` проходят.

Поля запросов прежние: клиент Бро не различает среды. Ответ парковки под `runc`
— `format: null`, в `parts` только `profile`, `timings`: `stopMs`,
`chromeStop` (`sigterm` или `killed`), `packMs`, `uploadMs`, `totalMs`; под
`runsc` — `format` снимка, части `profile` и `image`, `checkpointMs` вместо
`stopMs`. `restore` под `runc` — всегда `path: cold` с `fallback` «runc keeps no
memory snapshots»; набор gVisor на хосте `runc` поднимается с одним профилем
(часть `image` не скачивается), набор `runc` на хосте gVisor — `cold`.

Поколения: тот же id и поколение — ответ про уже живую песочницу (идемпотентно);
старшее поколение — песочницу принимает новый контроллер (`adopted`); младшее — 409. `restore` и `profile` — `{manifestUrl, chunkUrls, dataKey}`: первое — снимок
с откатом на холодный старт, второе — только архив профиля. Набор должен быть
строго старше поколения старта (иначе 409): парковка пишет в
`<префикс>/<своё поколение>/` и не перетирает чанки набора, из которого
песочница поднялась. Одновременно паркуются не больше `parallel_parks` (2).

**Парковка `runc`**: SIGTERM init (`runc kill`): тот гасит worker, Chrome
(SIGTERM и до `TimeoutStopSec` 30 с) и Xvfb и выходит. Внутри песочницы `hostd`
ничего не запускает: `runc exec` в контейнер, который могла захватить страница,
— вход известных побегов `runc`. SIGTERM Chrome не сохраняет cookie последних
30 с, поэтому до парковки Бро просит worker закрыть Chrome через CDP
(`closeChrome`), а `BrowserMetrics` профиля в набор не идёт.
`chromeStop: killed` — профиль мог отстать:
init убил Chrome по таймауту (строка «bro-chrome killed» в `runtime.log` после
SIGTERM), песочница не вышла за `chrome_stop_timeout_s` (45 с, тогда SIGKILL) или
её уже не было. Набор пишется и тогда: после SIGTERM песочница в `running` не
возвращается. Затем `runc delete`, tar профиля, zstd, шифрование, загрузка,
манифест последним; не загрузилось — та же песочница стартует здесь заново в
свежем netns на том же оверлее (`restoredLocally`; замок Xvfb прошлого запуска
init снимает сам).

## Набор в Object Storage

- Ключей S3 на хосте нет (ключ Cloud.ru на VM не попадает): Бро подписывает
  каждый PUT и GET (`<префикс>/<поколение>/chunk-0000…`, `manifest.json`) и
  передаёт URL в запросе. Для парковки URL чанков — с запасом; сколько занято,
  скажет ответ (`chunks`). URL уходит байт в байт как подписан
  (`yarl.URL(url, encoded=True)`): иначе aiohttp перекодирует `%2F` и `%3A`, и
  подпись не сходится.
- Части: `profile` (tar каталога профиля) и под gVisor `image` (tar снимка),
  каждая через `zstd -3`, чанки по 16 МБ, PUT по 6 параллельно, манифест —
  последним (нет манифеста — нет набора). В манифесте — `runtime` и `snapshot`
  (`null` у `runc`).
- Шифрование: ключ данных (64 hex) Бро выводит HKDF из `BROWSER_STATE_KEY` и id
  воркспейса и присылает с запросом; `hostd` держит его только в памяти. Ключ
  набора — HKDF от него со случайной солью и id набора
  (`<воркспейс>|<id>|<поколение>`); nonce — номер части и номер чанка, AAD — id
  набора, часть, номер и флаг последнего чанка: переставить, подмешать из другого
  набора или обрезать нельзя. Манифест подписан HMAC тем же ключом набора; SHA-256
  каждого чанка сверяется до расшифровки.
- Восстановление gVisor: манифест, затем чанки по 6 параллельно; формат снимка
  (`runsc --version`, отпечаток флагов CPU, версия корня, `memoryMb` не больше
  нового) не совпал, в `/dev/shm` нет места, `runsc restore` отказал или worker
  не ответил — холодный старт с профилем (`path: cold`, `fallback` — причина).
- Профиль пишет песочница, а распаковывает root другого хоста: в набор идут
  только обычные файлы и каталоги (второе имя жёсткой ссылки — копией), при
  распаковке — то же, через фильтр `data` tarfile (без владельцев, setuid и
  путей наружу); ссылки (`Singleton*` Chrome делает заново), FIFO и устройства
  пропускаются, отказ фильтра — тоже, а не сбой набора. Профиль затем целиком
  отдаётся `bro`.

## Сеть

Адрес внутри у всех песочниц один: `192.168.254.2/30`, шлюз `.1` (вне VPC
`10.0.0.0/8`). Уникальность — снаружи: у песочницы свой netns роутера
(`bro-r-<id>`) между ней и хостом, транзит роутер ↔ хост — свой `/30` из
`172.31.0.0/16` (`brt<n>` на хосте, `.4n+1` и `.4n+2`). Роутер делает SNAT выхода
песочницы и DNAT `транзит:8080` → `192.168.254.2:8080`: Caddy ходит к worker по
транзитному адресу. В корневом netns — одна таблица `inet bro` через `nft -f`
(атомарно): песочница выходит только в интернет через uplink с masquerade;
соседи, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16` (metadata),
`egress_blocked` конфига (`provision.sh` вписывает туда публичный IP хоста:
иначе — таймаут, Cloud.ru его не разворачивает), порты самого хоста и IPv6
закрыты; `brt<n>` пропускает только адрес своего роутера. Таблицу `hostd`
ставит заново и каждые `rules_every_s` (30 с): у Caddy, единственного процесса
хоста снаружи, `CAP_NET_ADMIN` нет, но пропажу таблицы больше никто бы не
заметил. Закрытое **отвергается** (TCP reset, ICMP
admin-prohibited), а не роняется молча: молчащий адрес вешал browser-use на
минуты. Молча роняются только подделанный адрес источника и IPv6.

Этап 1 показал, что восстановление gVisor смену адреса переносит, а у `runc`
снимков нет: роутер на песочницу больше не нужен. Схема оставлена как есть —
она работает и покрыта тестами; упрощать (уникальный адрес из пула хоста,
worker напрямую) — только в `network.py`. netns строятся заново перед каждым
стартом и восстановлением: gVisor забирает адреса netns себе, а остатки от
упавшего `hostd` иначе ломали бы `ip netns add`.

## Загрузка хоста

Своих образов в проекте не больше двух (оба в проде), поэтому хост — стоковая
`ubuntu-22.04` и cloud-init из `boot.py cloud-init`: `/etc/bro/host.json`,
`/etc/bro/boot.json` (среда, версия `runsc` для gVisor, зеркало apt, URL и
SHA-256 бандла и корня песочницы) и `bro-host-boot`, который скачивает бандл,
сверяет SHA-256 и запускает `provision.sh`. Бро пишет тот же документ байт в
байт (`browserHostCloudInit` в `agent/lib/browser-pool/hosts.ts`; тест Бро
сверяет его с выводом `boot.py cloud-init`): меняйте оба разом.

`bro-host-boot` лежит в `/var/lib/cloud/scripts/per-boot/`: cloud-init
запускает его на каждой загрузке, первой тоже, а не раз на VM, как `runcmd`.
Перезагрузка посреди установки (Бро перезагружает молчащий хост: первая
загрузка порой встаёт в `(initramfs)`) запускает установку заново, а не
оставляет мёртвый хост. Перезагрузка Cloud.ru — жёсткий сброс, и оборванный
прогон оставляет рваные файлы (02.10 — пустые списки apt, которые
`apt-get update` не перекачивал), поэтому перед повтором скрипт останавливает
`hostd`, стирает списки и кэш apt и venv и чинит dpkg
(`dpkg --configure -a`); остальные шаги `provision.sh` повторяемы с любого
места. Хост на `ready` скрипт не трогает: Caddy и `hostd` поднимаются сами.
Журнал всех загрузок — `/var/log/bro-provision.log`.

С Cloud.ru GitHub, PyPI и репозиторий Caddy молчат, `archive.ubuntu.com` не
отвечает (30.09), поэтому хост ходит только на зеркало apt (`aptMirror`, по
умолчанию `http://mirror.yandex.ru/ubuntu`: оттуда `runc`, `nftables`, `zstd`,
`python3-venv`) и в Object Storage. Остальное — в бандле: статический Caddy
(релиз GitHub, sha256 архива и бинарника в `vendor.json`) и колёса `hostd`
(`requirements.txt`, sha256 каждого; `pip install --no-index --require-hashes`).
`runsc` — из датированного набора apt gvisor.dev (`runscRelease`), после
установки сверяется и держится `apt-mark hold`; доступность
`storage.googleapis.com` с хоста не проверена.

Оценка загрузки — 2–3 минуты (стоковая загрузка ≈ 45 с, apt ≈ 40–60 с, venv
≈ 10 с, корень ≈ 20–60 с, сертификат ≈ 10 с), бюджет — 6 минут. Caddy и `hostd`
стартуют сразу после apt и venv, до скачивания корня: с этого момента стадия
(и `failed:<стадия>:line N`) видна в `https://<домен>/h/v1/health`; песочницы
хост берёт только на `ready`. Корень распаковывается с `--numeric-owner` в
скрытый `.<версия>.partial`. Домен по умолчанию — `<ip>.sslip.io` (адрес — от
Яндекса, ipify или icanhazip).

### Сборка бандла и корня

В сессии или у оператора (там, где GitHub и PyPI отвечают):

```sh
cd browser-vm/host
python boot.py vendor --dir /tmp/bro-vendor                                    # Caddy и 14 колёс, всё по пинам
python boot.py bundle --vendor /tmp/bro-vendor --out /tmp/bro-host.tgz         # печатает sha256 (≈ 23 МБ)
python ../../scripts/cloudru-sandbox-probe/s3.py put pool/host/host-<sha256[:12]>.tgz /tmp/bro-host.tgz
```

Корень — один раз на VM Cloud.ru (≈ 3 минуты на 2 vCPU), колёса песочницы — с
зеркала PyPI со сверкой хэшей, как на стенде (README стенда):

```sh
BRO_PYTHON_SETUP=/root/stand/vm/wheels.sh BRO_PYTHON_WHEELS=/srv/bro/wheels \
  bash browser-vm/image/sandbox/build_rootfs.sh /srv/bro/rootfs/<версия> <версия> /srv/bro/<версия>.tar.zst
# печатает sha256 архива; выгрузка — presigned PUT из сессии (s3.py presign put pool/rootfs/<версия>.tar.zst)
```

На стенде это `vm/rootfs_build.sh wheels` и `vm/rootfs_build.sh build <версия>`
(2,3 минуты на `gen-2-4`). Затем `boot.py cloud-init` с presigned GET бандла и
корня (срок — на время загрузки хоста). Текущие артефакты — корень
`pool/rootfs/sandbox-20260930.3.tar.zst` и бандл `pool/host/host-d9b5f3673fb6.tgz`
в проде; бандл `pool/host/host-bd7cf2673def.tgz` (кэши Chrome вне набора) ждёт
смены `BROWSER_HOST_BUNDLE` (sha256 и размеры — раздел 2 `docs/browser-pool.md`).

### Проверено на настоящих VM (этап 2, 30.09)

Три хоста `gen-2-8`, стенд — `scripts/cloudru-sandbox-probe/pool.py` (README
стенда), цифры — раздел 2 `docs/browser-pool.md`.

1. Загрузка по cloud-init до `ready` по HTTPS — 132–133 с от создания VM;
   установка 62–67 с (apt с зеркала 33 с, корень из S3 25–30 с). Одна первая
   загрузка из четырёх встала в `(initramfs)`: лечит `reboot`.
2. Старт песочницы 0,8 с до ответа worker; `memory.max` 3 ГБ, `pids.max` 4096,
   tmpfs и overlay смонтированы; Chrome **без** `--no-sandbox`: zygote в своих
   user- и pid-namespace, рендереры под seccomp-bpf.
3. Короткое поручение (Рувики) через `/g/<id>/` — 60 с, 0,88 ₽; CDP-сокеты через
   Caddy — с префиксом `/g/<id>/`.
4. Парковка — `chromeStop: systemctl`, 1,7–2,0 с, набор 40–70 МБ; на
   **другом** хосте — `cold` за 1,7 с, cookie и localStorage на месте.
5. Утечки (`vm/leak.py` стенда изнутри песочницы): соседка, `10/8`, metadata,
   порты хоста — отказ за < 1 мс. Таймаут — только на публичный IP самого хоста
   (Cloud.ru не разворачивает на него трафик).
6. Перезапуск `hostd` — песочница жива; перезагрузка хоста — песочница
   `failed`, новая с тем же id и `DELETE` работают; `DELETE` не оставляет
   монтирований, netns, veth, cgroup и каталогов.

Этап 4 (30.09, код Бро на настоящих хостах — раздел 2 `docs/browser-pool.md`):
Chrome под `seccomp.json` со своей песочницей (namespace, seccomp-bpf, без
`--no-sandbox`), профиль на образе ext4 (`loop`, `nodev,nosuid`), парковка
SIGTERM init — 0,52 с, `chromeStop: sigterm`. SIGTERM Chrome считает концом
сеанса и cookie последних 30 с не пишет: перед парковкой `runc` Бро просит
worker закрыть Chrome через CDP (`POST /v1/park {"closeChrome": true}`).
`BrowserMetrics` профиля (по 4 МиБ на каждый SIGTERM) в набор не идёт.
Не проверено на VM: `runsc` на хосте пула, поручения под нагрузкой соседей
(этап 3).

## Firecracker

Третья среда `hostd` (`runtime: "firecracker"`, `boot.py cloud-init --runtime firecracker`): API `hostd`, Caddy,
сеть хоста и сторона Бро те же, меняется то, чем запускается песочница. Код — `firecracker.py` (всё про VM) и
ветки `Host.*_microvm` в `hostd.py`. Ядро гостя и пины — `browser-vm/firecracker/` (`pins.json`).

**Хост** (`provision.sh`, этап `packages`): `/dev/kvm` обязан быть (иначе стадия `failed:/dev/kvm is missing (kernel …)`),
`uname -r` пишется в журнал; `e2fsprogs`; из бандла (`vendor/firecracker/`) ставятся
`/opt/bro/firecracker/{firecracker,jailer,vmlinux}` (пути — в `Config`: `firecracker`, `jailer`, `kernel`).
Бандл с Firecracker: `python boot.py vendor --dir V --firecracker-url <presigned GET tgz> --kernel-url <presigned GET vmlinux>`
(sha256 архива, двух бинарников и ядра сверяются с `browser-vm/firecracker/pins.json`; S3-ключи — в нём же), затем
`boot.py bundle --vendor V`. Бандл воспроизводим; при `vendor/firecracker/` без пинов или с чужим файлом он не собирается.

**Корень.** Каталог `/srv/bro/rootfs/<версия>/` остаётся как есть; из него один раз на версию строится
`/srv/bro/rootfs/<версия>.ext4` (`mkfs.ext4 -d`, без журнала, `0444`) и через `debugfs -w` в него кладутся
`/usr/local/sbin/bro-fc-init` и `bro-fc-clock` (не `/sbin/…`: в 22.04 `/sbin` — ссылка на `usr/sbin`). Образ общий и
read-only для всех VM (диск `rootfs`, `/dev/vda`). Строят его `provision.sh` (стадия `image`, до `ready`) и `hostd`
сам: при старте для каждой версии и при смене скриптов (имя образа — `image_id`: версия + текст скриптов + `IMAGE_FORMAT`;
рядом `<версия>.ext4.json`). Снимок принимается только на том образе, на котором снят.

**Гость.** Командная строка ядра целиком (`boot_args` заменяет умолчание Firecracker): `console=ttyS0 reboot=k panic=1
pci=off nomodule root=/dev/vda ro init=/usr/local/sbin/bro-fc-init ip=192.168.254.2::192.168.254.1:255.255.255.252::eth0:off
BRO_OVERLAY_MB BRO_WORKER_PORT BRO_NOW`. `bro-fc-init` монтирует proc/sys/dev, tmpfs на `overlay_mb` с overlayfs поверх
read-only корня, конфиг-диск (`/dev/vdc`, ext4 на 4 МиБ: `worker.json` 0600 владельца `bro`, `resolv.conf`), профиль
(`/dev/vdb`, `nodev,nosuid`) в `/var/lib/bro/profile`, `/dev/pts`, `/dev/shm` (1 ГБ), `/run`; имя `bro-sandbox`,
`vm.dirty_expire_centisecs=100`, `vm.dirty_writeback_centisecs=100` (запись в профиль доходит до образа за секунду);
часы — `bro-fc-clock --once` до старта (VM без RTC стартует в 1970; нет PTP — запасной `date -s @BRO_NOW`) и затем
каждую секунду (после восстановления снимка часы стоят): `/dev/ptp0` (ptp_kvm), id часов `((~fd) << 3) | 3`, шаг
`CLOCK_REALTIME`, если разница больше 0,5 с. Потом `pivot_root` и `exec bro-sandbox-init` с тем же окружением, что у
`runc`. Профиль **не монтируется на хосте**, пока VM жива; перед стартом `hostd` монтирует свежий `profile.img` на
мгновение (mkfs, распаковка набора, владелец `bro`, umount). Гостю нужны (ядро пинов это даёт): ext4, overlayfs,
devtmpfs, virtio-mmio/blk/net/rng, `IP_PNP`, `PTP_1588_CLOCK_KVM`, `VMGENID`, user/pid/net namespaces и seccomp (Chrome).

**Сеть** (`network.py`): netns песочницы `bro-s-<id>`, netns роутера, адрес внутри `192.168.254.2/30`, DNAT на :8080 и
правила хоста те же. В netns песочницы адреса нет: `eth0` (veth) и `tap0` (владелец — uid VM) — порты моста `br0`; у
`in0` роутера фиксированный MAC, поэтому ARP-запись, которую помнит восстановленный снимок, остаётся верной в новых netns.

**Процесс.** `jailer` без `--daemonize` (exec на месте: pid, который знает `hostd`, и есть VM; stdout — консоль гостя —
в `runtime.log`), `--netns`, `--cgroup-version 2 --parent-cgroup bro-sandboxes --cgroup memory.max=(memoryMb +
fc_overhead_mb)`, у каждой VM свой uid/gid `fc_uid_base + слот` (30000+; взломанный Firecracker не трогает соседей).
Chroot — `<jailer_dir>/firecracker/<id>/root` (по умолчанию `/srv/bro/jailer`, на той же ФС, что `/srv/bro`: файлы
кладутся жёсткими ссылками — ядро, образ корня, `profile.img`, `config.img`). Настройка по API-сокету
`firecracker.socket`: `boot-source`, диски `rootfs` (ro), `profile` (rw, `Writeback`), `config` (ro), `eth0`↔`tap0` с MAC
`06:00:c0:a8:fe:02`, 2 vCPU (`round(cpus)`), `mem_size_mib = memoryMb`, `entropy`, `InstanceStart`. Перезапуск `hostd`
VM не трогает: запись из `sandbox.json` держит `fcPid`, жива ли VM — по `/proc/<pid>/cmdline`. Сразу после запуска `jailer`
`hostd` пишет `200` в `/proc/<pid>/oom_score_adj` (значение переживает `exec` Firecracker; как у `runc`): при нехватке памяти
OOM-killer берёт VM раньше `hostd`, Caddy и sshd. Допуск (`admit`) и `memoryMb.committed` в `/v1/capacity` считают
`memoryMb + fc_overhead_mb` на каждую VM — столько же, сколько лимит её cgroup.

**Парковка и восстановление.** Бро по-прежнему сначала зовёт `POST /v1/park` worker (секреты из памяти; `closeChrome` не
шлётся: страницы живут в снимке). Затем `PATCH /vm Paused`, `PUT /snapshot/create` (Full) в chroot, VM убивается,
`vmstate`, `mem`, `profile.img`, `config.img` и `meta.json` уходят в `/srv/bro/snapshots/<id>/<поколение>/` (rename на той же
ФС; не `/dev/shm`: файл памяти — гигабайты), а в Object Storage — профиль (из копии образа: `e2fsck -fy` проигрывает журнал,
`debugfs -R "rdump / <каталог>"` читает файлы; оба — userspace, от uid самой VM, в каталоге `/srv/bro/profile-work/<id>`,
который принадлежит этому uid; образ, записанный гостем, **ядро хоста не монтирует**, а `pack` берёт только обычные файлы и
каталоги) с блоком `snapshot` в манифесте: `runtime`, `local`, `host`, `sandbox`, `generation`, версия
Firecracker, sha256 ядра, признаки CPU, версия и `image` корня, `memoryMb`, sha256 `vmstate`, размер `mem`. Ответ парковки —
`format` = этот блок, `parts` — только `profile`. Восстановление: манифест, `fits` (тот же хост, та же сборка и CPU, то же
поколение — иначе `path: cold` с причиной в `fallback`), файлы снимка на диске (размер и sha256 `vmstate`), свежие netns и
jail с теми же путями внутри, `PUT /snapshot/load` (`File`, `resume_vm`), ожидание worker; профиль из S3 не скачивается.
Снимок используется один раз (иначе две VM с одним состоянием ГСЧ) и стирается. Сбой загрузки → холодный старт с профилем
из набора. Старые снимки удаляются, их песочница восстановится холодно: старше `snapshot_ttl_days` (7; при старте `hostd`,
каждый час и при парковке), сверх бюджета `snapshot_budget_gb` (120) и — раньше проверки места, которая отвечает 507 — пока на
диске меньше, чем нужно парковке; снимок песочницы, которая сейчас стартует или паркуется, не трогают. `DELETE`
стирает и снимок. Снимок не шифруется (диск хоста — граница доверия, каталог `0700`).

**Самообновление.** `POST /v1/admin/update` `{url, sha256}`: токен с claim `scope: "update"`, подписанный `updateKey` хоста (см.
«API»; токен Бро и токен с ключом хоста ручку не открывают, а токен с `update` не проходит никуда, кроме ручек оператора).
`hostd` качает https-бандл (до 200 МБ), сверяет sha256, распаковывает в `/opt/bro/host.new` (только файлы и каталоги) и
отвечает `202`. Дальше, уже после ответа:

1. **Ждёт тишины.** Пока какая-нибудь песочница стартует, восстанавливается или паркуется, `hostd` не рестартует: новые старты и
   парковки получают `503`, идущие заканчиваются (не дольше `update_quiet_timeout_s`, 10 минут; потом обновление падает с
   понятной ошибкой в `update.json`, ничего не изменив). Рестарт посреди парковки потерял бы файлы и набор.
2. Подменяет `/opt/bro/host` (старый — `host.old`) и запускает `update.sh` нового кода.
3. `update.sh` **сначала проверяет код**, пока работает старый: `bash -n` всех скриптов, `sh -n` гостевого init,
   `python -m py_compile` всех `*.py`, импорт `caddy, firecracker, hostd, network, selfupdate, sets` и
   `Config.load('/etc/bro/hostd.json')` + `Host(...)` новым кодом — битый бандл не рестартует `hostd`, `update.sh` падает,
   старый код возвращается. Потом колёса venv (если сменились), ключ обновлений из бандла (ниже), юниты, Caddy, Firecracker.
4. **Сторож отката** (последний шаг `update.sh`): `systemd-run --on-active=15s --unit=bro-hostd-rollback-<sha[:12]>` запускает
   `rollback.sh <версия> <sha256>` из бандла. Он до ~75 с спрашивает `127.0.0.1:8090/v1/health`; норма — `hostd` новой версии
   и `update.state = done` для sha256 этого бандла (`update.json`). Иначе: останавливает `bro-hostd` (песочницы живут:
   `KillMode=process`), ставит `host.old` обратно, возвращает юнит, Caddy и бинарники Firecracker прежнего дерева, запускает
   `hostd`, пишет в `update.json` состояние `rolled-back` (новое дерево остаётся в `/opt/bro/host.failed`).
5. `systemctl --no-block restart bro-hostd`.

Итог — `/srv/bro/update.json`: `GET /v1/admin/update` отдаёт его целиком (ошибка, sha256, версия, `running`), а `/v1/health`
без токена — только `state`, `version`, `at`. Состояния: `downloaded`, `waiting`, `applying`, `restarting`, `done`, `failed`,
`rolled-back`, `rollback-failed`. Бандл — тот же tgz, что `boot.py bundle`.

**Ключ обновлений (`updateKey`).** Ключ подписи оператора — `BRO_HOST_UPDATE_SIGNING_KEY` (64 hex; у Бро его нет, храните
отдельно от `BROWSER_VM_SIGNING_KEY`). Ключ хоста — `HMAC-SHA256(ключ, "bro-browser-host-update:" + id хоста)`.

```sh
export BRO_HOST_UPDATE_SIGNING_KEY=…   # 64 hex, оператор; openssl rand -hex 32 для нового

# Новый хост: cloud-init пишет updateKey в /etc/bro/host.json (Бровский browserHostCloudInit его не пишет).
BROWSER_VM_SIGNING_KEY=… python boot.py cloud-init --host-id bro-dedicated-1 … > user-data.yaml

# Токен на 10 минут для любой ручки оператора (самообновление, лог, GET /v1/admin/update):
TOKEN=$(python boot.py token --host-id bro-dedicated-1 --scope update)
curl -H "Authorization: Bearer $TOKEN" https://<домен>/h/v1/admin/update
```

Хост, созданный до появления ключа (его `host.json` без `updateKey`), отвечает на ручки оператора `403`. Положить ключ в такой
хост можно только одним обновлением, которое несёт его в бандле (бандл этого хоста; не общий):

```sh
# 1. Бандл этого хоста с его ключом обновлений (vendor/ — как для обычного бандла); запишите sha256.
python boot.py bundle --vendor vendor/ --out host-bundle-bro-dedicated-1.tgz --enroll-update-key bro-dedicated-1
# 2. Загрузить в Object Storage, presigned GET. Старый hostd принимает scope update, подписанный ключом хоста:
#    единственный случай `--legacy-host-key` (ключ — BROWSER_VM_SIGNING_KEY). В тихое время: старый hostd не ждёт парковок.
TOKEN=$(BROWSER_VM_SIGNING_KEY=… python boot.py token --host-id bro-dedicated-1 --legacy-host-key)
curl -H "Authorization: Bearer $TOKEN" -d '{"url": "<presigned GET>", "sha256": "<sha256>"}' https://<домен>/h/v1/admin/update
# 3. Когда `GET /h/v1/health` покажет update.state = done: ключ на месте. Проверить новым токеном и удалить бандл из хранилища.
TOKEN=$(python boot.py token --host-id bro-dedicated-1)   # BRO_HOST_UPDATE_SIGNING_KEY в env
curl -H "Authorization: Bearer $TOKEN" https://<домен>/h/v1/admin/update
```

`update.sh` этого бандла дописывает `updateKey` в `/etc/bro/host.json` (0600, атомарно) и стирает `enroll/update-key` из дерева.
Так же ключ ротируется. После этого шага токен, подписанный ключом хоста (то есть всё, что может подписать Бро), ручки
оператора не открывает.

## Тесты

```sh
pip install aiohttp cryptography   # если их нет; системный cryptography Ubuntu бывает сломан — ставьте свой
cd browser-vm/host && python -m unittest   # 3.10 (как на хосте) и новее; в CI — задача browser-vm
```
