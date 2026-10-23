#!/bin/bash
# Calls one MerchantAPI method of МОНЕТА.РУ (docs/moneta.md) with its JSON envelope and prints the answer:
#
#   MONETA_LOGIN=… MONETA_PASSWORD=… scripts/moneta/probe.sh METHOD [BODY]
#   scripts/moneta/probe.sh FindAccountsListRequest '{"version":"VERSION_2"}'
#
# MONETA_URL is the test contour https://demo.moneta.ru/services unless set; production is
# https://service.moneta.ru/services. The login and password are those of the personal cabinet
# (Envelope.Header.Security.UsernameToken): a wrong pair answers 400 with faultDetail 300.1. Both
# reach curl on stdin, not in its arguments. The HTTP status goes to stderr, the answer to stdout.
#
# The proxy of a cloud session sometimes resets the connection to demo.moneta.ru (20.10). The call
# is repeated, up to 3 times, only when curl could not connect or finish TLS (exit 6, 7, 35): the
# request has not left then. After a reset mid-answer a Payment may have gone through, so it is not.
set -euo pipefail
METHOD=${1:?METHOD, such as FindAccountsListRequest}
BODY=${2:-'{}'}
URL=${MONETA_URL:-https://demo.moneta.ru/services}
: "${MONETA_LOGIN:?MONETA_LOGIN}" "${MONETA_PASSWORD:?MONETA_PASSWORD}"
[[ "$METHOD" =~ ^[A-Za-z]+$ ]] || {
  echo "METHOD: letters only" >&2
  exit 2
}
envelope=$(jq -c -n --arg method "$METHOD" --argjson body "$BODY" \
  '{Envelope: {Header: {Security: {UsernameToken: {Username: $ENV.MONETA_LOGIN, Password: $ENV.MONETA_PASSWORD}}}, Body: {($method): $body}}}')
answer=$(mktemp)
trap 'rm -f "$answer"' EXIT
for attempt in 1 2 3; do
  status=0
  code=$(printf '%s' "$envelope" | curl -sS --max-time 60 -o "$answer" -w '%{http_code}' \
    -H 'Content-Type: application/json;charset=UTF-8' --data-binary @- "$URL") || status=$?
  [[ $status -eq 6 || $status -eq 7 || $status -eq 35 ]] && [[ $attempt -lt 3 ]] && {
    sleep $((attempt * 2))
    continue
  }
  break
done
[[ $status -eq 0 ]] || {
  echo "curl failed: exit $status" >&2
  exit 1
}
echo "HTTP $code" >&2
jq . "$answer" 2>/dev/null || cat "$answer"
[[ $code -lt 400 ]]
