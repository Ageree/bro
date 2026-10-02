#!/bin/bash
# Installs the host's own code from the unpacked bundle this script lies in (/opt/bro/app-host): the systemd
# units, tg-egress (the way out to api.telegram.org, scripts/cloudru-app-host/tg-egress/README.md) and
# tg-bridge (scripts/cloudru-app-host/tg-bridge/README.md). Idempotent; run as root by provision.sh and by
# `host.py update-host` on a live VM. Enables and (re)starts tg-egress; never enables the bridge, which only
# `ops/tg-bridge.sh switch-to-bridge` does (it removes the webhook first). Leaves the other units' state
# alone: provision.sh enables them, a live VM keeps them as they are.
set -euo pipefail
HOST=$(cd "$(dirname "$0")" && pwd)

for unit in bro-web.service bro-eve.service deployd.service bro-watchdog.service bro-watchdog.timer \
  bro-backup.service bro-backup.timer bro-backup-alert.service caddy.service bro-egress.service; do
  install -m 644 "$HOST/$unit" "/etc/systemd/system/$unit"
done

install -d -m 755 /opt/bro/tg-egress
install -m 644 "$HOST/tg-egress/tg_egress.py" /opt/bro/tg-egress/tg_egress.py
install -m 755 "$HOST/tg-egress/setup.sh" /opt/bro/tg-egress/setup.sh
install -m 644 "$HOST/tg-egress/bro-tg-egress.service" /etc/systemd/system/bro-tg-egress.service
systemctl daemon-reload
systemctl enable bro-tg-egress.service >/dev/null
# A restart, not just a start: a live VM gets the new forwarder and setup.sh puts back the hosts line and the
# REDIRECT rule.
systemctl restart bro-tg-egress.service

# Its install.sh: the script, the unit, an empty /etc/bro/tg-bridge.env; a running bridge restarts on it.
bash "$HOST/tg-bridge/install.sh"
