#!/bin/bash
# Can gVisor freeze a running Chrome and bring it back in a new sandbox (no KVM needed)?
# Needs chrome_bench.sh first (Chrome and runsc installed). The sandbox gets its own network
# namespace: gVisor cannot checkpoint a sandbox on the host network.
set -u
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
# Network namespace with a veth pair and NAT, like a container runtime would do.
ip netns del ck 2>/dev/null; ip link del veth-h 2>/dev/null
ip netns add ck
ip link add veth-h type veth peer name veth-c
ip link set veth-c netns ck
ip addr add 10.200.1.1/24 dev veth-h; ip link set veth-h up
ip netns exec ck ip addr add 10.200.1.2/24 dev veth-c
ip netns exec ck ip link set veth-c up; ip netns exec ck ip link set lo up
ip netns exec ck ip route add default via 10.200.1.1
sysctl -qw net.ipv4.ip_forward=1
OUT=$(ip route | awk '/default/ {print $5; exit}')
iptables -t nat -C POSTROUTING -s 10.200.1.0/24 -o "$OUT" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.200.1.0/24 -o "$OUT" -j MASQUERADE
iptables -P FORWARD ACCEPT
# OCI bundle: the host root under an in-memory overlay (writes never reach the host), Chrome with CDP.
B=/root/ckb; rm -rf $B; mkdir -p $B; cd $B
runsc spec -- /opt/google/chrome/chrome --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/tmp/prof --remote-debugging-port=9222 https://example.com
python3 - <<'PY'
import json
c = json.load(open("config.json"))
c["root"] = {"path": "/", "readonly": False}
c["process"]["env"].append("HOME=/tmp")
c["process"]["terminal"] = False
c["linux"]["namespaces"] = [n for n in c["linux"]["namespaces"] if n["type"] != "network"] + [
    {"type": "network", "path": "/var/run/netns/ck"}]
c["mounts"].append({"destination": "/etc/resolv.conf", "type": "bind", "source": "/run/systemd/resolve/resolv.conf", "options": ["ro", "rbind"]})
json.dump(c, open("config.json", "w"), indent=1)
PY
R="runsc --root /run/runsc-ck --overlay2=root:memory"
$R delete -force ck1 2>/dev/null; $R delete -force ck2 2>/dev/null
$R create --bundle $B ck1 && $R start ck1
sleep 6
echo "before: $($R exec ck1 curl -s -m 3 http://127.0.0.1:9222/json/list | grep -o '"url": "[^"]*"' | head -2 | tr '\n' ' ')"
$R exec ck1 curl -s -m 5 -X PUT "http://127.0.0.1:9222/json/new?https://ya.ru" >/dev/null; sleep 3
echo "tabs: $($R exec ck1 curl -s -m 3 http://127.0.0.1:9222/json/list | grep -o '"url": "[^"]*"' | tr '\n' ' ')"
echo "sandbox memory: $(ps -o rss= -C runsc-sandbox 2>/dev/null | awk '{s+=$1} END {print s/1024 " MB"}')"
rm -rf /dev/shm/ck; mkdir -p /dev/shm/ck
t=$(date +%s%N); $R checkpoint --image-path=/dev/shm/ck ck1; echo "checkpoint rc=$? $(ms $t)ms, image $(du -sh /dev/shm/ck | cut -f1)"
t=$(date +%s%N); tar -C /dev/shm -I 'zstd -3 -T0' -cf /root/ck.tzst ck; echo "zstd: $(du -h /root/ck.tzst | cut -f1) in $(ms $t)ms"
$R delete -force ck1 2>/dev/null
free -m | awk '/Mem/ {print "free before restore: " $7 " MB"}'
# The restored sandbox keeps the stdio it was given: never pipe it, or the script waits forever.
t=$(date +%s%N); timeout 90 $R restore --image-path=/dev/shm/ck --bundle $B --detach ck2 > /root/ck2.out 2>&1
echo "restore rc=$? $(ms $t)ms"; $R list
sleep 2
t=$(date +%s%N); echo "after: $($R exec ck2 curl -s -m 5 http://127.0.0.1:9222/json/list | grep -o '"url": "[^"]*"' | tr '\n' ' ') first CDP $(ms $t)ms"
t=$(date +%s%N); $R exec ck2 curl -s -m 10 -X PUT "http://127.0.0.1:9222/json/new?https://example.org" | grep -o '"url": "[^"]*"'; echo "new tab after restore $(ms $t)ms"
$R delete -force ck2; ip netns del ck; ip link del veth-h 2>/dev/null; rm -rf /dev/shm/ck
