#!/bin/bash
# The nightly backup of Bro's database (bro-backup.timer; by hand: host.py ops NAME db-backup.sh):
#
#   db-backup.sh
#
# pg_dump --format=custom of app → openssl with BACKUP_ENCRYPTION_KEY → <BACKUP_PREFIX>/<UTC time>.dump.enc
# in Object Storage, its signed manifest (sha256s, row counts per table, no data) next to it as .json; then
# the nightly dumps older than BACKUP_KEEP_DAYS (14) go, the newest three stay whatever their age. Backups are
# off only with BACKUPS=off in /etc/bro/env; a missing key otherwise fails (and the owner hears). A table of
# another role fails it too, unless ALLOW_FOREIGN_TABLES names it. The last success goes to
# /var/backups/bro/last-backup.json, which the watchdog reads (no fresh backup for 26 hours — the owner hears).
source "$(dirname "$0")/db-lib.sh"
if ! backups_on; then
  echo "backups are off: BACKUPS=off in /etc/bro/env"
  exit 0
fi
need_backup_key
db_lock
connection SRC app
refuse_foreign SRC
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
# The backup is in; a failed pruning must not read as a failed backup (nor skip the restore check). What it
# left half deleted, the next night's pruning finds and drops (store.py prune).
store prune "$BACKUP_PREFIX" "${BACKUP_KEEP_DAYS:-14}" 3 || echo "pruning old backups failed: they stay until the next night" >&2
