# tg-egress: выход к api.telegram.org с VM Cloud.ru

С VM Cloud.ru (проба 02.10.2026, `ru.AZ-1`) адрес, который DNS даёт для
`api.telegram.org` (149.154.166.110), не принимает ни одного TCP-соединения.
Вся остальная подсеть Telegram тоже закрыта, кроме 149.154.167.220: это
настоящий `api.telegram.org` (сертификат Go Daddy на `api.telegram.org`). Но и
он теряет примерно каждый шестой SYN: соединение либо открывается за ~50 мс,
либо не открывается совсем (78–85% успеха на попытку). Так ходят все, кто зовёт
Bot API с VM: канал Telegram в eve, `agent/lib/owner-alert.ts`,
`agent/lib/inbound-media/telegram.ts` и сторож VM (`watchdog.py`, urllib).

```
процесс ──▶ api.telegram.org = 127.77.0.1 (/etc/hosts)
        ──▶ 127.77.0.1:443 ── iptables nat OUTPUT REDIRECT ──▶ 127.0.0.1:7443 tg_egress.py
        ──▶ 149.154.167.220:443 (попытка каждые 300 мс, до 3 сразу, первая открывшаяся — победитель)
        └─▶ CONNECT через HTTP-прокси, если задан TG_EGRESS_PROXY (через 1,5 с)
```

Форвардер TLS не расшифровывает: SNI, сертификат и токен бота идут насквозь,
сертификат проверяет сам клиент. Байты клиента он не читает, пока нет
соединения с Telegram, поэтому для клиента пропавший SYN — это лишние 300 мс, а
не таймаут. Код eve и Бро не меняется.

| Файл                    | Что                                                                     |
| ----------------------- | ----------------------------------------------------------------------- |
| `tg_egress.py`          | форвардер (Python 3.10, stdlib), `--check` — запрос к Telegram по имени |
| `setup.sh`              | строка в `/etc/hosts` и правило REDIRECT; идемпотентен, `--remove`      |
| `bro-tg-egress.service` | `DynamicUser`, перед стартом `setup.sh` от root (`ExecStartPre=+`)      |
| `test_tg_egress.py`     | `python3 -m unittest` (CI: шаг «Telegram egress of the app host»)       |

## Почему REDIRECT, а не 127.x:443

Caddy на VM слушает `:443` на всех адресах. Linux не даёт открыть
`127.77.0.1:443` рядом с таким сокетом (`EADDRINUSE` у любого, кто пришёл
вторым), поэтому форвардер слушает `127.0.0.1:7443`, а соединения на
`127.77.0.1:443` туда переводит правило в `nat OUTPUT`. Caddy менять не нужно.
Если когда-нибудь понадобится без iptables — Caddy слушает только приватный IP
и loopback (`default_bind 10.0.1.x 127.0.0.1` в глобальном блоке Caddyfile), а
форвардер — `127.77.0.1:443`.

Правило в цепочке `nat`, а `egress.sh` сервера фильтрует `OUTPUT` пользователя
`bro` в `filter`: порт 7443 там не закрыт, порт `deployd` (8095) остаётся
закрытым.

## Установка (provision.sh сервера)

```sh
install -d /opt/bro/tg-egress
install -m 644 tg_egress.py bro-tg-egress.service /opt/bro/tg-egress/
install -m 755 setup.sh /opt/bro/tg-egress/
install -m 644 /opt/bro/tg-egress/bro-tg-egress.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now bro-tg-egress
python3 /opt/bro/tg-egress/tg_egress.py --check   # ok — api.telegram.org по имени, как у клиентов
```

`bro-eve`, `bro-web` и `bro-watchdog` стоит запускать после него
(`After=bro-tg-egress.service`; юнит сам ставит `Before=` на них). Юнит —
`Type=notify`: форвардер сообщает systemd о готовности, когда оба порта уже
слушают, и только тогда стартуют сервисы после него.

`--check` идёт к `api.telegram.org` по имени, как любой клиент: строка в
`/etc/hosts`, правило REDIRECT, форвардер, Telegram. Он падает и тогда, когда
пропала строка (её может переписать cloud-init) или правило (сброс iptables),
хотя сам форвардер жив; `--check-listener` проверяет форвардер напрямую. Этот
`--check` (код выхода) должны звать проверка после выката и сторож VM
(`watchdog.py` сервера) с тревогой не через Telegram: тревога владельцу в
Telegram идёт тем же путём. При сбое `--check` сторожу достаточно
`systemctl restart bro-tg-egress` — `setup.sh` вернёт строку и правило.

