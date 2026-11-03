# Совместный сервер: приложение и база рядом с браузером и песочницами

Цель: один выделенный сервер Selectel держит браузерный хост, хост песочниц кода, сам Бро (eve, web, deployd)
и PostgreSQL 18. Сейчас приложение живёт на VM `bro-app-sel-2`, база — в управляемом кластере; сервер меняют
на дешевле, и вместе с ним переезжают приложение и база.

Статус: инструкция и код проверены тестами и на локальной сборке user data (`scripts/cloudru-app-host/host/test_host.py`),
но ни одна часть не запускалась на настоящем сервере. Перед переездом пройдите раздел «Что не решено».

## Что стоит на сервере

Три хоста, каждый своим загрузочным скриптом, в одном user data (`scripts/selectel/user_data.py` склеивает
`write_files` и `runcmd` в порядке аргументов):

| Хост                                       | Скрипт                                                                                             | Флаги совместного сервера                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| браузерный хост (hostd, Firecracker)       | `browser-vm/host/boot.py cloud-init`                                                               | `--runtime firecracker --domain <имя> --memory-limit-mb N`   |
| хост песочниц кода (sandboxd)              | `scripts/cloudru-code-host/host.py user-data NAME --domain code.<ip>.sslip.io --memory-limit-mb N` | `--shared-caddy` задаёт сам скрипт (в user data)             |
| приложение (eve, web, deployd, PostgreSQL) | `scripts/cloudru-app-host/host/boot.py cloud-init`                                                 | `--shared-caddy --local-postgres --domain ops.<ip>.sslip.io` |

Порядок в `user_data.py` — порядок `runcmd`: сначала браузерный хост (он ставит Caddy и создаёт
`/run/caddy/admin.sock`), затем песочницы, затем приложение. Песочницы и приложение ждут Caddy браузерного хоста
(до 30 и 10 минут), поэтому порядок важен.

Приложение получает ключ deployd так же, как VM: `HMAC-SHA256(DEPLOY_SIGNING_KEY, "bro-app-host:" + имя)`.
Команда:

```sh
DEPLOY_SIGNING_KEY=… python3 scripts/cloudru-app-host/host/boot.py cloud-init \
  --host-id bro-app-sel-3 --bundle-url "$BUNDLE_URL" --bundle-sha256 "$BUNDLE_SHA" \
  --objects objects.json --domain ops.<ip с дефисами>.sslip.io --shared-caddy --local-postgres > app.yaml
```

`objects.json` — `{имя файла из vendor.json: {"url": <presigned GET>, "sha256": <pin>}}` для Node и пакетов
клиента PostgreSQL. Bundle и объекты загружаются, как для VM (`host.py` через `boot.bundle` и `vendor`).

Флаги по умолчанию выключены, и тогда загрузка приложения делает то же, что раньше, — только `runcmd` стал
набором слов, а лог пишет сам скрипт (иначе `user_data.py` его не пропустит).

Склейка и проверка:

```sh
python3 scripts/selectel/user_data.py browser.yaml code.yaml app.yaml > server.yaml
```

`user_data.py` принимает только `write_files` и `runcmd`. Поэтому `chpasswd` (пароль root на консоли) через склейку
не проходит: см. «Что не решено».

## Память

Лимиты хостов — потолки, а не резервы: сумма потолков плюс запас не должна превышать память сервера. Браузерный хост
(hostd) с `--memory-limit-mb` отдаёт песочницам не больше этого потолка (отказ 507, `Refused` в `hostd.py`); без него —
`MemTotal − reserve_mb` (1024), и тогда приложение в расчёт не входит. Поэтому потолок задавайте всегда.

Приложение (юниты `bro-eve` и `bro-web` с кучей `--max-old-space-size=1280` и `640`) и PostgreSQL
(`shared_buffers = 512MB`, `work_mem = 8MB`, `max_connections = 100`) с рабочей памятью и `pg_dump`:
около 4,5 ГБ. Caddy и deployd — сотни МБ.

| Память сервера | reserve (ОС, Caddy, tg-egress, deployd) | приложение + PostgreSQL | браузерный хост `--memory-limit-mb` | песочницы кода `--memory-limit-mb` | запас |
| -------------- | --------------------------------------- | ----------------------- | ----------------------------------- | ---------------------------------- | ----- |
| 16 ГБ          | 1536                                    | ~4608                   | 5120                                | 3072                               | ~2 ГБ |
| 32 ГБ          | 2048                                    | ~6144                   | 16384                               | 6144                               | ~2 ГБ |

Это расчёт, а не замер. Проверьте после загрузки `free -m` и `systemctl status bro-eve bro-web`: ни один юнит не должен
сидеть в OOM, а `hostd` не должен отвечать 507 раньше своего потолка.

## Миграция с VM

Порядок важен: Telegram держит обновления 24 часа, пока мост на паузе (`tg-bridge.sh hold`).

1. Новый сервер поднят и прошёл `stage ready` на всех трёх хостах (`/var/lib/bro/stage`, `/var/log/bro-provision.log`).
   В `/var/lib/bro/domain` приложения — `ops.<ip>.sslip.io`.
2. Снимите список сайтов и версию релиза на VM: `host.py status NAME`, `host.py sites NAME`.
3. Заморозьте Telegram: `host.py ops NAME tg-bridge.sh hold`.
4. Остановите писателей на VM: `host.py stop NAME bro-eve bro-web` (плановая остановка, вотчдог три часа не будит).
5. Базу `app` на VM сохраните тем же скриптом, что ночной бэкап: `host.py ops NAME db-backup.sh` (зашифрованный
   дамп и манифест в Object Storage).
