# Стенд песочниц браузера на Cloud.ru

Проверки к `docs/browser-pool.md`: сколько теряет Chrome под gVisor, можно ли
заморозить уже запущенный Chrome и поднять его в новой песочнице, как быстро
Object Storage отдаёт снимок. Сюда же попали проверки Firecracker внутри VM
Evolution (29.09): технически он там запускается, но поддержка Cloud.ru
ответила, что вложенной виртуализации в Evolution нет и пользоваться ею
нельзя, — эти скрипты оставлены как история, для Bare Metal. Это
стенд, не код Бро и не пилот `scripts/cloudru-browser-pilot/`: без личных
данных и без продовых ключей. Этап 1 (30.09) гоняет уже наш образ — корень
песочницы из `browser-vm/image/sandbox` с worker и browser-use.

| Файл                      | Что делает                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `cloudru.py`              | Compute API: квоты, список, цены флейворов, создание и удаление пробной VM (вместе с её IP)              |
| `console.py`              | Команды на VM через serial-консоль Cloud.ru (вход root по паролю из cloud-init) и заливка скриптов       |
| `vm/check_kvm.sh`         | Флаги `vmx`/`svm`, `/dev/kvm`, `nested`                                                                  |
| `vm/chrome_bench.sh`      | Ставит Chrome и gVisor; Chrome без изоляции против `runsc do`, лёгкая и тяжёлая страница; `fio`          |
| `vm/gvisor_checkpoint.sh` | Chrome в песочнице gVisor со своим netns: `runsc checkpoint`, zstd, `runsc restore`, те же вкладки       |
| `vm/firecracker_setup.sh` | Firecracker 1.10.1, ядро 6.1 из CI Firecracker, rootfs гостя — копия этой VM с Chrome, tap0 и NAT        |
| `vm/guest_init.sh`        | PID 1 гостя: сеть, замеры Chrome, живой Chrome с CDP и цикл `ALIVE` для проверки снимка                  |
| `vm/snapshot_bench.sh`    | Загрузка гостя, пауза, полный снимок, zstd, восстановление в новом процессе Firecracker                  |
| `s3.py`                   | Object Storage из сессии: подписанные ссылки (SigV4), список, удаление по префиксу                       |
| `deliver.py`              | Стенд, ключ RouterAI и мастер-ключ наборов на VM через S3; ссылки на части наборов для `state.py`        |
| `verify_wheels.py`        | Сверка sha256 колёс с зеркала PyPI с самим PyPI и пины `--require-hashes`, без которых корень не собрать |
| `vm/host_setup.sh`        | Хост этапа 1: `runsc`, zstd, NAT для 10.200.0.0/16, выход песочниц, прокси-заглушка на :3130             |
| `vm/wheels.sh`            | python3.11 Ubuntu и колёса с зеркала для корня песочницы, когда GitHub и PyPI не отвечают                |
| `vm/sandbox.sh`           | Песочница из корня `browser-vm/image/sandbox`: gVisor, без gVisor, восстановление, стоп                  |
| `vm/proxy.py`             | HTTP-прокси на хосте вместо резидентского (выход — адрес Cloud.ru)                                       |
| `vm/bench.py`             | Драйвер worker (токены как у Бро): RU-набор, WB и Avito, форма, проверка после восстановления, память    |
| `vm/state.py`             | Парковка и восстановление: checkpoint, tar, zstd, AES-256-GCM, части в S3, манифест последним            |
| `vm/full.sh`              | Сравнение: без gVisor, затем gVisor, каждый с пустым профилем                                            |
| `vm/rootfs_build.sh`      | Этап 2: колёса с зеркала и корень песочницы в архив для S3 (`build_rootfs.sh` в режиме ARCHIVE)          |
| `pool.py`                 | Этап 2: хост пула как у Бро (cloud-init `boot.py`), API `hostd` и worker по HTTPS, парковка, наборы      |
| `vm/pool_inspect.sh`      | Этап 2, на хосте: `runc state`, cgroup, монтирования, namespace и seccomp процессов Chrome, лог          |
| `vm/leak.py`              | Этап 2, изнутри песочницы: TCP до соседки, хоста, VPC, metadata — отказ сразу или таймаут                |

