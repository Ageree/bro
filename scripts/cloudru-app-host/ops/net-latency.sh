#!/bin/bash
# How long the VM takes to reach the hosts a turn waits on, read only:
#
#   host.py ops NAME net-latency.sh [TRIES]
#
# For the model hosts (RunInfra, RouterAI) and the Telegram Bot API, TRIES (3) fresh connections each:
# seconds to the address, to TCP, to TLS and to the first byte of a GET that carries no key (an answer
# such as 401 or 404 is expected and still timed). The cost of the TLS setup is what a turn pays when a
# connection to the host was not kept open since the last call.
set -euo pipefail
TRIES=${1:-3}
[[ "$TRIES" =~ ^[0-9]+$ && "$TRIES" -ge 1 && "$TRIES" -le 10 ]] || {
  echo "TRIES: 1 to 10" >&2
  exit 2
}
printf '%-44s %6s %6s %6s %6s %5s\n' url dns tcp tls first code
for url in https://api.runinfra.ai/v1/models https://routerai.ru/api/v1/models https://api.telegram.org/; do
  for ((i = 1; i <= TRIES; i++)); do
    curl -s -o /dev/null --max-time 15 \
      -w "$(printf '%-44s' "$url") %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{http_code}\n" \
      "$url" || echo "$url failed"
  done
done
