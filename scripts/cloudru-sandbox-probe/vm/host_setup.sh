#!/bin/bash
# Probe host for stage 1 of docs/browser-pool.md: runsc, the tools of the park/restore path, forwarding and
# NAT for the sandboxes' own networks (10.200.0.0/16), and the stand-in egress proxy on :3130.
#   host_setup.sh [RUNSC_VERSION]  e.g. 20260921.0: the restore host takes the very package the snapshot was made
#                                  with (not just the binary: runsc runs sidecars from /usr/bin/gvisor-bin/)
set -eu
export DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")"
# On 30.09.2026 archive.ubuntu.com and security.ubuntu.com did not answer from Cloud.ru (port 80 timed out);
# the rootfs build takes the host's mirror too.
if ! curl -fsS -m 8 -o /dev/null http://archive.ubuntu.com/ubuntu/; then
  sed -i -E 's#http://(archive|security)\.ubuntu\.com/ubuntu/?#http://mirror.yandex.ru/ubuntu/#' /etc/apt/sources.list
fi
apt-get update -q >/dev/null
apt-get install -yq zstd debootstrap python3-cryptography python3-websocket jq >/dev/null
if ! command -v runsc >/dev/null; then
  # The direct runsc download URL answered 404 on 29.09.2026; the apt repository works.
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update -q >/dev/null && apt-get install -yq "runsc${1:+=$1}" >/dev/null
fi
sysctl -qw net.ipv4.ip_forward=1
OUT=$(ip route | awk '/default/ {print $5; exit}')
iptables -t nat -C POSTROUTING -s 10.200.0.0/16 -o "$OUT" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s 10.200.0.0/16 -o "$OUT" -j MASQUERADE
iptables -P FORWARD ACCEPT
# Sandboxes reach the internet directly only for DNS and the model API (RouterAI); pages go through the proxy
# on the host (INPUT, not FORWARD). Everything else is refused at once: from Cloud.ru many foreign hosts
# (GitHub, PyPI, openrouter.ai) accepted the connection and then sent nothing, and browser-use's pricing
# lookups after `done` hung each run for minutes.
iptables -N PROBE_SANDBOX 2>/dev/null || iptables -F PROBE_SANDBOX
iptables -C FORWARD -s 10.200.0.0/16 -j PROBE_SANDBOX 2>/dev/null || iptables -I FORWARD -s 10.200.0.0/16 -j PROBE_SANDBOX
iptables -A PROBE_SANDBOX -p udp --dport 53 -j RETURN
iptables -A PROBE_SANDBOX -p tcp --dport 53 -j RETURN
for ip in $(getent ahostsv4 routerai.ru | awk '{print $1}' | sort -u); do
  iptables -A PROBE_SANDBOX -d "$ip" -p tcp --dport 443 -j RETURN
done
iptables -A PROBE_SANDBOX -p tcp -j REJECT --reject-with tcp-reset
iptables -A PROBE_SANDBOX -j REJECT
pgrep -f "proxy.py 3130" >/dev/null || nohup python3 "$PWD/proxy.py" 3130 >/var/log/probe-proxy.log 2>&1 &
mkdir -p /srv/sandboxes
runsc --version | head -1
grep -m1 "model name" /proc/cpuinfo
grep -m1 -o -w -E "avx512f|amx_tile" /proc/cpuinfo | sort -u | tr '\n' ' '; echo
