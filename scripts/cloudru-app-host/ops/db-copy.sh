#!/bin/bash
# One database copied into another, checked table by table: the move off Neon, and the way back.
#
#   db-copy.sh FROM TO [--replace] [--dump-only]
#
# FROM and TO: app, neon (NEON_DATABASE_URL), db:<name>. Moving to Cloud.ru is `db-copy.sh neon app
# --replace`, going back `db-copy.sh app neon --replace` (docs/cloudru-migration.md, этап 5). The source must
# not change meanwhile (a read-only window): its row counts are taken before and after pg_dump and must match
# each other and the dump's. The dump leaves out Neon's neon_auth and keeps drizzle (the migrations journal,
# its orphan rows too). Before the restore an encrypted copy goes to <BACKUP_PREFIX>/<time>-<FROM>.dump.enc
# (when BACKUP_ENCRYPTION_KEY is set; never pruned). The restore is db-restore.sh's: one transaction, the
# target's own tables replaced, every table's count checked. --dump-only stops after the checks of the source
# (a rehearsal: does the VM reach it, how long does the dump take).
source "$(dirname "$0")/db-lib.sh"
[ $# -ge 2 ] || die "usage: db-copy.sh FROM TO [--replace] [--dump-only]"
REPLACE=no
DUMP_ONLY=no
for flag in "${@:3}"; do
  case "$flag" in
    --replace) REPLACE=yes ;;
    --dump-only) DUMP_ONLY=yes ;;
    *) die "unknown flag $flag" ;;
  esac
done
connection SRC "$1"
connection DST "$2"
same_database SRC DST && die "FROM and TO are the same database"
if [ "$DUMP_ONLY" = no ]; then
  refuse_world DST
  guard_target DST "$REPLACE"
fi
workdir
echo "source: $(psql_on SRC -c "SELECT current_setting('server_version')"), pg_dump $(pg_dump --version | awk '{print $3}')"
SCHEMAS=$(live_schemas SRC)
[ -n "$SCHEMAS" ] || die "the source has no tables"
table_counts SRC "$SCHEMAS" > "$WORK/before"
started=$(date +%s)
dump SRC "$WORK/db.dump"
echo "dump: $(stat -c %s "$WORK/db.dump") bytes in $(($(date +%s) - started)) s"
table_counts SRC "$SCHEMAS" > "$WORK/after"
if ! diff "$WORK/before" "$WORK/after" >&2; then
  die "the source changed during the dump: is it read-only? (< before, > after)"
fi
dump_counts "$WORK/db.dump" > "$WORK/counts"
if ! diff "$WORK/after" "$WORK/counts" >&2; then
  die "the dump's row counts differ from the source's (< source, > dump)"
fi
echo "source: $(wc -l < "$WORK/counts") tables in $SCHEMAS, $(awk '{s += $2} END {print s + 0}' "$WORK/counts") rows; the dump has them all"
[ "$DUMP_ONLY" = yes ] && exit 0
if [ -n "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  upload_backup "$WORK/db.dump" "$WORK/counts" "$BACKUP_PREFIX/$(date -u +%Y%m%dT%H%M%SZ)-${1//[^a-z0-9]/}.dump.enc" "$1"
else
  echo "no BACKUP_ENCRYPTION_KEY: no copy of the source in Object Storage"
fi
restore DST "$WORK/db.dump" "$WORK/counts"
psql_on DST -F ' ' <<'SQL' | awk '{print "drizzle journal: " $1 " rows, last migration of " $2}'
SELECT count(*), coalesce(to_char(to_timestamp(max(created_at) / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '-')
FROM drizzle.__drizzle_migrations
SQL
echo "copied $1 into $2"
