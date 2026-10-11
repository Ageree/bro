#!/bin/bash
# An operator's look at a Yandex service from the person's pool browser (yandex-probe.ts).
set -euo pipefail
node "$(dirname "$0")/yandex-probe.mjs" "$@"
