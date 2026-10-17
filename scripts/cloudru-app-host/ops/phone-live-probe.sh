#!/bin/bash
# One test call through the GPT-Live bridge (scripts/phone/live-probe.ts): +7DESTINATION +7BRO_NUMBER
# [s3put:KEY for the stereo WAV] [MAX_TALK_SECONDS]. It rings a real phone: only a number whose owner asked.
set -euo pipefail
node "$(dirname "$0")/phone-live-probe.mjs" "$@"
