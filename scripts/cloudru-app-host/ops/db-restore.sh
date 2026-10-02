#!/bin/bash
# Restores a dump into one database of the VM's env, run by deployd (POST /ops/v1/ops) as bro:
#
#   db-restore.sh app|world GET_URL SHA256 --replace
#
# GET_URL is a presigned Object Storage link to a pg_dump --format=custom file (db-dump.sh, or a dump of
# Neon made from the session), checked against SHA256 before anything is touched. --replace is required:
# the restore drops what the dump holds (pg_restore --clean --if-exists) in one transaction. Stop the
# services that write first (host.py restart is not enough: stop bro-eve, bro-web).
set -euo pipefail
case "${1:-}" in
  app) URL=${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}} ;;
  world) URL=${WORKFLOW_POSTGRES_URL:-} ;;
  *) echo "usage: db-restore.sh app|world GET_URL SHA256 --replace" >&2; exit 2 ;;
esac
[ -n "$URL" ] || { echo "no connection string for $1 in /etc/bro/env" >&2; exit 2; }
[[ "${3:-}" =~ ^[0-9a-f]{64}$ ]] || { echo "SHA256: 64 hex characters" >&2; exit 2; }
[ "${4:-}" = "--replace" ] || { echo "the restore replaces data: pass --replace" >&2; exit 2; }
FILE="/var/backups/bro/restore-$1.dump"
curl -fsS --retry 3 -m 3600 -o "$FILE" "$2"
echo "$3  $FILE" | sha256sum -c --quiet - || { rm -f "$FILE"; echo "sha256 mismatch" >&2; exit 1; }
echo "restore $(stat -c %s "$FILE") bytes into $1"
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error \
  --dbname "$URL" "$FILE"
rm -f "$FILE"
echo "restored"
