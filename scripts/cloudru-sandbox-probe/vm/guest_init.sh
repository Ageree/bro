#!/bin/bash
# PID 1 inside the Firecracker guest: network, Chrome timings, then a live Chrome with CDP that a loop
# polls every 2 s — the loop's lines in the console log show whether Chrome survives snapshot and restore.
mount -t proc proc /proc; mount -t sysfs sys /sys; mount -t devtmpfs dev /dev 2>/dev/null
mkdir -p /dev/pts /dev/shm; mount -t devpts devpts /dev/pts; mount -t tmpfs tmpfs /dev/shm
mount -t tmpfs tmpfs /tmp; mount -t tmpfs tmpfs /run
hostname fcguest; ip link set lo up; ip addr add 172.16.0.2/24 dev eth0; ip link set eth0 up
ip route add default via 172.16.0.1
# /etc/resolv.conf is a symlink into /run (tmpfs here): writing through it silently fails.
rm -f /etc/resolv.conf; echo nameserver 8.8.8.8 > /etc/resolv.conf
echo "GUEST_UP $(cut -d' ' -f1 /proc/uptime)s nproc=$(nproc) mem=$(free -m | awk '/Mem/ {print $2}')MB"
F="--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage"
HEAVY="https://ru.wikipedia.org/wiki/%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0"
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
for i in 1 2 3; do s=$(date +%s%N); google-chrome $F --user-data-dir=/tmp/p$i --dump-dom https://example.com >/dev/null 2>&1; echo "FC light #$i $(ms $s)ms"; done
for i in 1 2; do s=$(date +%s%N); n=$(google-chrome $F --user-data-dir=/tmp/h --dump-dom "$HEAVY" 2>/dev/null | wc -c); echo "FC heavy #$i $(ms $s)ms bytes=$n"; done
google-chrome $F --user-data-dir=/tmp/live --remote-debugging-port=9222 https://example.com >/dev/null 2>&1 &
sleep 4
echo READY_FOR_SNAPSHOT
n=0
while true; do
  n=$((n + 1))
  a=$(date +%s%N); v=$(curl -s -m 2 http://127.0.0.1:9222/json/version | grep -o '"Browser": "[^"]*"')
  b=$(date +%s%N); curl -s -m 10 -X PUT "http://127.0.0.1:9222/json/new?https://ya.ru" >/dev/null
  echo "ALIVE $n $(date +%T) up=$(cut -d' ' -f1 /proc/uptime) [$v] cdp=$(( ($b - $a) / 1000000 ))ms newtab=$(ms $b)ms"
  sleep 2
done
