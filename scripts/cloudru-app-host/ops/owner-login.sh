#!/bin/bash
# A one-time sign-in link into the owner's account, to a PUT URL (owner-login.ts).
set -euo pipefail
node "$(dirname "$0")/owner-login.mjs" "$@"
