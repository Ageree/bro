#!/bin/bash
# The rollback guard of hostd's self-update: update.sh arms it as a transient systemd timer
# (bro-hostd-rollback-<short sha>) that runs this 15 s after it, when hostd is being restarted on the new code.
#   rollback.sh <VERSION of the new hostd> <sha256 of the bundle>
# hostd can only be updated through itself, and on a server nobody can SSH into a hostd that does not come up
# is a lost host. So: for up to ~75 s (15 s of the timer + 75 s = ~90 s from the restart) it asks
# 127.0.0.1:8090/v1/health, and the update is good when hostd reports the new VERSION and an update state of
# `done` (hostd's start writes that, selfupdate.mark_started) for this bundle's hash in update.json. Otherwise
# it stops hostd, puts the previous tree (host.old) back as /opt/bro/host, puts back the unit, Caddy and
# Firecracker files that tree carries, starts hostd on it and records `rolled-back` in update.json (the new
# tree stays as host.failed). Sandboxes survive all of this: hostd's unit has KillMode=process.
# Best effort throughout (no `set -e`): one failing step must not keep the next from running.
main() {
  local VERSION="$1" SHA="$2"
  local HOST=/opt/bro/host OLD=/opt/bro/host.old FAILED=/opt/bro/host.failed STATUS=/srv/bro/update.json
  local i

  healthy() {
    local ANSWER
    ANSWER=$(curl -fsS -m 3 http://127.0.0.1:8090/v1/health 2>/dev/null) || return 1
    echo "$ANSWER" | python3 -c '
import json, sys
version, sha, path = sys.argv[1:4]
health = json.load(sys.stdin)
status = json.load(open(path))
ok = (health.get("hostd") == version and (health.get("update") or {}).get("state") == "done"
      and status.get("sha256") == sha)
sys.exit(0 if ok else 1)' "$VERSION" "$SHA" "$STATUS" 2>/dev/null
  }

  record() {
    python3 -c '
import json, sys, time
path, state, sha, version, error = sys.argv[1:6]
json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "state": state, "sha256": sha,
           "version": version, "error": error}, open(path, "w"))' "$STATUS" "$1" "$SHA" "$VERSION" "$2" || true
  }

  for i in $(seq 1 38); do
    if healthy; then
      echo "rollback.sh: hostd $VERSION is up, the update stands"
      return 0
    fi
    sleep 2
  done

  echo "rollback.sh: hostd did not report $VERSION within ~90 s: putting $OLD back"
  if [ ! -d "$OLD" ]; then
    record rollback-failed "hostd did not come up on $VERSION and there is no previous tree to go back to"
    return 1
  fi
  systemctl stop bro-hostd || true
  rm -rf "$FAILED"
  mv "$HOST" "$FAILED" && mv "$OLD" "$HOST"
  if [ ! -f "$HOST/hostd.py" ]; then
    record rollback-failed "the swap back failed"
    return 1
  fi

  # The previous tree's own unit, Caddy and Firecracker files (update.sh may have replaced them).
  if [ -f "$HOST/units.sh" ]; then
    . "$HOST/units.sh"
    write_hostd_unit || true
    write_caddy_unit || true
    systemctl daemon-reload || true
  fi
  if [ -f "$HOST/vendor/caddy" ] && ! cmp -s "$HOST/vendor/caddy" /usr/bin/caddy; then
    install -m 755 "$HOST/vendor/caddy" /usr/bin/caddy && systemctl restart caddy || true
  fi
  if [ -d "$HOST/vendor/firecracker" ]; then
    local FILE MODE
    for FILE in firecracker jailer vmlinux; do
      if [ -f "$HOST/vendor/firecracker/$FILE" ] && ! cmp -s "$HOST/vendor/firecracker/$FILE" "/opt/bro/firecracker/$FILE"; then
        MODE=755
        [ "$FILE" = vmlinux ] && MODE=644
        install -m "$MODE" "$HOST/vendor/firecracker/$FILE" "/opt/bro/firecracker/$FILE" || true
      fi
    done
  fi

  # Written before the restart: the old hostd's start must not find a `restarting` it would call `done`.
  record rolled-back "hostd did not report $VERSION within ~90 s of its restart: the previous code is back (the new one is $FAILED)"
  # A crash loop may have run into systemd's start limit.
  systemctl reset-failed bro-hostd || true
  systemctl restart bro-hostd || true
  echo "rollback.sh: done"
}
# Parsed whole before it runs: the directory it lives in is renamed below.
main "$@"
exit $?
