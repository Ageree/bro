#!/bin/bash
# Puts tg-bridge on the app VM (README.md here): the script in /opt/bro/tg-bridge, the unit in systemd.
# Does not start or enable it: that is `tg_bridge.py switch-to-bridge`, which removes the webhook first.
# Idempotent; run as root from the unpacked directory. A running bridge is restarted only when a file changed:
# a restart cuts the long poll and opens the one-duplicate window the README describes, for nothing otherwise.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
changed=0
put() { # mode source target: install the file unless the target is already the same
  if ! cmp -s "$2" "$3"; then
    install -m "$1" "$2" "$3"
    changed=1
  fi
}
install -d -m 755 /opt/bro/tg-bridge
put 644 "$HERE/tg_bridge.py" /opt/bro/tg-bridge/tg_bridge.py
put 644 "$HERE/bro-tg-bridge.service" /etc/systemd/system/bro-tg-bridge.service
# mkdir -p -m sets the mode of a directory it creates only: an existing /etc/bro keeps the one deployd gave it.
mkdir -p -m 755 /etc/bro
[ -f /etc/bro/tg-bridge.env ] || install -m 600 /dev/null /etc/bro/tg-bridge.env
systemctl daemon-reload
if [ "$changed" = 1 ] && systemctl is-active --quiet bro-tg-bridge.service; then
  systemctl restart bro-tg-bridge.service
fi
echo "tg-bridge installed; switch: python3 /opt/bro/tg-bridge/tg_bridge.py switch-to-bridge"
