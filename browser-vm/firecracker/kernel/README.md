# Гостевое ядро для Firecracker

`vmlinux` (несжатый ELF, его грузит Firecracker на x86_64) для песочниц пула
браузеров на bare metal Selectel. Ядро и Firecracker закреплены в
`../pins.json`; откуда они взяты — `build.sh` и `../firecracker.json`. Сборка
проверена, загрузка — нет: в облачной сессии нет KVM, первый запуск на хосте
покажет, что пропущено.

- Ядро: Linux 6.1.189 (LTS, kernel.org). Tarball сверяется с `sha256sums.asc`
  kernel.org и с хэшем в `build.sh`.
- Основа конфига: `resources/guest_configs/microvm-kernel-ci-x86_64-6.1.config`
  Firecracker v1.17.0, хэш закреплён в скрипте.
- Наши правки: `config-fragment` (сливается `scripts/kconfig/merge_config.sh`,
  затем `make olddefconfig`).
- Итог: `config` — финальный `.config`, лежит в репозитории для ревью.
- Артефакт: ключ в S3 и sha256 — `../pins.json`, раздел `kernel` (≈ 43 МБ).

## Сборка

```sh
apt-get install -y build-essential flex bison bc libelf-dev libssl-dev xz-utils curl
./build.sh                      # WORK=<каталог> JOBS=<n>; ~15 минут на 4 ядрах
./build.sh check config         # только проверка готового .config
```

Скрипт скачивает tarball и конфиг, сверяет хэши, собирает `make vmlinux` с
фиксированными `KBUILD_BUILD_*` и печатает sha256 и имя для S3
(`vmlinux-<версия>-<16 hex>`). Если итоговый `.config` отличается от
`kernel/config`, сборка падает: посмотрите разницу и повторите с
`UPDATE_CONFIG=1`. Байт-в-байт повторяется только на том же компиляторе:
`pins.json` хранит хэш того, что загружено в S3, на хосте проверяйте его, а не
пересобирайте.

Шаг проверки роняет сборку, если любая из обязательных опций не `=y` (список
`REQUIRED_BUILTIN` в `build.sh`: virtio MMIO/blk/net/rng, ext4, overlayfs,
tmpfs с ACL, devtmpfs, IP_PNP, все namespaces, cgroups, seccomp-bpf, SysV IPC,
POSIX mqueue, memfd, inotify, ptp_kvm, VMGenID, ACPI) или если остались модули.
`CONFIG_DEVPTS_FS` в 6.1 нет (devpts идёт с `UNIX98_PTYS`), `X86_MPPARSE`
отключён: устройства описывает ACPI.

Обновление: новая точка LTS — поменять `KERNEL_VERSION` и `KERNEL_SHA256` в
`build.sh` (хэш из `https://cdn.kernel.org/pub/linux/kernel/v6.x/sha256sums.asc`),
собрать, загрузить в S3, поправить `pins.json`. Подпись `sha256sums.asc` PGP
скрипт проверяет, только если ключи kernel.org уже в связке `gpg`; из облачной
сессии они недоступны, поэтому вручную сверяется лишь хэш.

## Строка ядра для хоста

```
console=ttyS0 reboot=k panic=1 pci=off nomodule root=/dev/vda ro rootfstype=ext4 init=/usr/local/sbin/bro-sandbox-init ip=<гость>::<шлюз>:<маска>::eth0:off
```

- `boot_args` в Firecracker заменяет строку по умолчанию целиком, поэтому
  `console=ttyS0` и `pci=off` нужно писать самим: по умолчанию Firecracker
  добавляет `8250.nr_uarts=0`, и консоли тогда нет. `pci=off` экономит время
  загрузки; `CONFIG_PCI=y` ядру нужен только для разбора ACPI.
- `root=/dev/vda ro`: корень читается только на чтение, запись идёт в overlay с
  upper-слоем в tmpfs (его монтирует init гостя). `init=` — init песочницы из
  `browser-vm/image/sandbox`, путь уточните у `build_rootfs.sh`.
- `ip=<гость>::<шлюз>:<маска>::eth0:off` — статический адрес без DHCP и
  userspace-настройки (`CONFIG_IP_PNP`). Пример: `ip=10.200.0.2::10.200.0.1:255.255.255.252::eth0:off`.
  DNS в строку не входит, `resolv.conf` кладёт rootfs.
- Устройства virtio-mmio ядро находит по ACPI-таблицам Firecracker, `virtio_mmio.device=`
  в строку добавлять не нужно (`VIRTIO_MMIO_CMDLINE_DEVICES` выключен). Сеть
  без PCI — как в этих строках; режим `--enable-pci` Firecracker не нужен.

## Часы и случайные числа

- `ptp_kvm`: `CONFIG_PTP_1588_CLOCK_KVM=y` даёт `/dev/ptp0` — время хоста по
  гипервызову. После восстановления из снимка часы гостя стоят на моменте
  снимка; init (или chrony с `refclock PHC /dev/ptp0`) должен выставить время
  по `/dev/ptp0` сразу после resume, до того как worker и Chrome начнут
  проверять сертификаты. Работает, если в гостя проброшены KVM-фичи CPUID
  (Firecracker это делает) и источник часов гостя — `kvm-clock`; на первой
  загрузке проверьте `ls /dev/ptp0` и `cat /sys/class/ptp/ptp0/clock_name`.
- VMGenID: Firecracker всегда выставляет устройство (ACPI `VMGENCTR`, с v1.8.0 на
  x86_64; v1.17.0 исправляет `_HID` под апстрим), при restore пишет новый
  идентификатор и шлёт гостю прерывание до запуска vCPU. Драйвер
  `CONFIG_VMGENID` в 6.1.189 — апстримный (с 5.18) и переинициализирует CSPRNG.
  Проверка на хосте: `dmesg | grep -i vmgenid` не пишет ошибок, а два клона
  одного снимка отдают разные `cat /proc/sys/kernel/random/uuid` после resume.
  Остаётся окно между запуском vCPU и обработкой прерывания: ничего секретного
  (ключи сессий, nonce) не генерируйте в первые миллисекунды после resume.
  Снимок надо делать после полной загрузки гостя: прерывание, пришедшее до
  инициализации ядра, может его уронить.
- Ядра Firecracker v1.17.0 собирают из Amazon Linux microvm-ядер с бэкпортами;
  мы берём апстрим 6.1.189 с их конфигом. Официально проверяются только их
  ядра (6.1: минимальный срок поддержки до 2026-09-02, дальше есть 6.18 с
  v1.16.1), поэтому первая загрузка, restore и проверка из списка выше — на
  хосте. Хосту Selectel (Ubuntu 22.04, ядро 5.15 или HWE 6.8) нужно помнить: в
  политике Firecracker хост-ядра 5.10, 6.1 и 6.18; снимок восстанавливается
  только на хосте с тем же CPU и ядром.
