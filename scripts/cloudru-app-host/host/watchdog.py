"""The app VM's watchdog: once a minute (bro-watchdog.timer) it asks Next, eve and Caddy on this host and
tells the owner in Telegram when one has been down for 5 minutes, again at most once an hour while it stays
down, and once more when it is back (scripts/cloudru-app-host/README.md). Python stdlib only.

Backups too, once /etc/bro/env has a DATABASE_URL and no BACKUPS=off: the nightly backup must have succeeded
within 26 hours (/var/backups/bro/last-backup.json, written by ops/db-backup.sh; with none yet, 26 hours from
when the watchdog first expected one) and the last run of bro-backup.service (backup, then restore check)
must not have failed; a missing BACKUP_ENCRYPTION_KEY is down at once. The same 5-minute and hourly rules
apply, so a backup or restore check that keeps failing is repeated every hour, and an alert Telegram did
not take is sent again. A failed run also tells the owner at once: `watchdog.py alert backup`
(bro-backup-alert).

The path to Telegram too: with tg-egress installed, `tg_egress.py --check` (api.telegram.org by name, the
way every client goes); a failure first restarts bro-tg-egress (setup.sh puts back a lost hosts line or
REDIRECT rule), at most once in EGRESS_RESTART_EVERY_S, and only a check that still fails counts as down.
With tg-bridge enabled (`systemctl is-enabled`), the unit must be active and its /health 200 (polling,
eve takes the secret, nothing stuck).

Where alerts go: every alert is a line `alert: …` in journald, always. Then Telegram: OPS_ALERT_BOT_TOKEN and
OPS_ALERT_CHAT_ID in /etc/bro/env, else the app's own TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID
(agent/lib/owner-alert.ts writes to the same chat); the rehearsal stand has no TELEGRAM_BOT_TOKEN, so it gets
the OPS_ALERT_* pair alone. Telegram goes the same way as the bridge and the bot, through tg-egress, so an
alert about that path rarely arrives there: OPS_ALERT_WEBHOOK_URL (https; the alert's text is POSTed as
text/plain, the shape of ntfy and similar push services) is a second way that does not depend on it. Composio
mail needs a card a person confirms, and iMessage (Photon) goes through eve's channel adapter: neither is a
way out for a stdlib script. An alert that reached no channel stays due (the next tick tries again) and is
listed under "undelivered" in watchdog.json, which deployd's status shows (`host.py status`).

State: /var/lib/bro/watchdog.json (when each check went down, when the owner last heard, an unsent recovery).

It runs on the VM it watches: the VM down, its network, DNS or certificate fail without a word from it. The
outside probe is a separate thing (scripts/cloudru-app-host/README.md, «Watchdog»).
"""

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deployd import EVE_HEALTH, WEB_HEALTH, Paths, read_env, write_private  # noqa: E402

DOWN_BEFORE_ALERT_S = 5 * 60
EGRESS_RESTART_EVERY_S = 10 * 60
BRIDGE_UNIT = "bro-tg-bridge"
BRIDGE_HEALTH = "http://127.0.0.1:7445/health"
REPEAT_S = 60 * 60
BACKUP_FRESH_S = 26 * 3600
NAMES = {"web": "Next (сайт и вход)", "eve": "eve (агент, каналы)", "caddy": "Caddy (HTTPS)",
         "backup": "ночной бэкап базы", "tg-egress": "путь к api.telegram.org (tg-egress)",
         "tg-bridge": "мост Telegram (входящие сообщения бота)"}
ALERTS = {"backup": "Бро на {host}: ночной бэкап базы или его проверка не прошли. Логи: host.py logs {host} bro-backup."}


def http_ok(url, timeout=10):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError, ValueError):
        return False


def caddy_ok():
    active = subprocess.run(["systemctl", "is-active", "--quiet", "caddy"]).returncode == 0
    try:
        socket.create_connection(("127.0.0.1", 443), timeout=5).close()
    except OSError:
        return False
    return active