Нужны `CLOUDRU_KEY_ID`, `CLOUDRU_KEY_SECRET` и `pip install websocket-client`;
для этапа 1 ещё `CLOUDRU_S3_TENANT_ID` и `ROUTERAI_API_KEY`.
Пароль root и кэш токена — в `$PROBE_STATE_DIR` (по умолчанию `~/.bro-probe`),
вне репозитория.

## Порядок

```sh
python cloudru.py usage                       # хватит ли квоты: VM gen-2-4 — 2 vCPU и публичный IP
python cloudru.py create probe-kvm            # ≈ 1,5 минуты до running, ещё ≈ минута до входа в консоль
until python console.py run probe-kvm 'cloud-init status' | grep -q done; do sleep 10; done
for f in check_kvm chrome_bench gvisor_checkpoint firecracker_setup guest_init snapshot_bench; do
  python console.py push probe-kvm vm/$f.sh /root/$f.sh
done
python console.py run probe-kvm 'bash /root/check_kvm.sh'
python console.py run probe-kvm 'bash /root/chrome_bench.sh > /root/c.log 2>&1; tail -20 /root/c.log' --timeout 600
python console.py run probe-kvm 'bash /root/gvisor_checkpoint.sh > /root/g.log 2>&1 < /dev/null; tail -12 /root/g.log' --timeout 300
python console.py run probe-kvm 'bash /root/firecracker_setup.sh > /root/f.log 2>&1; bash /root/snapshot_bench.sh 1024 /dev/shm' --timeout 600
python cloudru.py delete probe-kvm            # VM и её публичный IP: без явного удаления IP остаётся в счёте
```

Весь прогон — около 15 минут и 1 ₽. Имена пробных VM не начинайте с `bro-`,
чтобы не пересекаться с продом и пилотом.

## Этап 1: наш образ в песочнице

Ключ Cloud.ru на VM не попадает: VM получает от сессии подписанные ссылки на
объекты `probe/stage1/…` (`deliver.py`). Ключ worker стенд делает сам
(`openssl rand`), ключ продового `BROWSER_VM_SIGNING_KEY` не нужен.

```sh
python cloudru.py usage && python cloudru.py create probe-s1 --flavor gen-2-8 --disk 30
python deliver.py probe-s1                          # /root/stand, /root/.routerai, /root/.state-key
python console.py run probe-s1 'bash /root/stand/vm/host_setup.sh > /root/host.log 2>&1'
python console.py run probe-s1 'bash /root/stand/vm/wheels.sh download'          # если PyPI молчит
python console.py run probe-s1 'cat /srv/bro/wheels.sha256' > w.sha256 && python verify_wheels.py w.sha256 req.txt
python console.py push probe-s1 req.txt /srv/bro/wheels/requirements.txt    # пины PyPI: без них сборка не идёт
python console.py run probe-s1 'BRO_PYTHON_SETUP=/root/stand/vm/wheels.sh BRO_PYTHON_WHEELS=/srv/bro/wheels \
  nohup bash /root/stand/browser-vm/image/sandbox/build_rootfs.sh > /root/build.log 2>&1 &'   # ≈ 3 минуты
python console.py run probe-s1 'nohup bash /root/stand/vm/full.sh > /root/full.log 2>&1 &'  # ≈ 30 минут
python deliver.py probe-s1 --links set=put:probe/stage1/set-pk:16
python console.py run probe-s1 'cd /root/stand/vm; bash sandbox.sh gvisor pk 5; python3 bench.py session pk 5; \
  python3 bench.py form pk 5; sleep 30; python3 state.py park pk /root/links-set.json /root/.state-key'
python console.py run probe-s1 'cd /root/stand/vm; bash sandbox.sh restore pk 6 /dev/shm/park-pk/checkpoint; \
  python3 bench.py check pk 6'                      # тот же хост, другой адрес netns
# корень — в S3 (tar | zstd, state.py put), VM удалить; вторая VM: deliver, host_setup, state.py get корня,
# deliver --links set=get:probe/stage1/set-pk, state.py fetch, sandbox.sh restore pk 5 …, bench.py check pk 5
python s3.py delete-prefix probe/stage1/ && python cloudru.py delete probe-s2
```

