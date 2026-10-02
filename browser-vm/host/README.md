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

Тесты — на поддельных `runc`, `runsc`, `mount`, `ip`, `nft`, `zstd`, `caddy` и
S3; `runc` проверен и на настоящих VM (этап 2, 30.09, ниже и раздел 2
`docs/browser-pool.md`), `runsc` на хосте пула — нет.

| Файл               | Что это                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `hostd.py`         | HTTP API на `127.0.0.1:8090` за Caddy (`/h/…`), жизненный цикл песочниц, один `Runner` для команд              |
| `network.py`       | Сеть песочниц: netns, veth, транзитные адреса, правила nftables хоста и роутера — единственный модуль          |
| `sets.py`          | Наборы: zstd-части, AES-256-GCM по чанкам, манифест с HMAC, параллельные PUT/GET по presigned URL              |
| `caddy.py`         | Caddyfile хоста: `/g/<id>/*` → worker (префикс — в `X-Forwarded-Prefix`), `/h/*` → `hostd`, admin — unix-сокет |
| `seccomp.json`     | seccomp песочницы `runc`: всё, кроме путей побега из контейнера; user namespace для Chrome разрешены           |
| `provision.sh`     | Установка хоста на стоковой Ubuntu 22.04: apt с зеркала, runc (или runsc), Caddy и venv из бандла              |
| `boot.py`          | Сбор вендора (Caddy, колёса), бандл кода хоста и cloud-init одного хоста                                       |
| `vendor.json`      | Закреплённый Caddy: URL релиза, sha256 архива и бинарника; платформа колёс                                     |
| `requirements.txt` | Колёса `hostd` под Python 3.10 x86_64 с sha256 каждого (сверены с PyPI)                                        |
| `test_hostd.py`    | Тесты `hostd`, сети, шифрования под обеими средами (нужны aiohttp и cryptography, root не нужен)               |
| `test_boot.py`     | Тесты cloud-init, бандла и пинов, скрипта загрузки и инвариантов `provision.sh` (только stdlib)                |

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

| Метод и путь                            | Что делает                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                        | без токена: версия `hostd`, `runtime` и `runtimeVersion`, `runsc` (только под gVisor), стадия загрузки                                |
| `GET /v1/capacity`                      | память (и сумма лимитов), `/dev/shm`, диск, песочницы (состояние, лимит и занятая память), CPU, среда, `snapshotFormat` (runc — null) |
| `POST /v1/sandboxes`                    | `{id, workspace, generation, memoryMb?, workerKey, rootfsVersion, restore? \| profile?}` — старт, восстановление или холодный старт   |
| `GET /v1/sandboxes/<id>`                | запись песочницы (`state`, `runtime`, `path`: `fresh`, `restored`, `cold`, `adopted`; `fallback` — почему не снимок)                  |
| `DELETE /v1/sandboxes/<id>?generation=` | остановить, размонтировать корень, стереть каталог хоста, снимок, netns и маршрут (502, если не вышло)                                |
| `POST /v1/sandboxes/<id>/park`          | `{generation, dataKey, upload: {chunkUrls, manifestUrl}}` → размеры, время, среда, формат снимка (507 — нет места)                    |

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

## Тесты

```sh
pip install aiohttp cryptography   # если их нет; системный cryptography Ubuntu бывает сломан — ставьте свой
cd browser-vm/host && python -m unittest   # 3.10 (как на хосте) и новее; в CI — задача browser-vm
```
