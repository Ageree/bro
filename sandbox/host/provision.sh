#!/bin/bash
# Sets up a Bro code sandbox host (sandbox/README.md) on a stock ubuntu-22.04 VM: run once as root by
# bro-code-host-boot (cloud-init, see boot.py) from the unpacked bundle in /opt/bro/code-host. From Cloud.ru,
# GitHub and PyPI accept connections and send nothing and archive.ubuntu.com does not answer (30.09.2026):
# apt goes to the mirror the boot settings name (mirror.yandex.ru), Caddy and sandboxd come in the bundle, and
# the runsc package and the sandbox rootfs from presigned Object Storage URLs, each checked by SHA-256.
#
# sandboxd's config, /etc/bro/sandboxd.json (host id, host key, rootfs version), is written by cloud-init
# (0600) and only checked here. Stages go to /var/lib/bro/stage (and /var/lib/bro/timeline); a failure leaves
# `failed:<stage>:line N`. Caddy starts before the rootfs download, so its certificate is ready by the time
# sandboxd is; https://<domain>/v1/health answers once the stage is `ready`.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BOOT=/etc/bro/code-host-boot.json
CONFIG=/etc/bro/sandboxd.json
HOST=/opt/bro/code-host
STATE=/var/lib/bro
ROOT=/srv/sandboxd
mkdir -p "$STATE" "$ROOT/rootfs"
chmod 700 "$ROOT"
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
    value = value.get(key, "") if isinstance(value, dict) else ""
print(value)' "$1" "$2"; }
# First boot of a stock image: unattended-upgrades may hold the dpkg lock for a while.
APT=(apt-get -q -o DPkg::Lock::Timeout=600)
stage start

