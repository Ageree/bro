#!/bin/bash
# A backup from Object Storage into one database (scripts/cloudru-app-host/README.md, «База»):
#
#   db-restore.sh KEY|latest app|check|db:<name> [--replace]
#
# KEY is backups/…/<time>.dump.enc (db-backup.sh, db-copy.sh); latest is the newest nightly dump under
# BACKUP_PREFIX. The object must match its manifest (sha256 before and after decryption, the tables), then the
# target's own tables are dropped and the dump restored in one transaction, and every table must hold the
# dump's row count. A target with tables needs --replace; app also needs Bro stopped
# (host.py stop NAME bro-eve bro-web), and the world's database is refused.
source "$(dirname "$0")/db-lib.sh"
[ $# -ge 2 ] || die "usage: db-restore.sh KEY|latest app|check|db:<name> [--replace]"
KEY=$1
[ "$KEY" = latest ] && KEY=$(store latest "$BACKUP_PREFIX")
REPLACE=no
[ "${3:-}" = "--replace" ] && REPLACE=yes
connection DST "$2"
refuse_world DST
guard_target DST "$REPLACE"
workdir
fetch_backup "$KEY" "$WORK/db.dump" "$WORK/counts"
restore DST "$WORK/db.dump" "$WORK/counts"
echo "restored $KEY into $2"
