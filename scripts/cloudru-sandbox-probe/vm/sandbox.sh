#!/bin/bash
# One browser sandbox from the rootfs of browser-vm/image/sandbox, under gVisor or — for the comparison — under
# plain namespaces with the same rootfs, network and mounts, so the runtime is the only difference.
#   sandbox.sh gvisor ID IDX              runsc (systrap), rootfs under --overlay2=root:memory (host dir untouched)
#   sandbox.sh native ID IDX              overlayfs on tmpfs, chroot, own pid/uts/mount namespaces
#   sandbox.sh restore ID IDX IMAGE_DIR   runsc restore --detach from a checkpoint image
#   sandbox.sh stop ID | unnet IDX
# Network namespace nIDX with a veth 10.200.IDX.1 (host) ↔ 10.200.IDX.2 (sandbox), made anew for every start
# and restore: runsc moves the addresses into its own netstack and strips them from the namespace, so a second
# sandbox (or a restore) in the same namespace would come up with no network at all.
# Per sandbox: /srv/sandboxes/ID/{profile/, worker.json, bundle/, console.log}. The profile is a host
# directory bind-mounted to /var/lib/bro/profile; worker.json (a random key made here, never Bro's) to
# /etc/bro/worker.json. The worker listens on 10.200.IDX.2:8080 (BRO_WORKER_BIND=0.0.0.0).
set -eu
ROOTFS="${ROOTFS:-/srv/bro/rootfs}"
RUNSC=(runsc --root /run/runsc --platform=systrap --overlay2=root:memory)
cmd="$1"; shift

prepare() {
  local dir=/srv/sandboxes/$1 uid gid
  uid=$(stat -c %u "$ROOTFS/home/bro"); gid=$(stat -c %g "$ROOTFS/home/bro")
  mkdir -p "$dir/profile" "$dir/bundle"
  chown "$uid:$gid" "$dir/profile"
  if [ ! -s "$dir/worker.json" ]; then
    (umask 077; printf '{"environment": "probe-ws", "key": "%s"}\n' "$(openssl rand -hex 32)" > "$dir/worker.json")
  fi
  chown "$uid:$gid" "$dir/worker.json"; chmod 600 "$dir/worker.json"
}

bundle() {  # bundle ID NS: OCI config for runsc
  python3 - "$1" "$2" "$ROOTFS" <<'PY'
import json, sys
sid, ns, rootfs = sys.argv[1:]
d = f"/srv/sandboxes/{sid}"
caps = ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL", "CAP_SETGID", "CAP_SETUID",
        "CAP_SETPCAP", "CAP_NET_BIND_SERVICE", "CAP_NET_RAW", "CAP_SYS_CHROOT", "CAP_AUDIT_WRITE", "CAP_SETFCAP"]
config = {
    "ociVersion": "1.0.0",
    "process": {"terminal": False, "user": {"uid": 0, "gid": 0},
                "args": ["/usr/local/sbin/bro-sandbox-init"],
                "env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "BRO_WORKER_BIND=0.0.0.0"],
                "cwd": "/", "noNewPrivileges": False,
                "capabilities": {k: caps for k in ("bounding", "effective", "inheritable", "permitted")},
                "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 65536, "soft": 65536}]},
    # Not "readonly": gVisor then mounts the root read-only even under --overlay2. Writable here means
    # writable in the sandbox's memory: the overlay never writes to the rootfs directory.
    "root": {"path": rootfs, "readonly": False},
    # The same name everywhere: Chrome's SingletonLock names the host, and a restored or moved profile
    # must not look like it is in use on another computer.
    "hostname": "bro-sandbox",
    "mounts": [
        {"destination": "/proc", "type": "proc", "source": "proc"},
        {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "strictatime", "mode=755"]},
        {"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": ["nosuid", "noexec"]},
        {"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["nosuid", "noexec", "nodev"]},
        {"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": ["nosuid", "noexec", "nodev", "ro"]},
        {"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev"]},
        {"destination": "/var/lib/bro/profile", "type": "bind", "source": f"{d}/profile", "options": ["rbind", "rw"]},
        {"destination": "/etc/bro/worker.json", "type": "bind", "source": f"{d}/worker.json", "options": ["rbind", "ro"]},
        {"destination": "/etc/resolv.conf", "type": "bind", "source": "/run/systemd/resolve/resolv.conf",
         "options": ["rbind", "ro"]},
    ],
    "linux": {"namespaces": [{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"},
                             {"type": "network", "path": f"/var/run/netns/{ns}"}],
              "cgroupsPath": f"/probe-{sid}"},
}
json.dump(config, open(f"{d}/bundle/config.json", "w"), indent=1)
PY
}

