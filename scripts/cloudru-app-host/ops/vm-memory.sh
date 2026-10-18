#!/bin/bash
# The VM's memory as the services use it, read only:
#
#   host.py ops NAME vm-memory.sh
#
# Prints the current and peak memory and swap of bro-eve, bro-web and caddy (systemd's cgroup counters,
# the peak since the unit last started), when each started, and the VM's free and swap. The figure
# `docs/dev-notes.md` asks for before any MemoryHigh or MemoryMax goes into a unit.
set -euo pipefail
for unit in bro-eve bro-web caddy; do
  systemctl show "$unit" -p Id -p ActiveEnterTimestamp -p MemoryCurrent -p MemoryPeak \
    -p MemorySwapCurrent -p MemorySwapPeak -p NRestarts 2>/dev/null | tr '\n' ' '
  echo
done
free -m
cat /proc/pressure/memory 2>/dev/null || true
