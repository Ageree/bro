# Стенд песочниц браузера на Cloud.ru

Проверки к `docs/browser-pool.md`: сколько теряет Chrome под gVisor, можно ли
заморозить уже запущенный Chrome и поднять его в новой песочнице, как быстро
Object Storage отдаёт снимок. Сюда же попали проверки Firecracker внутри VM
Evolution (29.09): технически он там запускается, но поддержка Cloud.ru
ответила, что вложенной виртуализации в Evolution нет и пользоваться ею
нельзя, — эти скрипты оставлены как история, для Bare Metal. Это
стенд, не код Бро и не пилот `scripts/cloudru-browser-pilot/`: обычная Ubuntu
22.04 без образа Бро, без worker, без прокси и без личных данных.

| Файл                      | Что делает                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `cloudru.py`              | Compute API: квоты, список, цены флейворов, создание и удаление пробной VM (вместе с её IP)        |
| `console.py`              | Команды на VM через serial-консоль Cloud.ru (вход root по паролю из cloud-init) и заливка скриптов |
| `vm/check_kvm.sh`         | Флаги `vmx`/`svm`, `/dev/kvm`, `nested`                                                            |
| `vm/chrome_bench.sh`      | Ставит Chrome и gVisor; Chrome без изоляции против `runsc do`, лёгкая и тяжёлая страница; `fio`    |
| `vm/gvisor_checkpoint.sh` | Chrome в песочнице gVisor со своим netns: `runsc checkpoint`, zstd, `runsc restore`, те же вкладки |
| `vm/firecracker_setup.sh` | Firecracker 1.10.1, ядро 6.1 из CI Firecracker, rootfs гостя — копия этой VM с Chrome, tap0 и NAT  |
| `vm/guest_init.sh`        | PID 1 гостя: сеть, замеры Chrome, живой Chrome с CDP и цикл `ALIVE` для проверки снимка            |
| `vm/snapshot_bench.sh`    | Загрузка гостя, пауза, полный снимок, zstd, восстановление в новом процессе Firecracker            |

Нужны `CLOUDRU_KEY_ID`, `CLOUDRU_KEY_SECRET` и `pip install websocket-client`.
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