net() {
  local idx=$1 ns=n$1
  ip netns del "$ns" 2>/dev/null || true; ip link del "vh-$ns" 2>/dev/null || true
  ip netns add "$ns"
  ip link add "vh-$ns" type veth peer name "vc-$ns"
  ip link set "vc-$ns" netns "$ns"
  ip addr add "10.200.$idx.1/24" dev "vh-$ns"; ip link set "vh-$ns" up
  ip netns exec "$ns" ip link set "vc-$ns" name eth0
  ip netns exec "$ns" ip addr add "10.200.$idx.2/24" dev eth0
  ip netns exec "$ns" ip link set eth0 up; ip netns exec "$ns" ip link set lo up
  ip netns exec "$ns" ip route add default via "10.200.$idx.1"
}

case "$cmd" in
unnet)
  ip netns del "n$1" 2>/dev/null || true; ip link del "vh-n$1" 2>/dev/null || true
  ;;
gvisor)
  id=$1; ns=n$2
  "${RUNSC[@]}" delete -force "$id" 2>/dev/null || true
  net "$2"; prepare "$id"; bundle "$id" "$ns"
  # The sandbox keeps the stdio it was given: a file, never a pipe.
  "${RUNSC[@]}" run --detach --bundle "/srv/sandboxes/$id/bundle" "$id" > "/srv/sandboxes/$id/console.log" 2>&1
  "${RUNSC[@]}" list | grep -w "$id"
  ;;
restore)
  id=$1; ns=n$2; image=$3
  "${RUNSC[@]}" delete -force "$id" 2>/dev/null || true
  net "$2"; prepare "$id"; bundle "$id" "$ns"
  t=$(date +%s%N)
  timeout 120 "${RUNSC[@]}" restore --image-path="$image" --bundle "/srv/sandboxes/$id/bundle" --detach "$id" \
    > "/srv/sandboxes/$id/console.log" 2>&1 < /dev/null
  echo "restore rc=$? $(( ($(date +%s%N) - t) / 1000000 ))ms"
  "${RUNSC[@]}" list | grep -w "$id"
  ;;
native)
  id=$1; ns=n$2; d=/srv/sandboxes/$id; m=$d/native
  net "$2"; prepare "$id"
  mkdir -p "$m/mem" "$m/root"
  mount -t tmpfs tmpfs "$m/mem"; mkdir -p "$m/mem/upper" "$m/mem/work"
  mount -t overlay overlay -o "lowerdir=$ROOTFS,upperdir=$m/mem/upper,workdir=$m/mem/work" "$m/root"
  mount --bind "$d/profile" "$m/root/var/lib/bro/profile"
  mount --bind "$d/worker.json" "$m/root/etc/bro/worker.json"
  mount --bind /run/systemd/resolve/resolv.conf "$m/root/etc/resolv.conf"
  mount --rbind /dev "$m/root/dev"
  mount -t tmpfs tmpfs "$m/root/tmp"
  mount -t tmpfs tmpfs "$m/root/dev/shm" 2>/dev/null || true
  mkdir -p "/sys/fs/cgroup/probe-$id"
  # The init becomes PID 1 of its own pid namespace in the sandbox's network namespace.
  nohup setsid bash -c "echo \$\$ > /sys/fs/cgroup/probe-$id/cgroup.procs; exec ip netns exec $ns \
    unshare --pid --fork --uts --mount --propagation private sh -c 'mount -t proc proc $m/root/proc \
    && hostname bro-sandbox && exec chroot $m/root \
    env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin BRO_WORKER_BIND=0.0.0.0 \
    /usr/local/sbin/bro-sandbox-init'" > "$d/console.log" 2>&1 < /dev/null &
  echo $! > "$d/native.pid"
  echo "native $id pid $(cat "$d/native.pid")"
  ;;
stop)
  id=$1; d=/srv/sandboxes/$id; m=$d/native
  if [ -f "$d/native.pid" ]; then
    outer=$(cat "$d/native.pid"); init=$(pgrep -P "$outer" | head -1 || true)
    [ -n "$init" ] && kill -TERM "$init" 2>/dev/null || true
    for _ in $(seq 1 80); do kill -0 "$outer" 2>/dev/null || break; sleep 0.5; done
    kill -KILL "$outer" 2>/dev/null || true
    umount -R "$m/root" 2>/dev/null || umount -lR "$m/root" 2>/dev/null || true
    umount "$m/mem" 2>/dev/null || true
    rmdir "/sys/fs/cgroup/probe-$id" 2>/dev/null || true
    rm -f "$d/native.pid"
  else
    "${RUNSC[@]}" kill "$id" SIGTERM 2>/dev/null || true
    for _ in $(seq 1 80); do "${RUNSC[@]}" state "$id" 2>/dev/null | grep -q '"status": "running"' || break; sleep 0.5; done
    "${RUNSC[@]}" delete -force "$id" 2>/dev/null || true
  fi
  ;;
*)
  echo "unknown command $cmd" >&2; exit 2
  ;;
esac
