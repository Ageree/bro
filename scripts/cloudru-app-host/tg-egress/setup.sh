#!/bin/bash
# Points api.telegram.org at the forwarder (README.md here): a line in /etc/hosts sends the name to
# 127.77.0.1, and a nat OUTPUT rule sends 127.77.0.1:443 to the forwarder's port. Caddy keeps every
# address's :443 to itself; nothing listens on 127.77.0.1. Idempotent; run as root by bro-tg-egress.service
# before the forwarder (ExecStartPre=+), so the rule comes back after every boot.
#   setup.sh [listen port]     default: the port of TG_EGRESS_LISTEN (the unit's EnvironmentFile), else 7443
#   setup.sh --remove          take the rule and the hosts line away (Telegram goes back to DNS)
set -euo pipefail
ADDRESS=127.77.0.1
NAMES="api.telegram.org"
MARK="# bro-tg-egress"
MATCH=(-d "$ADDRESS/32" -p tcp --dport 443 -j REDIRECT --to-ports)

# Ports of every REDIRECT rule for the address, in chain order.
redirect_ports() {
  iptables -w -t nat -S OUTPUT | sed -n "s#.*-d $ADDRESS/32 .*--to-ports \([0-9]*\).*#\1#p"
}

remove_rules() {
  for port in $(redirect_ports); do
    iptables -w -t nat -D OUTPUT "${MATCH[@]}" "$port"
  done
}

if [ "${1:-}" = "--remove" ]; then
  remove_rules
  sed -i "/$MARK\$/d" /etc/hosts
  exit 0
fi

LISTEN=${TG_EGRESS_LISTEN:-127.0.0.1:7443}
[[ "$LISTEN" == *:* ]] || LISTEN="$LISTEN:7443"
PORT=${1:-${LISTEN##*:}}
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || { echo "bad port $PORT" >&2; exit 2; }
# Exactly one rule, to this port: a rule left from another port would match first and send Telegram to a
# port nobody listens on.
if [ "$(redirect_ports | tr '\n' ' ')" != "$PORT " ]; then
  remove_rules
  iptables -w -t nat -A OUTPUT "${MATCH[@]}" "$PORT"
fi
# One managed line, rewritten in place: another line for the same name earlier in the file would win.
sed -i "/$MARK\$/d" /etc/hosts
for name in $NAMES; do
  sed -i -E "/^[^#]*[[:space:]]$(printf '%s' "$name" | sed 's/\./\\./g')([[:space:]]|\$)/d" /etc/hosts
done
printf '%s %s %s\n' "$ADDRESS" "$NAMES" "$MARK" >> /etc/hosts
