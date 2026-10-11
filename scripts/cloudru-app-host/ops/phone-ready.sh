#!/bin/bash
# Read-only: check the configured ElevenLabs phone agent with the production readiness rules.
set -euo pipefail
node "$(dirname "$0")/phone-ready.mjs" "$@"