Итоги — таблица этапа 1 в разделе 2 `docs/browser-pool.md`. Прогон 30.09: три
VM (`gen-2-8` ×2, `lowcost10-2-4`) ≈ 3 ч — ≈ 17 ₽; RouterAI — 52 ₽ (два
RU-набора по ≈ 22 ₽ и отладка).

| Замер 30.09 (`gen-2-8`, Icelake)                                    | Без gVisor                             | gVisor (`systrap`)                        |
| ------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------- |
| Старт песочницы до ответа worker с Chrome                           | 0,4 с                                  | 1,5–1,9 с                                 |
| RU-набор: медиана / сумма / шагов / секунд на шаг                   | 72,8 / 789 / 65 / 12,0 с               | 104,6 / 808 / 58 / 14,1 с                 |
| Успех (по итоговой странице и ответу)                               | 6 из 7                                 | 6 из 7 (Госуслуги — нет в обоих)          |
| Память хоста за вычетом фона 0,6 ГБ, p50 / p95                      | 1,5 / 1,7 ГБ                           | 1,5 / 2,2 ГБ (учёт gVisor 2,0 / 2,7)      |
| Стоимость RU-набора (RouterAI)                                      | 22,7 ₽                                 | 22,3 ₽                                    |
| Парковка: стоп или checkpoint / tar / zstd / шифрование / S3        | 0,5 / 0,03 / 0,1 / 0,06 / 1,5 с, 37 МБ | 0,88 / 0,05 / 0,69 / 0,13 / 1,34 с, 83 МБ |
| Подъём на другой VM: S3 / расшифровка / распаковка / старт / worker | 1,0 / 0,04 / 0,14 / 0,4 с              | 1,0 / 0,09 / 0,62 / 0,73 / 0,19 с         |
| Пережило подъём                                                     | cookie, localStorage                   | + вкладка и значение в поле, часы ±0,03 с |

## Этап 2: хост пула на настоящих VM

Хост поднимается так, как его поднимет Бро: стоковая `ubuntu-22.04` и
cloud-init из `browser-vm/host/boot.py` с presigned GET бандла и корня. Стенд
только дописывает в cloud-init пароль root для `console.py` (у хостов Бро входа
нет). Ключ подписи — случайный (`$PROBE_STATE_DIR/pool-signing-key`), ключи
worker и данных песочниц — там же (`pool-<id>.json`); удалите их после прогона.

```sh
# корень — один раз (≈ 15 минут вместе с VM, ≈ 1 ₽)
python cloudru.py usage && python cloudru.py create probe-rootfs --disk 25
python deliver.py probe-rootfs --code && python console.py push probe-rootfs vm/rootfs_build.sh /root/stand/vm/rootfs_build.sh
python console.py run probe-rootfs 'bash /root/stand/vm/rootfs_build.sh wheels > /root/wheels.log 2>&1' --timeout 600
python console.py run probe-rootfs 'cat /srv/bro/wheels.sha256' > w.sha256 && python verify_wheels.py w.sha256 req.txt
python console.py push probe-rootfs req.txt /srv/bro/wheels/requirements.txt
python console.py run probe-rootfs 'nohup bash /root/stand/vm/rootfs_build.sh build <версия> > /root/build.log 2>&1 &'
python console.py run probe-rootfs "curl -fsS -T /srv/bro/<версия>.tar.zst '$(python s3.py presign put pool/rootfs/<версия>.tar.zst)'"
python cloudru.py delete probe-rootfs
# бандл — в сессии: README хоста, «Сборка бандла и корня»
# pool.py берёт текущие корень и бандл (раздел 2 docs/browser-pool.md); другие — POOL_BUNDLE_KEY и т. п.
python pool.py boot probe-host1                     # время до ready по HTTPS; нет ответа ≈ 3 минуты — set-power reboot
python pool.py create probe-host1 sbx-a             # песочница; время до ответа worker с Chrome
python console.py push probe-host1 vm/proxy.py /root/proxy.py   # прокси-заглушка и stand_host_ports [3130] в
python console.py run probe-host1 'nohup python3 /root/proxy.py 3130 > /var/log/probe-proxy.log 2>&1 &'  # hostd.json
python pool.py session probe-host1 sbx-a 172.31.0.1 # шлюз песочницы в слоте 0 (слот n — 172.31.0.<4n+1>)
python pool.py markers probe-host1 sbx-a set        # cookie и localStorage на ya.ru через CDP за Caddy
python pool.py errand probe-host1 sbx-a             # одно короткое поручение, ≈ 1 ₽ RouterAI
python pool.py park probe-host1 sbx-a 2 && python cloudru.py delete probe-host1
python pool.py boot probe-host2 && python pool.py create probe-host2 sbx-a --gen 3 --restore 2
python pool.py session probe-host2 sbx-a 172.31.0.1 && python pool.py markers probe-host2 sbx-a check
python pool.py create probe-host2 sbx-b             # соседка; затем на хосте:
#   runc --root /run/runc-bro exec bro-sbx-a python3 -c "$(cat /root/leak.py)" <адрес хоста в VPC> <публичный IP>
python pool.py delete probe-host2 sbx-a 3 && python pool.py forget <воркспейс sbx-a>
python cloudru.py delete probe-host2 && python s3.py delete-prefix probe/stage2/ && python cloudru.py usage
```

