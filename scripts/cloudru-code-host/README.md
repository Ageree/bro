# Хост исполнительной песочницы на Cloud.ru

Операторские скрипты хоста `sandboxd` (`sandbox/README.md`): ключи, артефакты в
Object Storage, VM и проверка живого хоста настоящими токенами. Сам хост — это
стоковая `ubuntu-22.04` и cloud-init из `sandbox/host/boot.py`; корень песочницы
собирает `sandbox/image/build_rootfs.sh`. Compute API, serial-консоль и подпись
S3 — из стенда `scripts/cloudru-sandbox-probe/` (`cloudru.py`, `console.py`,
`s3.py`), их кэши — в `~/.bro-code-host`.

| Файл           | Что делает                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `host.py`      | `key`, `deliver`, `create`, `status`, `update-sandboxd`, `set-hosts`, `reboot`, `delete` (справка — `-h`) |
| `e2e.py`       | Сквозная проверка живого `sandboxd`: токены, песочница, exec, файлы, офис, сеть, снимок, восстановление   |
| `test_host.py` | `python3 -m unittest`: `set-hosts` пропускает в строку root только проверенные имена и адреса             |

Нужны `CLOUDRU_KEY_ID`, `CLOUDRU_KEY_SECRET`, `CLOUDRU_S3_TENANT_ID` (значения
чистятся от пробелов и кавычек, как в стенде), для `status --stage` —
`pip install websocket-client`. Бакет — `bucket-ac164a` (`PROBE_BUCKET`), зона,
подсеть и группа — `CLOUDRU_ZONE`, `CLOUDRU_SUBNET`, `CLOUDRU_SECURITY_GROUP`
(по умолчанию `ru.AZ-1`, `Default_ru.AZ-1`, `bro-browser-az1`: вход tcp 80/443).
Скрипт трогает только VM с именами `sbx-…`: в проекте живут хосты пула
`bro-host-*` и пробные VM других сессий.

## Ключи

`python scripts/cloudru-code-host/host.py key sbx-code-1` один раз создаёт
`SANDBOX_SIGNING_KEY` (32 случайных байта hex) в `~/.bro-code-host/signing.json`
и пишет ключ хоста в `~/.bro-code-host/sbx-code-1.json` — оба `0600`, вне репозитория. Ключ хоста —
`HMAC-SHA256(SANDBOX_SIGNING_KEY, "bro-sandbox-host:" + id хоста)`, как его
выводит Бро (`sandboxHostKey` в `agent/lib/sandbox/keys.ts`), поэтому Бро
хватает того же `SANDBOX_SIGNING_KEY` в env, `SANDBOX_HOST_ID=sbx-code-1` и
`SANDBOX_HOST_ORIGIN=https://<ip с дефисами>.sslip.io`. Смена ключа подписи —
новые ключи всех хостов, то есть пересоздание хостов, и нечитаемые снимки
(ключ снимка Бро тоже выводит из него).

## Выкладка

```sh
sandbox/image/build_rootfs.sh build sandbox/tools/target/x86_64-unknown-linux-musl/release/tools
python sandbox/host/boot.py vendor --dir ~/.bro-code-host/vendor      # Caddy и пакет runsc по пинам vendor.json
(cd sandbox/sandboxd && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o ~/.bro-code-host/build/sandboxd .)
python scripts/cloudru-code-host/host.py deliver --sandboxd ~/.bro-code-host/build/sandboxd \
  --rootfs sandbox/image/out/rootfs-<версия>.tar.zst
python scripts/cloudru-code-host/host.py create sbx-code-1             # gen-2-8, диск 30 ГБ
python scripts/cloudru-code-host/e2e.py sbx-code-1
```

В Object Storage:

| Ключ                                  | Что                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `sandbox/rootfs/<версия>.tar.zst`     | корень песочницы и рядом `.sha256`; `.manifest.txt` остаётся локально             |
| `sandbox/runsc/runsc-<версия>.deb`    | пакет датированного выпуска gVisor из его apt-репозитория                         |
| `sandbox/host/code-host-<sha256>.tgz` | бандл: `provision.sh`, `fetch.py`, `sandboxd` и его юнит, Caddy                   |
| `sandbox/workspaces/…`                | снимки `/workspace` (Бро; `e2e.py` пишет `e2e-<хост>-<песочница>.snap` и стирает) |

