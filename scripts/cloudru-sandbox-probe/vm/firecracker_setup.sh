#!/bin/bash
# Firecracker, a CI guest kernel, a guest rootfs copied from this VM (Chrome included — run chrome_bench.sh
# first) with guest_init.sh as PID 1, and tap0 + NAT for the guest. Rootfs copy takes about a minute.
set -e
mkdir -p /root/fc && cd /root/fc
V=v1.10.1
curl -fsSL https://github.com/firecracker-microvm/firecracker/releases/download/$V/firecracker-$V-x86_64.tgz | tar xz
cp release-$V-x86_64/firecracker-$V-x86_64 /usr/local/bin/firecracker
firecracker --version | head -1
curl -fsSLo vmlinux https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/vmlinux-6.1.102
umount /mnt/rf 2>/dev/null || true
rm -f rootfs.ext4 && truncate -s 5G rootfs.ext4 && mkfs.ext4 -q -F rootfs.ext4
mkdir -p /mnt/rf && mount -o loop rootfs.ext4 /mnt/rf
rsync -aHAX --exclude=/proc --exclude=/sys --exclude=/dev --exclude=/run --exclude=/tmp --exclude=/mnt \
  --exclude=/root --exclude=/boot --exclude=/snap --exclude=/var/lib/snapd --exclude=/usr/lib/modules \
  --exclude=/usr/lib/firmware --exclude=/var/cache --exclude=/var/lib/apt --exclude=/usr/share/doc / /mnt/rf/
mkdir -p /mnt/rf/proc /mnt/rf/sys /mnt/rf/dev /mnt/rf/run /mnt/rf/tmp /mnt/rf/root
install -m 755 /root/guest_init.sh /mnt/rf/guest_init.sh
du -sh /mnt/rf; umount /mnt/rf
ip tuntap add tap0 mode tap 2>/dev/null || true
ip addr add 172.16.0.1/24 dev tap0 2>/dev/null || true
ip link set tap0 up
sysctl -qw net.ipv4.ip_forward=1
OUT=$(ip route | awk '/default/ {print $5; exit}')
iptables -t nat -C POSTROUTING -o "$OUT" -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -o "$OUT" -j MASQUERADE
iptables -P FORWARD ACCEPT
echo setup done