Итоги — таблицы этапа 2 в разделе 2 `docs/browser-pool.md`. Прогон 30.09:
четыре VM (`gen-2-4` для корня, три `gen-2-8`) ≈ 53 минуты — ≈ 5 ₽; RouterAI —
0,88 ₽.

## Грабли

- `set-password` Compute API на стоковом образе отвечает 422 «Guest agent is
  unavailable»: пароль задаёт cloud-init (`chpasswd`).
- Скрипт в `runcmd` cloud-init стартует раньше, чем появляется сеть; к консоли
  подключаться после `cloud-init status: done`.
- Websocket консоли Cloud.ru через некоторое время закрывает, в том числе
  посреди команды: `console.py` переподключается сам, команда на VM идёт
  дальше. Пока команда не кончилась, консоль занята: следующая ждёт её.
- `runsc checkpoint` не работает с `--network=host`: песочнице нужен свой netns
  (его делает `gvisor_checkpoint.sh`). Chrome под корнем только на чтение
  падает на `SingletonLock` — нужен оверлей `--overlay2=root:memory`.
- Восстановленная песочница держит стандартные потоки, которые ей дали: вывод
  `runsc restore` в пайп (`| tail`) ждёт вечно и держит консоль — на стенде это
  выглядело как зависшая VM. Потоки — в файл.
- Прямая ссылка на `runsc` в GCS отвечала 404; gVisor ставится из apt-репозитория.
- Под `runsc do` не резолвятся имена, пока `/etc/resolv.conf` указывает на
  `127.0.0.53`; в госте Firecracker `/etc/resolv.conf` — симлинк в `/run`
  (tmpfs), писать в него нельзя, только заменить файлом.
- Прокси облачной сессии иногда рвёт соединение с `compute.api.cloud.ru`:
  `cloudru.py` повторяет запросы.
- Кэшированный адрес консоли может молча перестать отвечать (подключение есть,
  данных нет), а сразу после запроса Cloud.ru отдаёт пустой адрес:
  `console.py` в обоих случаях просит новый.
- 30.09 с VM Cloud.ru GitHub, PyPI, Википедия, openrouter.ai, 2gis.ru и
  httpbin.org принимали TCP и молчали, `archive.ubuntu.com` не отвечал вовсе
  (MTU ни при чём). Ubuntu — `mirror.yandex.ru` (`host_setup.sh`), PyPI —
  зеркало Huawei с проверкой хэшей по PyPI (`wheels.sh`, `verify_wheels.py`),
  RU-набор — на Яндекс Картах и Рувики вместо 2ГИС и Википедии.
- Такой молчащий адрес вешает browser-use после `done` на минуты (цены
  моделей с GitHub и openrouter.ai): выход песочниц — только DNS и RouterAI,
  остальное `REJECT` с tcp-reset (`host_setup.sh`).
- `runsc` снимает адреса с интерфейса netns, забирая их в свой netstack:
  второй старт или восстановление в том же netns — без сети. `sandbox.sh`
  создаёт netns заново каждый раз.
- `"root": {"readonly": true}` в OCI gVisor монтирует только на чтение даже с
  `--overlay2=root:memory` (init падал на `/run`): нужен `false`, каталог
  корня хоста всё равно не меняется.
