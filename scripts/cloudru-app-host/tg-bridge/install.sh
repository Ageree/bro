#!/bin/bash
# Puts tg-bridge on the app VM (README.md here): the script in /opt/bro/tg-bridge, the unit in systemd.
# Does not start or enable it: that is `tg_bridge.py switch-to-bridge`, which removes the webhook first.
# Idempotent; run as root from the unpacked directory. A running bridge is restarted on the new script.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
install -d -m 755 /opt/bro/tg-bridge
install -m 644 "$HERE/tg_bridge.py" /opt/bro/tg-bridge/tg_bridge.py
install -m 644 "$HERE/bro-tg-bridge.service" /etc/systemd/system/bro-tg-bridge.service
[ -f /etc/bro/tg-bridge.env ] || install -m 600 /dev/null /etc/bro/tg-bridge.env
systemctl daemon-reload
if systemctl is-active --quiet bro-tg-bridge.service; then
  systemctl restart bro-tg-bridge.service
fi
echo "tg-bridge installed; switch: python3 /opt/bro/tg-bridge/tg_bridge.py switch-to-bridge"
