"""The app VM's watchdog: once a minute (bro-watchdog.timer) it asks Next, eve and Caddy on this host and
tells the owner in Telegram when one has been down for 5 minutes, again at most once an hour while it stays
down, and once more when it is back (scripts/cloudru-app-host/README.md). Python stdlib only.

The bot and the chat: OPS_ALERT_BOT_TOKEN and OPS_ALERT_CHAT_ID in /etc/bro/env, else the app's own
TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID (agent/lib/owner-alert.ts writes to the same chat). The rehearsal
stand has no TELEGRAM_BOT_TOKEN, so it gets the OPS_ALERT_* pair alone. Without them every check is still
logged to journald; nothing is sent.

State: /var/lib/bro/watchdog.json (when each check went down, when the owner last heard).
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
from deployd import EVE_HEALTH, WEB_HEALTH, Paths, read_env  # noqa: E402

DOWN_BEFORE_ALERT_S = 5 * 60
REPEAT_S = 60 * 60
NAMES = {"web": "Next (сайт и вход)", "eve": "eve (агент, каналы)", "caddy": "Caddy (HTTPS)"}


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


def probe():
    # No release yet: nothing of the app to watch, only Caddy.
    checks = {"caddy": caddy_ok()}
    if Paths(os.environ.get("DEPLOYD_ROOT", "/")).current.exists():
        checks["web"] = http_ok(WEB_HEALTH)
        checks["eve"] = http_ok(EVE_HEALTH)
    return checks


def send(env, text):
    token = env.get("OPS_ALERT_BOT_TOKEN") or env.get("TELEGRAM_BOT_TOKEN")
    chat = env.get("OPS_ALERT_CHAT_ID") or env.get("TELEGRAM_OWNER_CHAT_ID")
    if not token or not chat:
        print("no OPS_ALERT_BOT_TOKEN/OPS_ALERT_CHAT_ID: not sent", flush=True)
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
    """The messages due for these results; updates state in place. Pure, for the tests."""
    messages = []
    for name, ok in checks.items():
        entry = state.setdefault(name, {})
        if ok:
            if entry.get("alertedAt"):
                messages.append(f"Бро на {host}: {NAMES[name]} снова работает "
                                f"(лежал с {clock(entry['downSince'])}).")
            state[name] = {}
            continue
        entry.setdefault("downSince", now)
        down_for = now - entry["downSince"]
        alerted = entry.get("alertedAt")
        if down_for >= DOWN_BEFORE_ALERT_S and (alerted is None or now - alerted >= REPEAT_S):
            messages.append(f"Бро на {host}: {NAMES[name]} не отвечает с {clock(entry['downSince'])} "
                            f"({int(down_for // 60)} мин). Логи: host.py logs.")
            entry["pendingAlert"] = now
    return messages


def main():
    paths = Paths(os.environ.get("DEPLOYD_ROOT", "/"))
    state_file = paths.domain.with_name("watchdog.json")
    try:
        state = json.loads(state_file.read_text())
    except (OSError, ValueError):
        state = {}
    now = int(time.time())
    checks = probe()
    print(" ".join(f"{name}={'ok' if ok else 'DOWN'}" for name, ok in checks.items()), flush=True)
    try:
        host = json.loads(paths.config.read_text())["host"]
    except (OSError, ValueError, KeyError):
        host = socket.gethostname()
    messages = step(state, checks, now, host)
    env = read_env(paths)
    sent = all([send(env, text) for text in messages]) if messages else True
    for entry in state.values():
        pending = entry.pop("pendingAlert", None)
        # Unsent, the alert is due again on the next tick.
        if pending is not None and sent:
            entry["alertedAt"] = pending
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(state) + "\n")


if __name__ == "__main__":
    main()