- `runsc` 2026 года — не один файл: рядом `/usr/bin/gvisor-bin/gvisor_sentry` и
  другие, без них `sidecar "gvisor_sentry" not usable`. Закреплять пакет
  (`apt-get install runsc=<версия>`), не бинарник.
- `unshare --mount-proc=<путь в chroot>` на общей точке монтирования — «cannot
  change filesystem propagation»: `--mount --propagation private` и `mount -t
proc` внутри.
- Память gVisor по RSS и PSS процессов хоста завышена (общий memory file
  отображён многократно): смотреть MemTotal − MemAvailable хоста, cgroup и
  `runsc events --stats`.
- Хост пула: первая загрузка стоковой VM иногда встаёт в `(initramfs)` (одна
  из четырёх 30.09): `pool.py boot` ждёт 15 минут впустую — смотрите консоль и
  делайте `set-power reboot`, cloud-init после него отрабатывает как надо.
- Изнутри песочницы публичный IP своего же хоста не отвечает (таймаут, не
  отказ): Cloud.ru не разворачивает трафик на плавающий IP той же VM.
- Avito закрывает адрес «Доступ ограничен: проблема с IP» после серии
  запросов с него: в прогоне стена досталась проверке под gVisor сразу после
  набора без gVisor, а поручение под gVisor через 10 минут прошло без неё.

## Результаты 29–30.09.2026

VM `gen-2-4` (2 vCPU, 4 ГБ, SSD 15–20 ГБ), `ru.AZ-3`. Строки про Firecracker —
только история: на Evolution он официально не поддерживается.

| Замер                                                              | Результат                                   |
| ------------------------------------------------------------------ | ------------------------------------------- |
| Процессор / виртуализация                                          | Ice Lake, `vmx`, `/dev/kvm`, `nested=Y`     |
| Chrome без изоляции: example.com / Википедия (2,7 МБ DOM)          | 0,39–0,63 с / 1,9–2,5 с                     |
| Chrome под gVisor (`systrap`): то же                               | 2,5–2,7 с / 5,8–7,0 с                       |
| Chrome под gVisor (`kvm`): example.com                             | 3,5–3,8 с                                   |
| Гость Firecracker: загрузка до входа (256 МБ, Ubuntu 18.04)        | 2,4 с                                       |
| Chrome в госте Firecracker (2 vCPU): example.com / Википедия       | 0,45–0,73 с (первый 2,7–3,3 с) / 2,1–3,6 с  |
| Снимок гостя 2 ГБ на SSD VM / гостя 1 ГБ в `/dev/shm`              | 30,6 с / 0,41 с                             |
| Память гостя 1 ГБ с живым Chrome после `zstd -3`                   | 218 МБ за 1,9 с                             |
| Восстановление в новом процессе Firecracker                        | 13–23 мс; Chrome отвечает по CDP сразу      |
| Первое обращение к CDP / новая вкладка после восстановления        | 70–220 мс / 140–440 мс, дальше как до паузы |
| Диск SSD 15 ГБ: запись 1 МБ блоками / случайное чтение 4 КБ        | 65–73 МБ/с / ≈ 5 000 IOPS                   |
| Внутренняя сеть: 218 МБ между VM (на `lowcost10-1-1`)              | 0,25 с (> 7 Гбит/с)                         |
| VM без публичного IP: интернет / соседняя VM по внутреннему адресу | нет / да, 3 мс                              |
| gVisor: `runsc checkpoint` песочницы с живым Chrome (2 вкладки)    | 0,76–0,89 с, образ 275–324 МБ               |
| Образ заморозки после `zstd -3`                                    | 44–56 МБ за 0,7–0,8 с                       |
| `runsc restore` в новую песочницу                                  | 0,59 с; вкладки те же, CDP через 99 мс      |
| Новая вкладка после восстановления (сеть через свой netns)         | 159 мс                                      |
| Object Storage с VM, 200 МБ: загрузка / скачивание одним потоком   | 7,8–9,2 с / 5,2–5,6 с                       |
| Object Storage с VM, 200 МБ: скачивание 4 частями параллельно      | 1,5 с                                       |

После восстановления Firecracker часы гостя идут с момента паузы (строки
`ALIVE` продолжают время до паузы): их нужно подводить. S3 проверялся
подписанными ссылками, сгенерированными в сессии: ключ Cloud.ru на пробную VM
не передавался.
