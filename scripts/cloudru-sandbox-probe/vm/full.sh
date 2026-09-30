#!/bin/bash
# The comparison run: the same rootfs, network and egress, native namespaces first, then gVisor; each from an
# empty profile: start → worker ready, WB and Avito pages, the RU errand set. Output in /root/results/.
#   full.sh [ERRANDS]      (comma-separated names; all by default)
cd "$(dirname "$0")"
mkdir -p /root/results
for id in g1 n2; do bash sandbox.sh stop "$id" >/dev/null 2>&1; done
sleep 5
python3 bench.py mem none > /root/results/baseline.json
for spec in native:nt:3 gvisor:gv:4; do
  IFS=: read -r kind id idx <<< "$spec"
  rm -rf "/srv/sandboxes/$id"
  bash sandbox.sh "$kind" "$id" "$idx" > /dev/null
  python3 bench.py wait "$id" "$idx" > "/root/results/start-$id.json"
  python3 bench.py session "$id" "$idx" > "/root/results/session-$id.txt"
  python3 bench.py sites "$id" "$idx" "sites-$id" > "/root/results/sites-$id.jsonl" 2>&1
  python3 bench.py errands "$id" "$idx" "ru-$id" ${1:-} > "/root/results/ru-$id.jsonl" 2>&1
  bash sandbox.sh stop "$id"
done
echo FULL-DONE > /root/results/done
