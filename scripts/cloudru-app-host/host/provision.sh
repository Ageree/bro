#!/bin/bash
# Sets up Bro's own VM (scripts/cloudru-app-host/README.md) on a stock ubuntu-22.04: run once as root by
# bro-app-host-boot (cloud-init, see boot.py) from the unpacked bundle in /opt/bro/app-host. From Cloud.ru
# only mirror.yandex.ru (apt) and Object Storage answer reliably: Caddy comes in the bundle, Node and the
# PostgreSQL client from presigned Object Storage URLs, each checked by SHA-256.
#
# What it leaves: the user bro (home /var/lib/bro-home), /srv/bro/{releases,current} owned by root, /etc/bro/env (0600, empty until PUT
# /ops/v1/env), the units bro-web and bro-eve (they start with the first release), deployd behind Caddy on
# the ops host <public IP with dashes>.sslip.io, the watchdog and backup timers, tg-egress running and
# tg-bridge installed but off (install-code.sh), journald capped at 1 GB. Stages go to
# /var/lib/bro/stage and timeline; a failure leaves `failed:<stage>:line N`.
#
# Two options of the colocated server (boot.py --shared-caddy --local-postgres, docs/colocated-host.md), both off
# in the VM's boot settings, which then does exactly what it did before them:
#   sharedCaddy:  the browser host's Caddy (browser-vm/host) serves the ops domain as a file in sites/; no Caddy
#                 is installed here and no caddy user made (the browser host's caddy user gets CADDY_EGRESS)
#   localPostgres: PostgreSQL 18 server on localhost for the app and the world, its passwords in postgres.json
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BOOT=/etc/bro/app-host-boot.json
HOST=/opt/bro/app-host
STATE=/var/lib/bro
mkdir -p "$STATE"
stage() {
  echo "$1" > "$STATE/stage"
  echo "$(cut -d' ' -f1 /proc/uptime) $(date +%s) $1" >> "$STATE/timeline"
}
retry() { for i in 1 2 3 4 5; do "$@" && return 0; sleep $((i * 5)); done; return 1; }
fail() { stage "failed:$1"; exit 1; }
trap 'stage "failed:$(cat "$STATE/stage"):line $LINENO"' ERR
field() { python3 -c 'import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value[int(key)] if isinstance(value, list) else value.get(key, "")
print(value)' "$1" "$2"; }
APT=(apt-get -q -o DPkg::Lock::Timeout=600)
stage start

for file in install-code.sh deployd.py watchdog.py egress.sh world-unlock.sh bro-egress.service bro-web.service bro-eve.service \
  deployd.service bro-watchdog.service bro-watchdog.timer bro-backup.service bro-backup.timer \
  bro-backup-alert.service caddy.service vendor/caddy tg-egress/tg_egress.py tg-egress/setup.sh \
  tg-egress/bro-tg-egress.service tg-bridge/tg_bridge.py tg-bridge/install.sh tg-bridge/bro-tg-bridge.service \
  ops/tg-bridge.sh; do
  [ -f "$HOST/$file" ] || fail "the bundle has no $file"
done
[ -f /etc/bro/deployd.json ] || fail "no /etc/bro/deployd.json"

stage packages
APT_MIRROR=$(field "$BOOT" aptMirror)
if [ -n "$APT_MIRROR" ]; then
  sed -i -E "s#https?://([a-z]{2}\.)?(archive|security)\.ubuntu\.com/ubuntu/?#${APT_MIRROR%/}/#g" \
    /etc/apt/sources.list
fi
retry "${APT[@]}" update
retry "${APT[@]}" install -y curl ca-certificates zstd xz-utils python3 iptables

fetch() {  # url sha256 out
  for i in 1 2 3 4 5; do
    curl -fsS --connect-timeout 10 -m 600 -o "$3" "$1" && echo "$2  $3" | sha256sum -c --quiet - && return 0
    rm -f "$3"
    sleep $((i * 5))
  done
  return 1
}

stage node
NODE_VERSION=$(field "$BOOT" node.version)
[[ "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "bad node version"
if [ ! -x "/opt/node-v$NODE_VERSION/bin/node" ]; then
  fetch "$(field "$BOOT" node.url)" "$(field "$BOOT" node.sha256)" /root/node.tar.xz || fail "node download"
  rm -rf "/opt/.node-v$NODE_VERSION"
  mkdir -p "/opt/.node-v$NODE_VERSION"
  tar -xJf /root/node.tar.xz -C "/opt/.node-v$NODE_VERSION" --strip-components=1 --no-same-owner
  rm -f /root/node.tar.xz
  mv "/opt/.node-v$NODE_VERSION" "/opt/node-v$NODE_VERSION"
fi
ln -sfn "/opt/node-v$NODE_VERSION/bin/node" /usr/local/bin/node
[ "$(/usr/local/bin/node --version)" = "v$NODE_VERSION" ] || fail "node is not v$NODE_VERSION"

stage postgresql-client
# pg_dump, pg_restore and psql of PostgreSQL 18 (the managed cluster's version) for the ops scripts.
DEBS=()
for i in 0 1 2; do
  NAME=$(field "$BOOT" "postgresqlClient.$i.name")
  [[ "$NAME" =~ ^[A-Za-z0-9.+_-]+\.deb$ ]] || fail "bad package name"
  fetch "$(field "$BOOT" "postgresqlClient.$i.url")" "$(field "$BOOT" "postgresqlClient.$i.sha256")" \
    "/root/$NAME" || fail "download $NAME"
  DEBS+=("/root/$NAME")
done
retry "${APT[@]}" install -y "${DEBS[@]}"
rm -f "${DEBS[@]}"
/usr/lib/postgresql/18/bin/pg_dump --version | grep -q ' 18\.' || fail "pg_dump is not 18"
LOCAL_POSTGRES=$(field "$BOOT" localPostgres)
if [ "$LOCAL_POSTGRES" = True ]; then
  stage postgresql-server
  # The server of PostgreSQL 18 from the PostgreSQL project's apt repository (apt.postgresql.org). The key that signs
  # it is pinned by its full fingerprint, checked here before apt trusts it; apt then checks every package by it.
  PGDG_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
  retry "${APT[@]}" install -y gnupg
  for i in 1 2 3 4 5; do
    curl -fsS --connect-timeout 10 -m 120 -o /root/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc && break
    [ "$i" = 5 ] && fail "the PGDG key"
    sleep $((i * 5))
  done
  [ "$(gpg --batch --with-colons --show-keys /root/pgdg.asc | awk -F: '$1 == "fpr" { print $10; exit }')" \
    = "$PGDG_FINGERPRINT" ] || fail "the PGDG key is not $PGDG_FINGERPRINT"
  gpg --batch --yes --dearmor --output /usr/share/keyrings/pgdg.gpg /root/pgdg.asc
  rm -f /root/pgdg.asc
  # shellcheck disable=SC1091 # the release file of this host
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  [ "$CODENAME" = jammy ] || fail "the PGDG packages checked here are for jammy, not $CODENAME"
  echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  retry "${APT[@]}" update
  # Before the holds below: the server's own client may move to the repository's build of 18 with it.
  retry "${APT[@]}" install -y postgresql-18
  /usr/lib/postgresql/18/bin/postgres --version | grep -q ' 18\.' || fail "postgres is not 18"

  stage postgresql-database
  PG_CONF=/etc/postgresql/18/main
  [ -d "$PG_CONF" ] || fail "no PostgreSQL 18 cluster"
  grep -q "^include_dir = 'conf.d'" "$PG_CONF/postgresql.conf" || fail "the cluster reads no conf.d"
  # Localhost only, and memory for a server that also runs the browser host and the code host
  # (docs/colocated-host.md, the memory split): 512 MB of shared buffers, 8 MB per sort, 100 connections.
  printf "listen_addresses = 'localhost'\nmax_connections = 100\nshared_buffers = 512MB\nwork_mem = 8MB\n" \
    > "$PG_CONF/conf.d/bro.conf"
  chmod 644 "$PG_CONF/conf.d/bro.conf"
  systemctl restart postgresql@18-main
  # The passwords are made once and kept: a second run sets the same ones again.
  PGJSON=/etc/bro/postgres.json
  if [ ! -s "$PGJSON" ]; then
    PASS=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
    install -m 600 /dev/null "$PGJSON.tmp"
    printf '%s' "$PASS" | python3 -c 'import json, sys
base = "postgresql://bro:" + sys.stdin.read() + "@localhost:5432"
print(json.dumps({"app": base + "/bro", "world": base + "/bro_workflow"}, indent=1))' > "$PGJSON.tmp"
    mv "$PGJSON.tmp" "$PGJSON"
  fi
  chmod 600 "$PGJSON"
  PASS=$(python3 -c 'import json, urllib.parse as u
print(u.urlsplit(json.load(open("/etc/bro/postgres.json"))["app"]).password)')
  # Databases named as the managed cluster had them (host.py PG_DATABASES): a dump restores under the same names.
  # The password goes in on psql's input (hex, so safe inside the quotes), never in an argument `ps` shows.
  { printf "\\set pw '%s'\n" "$PASS"; cat <<'SQL'
SELECT 'CREATE ROLE bro LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bro') \gexec
ALTER ROLE bro WITH LOGIN PASSWORD :'pw';
SELECT 'CREATE DATABASE bro OWNER bro' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'bro') \gexec
SELECT 'CREATE DATABASE bro_workflow OWNER bro' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'bro_workflow') \gexec
SQL
  } | (cd / && runuser -u postgres -- /usr/lib/postgresql/18/bin/psql -X -q -v ON_ERROR_STOP=1)
  for db in bro bro_workflow; do
    [ "$(PGPASSWORD="$PASS" /usr/lib/postgresql/18/bin/psql -X -h localhost -U bro -d "$db" -tAc 'select 1' 2>/dev/null)" = 1 ] \
      || fail "the $db database does not answer"
  done
fi
apt-mark hold libpq5 postgresql-client-18 postgresql-client-common >/dev/null
if [ "$LOCAL_POSTGRES" = True ]; then apt-mark hold postgresql-18 postgresql-common >/dev/null; fi

stage layout
# bro runs the app and the model's tools: it writes only its home, the backups and the unpacked release
# trees. /srv/bro itself, releases/, downloads/, history.json and `current` stay root's: root deployd
# renames, unpacks and removes there, and a bro that could swap releases/ for a link would steer that.
id -u bro >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/bro-home --shell /usr/sbin/nologin bro
usermod --home /var/lib/bro-home bro
mkdir -p /srv/bro/releases /srv/bro/downloads /var/backups/bro /etc/bro /var/lib/bro-home
chown root:root /srv/bro /srv/bro/releases /srv/bro/downloads
chmod 755 /srv/bro /srv/bro/releases /srv/bro/downloads
chown bro:bro /var/backups/bro /var/lib/bro-home
chmod 750 /var/backups/bro /var/lib/bro-home
[ -f /etc/bro/env ] || install -m 600 /dev/null /etc/bro/env
chmod 600 /etc/bro/env /etc/bro/deployd.json
# journald: the services log to it; a busy month must not fill the disk.
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=1G\nSystemMaxFileSize=100M\nMaxRetentionSec=30day\n' \
  > /etc/systemd/journald.conf.d/bro.conf
systemctl restart systemd-journald

stage caddy
SHARED=$(field "$BOOT" sharedCaddy)
if [ "$SHARED" = True ]; then
  # A dedicated server shared with the browser host (browser-vm/host): its Caddy is the browser host's, which hostd
  # rewrites and reloads and which imports sites/*. This host installs no Caddy: it writes its site file there
  # and has that Caddy reload it (deployd.py, shared mode).
  DOMAIN=$(field "$BOOT" domain)
  [ -n "$DOMAIN" ] || fail "a shared Caddy needs the ops domain"
  for i in $(seq 1 60); do
    [ -S /run/caddy/admin.sock ] && [ -d /etc/caddy/sites ] && break
    [ "$i" = 60 ] && fail "the browser host's Caddy is not up"
    sleep 10
  done
else
  install -m 755 "$HOST/vendor/caddy" /usr/bin/caddy
  getent group caddy >/dev/null || groupadd --system caddy
  id -u caddy >/dev/null 2>&1 || useradd --system --gid caddy --create-home --home-dir /var/lib/caddy \
    --shell /usr/sbin/nologin caddy
  mkdir -p /etc/caddy
  DOMAIN=$(field "$BOOT" domain)
  if [ -z "$DOMAIN" ]; then
    # <public IP with dashes>.sslip.io; the public address is Cloud.ru's floating IP, on no interface.
    IP=""
    for i in 1 2 3 4 5 6 7 8 9; do
      case $((i % 3)) in
        1) URL=https://ipv4-internet.yandex.net/api/v0/ip ;;
        2) URL=https://api.ipify.org ;;
        *) URL=https://ipv4.icanhazip.com ;;
      esac
      IP=$(curl -fsS -m 5 "$URL" | tr -d '"[:space:]' || true)
      [[ "$IP" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && break
      IP=""
      sleep 2
    done
    [ -n "$IP" ] || fail "no public address"
    DOMAIN="${IP//./-}.sslip.io"
  fi
fi
echo "$DOMAIN" > "$STATE/domain"
install -m 644 "$HOST/bro-egress.service" /etc/systemd/system/
if [ "$SHARED" != True ]; then
  install -m 644 "$HOST/caddy.service" /etc/systemd/system/
fi
systemctl daemon-reload
# Neither caddy (facing the internet) nor bro's processes reach the metadata service (the user data holds
# deployd's host key), and bro does not reach deployd: the rules come before Caddy starts.
systemctl enable --now bro-egress >/dev/null
iptables -w -C OUTPUT -m owner --uid-owner bro -j BRO_EGRESS || fail "no egress rules for bro"
iptables -w -C OUTPUT -m owner --uid-owner caddy -j CADDY_EGRESS || fail "no egress rules for caddy"
# The ops host and the sites of /etc/bro/sites.json (none yet): deployd renders the Caddy text, where this host's
# Caddy reads it (the Caddyfile, or the site file in shared mode).
python3 "$HOST/deployd.py" caddyfile
if [ "$SHARED" = True ]; then
  retry /usr/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock
else
  systemctl daemon-reload
  systemctl enable caddy >/dev/null
  systemctl restart caddy
fi

stage services
# The units, tg-egress (enabled and started: api.telegram.org answers from Cloud.ru only through it) and
# tg-bridge (installed, not enabled: `host.py ops NAME tg-bridge.sh switch-to-bridge` turns it on).
bash "$HOST/install-code.sh"
systemctl enable bro-web bro-eve >/dev/null
# The nightly backup runs once there is a release and BACKUP_ENCRYPTION_KEY in /etc/bro/env.
systemctl enable --now deployd bro-watchdog.timer bro-backup.timer >/dev/null
for i in $(seq 1 30); do
  curl -fsS -m 5 -o /dev/null http://127.0.0.1:8095/ops/v1/health && break
  [ "$i" = 30 ] && fail "deployd does not answer"
  sleep 2
done
# The path to Telegram, once: a failure is logged, not fatal (the watchdog checks it every minute, and a new
# VM's network is shaky in its first minutes).
stage telegram
timeout 60 python3 /opt/bro/tg-egress/tg_egress.py --check || echo "tg-egress: no answer yet (watchdog retries)"
stage ready
