#!/bin/bash
# Shared by the db-*.sh ops scripts (scripts/cloudru-app-host/README.md, «База»); sourced, does nothing run
# on its own. The scripts run on the VM as bro, by bro-backup.service or deployd (POST /ops/v1/ops), with the
# env of /etc/bro/env (and deployd's /etc/bro/ops-env: NEON_DATABASE_URL, never in the app's env). One runs at
# a time on the VM (db_lock). A dump holds people's data: it lives only in a 0700 work directory that goes away
# when the script ends (one left by a killed run goes with the next run), and leaves the VM only encrypted
# (openssl, BACKUP_ENCRYPTION_KEY).
#
# Databases are named, never written out: app (DATABASE_URL_UNPOOLED, else DATABASE_URL), check
# (BACKUP_CHECK_DATABASE_URL, the scratch database of db-restore-check.sh), neon (NEON_DATABASE_URL, only
# while moving off Neon or back) and db:<name> (one of DB_NAMES of app's cluster, with app's user). A
# password never goes on a command line, where any user of the VM could read it: commands get the URL without
# it and PGPASSWORD in their own environment.
#
# Errors of psql are terse and only their first ERROR line is shown: a failed COPY otherwise prints the row
# (DETAIL, CONTEXT) into the job log and journald.
set -euo pipefail
umask 077
OPS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PG_BIN=${PG_BIN:-/usr/lib/postgresql/18/bin}
if [ -d "$PG_BIN" ]; then PATH="$PG_BIN:$PATH"; fi
WORK_ROOT=${BACKUP_WORKDIR:-/var/backups/bro}
BACKUP_PREFIX=${BACKUP_PREFIX:-backups/postgres}
# AES-256-CBC with a PBKDF2 key from BACKUP_ENCRYPTION_KEY; the manifest carries the sha256s and an HMAC of
# the same key (store.py), so a dump someone else put in the bucket is refused before it is decrypted.
CIPHER=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha256)
# Every table of these schemas is counted; neon_auth is Neon's own (its role does not exist elsewhere).
SKIP_SCHEMAS="'pg_catalog','information_schema','pg_toast','neon_auth'"
# The only databases db:<name> may name: the stand's app database and the scratch one. Never a world
# (*_workflow) or production's bro.
DB_NAMES=${DB_NAMES:-bro_stand bro_restore_check}

die() {
  echo "$*" >&2
  exit 1
}

# BACKUPS=off in /etc/bro/env turns backups off on purpose; anything else means they are expected, and a
# missing key or check database is a failure the owner hears about, not a quiet skip.
backups_on() { [ "${BACKUPS:-on}" != off ]; }

need_backup_key() {
  [ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || die "no BACKUP_ENCRYPTION_KEY in /etc/bro/env (BACKUPS=off turns backups off)"
}

# One db-*.sh at a time on this VM, whoever starts it (bro-backup.service, deployd's POST /ops/v1/ops): a
# backup must not dump while a restore wipes, nor two backups share a key or the success marker. Taken before
# any check of a database and held until the process ends; bro-backup.service runs its two scripts one after
# the other, so each takes it in turn. Not in /tmp: bro-backup.service has a private one.
db_lock() {
  mkdir -p "$WORK_ROOT"
  exec 9>> "$WORK_ROOT/.db.lock"
  if ! flock -n 9; then
    echo "another db-*.sh is running on this VM: waiting for it (at most an hour)" >&2
    flock -w 3600 9 || die "another db-*.sh is still running after an hour: nothing done"
  fi
  # No other run is going now: a work directory is a killed run's (OOM, reboot, timeout), a dump in plain text.
  find "$WORK_ROOT" -mindepth 1 -maxdepth 1 -name 'work.*' -exec rm -rf {} + \
    || echo "could not remove a killed run's work directory in $WORK_ROOT" >&2
}

workdir() {
  mkdir -p "$WORK_ROOT"
  WORK=$(mktemp -d "$WORK_ROOT/work.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT
}

store() { python3 "$OPS/store.py" "$@"; }

database_url() {
  local base name
  case "$1" in
    app) echo "${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}" ;;
    check) echo "${BACKUP_CHECK_DATABASE_URL:-}" ;;
    neon) echo "${NEON_DATABASE_URL:-}" ;;
    db:*)
      name=${1#db:}
      [[ " $DB_NAMES " == *" $name "* ]] || die "db:$name: only db:<one of $DB_NAMES>"
      base=${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}
      [ -n "$base" ] || die "db:$name needs DATABASE_URL in /etc/bro/env"
      BASE_URL="$base" DB_NAME="$name" python3 -c 'import os, urllib.parse as u
p = u.urlsplit(os.environ["BASE_URL"])
print(u.urlunsplit(p._replace(path="/" + os.environ["DB_NAME"])))'
      ;;
    *) die "a database: app, check, neon or db:<name>" ;;
  esac
}