def backup_fresh(paths, env, now, state):
    """None when no backup is expected (no database yet, or BACKUPS=off); else whether one succeeded lately.
    state["expected"]["backup"] is when the watchdog first expected one: with no success at all, 26 hours
    from then."""
    expected = state.setdefault("expected", {})
    if not env.get("DATABASE_URL") or env.get("BACKUPS") == "off":
        expected.pop("backup", None)
        return None
    since = expected.setdefault("backup", now)
    if not env.get("BACKUP_ENCRYPTION_KEY"):
        return False  # db-backup.sh fails without it
    try:
        finished = json.loads(paths.backups.joinpath("last-backup.json").read_text())["finishedAt"]
    except (OSError, ValueError, KeyError, TypeError):
        finished = since
    return now - finished < BACKUP_FRESH_S


def backup_unit_failed():
    """The last run of bro-backup.service failed (backup or restore check): systemd keeps that until the next
    run succeeds."""
    result = subprocess.run(["systemctl", "show", "--property=Result", "--value", "bro-backup.service"],
                            capture_output=True, text=True)
    return result.returncode == 0 and result.stdout.strip() not in ("", "success")


def egress_check(paths):
    try:
        return subprocess.run(["python3", str(paths.tg_egress), "--check"], capture_output=True,
                              timeout=40).returncode == 0
    except subprocess.TimeoutExpired:
        return False


def egress_ok(paths, now, state):
    """tg_egress.py --check; a failure restarts bro-tg-egress (at most once in EGRESS_RESTART_EVERY_S) and
    checks again."""
    if egress_check(paths):
        return True
    if now - state.get("egressRestartedAt", 0) < EGRESS_RESTART_EVERY_S:
        return False
    state["egressRestartedAt"] = now
    code = subprocess.run(["systemctl", "restart", "bro-tg-egress"], capture_output=True).returncode
    print(f"tg-egress: check failed, restart: {'ok' if code == 0 else 'exit ' + str(code)}", flush=True)
    time.sleep(3)
    return egress_check(paths)


def unit_is(state, unit):
    return subprocess.run(["systemctl", state, "--quiet", unit]).returncode == 0


def probe(paths, env, now, state):
    # No release yet: nothing of the app to watch, only Caddy.
    checks = {"caddy": caddy_ok()}
    if paths.current.exists():
        checks["web"] = http_ok(WEB_HEALTH)
        checks["eve"] = http_ok(EVE_HEALTH)
    if paths.tg_egress.exists():
        checks["tg-egress"] = egress_ok(paths, now, state)
    if unit_is("is-enabled", BRIDGE_UNIT):
        checks["tg-bridge"] = unit_is("is-active", BRIDGE_UNIT) and http_ok(BRIDGE_HEALTH)
    fresh = backup_fresh(paths, env, now, state)
    if fresh is not None:
        checks["backup"] = fresh and not backup_unit_failed()
    return checks


def send(env, text):
    """Journald, then every channel there is; True when one of them took the alert."""
    print(f"alert: {text}", flush=True)
    sent = send_telegram(env, text)
    return send_webhook(env, text) or sent


def send_webhook(env, text):
    url = env.get("OPS_ALERT_WEBHOOK_URL")
    if not url:
        return False
    if not url.startswith("https://"):
        print("OPS_ALERT_WEBHOOK_URL: not https, not sent", flush=True)
        return False
    request = urllib.request.Request(url, text.encode(), {"Content-Type": "text/plain; charset=utf-8"},
                                     method="POST")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError, ValueError) as error:
        # The URL may be the secret (a push topic): only the error's class.
        print(f"alert webhook: {type(error).__name__}", flush=True)
        return False


def send_telegram(env, text):
    token = env.get("OPS_ALERT_BOT_TOKEN") or env.get("TELEGRAM_BOT_TOKEN")
    chat = env.get("OPS_ALERT_CHAT_ID") or env.get("TELEGRAM_OWNER_CHAT_ID")
    if not token or not chat:
        print("no OPS_ALERT_BOT_TOKEN/OPS_ALERT_CHAT_ID: not sent to Telegram", flush=True)
        return False
    data = urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()
    try:
        with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data, timeout=15) as r:
            return json.loads(r.read()).get("ok") is True
    except (OSError, urllib.error.URLError, ValueError) as error:
        # The error names the URL, and the URL holds the token: only its class.
        print(f"telegram: {type(error).__name__}", flush=True)
        return False


