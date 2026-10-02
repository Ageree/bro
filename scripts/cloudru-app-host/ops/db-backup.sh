#!/bin/bash
# The nightly backup of Bro's database (bro-backup.timer; by hand: host.py ops NAME db-backup.sh):
#
#   db-backup.sh
#
# pg_dump --format=custom of app → openssl with BACKUP_ENCRYPTION_KEY → <BACKUP_PREFIX>/<UTC time>.dump.enc
# in Object Storage, its manifest (sha256s, row counts per table, no data) next to it as .json; then the
# nightly dumps older than BACKUP_KEEP_DAYS (14) go, the newest three stay whatever their age. Without
# BACKUP_ENCRYPTION_KEY backups are off: it says so and exits 0. The last success goes to
# /var/backups/bro/last-backup.json, which the watchdog reads (no fresh backup for a day — the owner hears).
source "$(dirname "$0")/db-lib.sh"
if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "backups are off: no BACKUP_ENCRYPTION_KEY in /etc/bro/env"
  exit 0
fi
connection SRC app
workdir
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
KEY="$BACKUP_PREFIX/$STAMP.dump.enc"
started=$(date +%s)
dump SRC "$WORK/db.dump"
dump_counts "$WORK/db.dump" > "$WORK/counts"
[ -s "$WORK/counts" ] || die "the dump holds no table"
upload_backup "$WORK/db.dump" "$WORK/counts" "$KEY" "app"
echo "backup $KEY: $(wc -l < "$WORK/counts") tables, $(awk '{s += $2} END {print s + 0}' "$WORK/counts") rows," \
  "dump $(stat -c %s "$WORK/db.dump") bytes in $(($(date +%s) - started)) s"
printf '{"key": "%s", "finishedAt": %s}\n' "$KEY" "$(date +%s)" > "$WORK_ROOT/.last-backup.json"
mv "$WORK_ROOT/.last-backup.json" "$WORK_ROOT/last-backup.json"
store prune "$BACKUP_PREFIX" "${BACKUP_KEEP_DAYS:-14}" 3
