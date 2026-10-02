#!/bin/bash
# What bro's processes (the app, the model's tools, the ops scripts) may not reach: the metadata service,
# which serves the user data with deployd's host key to any local process, and deployd itself. Applied at
# every boot by bro-egress.service, before bro-web and bro-eve; idempotent.
set -euo pipefail
iptables -w -N BRO_EGRESS 2>/dev/null || iptables -w -F BRO_EGRESS
iptables -w -A BRO_EGRESS -d 169.254.0.0/16 -j REJECT
iptables -w -A BRO_EGRESS -d 127.0.0.0/8 -p tcp --dport 8095 -j REJECT --reject-with tcp-reset
iptables -w -C OUTPUT -m owner --uid-owner bro -j BRO_EGRESS 2>/dev/null ||
  iptables -w -I OUTPUT -m owner --uid-owner bro -j BRO_EGRESS
