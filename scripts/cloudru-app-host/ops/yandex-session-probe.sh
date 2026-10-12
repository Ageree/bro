#!/bin/bash
# Method 4 measurement: reads with the browser cookies, from the server (yandex-session-probe.ts).
set -euo pipefail
node "$(dirname "$0")/yandex-session-probe.mjs" "$@"