ROOTFS_VERSION=$(field "$BOOT" rootfs.version)
[[ "$ROOTFS_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "bad rootfs version"
[ "$(field "$CONFIG" rootfs_version)" = "$ROOTFS_VERSION" ] || fail "sandboxd.json names another rootfs"
[[ "$(field "$CONFIG" key)" =~ ^[0-9a-f]{64}$ ]] || fail "sandboxd.json has no host key"
RUNSC_RELEASE=$(field "$BOOT" runsc.release)
# A dated release, never the moving `release` suite.
[[ "$RUNSC_RELEASE" =~ ^[0-9]{8}(\.[0-9]+)?$ ]] || fail "runsc release is not a dated release"
for file in sandboxd sandboxd.service fetch.py vendor/caddy; do
  [ -f "$HOST/$file" ] || fail "the bundle has no $file"
done
SANDBOXD=$(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' "$HOST/sandboxd.service" | head -1)
[[ "$SANDBOXD" == /* ]] || fail "sandboxd.service has no absolute ExecStart"

stage hosts
# Names pinned at private addresses (boot.py --hosts-entry): Bro's domain at its VM in the project's subnet,
# since no VM of the project reaches another's public address and sandboxd calls Bro's tool router by name.
# The lines carry a mark and are rewritten, never added twice; cloud-init's template gets them too, in case
# the image lets it rewrite /etc/hosts at boot.
python3 - "$BOOT" /etc/hosts /etc/cloud/templates/hosts.debian.tmpl <<'PY'
import json, os, re, sys
from pathlib import Path
mark = "# bro-private"
entries = json.load(open(sys.argv[1])).get("hosts", [])
for entry in entries:
    if not (re.fullmatch(r"[a-z0-9.-]{1,253}", entry["name"]) and re.fullmatch(r"[0-9.]{7,15}", entry["address"])):
        sys.exit("bad hosts entry")
names = {entry["name"] for entry in entries}
if len(names) != len(entries):
    sys.exit("a host name is pinned twice")
for path in map(Path, sys.argv[2:]):
    if not path.exists():
        continue
    kept = [line for line in path.read_text().splitlines()
            if not line.endswith(mark) and not (names & set(line.split("#")[0].split()[1:]))]
    # Written aside and renamed over: a boot cut short never leaves the file half written.
    new = path.with_name(path.name + ".bro-new")
    with open(new, "w") as out:
        out.write("\n".join(kept + [f"{e['address']} {e['name']} {mark}" for e in entries]) + "\n")
        out.flush()
        os.fsync(out.fileno())
    os.chmod(new, path.stat().st_mode & 0o7777)
    os.replace(new, path)
PY

stage packages
APT_MIRROR=$(field "$BOOT" aptMirror)
if [ -n "$APT_MIRROR" ]; then
  # Every Ubuntu archive of the stock image (archive, security, the country mirrors) to the one that answers.
  sed -i -E "s#https?://([a-z]{2}\.)?(archive|security)\.ubuntu\.com/ubuntu/?#${APT_MIRROR%/}/#g" \
    /etc/apt/sources.list
fi
retry "${APT[@]}" update
retry "${APT[@]}" install -y curl ca-certificates zstd python3

stage runsc
# The package of the dated gVisor release, vendored to Object Storage (boot.py vendor); no dependencies.
# gVisor's own apt repository (Google Cloud Storage) is untested from Cloud.ru: no fallback to it.
RUNSC_URL=$(field "$BOOT" runsc.url)
[ -n "$RUNSC_URL" ] || fail "no runsc package URL"
python3 "$HOST/fetch.py" --sha256 "$(field "$BOOT" runsc.sha256)" "$RUNSC_URL" /root/runsc.deb
retry "${APT[@]}" install -y /root/runsc.deb
rm -f /root/runsc.deb
# runsc 2026 is a package, not a binary (sidecars in /usr/bin/gvisor-bin/): hold all of it.
runsc --version | head -1 | grep -q "release-${RUNSC_RELEASE}" || fail "runsc is not release ${RUNSC_RELEASE}"
apt-mark hold runsc >/dev/null

stage caddy
install -m 755 "$HOST/vendor/caddy" /usr/bin/caddy
getent group caddy >/dev/null || groupadd --system caddy
id -u caddy >/dev/null 2>&1 || useradd --system --gid caddy --create-home --home-dir /var/lib/caddy \
  --shell /usr/sbin/nologin caddy
mkdir -p /etc/caddy
DOMAIN=$(field "$BOOT" domain)
if [ -z "$DOMAIN" ]; then
  # The host's own name: <public IP with dashes>.sslip.io. The public address is Cloud.ru's floating IP,
  # not on any interface; Yandex first, since from Cloud.ru foreign services may accept and never answer.
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
# The unit of Caddy's own packages for the static binary; the admin API only on a unix socket (on
# localhost:2019 any local process could load a config). Ports 80 and 443 only, no CAP_NET_ADMIN.
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
RuntimeDirectory=caddy
RuntimeDirectoryMode=0750

[Install]
WantedBy=multi-user.target
UNIT
# flush_interval -1: an exec answer is a stream of NDJSON lines, each must reach Bro as it is written.
printf '{\n\tadmin unix//run/caddy/admin.sock\n}\n%s {\n\treverse_proxy 127.0.0.1:8091 {\n\t\tflush_interval -1\n\t}\n}\n' \
  "$DOMAIN" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable caddy >/dev/null
systemctl restart caddy

stage rootfs
ROOTFS="$ROOT/rootfs/$ROOTFS_VERSION"
if [ ! -d "$ROOTFS" ]; then
  ARCHIVE="$ROOT/rootfs/.$ROOTFS_VERSION.tar.zst"
  PARTIAL="$ROOT/rootfs/.$ROOTFS_VERSION.partial"  # hidden until whole
  retry python3 "$HOST/fetch.py" --sha256 "$(field "$BOOT" rootfs.sha256)" "$(field "$BOOT" rootfs.url)" "$ARCHIVE"
  rm -rf "$PARTIAL"
  mkdir -p "$PARTIAL"
  # The rootfs's own uids and gids (sandbox is 1000 there), not the host's accounts of the same names.
  tar --numeric-owner -I zstd -xpf "$ARCHIVE" -C "$PARTIAL"
  rm -f "$ARCHIVE"
  mv "$PARTIAL" "$ROOTFS"
fi

stage sandboxd
install -m 755 "$HOST/sandboxd" "$SANDBOXD"
install -m 644 "$HOST/sandboxd.service" /etc/systemd/system/sandboxd.service
systemctl daemon-reload
systemctl enable sandboxd >/dev/null
systemctl restart sandboxd
for i in $(seq 1 30); do
  curl -fsS -m 5 -o /dev/null http://127.0.0.1:8091/v1/health && break
  [ "$i" = 30 ] && fail "sandboxd does not answer"
  sleep 2
done
stage ready
