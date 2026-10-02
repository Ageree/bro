#!/bin/bash
# Does the backup restore? (after each nightly backup in bro-backup.service; by hand:
# host.py ops NAME db-restore-check.sh [KEY])
#
#   db-restore-check.sh [KEY|latest]
#
# Restores the dump into the scratch database `check` (BACKUP_CHECK_DATABASE_URL, bro_restore_check of
# `host.py pg databases`): every table must hold the dump's row count, or it fails. Then it sets the counts
# beside the live app database: rows written since the dump differ, so that part is printed, not judged.
# The scratch database is emptied at the end, whatever the outcome. Without BACKUP_CHECK_DATABASE_URL it
# says so and exits 0.
source "$(dirname "$0")/db-lib.sh"
if [ -z "${BACKUP_CHECK_DATABASE_URL:-}" ]; then
  echo "restore check is off: no BACKUP_CHECK_DATABASE_URL in /etc/bro/env"
  exit 0
fi
KEY=${1:-latest}
[ "$KEY" = latest ] && KEY=$(store latest "$BACKUP_PREFIX")
connection CHECK check
connection SRC app
same_database CHECK SRC && die "BACKUP_CHECK_DATABASE_URL is the app's database: refusing to wipe it"
refuse_world CHECK
workdir
trap 'wipe CHECK >/dev/null 2>&1 || echo "could not empty the scratch database" >&2; rm -rf "$WORK"' EXIT
fetch_backup "$KEY" "$WORK/db.dump" "$WORK/counts"
restore CHECK "$WORK/db.dump" "$WORK/counts"
table_counts SRC "$(schemas_of "$WORK/counts")" > "$WORK/live"
LC_ALL=C join -a 1 -a 2 -e - -o 0,1.2,2.2 "$WORK/counts" "$WORK/live" | awk '
  $2 != $3 { changed++; printf "  %s: backup %s, now %s\n", $1, $2, $3 }
  END { if (changed) printf "%d tables changed since the backup (writes after it, or a migration)\n", changed;
        else print "the live database has the same row counts as the backup" }'
echo "restore check of $KEY: ok"
