#!/bin/bash
# Run by hostd as root (selfupdate.py) after it has swapped a new host bundle into /opt/bro/host, and before it
# restarts itself: the idempotent parts of provision.sh that a code update needs. Nothing here touches sandboxes,
# the network or the rootfs; a failure (exit status) makes hostd put the old code back and not restart.
#   - the venv, when requirements.txt changed (offline, hash-checked, from the bundle's wheels)
#   - a check that the new code runs: every script parses, every module of hostd compiles and imports, and the
#     new Config and Host accept this host's own settings (a bundle that would not start hostd is refused here,
#     while the old code still runs: hostd can only be updated through itself)
#   - the operator's update key, when the bundle carries one (boot.py bundle --enroll-update-key)
#   - the systemd units (provision.sh's own, units.sh), daemon-reload when one changed
#   - Caddy's binary, when the bundle's differs (the one case a Caddy restart is worth it)
#   - firecracker, jailer and the guest kernel, when the bundle carries other ones (a running VM keeps the
#     files it has open; snapshots of the old build are refused by `fits` and restore cold)
#   - last, the rollback guard: a systemd timer that runs rollback.sh, which puts the previous tree back (host.old)
#     and restarts hostd when the restarted hostd does not report this version within ~90 s
# The Caddyfile is hostd's: it writes it again when it starts. The rootfs images are rebuilt by hostd's start.
set -euo pipefail
HOST=/opt/bro/host
VENV=/opt/bro/venv
RUNTIME=$(python3 -c 'import json; print(json.load(open("/etc/bro/boot.json")).get("runtime") or "runc")')
. "$HOST/units.sh"
echo "update.sh: runtime $RUNTIME, hostd $(grep -m1 '^VERSION' "$HOST/hostd.py")"

WANT=$(sha256sum "$HOST/requirements.txt" | cut -d' ' -f1)
if [ "$WANT" != "$(cat "$VENV/.requirements.sha256" 2>/dev/null || true)" ]; then
  ls "$HOST"/wheels/*.whl >/dev/null
  "$VENV/bin/pip" install -q --no-index --find-links "$HOST/wheels" --require-hashes -r "$HOST/requirements.txt"
  echo "$WANT" > "$VENV/.requirements.sha256"
  echo "update.sh: the venv is on the new requirements"
fi

# The new code must run before anything is changed for good.
for SCRIPT in "$HOST"/*.sh; do
  bash -n "$SCRIPT"
done
[ ! -f "$HOST/guest/bro-fc-init" ] || sh -n "$HOST/guest/bro-fc-init"
"$VENV/bin/python" -m py_compile "$HOST"/*.py
PYTHONDONTWRITEBYTECODE=1 "$VENV/bin/python" - "$HOST" <<'PY'
import pathlib
import sys

host = pathlib.Path(sys.argv[1])
clock = host / "guest" / "bro-fc-clock"  # no .py: py_compile would not write it, compile() reads it
if clock.is_file():
    compile(clock.read_bytes(), str(clock), "exec")
sys.path.insert(0, str(host))
import caddy, firecracker, hostd, network, selfupdate, sets  # noqa: E401,F401  (importing is the check)

config = hostd.Config.load("/etc/bro/hostd.json")
hostd.Host(config, hostd.load_identity(config.identity_file))
print(f"update.sh: hostd {hostd.VERSION} compiles, imports and takes this host's settings")
PY

"$VENV/bin/python" "$HOST/selfupdate.py" enroll "$HOST/enroll/update-key" /etc/bro/host.json

CHANGED=0
write_caddy_unit && CHANGED=1
write_hostd_unit && CHANGED=1
[ "$CHANGED" = 0 ] || { systemctl daemon-reload; echo "update.sh: units rewritten"; }

if [ -f "$HOST/vendor/caddy" ] && ! cmp -s "$HOST/vendor/caddy" /usr/bin/caddy; then
  install -m 755 "$HOST/vendor/caddy" /usr/bin/caddy
  systemctl restart caddy
  echo "update.sh: caddy replaced"
fi

if [ "$RUNTIME" = firecracker ] && [ -d "$HOST/vendor/firecracker" ]; then
  install -d -m 755 /opt/bro/firecracker
  for FILE in firecracker jailer vmlinux; do
    SOURCE="$HOST/vendor/firecracker/$FILE"
    [ -f "$SOURCE" ] || { echo "update.sh: the bundle lacks vendor/firecracker/$FILE"; exit 1; }
    if ! cmp -s "$SOURCE" "/opt/bro/firecracker/$FILE"; then
      MODE=755
      [ "$FILE" = vmlinux ] && MODE=644
      install -m "$MODE" "$SOURCE" "/opt/bro/firecracker/$FILE"
      echo "update.sh: $FILE replaced"
    fi
  done
  /opt/bro/firecracker/firecracker --version | sed -n 1p
fi

# The rollback guard, armed last: hostd restarts right after this script, and a timer that is not there
# cannot bring back a hostd that does not come up. hostd wrote the bundle's hash to update.json before it
# ran this (every hostd that can update itself does); rollback.sh looks for it in the restarted hostd's status.
command -v systemd-run >/dev/null || { echo "update.sh: no systemd-run, no rollback guard: not updating"; exit 1; }
SHA=$("$VENV/bin/python" -c 'import json, sys; print(json.load(open(sys.argv[1])).get("sha256", ""))' /srv/bro/update.json)
NEW=$(grep -m1 '^VERSION = ' "$HOST/hostd.py" | cut -d'"' -f2)
UNIT="bro-hostd-rollback-${SHA:0:12}"
systemctl stop "$UNIT.timer" "$UNIT.service" 2>/dev/null || true
systemctl reset-failed "$UNIT.service" 2>/dev/null || true
systemd-run --quiet --unit="$UNIT" --on-active=15s --description="Roll hostd back unless $NEW comes up" \
  bash "$HOST/rollback.sh" "$NEW" "$SHA"
echo "update.sh: rollback guard $UNIT armed for $NEW"
echo "update.sh: done"
