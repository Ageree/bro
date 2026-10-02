#!/bin/bash
# Shared by the db-*.sh ops scripts (scripts/cloudru-app-host/README.md, «База»); sourced, does nothing run
# on its own. The scripts run on the VM as bro, by bro-backup.service or deployd (POST /ops/v1/ops), with the
# env of /etc/bro/env. A dump holds people's data: it lives only in a 0700 work directory that goes away when
# the script ends, and leaves the VM only encrypted (openssl, BACKUP_ENCRYPTION_KEY).
#
# Databases are named, never written out: app (DATABASE_URL_UNPOOLED, else DATABASE_URL), check
# (BACKUP_CHECK_DATABASE_URL, the scratch database of db-restore-check.sh), neon (NEON_DATABASE_URL, only
# while moving off Neon or back) and db:<name> (another database of app's cluster, with app's user). A
# password never goes on a command line, where any user of the VM could read it: commands get the URL without
# it and PGPASSWORD in their own environment.
set -euo pipefail
umask 077
OPS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PG_BIN=${PG_BIN:-/usr/lib/postgresql/18/bin}
if [ -d "$PG_BIN" ]; then PATH="$PG_BIN:$PATH"; fi
WORK_ROOT=${BACKUP_WORKDIR:-/var/backups/bro}
BACKUP_PREFIX=${BACKUP_PREFIX:-backups/postgres}
# AES-256-CBC with a PBKDF2 key from BACKUP_ENCRYPTION_KEY; integrity is the sha256 in the manifest.
CIPHER=(-aes-256-cbc -pbkdf2 -iter 600000 -md sha256)
# Every table of these schemas is counted; neon_auth is Neon's own (its role does not exist elsewhere).
SKIP_SCHEMAS="'pg_catalog','information_schema','pg_toast','neon_auth'"

