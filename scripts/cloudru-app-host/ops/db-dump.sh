#!/bin/bash
# A dump of one database of the VM's env, run by deployd (POST /ops/v1/ops) as bro:
#
#   db-dump.sh app|world [PUT_URL]
#
# app is DATABASE_URL_UNPOOLED (else DATABASE_URL), world is WORKFLOW_POSTGRES_URL. The dump
# (pg_dump --format=custom) lands in /var/backups/bro/<db>-<UTC time>.dump; with PUT_URL, a presigned
# Object Storage PUT from `host.py ops`, it is uploaded there too. Prints the file, its size and sha256,
# never a connection string. Keeps the 5 newest dumps of each database on the disk.
set -euo pipefail
case "${1:-}" in
  app) URL=${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}} ;;
  world) URL=${WORKFLOW_POSTGRES_URL:-} ;;
  *) echo "usage: db-dump.sh app|world [PUT_URL]" >&2; exit 2 ;;
esac
[ -n "$URL" ] || { echo "no connection string for $1 in /etc/bro/env" >&2; exit 2; }
OUT="/var/backups/bro/$1-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-privileges --file "$OUT.partial" --dbname "$URL"
mv "$OUT.partial" "$OUT"
echo "dump $OUT $(stat -c %s "$OUT") bytes sha256 $(sha256sum "$OUT" | cut -d' ' -f1)"
if [ -n "${2:-}" ]; then
  curl -fsS --retry 3 -m 3600 -T "$OUT" "$2" -o /dev/null
  echo "uploaded"
fi
ls -1t /var/backups/bro/"$1"-*.dump | tail -n +6 | xargs -r rm -f