# connection NAME WHICH: NAME_CONN (the URL without its password) and NAME_PASS for database WHICH.
connection() {
  local url out
  url=$(database_url "$2")
  [ -n "$url" ] || die "no connection string for $2 in /etc/bro/env"
  out=$(CONN_URL="$url" python3 -c 'import os, urllib.parse as u
p = u.urlsplit(os.environ["CONN_URL"])
if p.scheme not in ("postgres", "postgresql") or not p.hostname or not p.path.strip("/"):
    raise SystemExit(1)
user = u.quote(u.unquote(p.username), safe="") + "@" if p.username else ""
print(u.urlunsplit(p._replace(netloc=user + p.netloc.rpartition("@")[2])))
print("P" + u.unquote(p.password or ""))') || die "$2: not a postgres:// URL with a host and a database"
  printf -v "${1}_CONN" '%s' "${out%%$'\n'*}"
  local pass=${out#*$'\n'}
  printf -v "${1}_PASS" '%s' "${pass#P}"
  printf -v "${1}_WHICH" '%s' "$2"
}

# as_db NAME COMMAND...: the command with NAME's password in its environment only.
as_db() {
  local pass="${1}_PASS"
  shift
  PGPASSWORD="${!pass}" "$@"
}

conn() {
  local var="${1}_CONN"
  echo "${!var}"
}

which_of() {
  local var="${1}_WHICH"
  echo "${!var}"
}

psql_on() {
  local name=$1
  shift
  as_db "$name" psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -v SHOW_CONTEXT=never \
    --dbname "$(conn "$name")" "$@"
}

# The first ERROR line of a psql stderr file, cut short: what a job log may show of a failure.
first_error() {
  { grep -m1 -o 'ERROR:.*' "$1" || echo "(no ERROR line)"; } | cut -c1-200
}

# The database the world keeps its runs in: restoring Bro's tables there would wipe it.
refuse_world() {
  [ -n "${WORKFLOW_POSTGRES_URL:-}" ] || return 0
  WORLD_URL="$WORKFLOW_POSTGRES_URL" TARGET="$(conn "$1")" python3 -c 'import os, sys, urllib.parse as u
a, b = u.urlsplit(os.environ["WORLD_URL"]), u.urlsplit(os.environ["TARGET"])
same = (a.hostname, a.port or 5432, a.path) == (b.hostname, b.port or 5432, b.path)
sys.exit(1 if same else 0)' || die "that is the Workflow world's database: refusing to restore Bro's tables there"
}

same_database() {
  A="$(conn "$1")" B="$(conn "$2")" python3 -c 'import os, sys, urllib.parse as u
a, b = u.urlsplit(os.environ["A"]), u.urlsplit(os.environ["B"])
sys.exit(0 if (a.hostname, a.port or 5432, a.path) == (b.hostname, b.port or 5432, b.path) else 1)'
}

# "schema.table" (quoted where SQL needs it, as pg_dump's patterns take it) of every table another role owns (outside the system schemas and neon_auth): a dump leaves
# them out, since the connecting user may not read them, and a restore would not own them.
foreign_tables() {
  psql_on "$1" <<SQL
SELECT format('%I.%I', schemaname, tablename) FROM pg_catalog.pg_tables
WHERE tableowner <> current_user AND schemaname NOT IN ($SKIP_SCHEMAS) AND schemaname NOT LIKE 'pg\_temp%'
ORDER BY 1
SQL
}

# A source whose tables a dump would leave out fails, unless each is in ALLOW_FOREIGN_TABLES ("schema.table"
# or "schema.*", space-separated): the counts cover only the dumped tables, so they could not see the gap.
refuse_foreign() {
  local table missing=()
  while read -r table; do
    [ -n "$table" ] || continue
    if [[ " ${ALLOW_FOREIGN_TABLES:-} " == *" $table "* || " ${ALLOW_FOREIGN_TABLES:-} " == *" ${table%%.*}.* "* ]]; then
      echo "left out (another role's, ALLOW_FOREIGN_TABLES): $table" >&2
    else
      missing+=("$table")
    fi
  done < <(foreign_tables "$1")
  [ ${#missing[@]} -eq 0 ] || die "$(which_of "$1") has tables of another role, which a dump leaves out:" \
    "${missing[*]} (ALLOW_FOREIGN_TABLES in /etc/bro/env lets them go, if that is right)"
}

# NAME FILE: the custom-format dump of the connecting user's tables; FILE.excluded lists the tables of other
# roles it left out (and says so on stderr). Neon's neon_auth is never dumped.
dump() {
  local foreign=() args=() table
  mapfile -t foreign < <(foreign_tables "$1")
  : > "$2.excluded"
  for table in "${foreign[@]}"; do
    [ -n "$table" ] || continue
    echo "$table" >> "$2.excluded"
    args+=("--exclude-table=$table")
  done
  if [ -s "$2.excluded" ]; then
    echo "left out of the dump (another role's): $(paste -sd' ' "$2.excluded")" >&2
  fi
  as_db "$1" pg_dump --format=custom --no-owner --no-privileges --exclude-schema=neon_auth "${args[@]}" \
    --file "$2.partial" --dbname "$(conn "$1")"
  mv "$2.partial" "$2"
}

# COPY text on stdin → "schema.table rows" per COPY block. A header counts only outside a block: a row may
# well start with "COPY " too. COPY's text format escapes line breaks and backslashes, so one line is one row
# and a data line is never "\.".
copy_counts() {
  awk '
    !inside && /^COPY / { name = $2; gsub(/"/, "", name); rows = 0; inside = 1; next }
    inside && /^\\\.$/ { print name, rows; inside = 0; next }
    inside { rows++ }' | LC_ALL=C sort
}

# The counts of a dump's tables, from its COPY blocks: those of the dump's snapshot.
dump_counts() {
  pg_restore --data-only --file - "$1" | copy_counts
}

schemas_of() {  # counts file -> schema,schema
  cut -d' ' -f1 "$1" | sed 's/\..*//' | LC_ALL=C sort -u | paste -sd, -
}

# "schema.table rows" per table of these schemas in a live database: the tables of the connecting user (a
# restore makes it their owner); refuse_foreign makes sure no other table was there to count.
table_counts() {  # NAME SCHEMAS
  psql_on "$1" -F ' ' -v schemas="$2" <<'SQL' | LC_ALL=C sort
SELECT format('%s.%s', schemaname, tablename),
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename),
                                            false, true, '')))[1]::text
FROM pg_catalog.pg_tables
WHERE schemaname = ANY (string_to_array(:'schemas', ',')) AND tableowner = current_user
SQL
}

# The schemas with tables in a live database, Neon's and the system's left out.
live_schemas() {
  psql_on "$1" <<SQL | paste -sd, -
SELECT DISTINCT schemaname FROM pg_catalog.pg_tables
WHERE tableowner = current_user AND schemaname NOT IN ($SKIP_SCHEMAS) AND schemaname NOT LIKE 'pg\_temp%' ORDER BY 1
SQL
}

owned_tables() {
  psql_on "$1" <<SQL
SELECT count(*) FROM pg_catalog.pg_tables WHERE tableowner = current_user AND schemaname NOT IN ($SKIP_SCHEMAS)
SQL
}

# Writes so far to the tables a dump takes (inserted, updated, deleted rows): UPDATEs leave the row counts
# alone, these do not. The statistics lag a backend by up to a second or so, which the frozen-source check
# before the dump covers.
write_activity() {
  psql_on "$1" <<SQL
SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) FROM pg_catalog.pg_stat_user_tables
WHERE schemaname NOT IN ($SKIP_SCHEMAS)
SQL
}

# Other sessions of the connecting user (Bro's own, or Vercel's on Neon) in that database.
other_sessions() {  # NAME [busy]: busy counts only those inside a transaction
  local busy=""
  [ "${2:-}" = busy ] && busy="AND state IS DISTINCT FROM 'idle' AND xact_start IS NOT NULL"
  psql_on "$1" -c "SELECT count(*) FROM pg_catalog.pg_stat_activity
    WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid() $busy"
}

# The database's own default, not this session's (no PGOPTIONS here).
read_only_default() { psql_on "$1" -c "SHOW default_transaction_read_only"; }

# A source that cannot change while it is dumped: read-only for its app (the window of a move) or with nobody
# else connected (Bro stopped), and no transaction of anyone else open.
require_frozen() {
  local ro others busy
  ro=$(read_only_default "$1")
  others=$(other_sessions "$1")
  if [ "$ro" != on ] && [ "$others" != 0 ]; then
    die "$(which_of "$1") is writable and has $others other sessions: make it read-only first" \
      "(ALTER DATABASE … SET default_transaction_read_only = on and pg_terminate_backend, or host.py stop" \
      "NAME bro-eve bro-web); --live-source copies a live database (a rehearsal, never the move)"
  fi
  busy=$(other_sessions "$1" busy)
  [ "$busy" = 0 ] || die "$(which_of "$1") has $busy other sessions inside a transaction: they could still write"
}

# Nobody else in a target: Bro (stopped for a restore), or on Neon a session of Vercel's. read_only is only the
# default of new sessions, so one opened before Neon went read-only can still write.
no_other_sessions() {
  local others
  others=$(other_sessions "$1")
  [ "$others" = 0 ] && return 0
  if [ "$(which_of "$1")" = neon ]; then
    die "$others other sessions on Neon: one opened before it went read-only could still write" \
      "(pg_terminate_backend them, with Vercel's crons off)"
  fi
  die "$others other connections to $(which_of "$1"): host.py stop NAME bro-eve bro-web first"
}

# Drops what the connecting user owns outside the system schemas: its schemas (neon_auth aside), and its
# tables, views, sequences, types and routines in public, none of an extension. A restore lands in an empty
# database. Objects of other roles (the provider's, Neon's neon_auth) stay.
WIPE_SQL=$(cat <<'SQL'
DO $wipe$
DECLARE r record;
BEGIN
  FOR r IN SELECT n.nspname FROM pg_catalog.pg_namespace n
           WHERE n.nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
             AND n.nspname NOT IN ('public', 'information_schema', 'neon_auth') AND n.nspname NOT LIKE 'pg\_%'
  LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', r.nspname);
  END LOOP;
  FOR r IN SELECT c.relname, c.relkind FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND pg_catalog.pg_get_userbyid(c.relowner) = current_user
             AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass
                             AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('DROP %s IF EXISTS public.%I CASCADE',
                   CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                                  WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
                   r.relname);
  END LOOP;
  -- Enums, domains, ranges and standalone composite types (a table's own row type went with the table).
  FOR r IN SELECT t.typname FROM pg_catalog.pg_type t
           JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' AND pg_catalog.pg_get_userbyid(t.typowner) = current_user
             AND (t.typtype IN ('e', 'd', 'r')
                  OR (t.typtype = 'c' AND (SELECT relkind FROM pg_catalog.pg_class WHERE oid = t.typrelid) = 'c'))
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_type'::regclass
                             AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure::text AS routine FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND pg_catalog.pg_get_userbyid(p.proowner) = current_user
             AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                             AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('DROP ROUTINE IF EXISTS %s CASCADE', r.routine);
  END LOOP;
END
$wipe$;
SQL
)

# A database held read-only for its app (ALTER DATABASE … SET default_transaction_read_only, the window of a
# move) still takes the restore: the setting is only a default, and these sessions turn it off.
WRITABLE="-c default_transaction_read_only=off"

wipe() { PGOPTIONS="$WRITABLE" psql_on "$1" -c "SET client_min_messages = warning" -c "$WIPE_SQL"; }

# Refuses a database that has tables unless --replace was given; any but the scratch one while another session
# is in it (checked again right before the restore); Neon unless this is production and Neon is read-only
# for its app (the window of a rollback: before it, Neon is production's live database); the world's.
guard_target() {  # NAME REPLACE(yes|no)
  local tables which
  which=$(which_of "$1")
  refuse_world "$1"
  if [ "$which" = neon ]; then
    [ "${HOST_PROFILE:-}" = prod ] || die "neon is a target only on production's VM (HOST_PROFILE=prod)"
    [ "$(read_only_default "$1")" = on ] || die "Neon is writable for its app (live production): writing to it" \
      "is for the rollback window only (ALTER DATABASE … SET default_transaction_read_only = on first)"
  fi
  tables=$(owned_tables "$1")
  if [ "$tables" != "0" ] && [ "$2" != "yes" ]; then
    die "$which has $tables tables: pass --replace to put the dump in their place"
  fi
  if [ "$which" != check ]; then
    no_other_sessions "$1"
    printf -v "${1}_LIVE" '%s' yes
  fi
}

# upload_backup DUMP COUNTS KEY SOURCE: the encrypted dump at KEY and its signed manifest next to it.
upload_backup() {
  need_backup_key
  encrypt "$1" "$WORK/upload.enc"
  store manifest --out "$WORK/manifest.json" --key "$3" --source "$4" --counts "$2" --excluded "$1.excluded" \
    --sha256 "$(sha256_of "$WORK/upload.enc")" --size "$(stat -c %s "$WORK/upload.enc")" \
    --dump-sha256 "$(sha256_of "$1")" --pg-dump "$(pg_dump --version)"
  # The manifest goes last: a dump without one is never taken for a backup (store.py latest).
  store put "$3" "$WORK/upload.enc"
  store put "${3%.dump.enc}.json" "$WORK/manifest.json"
  rm -f "$WORK/upload.enc"
}

# What the target holds goes to Object Storage before it is wiped: a restore or copy run by mistake (or one
# more time, over writes made since) can be undone. The scratch database needs none.
keep_target() {  # NAME
  local which
  which=$(which_of "$1")
  [ "$which" != check ] || return 0
  [ "$(owned_tables "$1")" != 0 ] || return 0
  need_backup_key
  dump "$1" "$WORK/target.dump"
  dump_counts "$WORK/target.dump" > "$WORK/target.counts"
  upload_backup "$WORK/target.dump" "$WORK/target.counts" \
    "$BACKUP_PREFIX/$(date -u +%Y%m%dT%H%M%SZ)-pre${which//[^a-z0-9]/}.dump.enc" "$which"
  rm -f "$WORK/target.dump" "$WORK/target.counts"
}

# restore NAME DUMP COUNTS: the target's own copy to Object Storage, then wipe and restore in one transaction
# (a failure leaves the database as it was), then the row count of every table must be the dump's.
restore() {
  local which
  which=$(which_of "$1")
  pg_restore --no-owner --no-privileges --file "$WORK/restore.sql" "$2"
  keep_target "$1"
  local live="${1}_LIVE"
  if [ "${!live:-}" = yes ]; then no_other_sessions "$1"; fi  # a deploy, restart or reconnect since the guard
  if ! PGOPTIONS="$WRITABLE" psql_on "$1" --single-transaction -c "SET client_min_messages = warning" \
    -c "$WIPE_SQL" -f "$WORK/restore.sql" > /dev/null 2> "$WORK/restore.err"; then
    die "the restore failed, $which is as it was: $(first_error "$WORK/restore.err")"
  fi
  rm -f "$WORK/restore.sql" "$WORK/restore.err"
  PGOPTIONS="$WRITABLE" psql_on "$1" -c "SET client_min_messages = error" -c "ANALYZE"
  table_counts "$1" "$(schemas_of "$3")" > "$WORK/restored-counts"
  if ! diff "$3" "$WORK/restored-counts" > "$WORK/restored-diff"; then
    cat "$WORK/restored-diff" >&2
    die "the restored row counts differ from the dump's (< dump, > restored)"
  fi
  echo "restored $(wc -l < "$3") tables, $(awk '{s += $2} END {print s + 0}' "$3") rows; counts match the dump"
}

encrypt() {
  need_backup_key
  export BACKUP_ENCRYPTION_KEY
  openssl enc -e "${CIPHER[@]}" -salt -pass env:BACKUP_ENCRYPTION_KEY -in "$1" -out "$2"
}

decrypt() {
  need_backup_key
  export BACKUP_ENCRYPTION_KEY
  openssl enc -d "${CIPHER[@]}" -pass env:BACKUP_ENCRYPTION_KEY -in "$1" -out "$2" \
    || die "cannot decrypt: a damaged object"
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# fetch_backup KEY DUMP COUNTS: download, check the manifest's signature and the object against it,
# decrypt, count.
fetch_backup() {
  need_backup_key
  export BACKUP_ENCRYPTION_KEY
  store get "${1%.dump.enc}.json" "$WORK/manifest.json"
  store verify --manifest "$WORK/manifest.json" --key "$1"
  store get "$1" "$WORK/fetched.enc"
  store verify --manifest "$WORK/manifest.json" --key "$1" --file "$WORK/fetched.enc"
  decrypt "$WORK/fetched.enc" "$2"
  rm -f "$WORK/fetched.enc"
  store verify --manifest "$WORK/manifest.json" --key "$1" --dump "$2"
  dump_counts "$2" > "$3"
  store verify --manifest "$WORK/manifest.json" --key "$1" --counts "$3"
}
