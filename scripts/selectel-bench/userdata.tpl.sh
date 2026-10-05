#!/bin/bash
# Selectel bench v2 (role __ROLE__): Chrome cold/warm/restored-profile page loads, then browser-use errands.
# Results are served read-only from /var/www/bench on :80 and echoed to the serial console.
R=/var/www/bench; mkdir -p $R /etc/bench /opt/bench; rm -f $R/*
log(){ echo "BENCH $*" | tee -a $R/log.txt >/dev/ttyS0; }
log "runcmd-start role=__ROLE__ epoch=$(date +%s.%N) uptime=$(cut -d' ' -f1 /proc/uptime)"
(cd $R && nohup python3 -m http.server 80 >/dev/null 2>&1 &)
log "cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs) nproc=$(nproc) mem=$(free -m | awk '/Mem/{print $2}') vmx=$(grep -c -w vmx /proc/cpuinfo) svm=$(grep -c -w svm /proc/cpuinfo) kvm=$(test -e /dev/kvm && echo yes || echo no)"
echo "127.0.1.1 $(hostname)" >> /etc/hosts; useradd -m -s /bin/bash bench 2>/dev/null
echo '__KEY_B64__' | base64 -d > /etc/bench/routerai; chown bench /etc/bench/routerai; chmod 600 /etc/bench/routerai
echo '__BU_B64__' | base64 -d > /opt/bench/bu_bench.py
echo '__CDP_B64__' | base64 -d > /opt/bench/cdp.py
echo '__EXT_B64__' | base64 -d > /opt/bench/extend_system.txt
chmod -R a+r /opt/bench; chown -R bench $R
export DEBIAN_FRONTEND=noninteractive
t0=$(date +%s.%N)
for n in 1 2 3; do curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && break; sleep 5; done
apt-get update -qq; apt-get install -y -qq /tmp/chrome.deb xvfb fonts-noto-color-emoji fonts-liberation python3-websocket python3-venv zstd >/dev/null 2>&1
log "chrome-install rc=$? sec=$(python3 -c "import time;print(round(time.time()-$t0,1))") ver=$(google-chrome --version 2>&1)"
t0=$(date +%s.%N)
sudo -u bench bash -c 'python3 -m venv /home/bench/venv && /home/bench/venv/bin/pip install -q browser-use==0.13.10' > $R/pip.txt 2>&1
log "browser-use-install rc=$? sec=$(python3 -c "import time;print(round(time.time()-$t0,1))")"
sudo -u bench bash -c 'Xvfb :98 -screen 0 1366x900x24 >/dev/null 2>&1 &'; sudo -u bench bash -c 'Xvfb :99 -screen 0 1366x900x24 >/dev/null 2>&1 &'; sleep 1
SITES="https://www.ozon.ru/ https://www.wildberries.ru/ https://www.avito.ru/ https://market.yandex.ru/ https://rasp.yandex.ru/ https://www.gosuslugi.ru/"
C="sudo -u bench python3 /opt/bench/cdp.py"
sync; echo 3 > /proc/sys/vm/drop_caches
$C /home/bench/prof-a cold-empty-dropcaches $SITES > $R/chrome1.json 2>&1; log "chrome1 $(cat $R/chrome1.json)"
$C /home/bench/prof-a warm-same-profile $SITES > $R/chrome2.json 2>&1; log "chrome2 $(cat $R/chrome2.json)"
log "profile-size $(du -sm /home/bench/prof-a | cut -f1)MB files=$(find /home/bench/prof-a -type f | wc -l)"
t0=$(date +%s.%N); tar -C /home/bench -cf - prof-a | zstd -q -3 -T0 -o /home/bench/prof-a.tar.zst; log "profile-pack sec=$(python3 -c "import time;print(round(time.time()-$t0,2))") size=$(du -m /home/bench/prof-a.tar.zst | cut -f1)MB"
sync; echo 3 > /proc/sys/vm/drop_caches
t0=$(date +%s.%N); mkdir -p /home/bench/rest && zstd -q -d -c /home/bench/prof-a.tar.zst | tar -C /home/bench/rest -xf -; chown -R bench /home/bench/rest; log "profile-unpack sec=$(python3 -c "import time;print(round(time.time()-$t0,2))")"
sync; echo 3 > /proc/sys/vm/drop_caches
$C /home/bench/rest/prof-a restored-profile-dropcaches $SITES > $R/chrome3.json 2>&1; log "chrome3 $(cat $R/chrome3.json)"
$C /home/bench/rest/prof-a restored-warm $SITES > $R/chrome4.json 2>&1; log "chrome4 $(cat $R/chrome4.json)"
sudo -u bench bash -c 'DISPLAY=:99 nohup google-chrome --user-data-dir=/home/bench/profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-dev-shm-usage --password-store=basic --window-size=1366,900 --lang=ru-RU --accept-lang=ru-RU,ru,en-US,en --disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction about:blank >/tmp/bro-chrome.log 2>&1 &'
for i in $(seq 1 150); do curl -s -m 1 http://127.0.0.1:9222/json/version >/dev/null && break; sleep 0.2; done
log "bu-start configs=__CONFIGS__ tasks=__TASKS__"
sudo -u bench BENCH_BUDGET_RUB=__BUDGET__ /home/bench/venv/bin/python /opt/bench/bu_bench.py __CONFIGS__ __TASKS__ > $R/bu-stdout.txt 2>&1
log "bu-exit rc=$?"
shred -u /etc/bench/routerai
log "done epoch=$(date +%s.%N) uptime=$(cut -d' ' -f1 /proc/uptime)"
