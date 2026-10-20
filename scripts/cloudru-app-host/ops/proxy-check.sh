#!/bin/bash
# Whether the browser's proxies let a tunnel through, from this VM, read only:
#
#   host.py ops NAME proxy-check.sh [URL]
#
# For BROWSER_VM_PROXY (Geonode: its own port and 10000, the sticky one the sandboxes use) and
# BROWSER_VM_PROXY_FALLBACK, TRIES fresh sessions each: the proxy's answer to CONNECT (200; 402 is an
# empty balance, 407 a refused login, 5xx the provider's own failure — what Chrome shows as
# ERR_TUNNEL_CONNECTION_FAILED), the page's code and the time. The credentials go to curl on stdin,
# never in its arguments or the output.
set -euo pipefail
URL=${1:-https://ya.ru/}
TRIES=3
[[ "$URL" =~ ^https://[A-Za-z0-9.-]+/?$ ]] || {
  echo "URL: https://host/" >&2
  exit 2
}

check() {
  local label=$1 value=$2 port=$3 host given user pass session name code
  # host:port:user:password, the user with {session} for a sticky exit.
  IFS=: read -r host given user pass <<<"${value#*://}"
  [[ -n "$port" ]] || port=$given
  name=$(printf '%-24s' "$label:$port")
  for ((i = 1; i <= TRIES; i++)); do
    session=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
    code=0
    printf 'proxy-user = "%s:%s"\n' "${user//\{session\}/$session}" "$pass" |
      curl -s -o /dev/null --max-time 25 -K - -x "http://$host:$port" \
        -w "$name connect=%{http_connect} page=%{http_code} %{time_total}s" \
        "$URL" || code=$?
    # 56: the proxy refused the tunnel (its code is in connect=), 28: no answer in time.
    if ((code == 0)); then echo; else echo " curl=$code"; fi
  done
}

if [[ -n "${BROWSER_VM_PROXY:-}" ]]; then
  check geonode "$BROWSER_VM_PROXY" ""
  check geonode "$BROWSER_VM_PROXY" 10000
else
  echo "no BROWSER_VM_PROXY"
fi
if [[ -n "${BROWSER_VM_PROXY_FALLBACK:-}" ]]; then
  check fallback "$BROWSER_VM_PROXY_FALLBACK" ""
else
  echo "no BROWSER_VM_PROXY_FALLBACK"
fi
