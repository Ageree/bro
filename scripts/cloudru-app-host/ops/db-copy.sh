#!/bin/bash
# One database copied into another, checked table by table: the move off Neon, and the way back.
#
#   db-copy.sh FROM TO [--replace] [--dump-only] [--live-source]
#
# FROM and TO: app, neon (NEON_DATABASE_URL of deployd's ops env), db:<name>. Moving to Cloud.ru is
# `db-copy.sh neon app --replace`, going back `db-copy.sh app neon --replace` (docs/cloudru-migration.md,
# этап 5). The source must not change meanwhile: before the dump it must be read-only for its app or have
# nobody else connected, with no transaction of anyone else open; its row counts and its write counters
# (rows inserted, updated, deleted) are taken before and after pg_dump and must not move, and the dump's
# counts must be the source's. A table of another role fails it, unless ALLOW_FOREIGN_TABLES names it; Neon's
# neon_auth is never copied, drizzle (the migrations journal, its orphan rows too) is. Before the restore an
# encrypted copy of the source goes to <BACKUP_PREFIX>/<time>-<FROM>.dump.enc, and one of the target (when it
# has tables) to <time>-pre<TO>.dump.enc; never pruned. The restore is db-restore.sh's: one transaction, the
# target's own tables replaced, every table's count checked. Neon is a target only on production's VM while
# it is read-only with nobody else connected (the rollback window).
#
# --dump-only stops after the dump (a rehearsal, the source may be live: does the VM reach it, how long does
# the dump take; whether the source held still is not judged); --live-source copies a source that is in use,
# only on the stand (HOST_PROFILE=stand: the dump is one snapshot, but rows written meanwhile are not in it,
# so never for the move itself).
source "$(dirname "$0")/db-lib.sh"
[ $# -ge 2 ] || die "usage: db-copy.sh FROM TO [--replace] [--dump-only] [--live-source]"
REPLACE=no
DUMP_ONLY=no
LIVE=no
for flag in "${@:3}"; do
  case "$flag" in
    --replace) REPLACE=yes ;;
    --dump-only) DUMP_ONLY=yes ;;
    --live-source) LIVE=yes ;;
    *) die "unknown flag $flag" ;;
  esac
done
if [ "$LIVE" = yes ] && [ "${HOST_PROFILE:-}" != stand ]; then
  die "--live-source copies a live database, into the stand only (HOST_PROFILE=stand): here the source must be frozen"
fi
# The move needs a source that holds still; a rehearsal takes the dump's one snapshot.
FROZEN=no
if [ "$LIVE" = no ] && [ "$DUMP_ONLY" = no ]; then FROZEN=yes; fi
db_lock
connection SRC "$1"
connection DST "$2"
same_database SRC DST && die "FROM and TO are the same database"
if [ "$DUMP_ONLY" = no ]; then
  need_backup_key  # the copies of source and target are what undoes a copy made by mistake
  guard_target DST "$REPLACE"
fi
refuse_foreign SRC
if [ "$FROZEN" = yes ]; then
  require_frozen SRC
fi
workdir
echo "source: $(psql_on SRC -c "SELECT current_setting('server_version')"), pg_dump $(pg_dump --version | awk '{print $3}')"
SCHEMAS=$(live_schemas SRC)
[ -n "$SCHEMAS" ] || die "the source has no tables"
table_counts SRC "$SCHEMAS" > "$WORK/before"
writes_before=$(write_activity SRC)
started=$(date +%s)
dump SRC "$WORK/db.dump"
echo "dump: $(stat -c %s "$WORK/db.dump") bytes in $(($(date +%s) - started)) s"
dump_counts "$WORK/db.dump" > "$WORK/counts"
if [ "$FROZEN" = yes ]; then
  table_counts SRC "$SCHEMAS" > "$WORK/after"
  writes_after=$(write_activity SRC)
  if ! diff "$WORK/before" "$WORK/after" >&2 || [ "$writes_before" != "$writes_after" ]; then
    die "the source changed during the dump ($writes_before → $writes_after rows written): is it read-only?" \
      "(< before, > after)"
  fi
  if ! diff "$WORK/after" "$WORK/counts" >&2; then
    die "the dump's row counts differ from the source's (< source, > dump)"
  fi
  echo "source: $(wc -l < "$WORK/counts") tables in $SCHEMAS, $(awk '{s += $2} END {print s + 0}' "$WORK/counts") rows; the dump has them all, nothing was written meanwhile"
else
  echo "source not checked for writes (--dump-only, --live-source): $(wc -l < "$WORK/counts") tables, $(awk '{s += $2} END {print s + 0}' "$WORK/counts") rows in the dump's snapshot"
fi
[ "$DUMP_ONLY" = yes ] && exit 0
upload_backup "$WORK/db.dump" "$WORK/counts" "$BACKUP_PREFIX/$(date -u +%Y%m%dT%H%M%SZ)-${1//[^a-z0-9]/}.dump.enc" "$1"
restore DST "$WORK/db.dump" "$WORK/counts"
psql_on DST -F ' ' <<'SQL' | awk '{print "drizzle journal: " $1 " rows, last migration of " $2}'
SELECT count(*), coalesce(to_char(to_timestamp(max(created_at) / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '-')
FROM drizzle.__drizzle_migrations
SQL
echo "copied $1 into $2"