def clock(seconds):
    return time.strftime("%H:%M UTC", time.gmtime(seconds))


def step(state, checks, now, host):
    """The messages due for these results, as (check, text); updates state in place. A message goes on the
    record only once it is sent (sent()), so an unsent alert or recovery is due again on the next tick."""
    messages = []
    for name, ok in checks.items():
        entry = state.setdefault(name, {})
        if ok:
            if "alertedAt" in entry or "recovered" in entry:
                since = entry["recovered"] if "recovered" in entry else entry["downSince"]
                state[name] = {"recovered": since}
                messages.append((name, f"Бро на {host}: {NAMES[name]} снова работает (лежал с {clock(since)})."))
            else:
                state[name] = {}
                sent(state, name)  # an alert that never went out is moot now
            continue
        entry.pop("recovered", None)
        entry.setdefault("downSince", now)
        down_for = now - entry["downSince"]
        alerted = entry.get("alertedAt")
        if down_for >= DOWN_BEFORE_ALERT_S and (alerted is None or now - alerted >= REPEAT_S):
            if name == "backup":
                text = (f"Бро на {host}: ночной бэкап базы не в порядке с {clock(entry['downSince'])}: "
                        f"нет удачного за сутки, нет ключа или последний запуск (бэкап или проверка) упал. "
                        f"Логи: host.py logs {host} bro-backup.")
            else:
                text = (f"Бро на {host}: {NAMES[name]} не отвечает с {clock(entry['downSince'])} "
                        f"({int(down_for // 60)} мин). Логи: host.py logs.")
            messages.append((name, text))
            entry["pendingAlert"] = now
    return messages


def sent(state, name):
    """The message about this check reached the owner."""
    undelivered = state.get("undelivered")
    if isinstance(undelivered, dict):
        undelivered.pop(name, None)
        if not undelivered:
            state.pop("undelivered")
    entry = state.get(name, {})
    if "recovered" in entry:
        state[name] = {}
    elif "pendingAlert" in entry:
        entry["alertedAt"] = entry.pop("pendingAlert")


def host_name(paths):
    try:
        return json.loads(paths.config.read_text())["host"]
    except (OSError, ValueError, KeyError):
        return socket.gethostname()


def alert(paths, what):
    """One message now (bro-backup-alert.service); exit 1 when it could not be sent, so the journal says so."""
    host = host_name(paths)
    if not send(read_env(paths), ALERTS[what].format(host=host)):
        sys.exit(1)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    paths = Paths(os.environ.get("DEPLOYD_ROOT", "/"))
    if argv[:1] == ["alert"]:
        if argv[1:] != ["backup"]:
            raise SystemExit("usage: watchdog.py [alert backup]")
        return alert(paths, "backup")
    state_file = paths.domain.with_name("watchdog.json")
    try:
        state = json.loads(state_file.read_text())
    except (OSError, ValueError):
        state = {}
    now = int(time.time())
    env = read_env(paths)
    checks = probe(paths, env, now, state)
    print(" ".join(f"{name}={'ok' if ok else 'DOWN'}" for name, ok in checks.items()), flush=True)
    host = host_name(paths)

    def save():
        # Atomic (temporary file, fsync, rename): a power cut mid-write must not reset every countdown and
        # the hour since the last alert. Pending alerts are left out: unsent, they are due on the next tick.
        kept = {name: {k: v for k, v in entry.items() if k != "pendingAlert"} if isinstance(entry, dict) else entry
                for name, entry in state.items()}
        write_private(state_file, json.dumps(kept) + "\n")

    for name, text in step(state, checks, now, host):
        if send(env, text):
            sent(state, name)
            save()  # each sent alert at once: a stop mid-run must not send it again
        else:
            state.setdefault("undelivered", {}).setdefault(name, now)
    save()


if __name__ == "__main__":
    main()
