#!/bin/bash
set -euo pipefail
node "$(dirname "$0")/phone-adopt.mjs" "$@"
