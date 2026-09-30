#!/bin/bash
# Chrome without isolation vs under gVisor (runsc do): cold start on a light page and a heavy page.
set -e
cd /root
export DEBIAN_FRONTEND=noninteractive
if ! command -v google-chrome >/dev/null; then
  curl -fsSLo chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get update -q >/dev/null && apt-get install -y -q ./chrome.deb zstd fio >/dev/null
fi
if ! command -v runsc >/dev/null; then
  # The direct runsc download URL answered 404 on 29.09.2026; the apt repository works.
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update -q >/dev/null && apt-get install -y -q runsc >/dev/null
fi
# The sandbox's own netstack cannot reach systemd-resolved on 127.0.0.53: ERR_NAME_NOT_RESOLVED otherwise.
ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
set +e
google-chrome --version; runsc --version | head -1
F="--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage"
HEAVY="https://ru.wikipedia.org/wiki/%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0"
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
for i in 1 2 3; do
  s=$(date +%s%N); google-chrome $F --user-data-dir=/root/p-native --dump-dom https://example.com >/dev/null 2>&1; echo "native light #$i $(ms $s)ms"
  s=$(date +%s%N); runsc --platform=systrap --network=host do google-chrome $F --user-data-dir=/root/p-gvisor --dump-dom https://example.com >/dev/null 2>&1; echo "gvisor light #$i $(ms $s)ms"
done
for i in 1 2; do
  s=$(date +%s%N); n=$(google-chrome $F --user-data-dir=/root/p-native --dump-dom "$HEAVY" 2>/dev/null | wc -c); echo "native heavy #$i $(ms $s)ms bytes=$n"
  s=$(date +%s%N); n=$(runsc --platform=systrap --network=host do google-chrome $F --user-data-dir=/root/p-gvisor --dump-dom "$HEAVY" 2>/dev/null | wc -c); echo "gvisor heavy #$i $(ms $s)ms bytes=$n"
done
echo "disk:"
fio --name=w --filename=/root/fio --size=1G --bs=1M --rw=write --direct=1 --ioengine=libaio --iodepth=16 | grep -E "WRITE:"
fio --name=rr --filename=/root/fio --size=1G --bs=4k --rw=randread --direct=1 --ioengine=libaio --iodepth=32 --runtime=15 --time_based | grep -E "IOPS"
rm -f /root/fio
