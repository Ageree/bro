#!/bin/bash
# Stage 2: what a pool host shows of one runc sandbox (docs/browser-pool.md). Run as root on the host.
#   pool_inspect.sh ID
set -u
ID="$1"
R=(runc --root /run/runc-bro)
echo "== state"; "${R[@]}" state "bro-$ID" | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["status"], s["pid"])'
CG=/sys/fs/cgroup/bro-sandboxes/$ID
echo "== cgroup"; echo "memory.max $(cat "$CG/memory.max") pids.max $(cat "$CG/pids.max") current $(( $(cat "$CG/memory.current") / 1048576 )) MB"
echo "== mounts"; grep "/srv/bro/sandboxes/$ID" /proc/mounts | awk '{print $3, $2}'
INIT=$("${R[@]}" state "bro-$ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
echo "== chrome sandbox"
for pid in $(pgrep -f -- "--type=zygote" | head -4); do
  printf '%s userns=%s pidns=%s init-userns=%s seccomp=%s args=%s\n' "$pid" "$(readlink /proc/$pid/ns/user)" \
    "$(readlink /proc/$pid/ns/pid)" "$(readlink /proc/$INIT/ns/user)" "$(awk '/^Seccomp:/ {print $2}' /proc/$pid/status)" \
    "$(tr '\0' ' ' < /proc/$pid/cmdline | grep -o -- '--no-sandbox\|--type=zygote[^ ]*\|--no-zygote-sandbox' | tr '\n' ' ')"
done
pgrep -fa -- "--type=renderer" | head -1 | cut -c1-160
for pid in $(pgrep -f -- "--type=renderer" | head -2); do
  echo "renderer $pid userns=$(readlink /proc/$pid/ns/user) seccomp=$(awk '/^Seccomp:/ {print $2}' /proc/$pid/status)"
done
echo "== no-sandbox anywhere"; pgrep -fa -- "--no-sandbox" | grep -v pgrep | head -2 || true
echo "== log"; grep -i -E "sandbox|namespace|zygote|fatal|error" "/srv/bro/sandboxes/$ID/runtime.log" | tail -12
