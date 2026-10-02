#!/bin/bash
# What the VM's untrusted processes may not reach: the metadata service, which serves the user data with
# deployd's host key to any local process, and deployd itself. bro (the app, the model's tools, the ops
# scripts) reaches neither; caddy, facing the internet, does not reach the metadata service (it does reach
# deployd: it routes /ops/v1/* there). Applied at every boot by bro-egress.service, before caddy, bro-web
# and bro-eve, and by install-code.sh on a live VM; idempotent.
#
# One iptables-restore --noflush commit: a chain named here is refilled in the same transaction as it is
# emptied, so a live VM never runs a moment without the rules (two commands, -F then -A, would leave one).
set -euo pipefail
rules=$(
  cat <<'RULES'
*filter
:BRO_EGRESS - [0:0]
-A BRO_EGRESS -d 169.254.0.0/16 -j REJECT
-A BRO_EGRESS -d 127.0.0.0/8 -p tcp --dport 8095 -j REJECT --reject-with tcp-reset
:CADDY_EGRESS - [0:0]
-A CADDY_EGRESS -d 169.254.0.0/16 -j REJECT
RULES
)
# The jumps from OUTPUT, once each: the commit adds those not there yet.
for owner in bro:BRO_EGRESS caddy:CADDY_EGRESS; do
  jump="OUTPUT -m owner --uid-owner ${owner%%:*} -j ${owner#*:}"
  # shellcheck disable=SC2086 # the rule's words
  iptables -w -C $jump 2>/dev/null || rules+=$'\n'"-I $jump"
done
printf '%s\nCOMMIT\n' "$rules" | iptables-restore -w --noflush
