#!/bin/bash
# Provision or verify the existing workspace agent's inbox using production code.
set -euo pipefail
node "$(dirname "$0")/agent-mail.mjs" "$@"