Здоровье: `curl -s 127.0.0.1:7444/health` — счётчики по адресам, доля успехов
последних 200 соединений, `down`; 503, если доля ниже 90% или путь лежит. Лог —
`journalctl -u bro-tg-egress`: одна строка на соединение (путь, попытки, время
до Telegram, байты), без адресов запросов и секретов; `upstream down` /
`upstream back` — смена состояния.

Соединение, где байты не шли ни в одну сторону `TG_EGRESS_IDLE_S` (180 с),
закрывается; когда одна сторона закрылась, другой дано `TG_EGRESS_LINGER_S`
(20 с); больше `TG_EGRESS_MAX_CONNECTIONS` (256) разом не держится. Сеть здесь
теряет потоки молча, и без этого мёртвые соединения жили бы часами.

## Настройки

`/etc/bro/tg-egress.env` (необязателен, `0600`): `TG_EGRESS_UPSTREAMS`
(адреса через запятую, по умолчанию 149.154.167.220), `TG_EGRESS_ATTEMPT_MS`,
`TG_EGRESS_STAGGER_MS`, `TG_EGRESS_PARALLEL`, `TG_EGRESS_DEADLINE_MS` и запасной
путь `TG_EGRESS_PROXY` (`http://<login>:<password>@<host>:<port>` или `host:port:user:pass`)
с `TG_EGRESS_PROXY_AFTER_MS`; `TG_EGRESS_STAGGER_MS` — больше нуля. Ещё:
`TG_EGRESS_HEALTH` (127.0.0.1:7444, где `/health`), `TG_EGRESS_TARGET`
(api.telegram.org:443 — куда просить `CONNECT` у прокси и куда ходит
`--check`), `TG_EGRESS_DOWN_AFTER` (5 соединений подряд без Telegram — путь
лежит) и `TG_EGRESS_DOWN_DEADLINE_MS` (4000 — сколько ждёт соединение, пока
путь лежит). Порт правила REDIRECT `setup.sh` берёт из
`TG_EGRESS_LISTEN` того же файла и убирает правила на прежний порт.

Прокси с VM не проверен (боевые ключи Geonode на пробную VM не попадали):
Geonode резидентский и платный за трафик, страна — сегмент
`type-residential-country-<код>` в логине, порты 9000 (ротация) и 10000
(sticky). Без нужды не включать; если 149.154.167.220 закроют совсем —
сначала проверить его на VM (`curl -x` к `getMe` и `ipinfo.io/json`).

## Если адрес закрыли

Признаки: `upstream down` в журнале, `/health` — 503 с `"down": true`,
`--check` падает. Пока путь лежит, соединение ждёт 4 с, а не 12, и прокси (если
задан) идёт сразу. Что делать:

1. С VM найти живой адрес: `curl -sv --connect-timeout 5 --resolve
api.telegram.org:443:<адрес> https://api.telegram.org/` по адресам из
   149.154.160.0/20 и 91.108.0.0/16 — по одному, с паузой (сеть Cloud.ru рвётся
   от пачки соединений).
2. Вписать его в `TG_EGRESS_UPSTREAMS` в `/etc/bro/tg-egress.env` (можно
   несколько через запятую) или задать `TG_EGRESS_PROXY`.
3. `systemctl restart bro-tg-egress`, затем `tg_egress.py --check` и
   `curl -s 127.0.0.1:7444/health`.

## Проверка на VM (02.10.2026)

Пробная VM `low-1-1` в `ru.AZ-1` (ubuntu 22.04, Python 3.10, systemd 249),
юнит из этого каталога, токен поддельный (`getMe` отвечает 401, когда запрос
дошёл до Bot API), запросы по одному с паузой 1 с:

| Путь                                     | Успех     | p50    | p90    | максимум |
| ---------------------------------------- | --------- | ------ | ------ | -------- |
| `curl` через `/etc/hosts` и форвардер    | 200 / 200 | 0,15 с | 0,46 с | 2,15 с   |
| Python urllib (путь `watchdog.py`)       | 20 / 20   | 0,15 с | 0,44 с | 0,45 с   |
| напрямую на 149.154.167.220, таймаут 5 с | 54 / 60   | 0,18 с | 0,20 с | —        |

Форвардер: 221 соединение, 170 открылись с первой попытки, 37 — со второй,
10 — с третьей, 4 — с четвёртой, ни одно не потеряно. Четвёртая попытка ждёт,
пока освободится слот (`TG_EGRESS_ATTEMPT_MS`, 2 с): отсюда максимум ~2 с.
Пропавший SYN Linux повторяет лишь через 1 с, так что
`TG_EGRESS_ATTEMPT_MS=1000` и `TG_EGRESS_PARALLEL=4` срежут хвост до ~1 с
(на VM не проверено).
