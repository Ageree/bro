#!/bin/bash
# Sets up Bro's own VM (scripts/cloudru-app-host/README.md) on a stock ubuntu-22.04: run once as root by
# bro-app-host-boot (cloud-init, see boot.py) from the unpacked bundle in /opt/bro/app-host. From Cloud.ru
# only mirror.yandex.ru (apt) and Object Storage answer reliably: Caddy comes in the bundle, Node and the
# PostgreSQL client from presigned Object Storage URLs, each checked by SHA-256.
#
# What it leaves: the user bro (home /var/lib/bro-home), /srv/bro/{releases,current} owned by root, /etc/bro/env (0600, empty until PUT
# /ops/v1/env), the units bro-web and bro-eve (they start with the first release), deployd behind Caddy on
# the ops host <public IP with dashes>.sslip.io, the watchdog timer, journald capped at 1 GB. Stages go to
# /var/lib/bro/stage and timeline; a failure leaves `failed:<stage>:line N`.
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

for file in deployd.py watchdog.py egress.sh bro-egress.service bro-web.service bro-eve.service deployd.service bro-watchdog.service \
  bro-watchdog.timer caddy.service vendor/caddy; do
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
apt-mark hold libpq5 postgresql-client-18 postgresql-client-common >/dev/null

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
echo "$DOMAIN" > "$STATE/domain"
install -m 644 "$HOST/caddy.service" /etc/systemd/system/caddy.service
# The ops host and the sites of /etc/bro/sites.json (none yet): deployd renders the file.
python3 "$HOST/deployd.py" caddyfile
systemctl daemon-reload
systemctl enable caddy >/dev/null
systemctl restart caddy

stage services
for unit in bro-egress.service bro-web.service bro-eve.service deployd.service bro-watchdog.service \
  bro-watchdog.timer; do
  install -m 644 "$HOST/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
# bro's processes never reach the metadata service (the user data holds deployd's host key) nor deployd.
systemctl enable --now bro-egress >/dev/null
iptables -w -C OUTPUT -m owner --uid-owner bro -j BRO_EGRESS || fail "no egress rules for bro"
systemctl enable bro-web bro-eve >/dev/null
systemctl enable --now deployd bro-watchdog.timer >/dev/null
for i in $(seq 1 30); do
  curl -fsS -m 5 -o /dev/null http://127.0.0.1:8095/ops/v1/health && break
  [ "$i" = 30 ] && fail "deployd does not answer"
  sleep 2
done
stage ready
