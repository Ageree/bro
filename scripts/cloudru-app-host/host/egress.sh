#!/bin/bash
# What the VM's untrusted processes may not reach: the metadata service, which serves the user data with
# deployd's host key to any local process, and deployd itself. bro (the app, the model's tools, the ops
# scripts) reaches neither; caddy, facing the internet, does not reach the metadata service (it does reach
# deployd: it routes /ops/v1/* there). Applied at every boot by bro-egress.service, before caddy, bro-web
# and bro-eve; idempotent.
set -euo pipefail
iptables -w -N BRO_EGRESS 2>/dev/null || iptables -w -F BRO_EGRESS
iptables -w -A BRO_EGRESS -d 169.254.0.0/16 -j REJECT
iptables -w -A BRO_EGRESS -d 127.0.0.0/8 -p tcp --dport 8095 -j REJECT --reject-with tcp-reset
iptables -w -C OUTPUT -m owner --uid-owner bro -j BRO_EGRESS 2>/dev/null ||
  iptables -w -I OUTPUT -m owner --uid-owner bro -j BRO_EGRESS
iptables -w -N CADDY_EGRESS 2>/dev/null || iptables -w -F CADDY_EGRESS
iptables -w -A CADDY_EGRESS -d 169.254.0.0/16 -j REJECT
iptables -w -C OUTPUT -m owner --uid-owner caddy -j CADDY_EGRESS 2>/dev/null ||
  iptables -w -I OUTPUT -m owner --uid-owner caddy -j CADDY_EGRESS