`deliver` печатает ссылки без подписи; целиком — только с `--print-urls`.
`create` подписывает ссылки на 12 часов (cloud-init отрабатывает один раз), ждёт
`running` и затем `https://<ip с дефисами>.sslip.io/v1/health`. Здесь и ниже
`host.py` — это `python scripts/cloudru-code-host/host.py` из корня репозитория.
Стадию установки видно через serial-консоль: `host.py status sbx-code-1 --stage`
(пароль root — в `~/.bro-code-host/sbx-code-1.password`, в user data — только
хэш; SSH нет). Первая загрузка иногда встаёт в `(initramfs)` и молчит —
`host.py reboot sbx-code-1`.

Новый `sandboxd` на живом хосте — `host.py update-sandboxd sbx-code-1 --sandboxd
<бинарник>`: бинарник едет через S3, консоль сверяет SHA-256, подменяет и
перезапускает сервис; живые песочницы переживают перезапуск (их подхватывает
новый `sandboxd`). Затем `deliver`, чтобы новые хосты взяли тот же бинарник.

## Как ставится хост

`bro-code-host-boot` из cloud-init ждёт сеть (в `ru.AZ-1` её нет первые ≈ 3
минуты), скачивает бандл, сверяет SHA-256 и запускает `provision.sh`: apt с
`mirror.yandex.ru` (`curl`, `zstd`), `runsc` из пакета в S3 (сверка SHA-256,
`release-<дата>` в `runsc --version`, `apt-mark hold`), Caddy с Let's Encrypt
на `<ip с дефисами>.sslip.io` (админка — только unix-сокет,
`flush_interval -1` для потока NDJSON), корень — параллельными ranged GET
(`fetch.py`) в `/srv/sandboxd/rootfs/<версия>` через скрытый `.partial`, затем
`sandboxd` и его юнит. Стадии — `/var/lib/bro/stage` и `timeline`, лог —
`/var/log/bro-provision.log`. Конфиг `sandboxd` (`host`, `key`,
`rootfs_version`) кладёт cloud-init в `/etc/bro/sandboxd.json` (`0600`).
`--runsc-url` в `boot.py cloud-init` обязателен: хост ставит `runsc` только из
Object Storage (`host.py create` всегда даёт ссылку), apt-репозиторий gVisor
(`storage.googleapis.com`) с Cloud.ru не проверен.

## Адрес Бро на хосте

`sandboxd` зовёт роутер инструментов Бро по имени (`/eve/v1/sandbox-tools` на
`brobro.tech`), а VM проекта не достаёт до публичного IP другой VM проекта.
Поэтому домен Бро на хосте закреплён за приватным адресом VM Бро: новый хост
— `create … --hosts-entry brobro.tech=bro-app-1 --hosts-entry
cloud.brobro.tech=bro-app-1`, живой хост — та же пара через serial-консоль,
без пересоздания:

```sh
host.py set-hosts sbx-code-2 --hosts-entry brobro.tech=bro-app-1 --hosts-entry cloud.brobro.tech=bro-app-1
```

`bro-app-1` скрипт читает как приватный адрес VM из Compute API (можно и
IPv4). Имя и адрес проверяются, как в cloud-init (`boot.check_hosts`: простое
имя без повторов, IPv4 из ASCII-цифр), и каждое значение экранировано: в
строку root на хосте не попадает ничего, кроме них. Команда идемпотентна:
убирает прежние строки `# bro-private` и любые строки с этими именами и
дописывает по строке на имя — в `/etc/hosts` и в шаблон cloud-init
`hosts.debian.tmpl` (если образ перепишет `/etc/hosts` при загрузке).
Печатает только число строк `bro-private`; ждать `2`. Проверка с хоста —
`curl -sS https://brobro.tech/eve/v1/health` через `console.py run`.
`sbx-code-2` создан до `--hosts-entry`: на нём это шаг выкладки, до
переключения домена (раздел «Переключение» `docs/cloudru-migration.md`).
