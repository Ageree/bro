#!/bin/bash
# Boot the guest, wait until its Chrome is live, pause, full snapshot, compress, restore in a fresh
# Firecracker process and watch the guest carry on.
#   snapshot_bench.sh [MEM_MIB=1024] [SNAP_DIR=/dev/shm]
# SNAP_DIR=/dev/shm keeps the memory file in RAM (0.4 s for 1 GB); on the VM's SSD a 2 GB file took 30 s.
MEM=${1:-1024}; DIR=${2:-/dev/shm}
cd /root/fc; S=/tmp/fc.sock
pkill -x firecracker; sleep 0.5; rm -f $S "$DIR/snap" "$DIR/mem" mem.zst a.log b.log
api() { curl -s --unix-socket $S -X "$1" "http://localhost/$2" -H 'Content-Type: application/json' -d "$3"; }
ms() { echo $(( ($(date +%s%N) - $1) / 1000000 )); }
firecracker --api-sock $S > a.log 2>&1 &
FIRST=$!
sleep 0.3
api PUT boot-source '{"kernel_image_path":"/root/fc/vmlinux","boot_args":"console=ttyS0 reboot=k panic=1 pci=off init=/guest_init.sh"}'
api PUT drives/rootfs '{"drive_id":"rootfs","path_on_host":"/root/fc/rootfs.ext4","is_root_device":true,"is_read_only":false}'
api PUT machine-config "{\"vcpu_count\":2,\"mem_size_mib\":$MEM}"
api PUT network-interfaces/eth0 '{"iface_id":"eth0","guest_mac":"06:00:AC:10:00:02","host_dev_name":"tap0"}'
t=$(date +%s%N); api PUT actions '{"action_type":"InstanceStart"}'
for i in $(seq 1 1200); do grep -q READY_FOR_SNAPSHOT a.log && break; sleep 0.1; done
echo "boot -> Chrome live: $(ms $t)ms"
sleep 5
api PATCH vm '{"state":"Paused"}'
t=$(date +%s%N); api PUT snapshot/create "{\"snapshot_type\":\"Full\",\"snapshot_path\":\"$DIR/snap\",\"mem_file_path\":\"$DIR/mem\"}"
echo "snapshot ${MEM}MiB to $DIR: $(ms $t)ms"
kill $FIRST; sleep 0.5; rm -f $S
t=$(date +%s%N); zstd -q -T0 -3 -f "$DIR/mem" -o mem.zst; echo "zstd: $(du -h mem.zst | cut -f1) in $(ms $t)ms"
firecracker --api-sock $S > b.log 2>&1 &
SECOND=$!
sleep 0.3
t=$(date +%s%N)
api PUT snapshot/load "{\"snapshot_path\":\"$DIR/snap\",\"mem_backend\":{\"backend_type\":\"File\",\"backend_path\":\"$DIR/mem\"},\"resume_vm\":true}"
echo "restore: $(ms $t)ms"
sleep 8
echo "--- guest before the snapshot"; grep -aE "GUEST_UP|FC |ALIVE" a.log | tail -8
echo "--- guest after the restore (its clock resumes from the pause)"; grep -a ALIVE b.log | head -4
kill $SECOND; rm -f "$DIR/snap" "$DIR/mem"
