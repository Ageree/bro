#!/bin/bash
# Does the backup restore? (after each nightly backup in bro-backup.service; by hand:
# host.py ops NAME db-restore-check.sh [KEY])
#
#   db-restore-check.sh [KEY|latest]
#
# Restores the dump into the scratch database `check` (BACKUP_CHECK_DATABASE_URL, bro_restore_check of
# `host.py pg databases`): every table must hold the dump's row count, or it fails. Then it sets the counts
# beside the live app database: rows written since the dump differ, so that part is printed, not judged.
# The scratch database is emptied at the end, whatever the outcome; when that fails, so does the check (a copy
# of people's data would stay there). Off only with BACKUPS=off; without BACKUP_CHECK_DATABASE_URL or the key
# it fails.
source "$(dirname "$0")/db-lib.sh"
if ! backups_on; then
  echo "restore check is off: BACKUPS=off in /etc/bro/env"
  exit 0
fi
need_backup_key
[ -n "${BACKUP_CHECK_DATABASE_URL:-}" ] || die "no BACKUP_CHECK_DATABASE_URL in /etc/bro/env: no restore check"
db_lock
KEY=${1:-latest}
[ "$KEY" = latest ] && KEY=$(store latest "$BACKUP_PREFIX")
connection CHECK check
connection SRC app
same_database CHECK SRC && die "BACKUP_CHECK_DATABASE_URL is the app's database: refusing to wipe it"
refuse_world CHECK
workdir
leave() {
  local status=$?
  wipe CHECK > /dev/null 2>&1 || { echo "could not empty the scratch database" >&2; [ "$status" != 0 ] || status=1; }
  rm -rf "$WORK"
  exit "$status"
}
trap leave EXIT
fetch_backup "$KEY" "$WORK/db.dump" "$WORK/counts"
restore CHECK "$WORK/db.dump" "$WORK/counts"
table_counts SRC "$(schemas_of "$WORK/counts")" > "$WORK/live"
LC_ALL=C join -a 1 -a 2 -e - -o 0,1.2,2.2 "$WORK/counts" "$WORK/live" | awk '
  $2 != $3 { changed++; printf "  %s: backup %s, now %s\n", $1, $2, $3 }
  END { if (changed) printf "%d tables changed since the backup (writes after it, or a migration)\n", changed;
        else print "the live database has the same row counts as the backup" }'
echo "restore check of $KEY: ok"
