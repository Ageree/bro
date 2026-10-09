#!/bin/bash
# Run by hostd as root (selfupdate.py) after it has swapped a new host bundle into /opt/bro/host, and before it
# restarts itself: the idempotent parts of provision.sh that a code update needs. Nothing here touches sandboxes,
# the network or the rootfs; a failure (exit status) makes hostd put the old code back and not restart.
#   - the venv, when requirements.txt changed (offline, hash-checked, from the bundle's wheels)
#   - the systemd units (provision.sh's own, units.sh), daemon-reload when one changed
#   - Caddy's binary, when the bundle's differs (the one case a Caddy restart is worth it)
#   - firecracker, jailer and the guest kernel, when the bundle carries other ones (a running VM keeps the
#     files it has open; snapshots of the old build are refused by `fits` and restore cold)
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
echo "update.sh: done"
