#!/bin/bash
# Which way Telegram's updates reach eve, and the switch between the webhook and tg-bridge
# (scripts/cloudru-app-host/tg-bridge/README.md, «Переключение»):
#
#   tg-bridge.sh status                      the units, the bridge's health and getWebhookInfo
#   tg-bridge.sh switch-to-bridge            tg-egress must answer first; then deleteWebhook (pending kept),
#                                            enable and start the bridge, wait for its health
#   tg-bridge.sh switch-to-webhook URL       stop and disable the bridge, confirm what it delivered,
#                                            setWebhook URL with the secret (https://<host>/eve/v1/telegram)
#
# Root's: deployd runs the copy in the host bundle (/opt/bro/app-host/ops/tg-bridge.sh) as root, never the
# release's (bro owns a release's files). tg_bridge.py reads the token and the secret from /etc/bro/env
# itself; nothing secret is printed.
set -euo pipefail
BRIDGE=/opt/bro/tg-bridge/tg_bridge.py
EGRESS=/opt/bro/tg-egress/tg_egress.py
UNIT=bro-tg-bridge.service
[ -f "$BRIDGE" ] || {
  echo "tg-bridge is not installed: the host bundle installs it (install-code.sh)"
  exit 1
}

case "${1:-}" in
  status)
    [ $# = 1 ] || exit 2
    echo "bridge: $(systemctl is-enabled "$UNIT" 2>/dev/null || true), $(systemctl is-active "$UNIT" 2>/dev/null || true)"
    if [ -f "$EGRESS" ]; then
      echo "tg-egress: $(systemctl is-active bro-tg-egress.service 2>/dev/null || true), check: $(timeout 40 python3 "$EGRESS" --check 2>&1 | tail -n 1)"
    fi
    if systemctl is-enabled --quiet "$UNIT"; then
      python3 "$BRIDGE" check || true
    fi
    exec python3 "$BRIDGE" status
    ;;
  switch-to-bridge)
    [ $# = 1 ] || exit 2
    # The bridge polls through tg-egress: a path that does not answer would leave the bot with neither.
    if [ -f "$EGRESS" ] && ! timeout 40 python3 "$EGRESS" --check; then
      echo "tg-egress does not reach api.telegram.org: the webhook stays (journalctl -u bro-tg-egress)"
      exit 1
    fi
    exec python3 "$BRIDGE" switch-to-bridge
    ;;
  switch-to-webhook)
    [ $# = 2 ] || {
      echo "usage: tg-bridge.sh switch-to-webhook https://<host>/eve/v1/telegram"
      exit 2
    }
    exec python3 "$BRIDGE" switch-to-webhook "$2"
    ;;
  *)
    echo "usage: tg-bridge.sh status | switch-to-bridge | switch-to-webhook URL"
    exit 2
    ;;
esac