6. Базу `bro_workflow` (мир eve: история сессий, очередь ходов) `db-backup.sh` не берёт, а `db-restore.sh`
   отказывает ей. Сохраните её вручную: `pg_dump --format=custom` с `WORKFLOW_POSTGRES_URL` (на VM, eve остановлен),
   зашифруйте `BACKUP_ENCRYPTION_KEY` и положите рядом с ночными дампами. Что именно — решает оператор при переезде.
7. Env приложения (`/etc/bro/env`) живёт только на VM (`docs/dev-notes.md`, «Env прода правьте только на VM»).
   Снимите его ops-скриптом через Object Storage (не в журнал задания), замените `DATABASE_URL`,
   `DATABASE_URL_UNPOOLED` и `WORKFLOW_POSTGRES_URL` на локальные (`postgres://bro:…@localhost:5432/bro` и
   `…/bro_workflow`, пароли — из `/etc/bro/postgres.json` нового сервера), затем на новом сервере
   `PUT /ops/v1/env` с `{"env": {…}}` (deployd заменяет файл целиком; проверьте, что нет лишних имён).
8. Выкатите тот же релиз: `host.py deploy NAME --version <версия с VM>` (`status` покажет её на VM): `db-restore.sh` и
   прочие ops-скрипты берутся из текущего релиза, до выката их на сервере нет. Выкат накатит миграции на пустую базу и
   запустит eve и web.
9. Сразу остановите их (`host.py stop NAME bro-eve bro-web`): `db-restore.sh` требует, чтобы Бро на базе не работал.
   Восстановите `app`: `host.py ops NAME db-restore.sh latest app`; мир — вручную, как шаг 6, с `pg_restore` в
   пустой `bro_workflow` (перед ним `DROP`/`CREATE` базы мира, раз выкат её уже наполнил). Затем
   `host.py restart NAME bro-eve bro-web` (команды `start` у `host.py` нет).
10. Сайты: `host.py sites NAME --set <список с VM>`.
11. Проверки на новом сервере: `GET https://ops.<ip>.sslip.io/ops/v1/health`, `host.py status NAME`, `host.py logs NAME bro-eve`
    (строки `[eve] turn start`, без ошибок миграции), ход в тестовом аккаунте.
12. DNS: A-записи `@` и `www` на IP нового сервера (TTL заранее 60; записи Vercel DNS, см. `docs/dev-notes.md`).
    Сертификаты Caddy выпустятся на первом запросе, когда DNS уже указывает на новый IP.
13. Мост Telegram: `host.py ops NAME tg-bridge.sh switch-to-bridge` на новом сервере, только когда eve здоров
    (скрипт сам проверит tg-egress и здоровье eve).
14. Бэкап на новом сервере: `host.py ops NAME db-backup.sh` и `db-restore-check.sh` (восстановление в проверочную базу).
15. Старую VM и управляемый кластер не удаляйте несколько дней: VM выключена (`stop`), кластер только для чтения.
    Удаление — решение владельца (`docs/dev-notes.md`, правила удаления ресурсов).

Откат: до шага 13 Telegram ещё на паузе, DNS — на VM (вернуть A-записи), VM поднимается `restart`, мир и база на VM
не менялись. После шага 13 откат — тот же переезд в обратную сторону.

## Что не решено

- **Нет консоли для обновлений кода.** У выделенного сервера нет консоли, которую умеет `host.py update-host`
  (он идёт через VNC VM Selectel). Код deployd, provision и egress на сервере меняется только переустановкой:
  новым сервером. Обновление браузерного хоста через `POST /v1/admin/update` сюда не относится.
- **Диск.** RAID1 переживает отказ одного диска, но не ошибку в данных и не удаление. Потеря данных — с последнего
  бэкапа: ночной дамп `app` (`bro-backup.timer`), в лучшем случае сутки. `bro_workflow` в ночном бэкапе нет
  (шаг 6): при отказе диска мир потерян. Добавить его в бэкап — отдельная задача.
- **Пароль консоли.** `scripts/selectel/user_data.py` не пропускает `chpasswd`, поэтому root без пароля на
  консоли: тот же класс проблемы, что у `bro-app-sel-2` (`docs/dev-notes.md`, cloud-init 21.3). Задайте пароль
  вручную на загруженном сервере или расширьте `user_data.py` осознанно.
- **Память не ограничена.** Юниты приложения не имеют `MemoryMax`: вышедший за кучу `bro-eve` может задеть соседей.
  Лимит ставится после замера `MemoryPeak` (`docs/dev-notes.md`, «Память VM»).
- **Caddy браузерного хоста.** Перезапуск `caddy` из deployd на общем сервере отказан (это Caddy браузерного
  хоста). Файл сайта проверяется только перезагрузкой: неверный файл откатывается, но `caddy validate` не запускается.
- **Непроверено на сервере.** Сборка bundle с новым provision, установка PostgreSQL 18 из PGDG на Ubuntu 22.04,
  загрузка приложения за Caddy браузерного хоста. Отпечаток ключа PGDG (`B97B 0AFC AA1A 47F0 44F2 44A0 7FCC 7D46 ACCC 4CF8`)
  в `provision.sh` сверьте с официальной страницей PostgreSQL до первого запуска: если он не совпадает, установка
  остановится на `the PGDG key`.
- **Доступ к локальной базе.** `pg_hba` Debian пускает системного пользователя `bro` по сокету в роль `bro` без пароля
  (`peer`). Это роль самого приложения, суперпользователя там нет; `postgres` по сокету доступен только root.
