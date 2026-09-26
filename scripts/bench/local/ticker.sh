#!/usr/bin/env bash
# `eve dev` never runs schedules by cron; browser errands report back only when
# `browser-runs` ticks. SCHEDULES may add `proactive` (it reads the tester's
# real mail and writes into the last web session).
SCHEDULES="${SCHEDULES:-browser-runs dynamic memory}"
LOG="${LOG:-/tmp/bro-dev.log}"
while true; do
  PORT=$(grep -o 'eve:dev\] server listening at http://127.0.0.1:[0-9]*' "$LOG" | tail -1 | grep -o '[0-9]*$')
  for s in $SCHEDULES; do
    curl -s -m 110 -X POST "http://127.0.0.1:${PORT}/eve/v1/dev/schedules/$s" -o /dev/null -w "$(date +%T) $s %{http_code}\n" &
  done
  wait
  sleep 50
done
