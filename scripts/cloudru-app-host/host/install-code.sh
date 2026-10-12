#!/bin/bash
# Installs the host's own code from the unpacked bundle this script lies in (/opt/bro/app-host): the systemd
# units, tg-egress (the way out to api.telegram.org, scripts/cloudru-app-host/tg-egress/README.md) and
# tg-bridge (scripts/cloudru-app-host/tg-bridge/README.md). Idempotent; run as root by provision.sh and by
# `host.py update-host` on a live VM. Enables and (re)starts tg-egress; never enables the bridge, which only
# `ops/tg-bridge.sh switch-to-bridge` does (it removes the webhook first). Leaves the other units' state
# alone: provision.sh enables them, a live VM keeps them as they are.
set -euo pipefail
HOST=$(cd "$(dirname "$0")" && pwd)

# A 2 GB swap file on a 4 GB VM: memory pressure slows it down before the OOM killer picks a process. Idempotent
# (a live VM that has swap keeps it), and no restart: the units' memory limits (bro-eve, bro-web) come into force
# at their next restart, a release.
SWAPFILE=/swapfile
if ! swapon --show=NAME --noheadings | grep -qx "$SWAPFILE"; then
  if [ ! -f "$SWAPFILE" ]; then
    (umask 077 && { fallocate -l 2G "$SWAPFILE" || dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048; })
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null
  fi
  swapon "$SWAPFILE"
fi
grep -qs "^$SWAPFILE " /etc/fstab || echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
# Swap is for spikes, not for the working set.
echo "vm.swappiness=10" > /etc/sysctl.d/90-bro-swap.conf
sysctl -q -w vm.swappiness=10

for unit in bro-web.service bro-eve.service deployd.service bro-watchdog.service bro-watchdog.timer \
  bro-backup.service bro-backup.timer bro-backup-alert.service caddy.service bro-egress.service; do
  install -m 644 "$HOST/$unit" "/etc/systemd/system/$unit"
done
# This code's egress rules now, not at the next boot: bro-egress is a oneshot that stays active, so a live VM
# never runs it again, and restarting it would restart caddy, bro-web and bro-eve (their Requires=). Idempotent.
bash "$HOST/egress.sh"

install -d -m 755 /opt/bro/tg-egress
install -m 644 "$HOST/tg-egress/tg_egress.py" /opt/bro/tg-egress/tg_egress.py
install -m 755 "$HOST/tg-egress/setup.sh" /opt/bro/tg-egress/setup.sh
install -m 644 "$HOST/tg-egress/bro-tg-egress.service" /etc/systemd/system/bro-tg-egress.service
systemctl daemon-reload
systemctl enable bro-tg-egress.service >/dev/null
# A restart, not just a start: a live VM gets the new forwarder and setup.sh puts back the hosts line and the
# REDIRECT rule.
systemctl restart bro-tg-egress.service

# Its install.sh: the script, the unit, an empty /etc/bro/tg-bridge.env; a running bridge restarts only when
# one of its files changed (a restart cuts the long poll for nothing otherwise).
bash "$HOST/tg-bridge/install.sh"

# Last: this code installed whole. host.py update-host moves it to app-host.old only with this mark, so a retry
# after a failed install never overwrites the last good code there.
touch "$HOST/.installed"
