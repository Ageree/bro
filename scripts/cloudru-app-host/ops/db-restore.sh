#!/bin/bash
# A backup from Object Storage into one database (scripts/cloudru-app-host/README.md, «База»):
#
#   db-restore.sh KEY|latest app|check|db:<name> [--replace]
#
# KEY is backups/…/<time>.dump.enc (db-backup.sh, db-copy.sh); latest is the newest nightly dump under
# BACKUP_PREFIX that has its manifest. The manifest must be signed with this BACKUP_ENCRYPTION_KEY and name
# KEY, the object must match it (sha256 before and after decryption, the tables). Then what the target holds
# goes to Object Storage (<time>-pre<target>.dump.enc), its own tables are dropped and the dump restored in
# one transaction, and every table must hold the dump's row count. A target with tables needs --replace; any
# target but check needs Bro gone from it (host.py stop NAME bro-eve bro-web), checked again right before
# the restore; the world's database and neon are refused.
source "$(dirname "$0")/db-lib.sh"
# Exactly these: a word it does not know (--dry-run) must stop it, not leave a plain restore.
if [ $# -eq 2 ]; then
  REPLACE=no
elif [ $# -eq 3 ] && [ "$3" = --replace ]; then
  REPLACE=yes
else
  die "usage: db-restore.sh KEY|latest app|check|db:<name> [--replace]"
fi
[ "$2" != neon ] || die "a backup goes back into Neon only through db-copy.sh app neon (the rollback)"
db_lock
KEY=$1
[ "$KEY" = latest ] && KEY=$(store latest "$BACKUP_PREFIX")
connection DST "$2"
guard_target DST "$REPLACE"
workdir
fetch_backup "$KEY" "$WORK/db.dump" "$WORK/counts"
restore DST "$WORK/db.dump" "$WORK/counts"
echo "restored $KEY into $2"