die() {
  echo "$*" >&2
  exit 1
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
      [[ "$name" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "db:<name>: a plain database name"
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

psql_on() {
  local name=$1
  shift
  as_db "$name" psql -X -q -A -t -v ON_ERROR_STOP=1 --dbname "$(conn "$name")" "$@"
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

# NAME FILE: the custom-format dump of the connecting user's tables: Neon's neon_auth and whatever else
# another role owns (the provider's) are left out, as they are from the counts.
dump() {
  local foreign=()
  mapfile -t foreign < <(psql_on "$1" <<SQL
SELECT '--exclude-table="' || replace(schemaname, '"', '""') || '"."' || replace(tablename, '"', '""') || '"'
FROM pg_catalog.pg_tables WHERE tableowner <> current_user AND schemaname NOT IN ($SKIP_SCHEMAS)
SQL
  )
  as_db "$1" pg_dump --format=custom --no-owner --no-privileges --exclude-schema=neon_auth "${foreign[@]}" \
    --file "$2.partial" --dbname "$(conn "$1")"
  mv "$2.partial" "$2"
}

# "schema.table rows" per table of the dump, from its COPY blocks (one line per row: COPY's text format
# escapes line breaks), so the counts are those of the dump's snapshot.
dump_counts() {
  pg_restore --data-only --file - "$1" | awk '
    /^COPY / { name = $2; gsub(/"/, "", name); rows = 0; inside = 1; next }
    inside && /^\\\.$/ { print name, rows; inside = 0; next }
    inside { rows++ }' | LC_ALL=C sort
}

schemas_of() {  # counts file -> schema,schema
  cut -d' ' -f1 "$1" | sed 's/\..*//' | LC_ALL=C sort -u | paste -sd, -
}

# "schema.table rows" per table of these schemas in a live database: the tables of the connecting user (a
# restore makes it their owner), not the provider's.
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

# Drops what the connecting user owns outside the system schemas (its schemas, and its tables, views and
# sequences in public): a restore lands in an empty database. Objects of other roles (the provider's, Neon's
# neon_auth) stay.
WIPE_SQL=$(cat <<'SQL'
DO $wipe$
DECLARE r record;
BEGIN
  FOR r IN SELECT n.nspname FROM pg_catalog.pg_namespace n
           WHERE n.nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
             AND n.nspname NOT IN ('public', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
  LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', r.nspname);
  END LOOP;
  FOR r IN SELECT c.relname, c.relkind FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND pg_catalog.pg_get_userbyid(c.relowner) = current_user
             AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  LOOP
    EXECUTE format('DROP %s IF EXISTS public.%I CASCADE',
                   CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                                  WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
                   r.relname);
  END LOOP;
END
$wipe$;
SQL
)

# A database held read-only for its app (ALTER DATABASE … SET default_transaction_read_only, the window of a
# move) still takes the restore: the setting is only a default, and these sessions turn it off.
WRITABLE="-c default_transaction_read_only=off"

wipe() { PGOPTIONS="$WRITABLE" psql_on "$1" -c "SET client_min_messages = warning" -c "$WIPE_SQL"; }

# Refuses a database that has tables unless --replace was given, and `app` while Bro is connected to it.
guard_target() {  # NAME REPLACE(yes|no)
  local tables
  tables=$(owned_tables "$1")
  local which="${1}_WHICH"
  if [ "$tables" != "0" ] && [ "$2" != "yes" ]; then
    die "${!which} has $tables tables: pass --replace to put the dump in their place"
  fi
  if [ "${!which}" = "app" ]; then
    local others
    others=$(psql_on "$1" -c "SELECT count(*) FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid()")
    [ "$others" = "0" ] || die "$others other connections of Bro to app: host.py stop NAME bro-eve bro-web first"
  fi
}

# restore NAME DUMP COUNTS: wipe and restore in one transaction (a failure leaves the database as it was),
# then the row count of every table must be the dump's.
restore() {
  pg_restore --no-owner --no-privileges --file "$WORK/restore.sql" "$2"
  PGOPTIONS="$WRITABLE" psql_on "$1" --single-transaction -c "SET client_min_messages = warning" -c "$WIPE_SQL" \
    -f "$WORK/restore.sql" >/dev/null
  rm -f "$WORK/restore.sql"
  PGOPTIONS="$WRITABLE" psql_on "$1" -c "SET client_min_messages = error" -c "ANALYZE"
  table_counts "$1" "$(schemas_of "$3")" > "$WORK/restored-counts"
  if ! diff "$3" "$WORK/restored-counts" > "$WORK/restored-diff"; then
    cat "$WORK/restored-diff" >&2
    die "the restored row counts differ from the dump's (< dump, > restored)"
  fi
  echo "restored $(wc -l < "$3") tables, $(awk '{s += $2} END {print s + 0}' "$3") rows; counts match the dump"
}

encrypt() {
  [ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || die "no BACKUP_ENCRYPTION_KEY in /etc/bro/env"
  export BACKUP_ENCRYPTION_KEY
  openssl enc -e "${CIPHER[@]}" -salt -pass env:BACKUP_ENCRYPTION_KEY -in "$1" -out "$2"
}

decrypt() {
  [ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || die "no BACKUP_ENCRYPTION_KEY in /etc/bro/env"
  export BACKUP_ENCRYPTION_KEY
  openssl enc -d "${CIPHER[@]}" -pass env:BACKUP_ENCRYPTION_KEY -in "$1" -out "$2" \
    || die "cannot decrypt: another BACKUP_ENCRYPTION_KEY, or a damaged object"
}

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# upload_backup DUMP COUNTS KEY SOURCE: the encrypted dump at KEY and its manifest next to it (.json).
upload_backup() {
  encrypt "$1" "$WORK/upload.enc"
  store manifest --out "$WORK/manifest.json" --key "$3" --source "$4" --counts "$2" \
    --sha256 "$(sha256_of "$WORK/upload.enc")" --size "$(stat -c %s "$WORK/upload.enc")" \
    --dump-sha256 "$(sha256_of "$1")" --pg-dump "$(pg_dump --version)"
  store put "$3" "$WORK/upload.enc"
  store put "${3%.dump.enc}.json" "$WORK/manifest.json"
  rm -f "$WORK/upload.enc"
}

# fetch_backup KEY DUMP COUNTS: download, check against the manifest, decrypt, count.
fetch_backup() {
  store get "${1%.dump.enc}.json" "$WORK/manifest.json"
  store get "$1" "$WORK/fetched.enc"
  store verify --manifest "$WORK/manifest.json" --file "$WORK/fetched.enc"
  decrypt "$WORK/fetched.enc" "$2"
  rm -f "$WORK/fetched.enc"
  store verify --manifest "$WORK/manifest.json" --dump "$2"
  dump_counts "$2" > "$3"
  store verify --manifest "$WORK/manifest.json" --counts "$3"
}
