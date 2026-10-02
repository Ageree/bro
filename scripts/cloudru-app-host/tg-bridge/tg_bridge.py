"""tg-bridge: Telegram updates for eve without a webhook (Python 3.10 stdlib, README.md here).

Telegram's webhook cannot reach a server in Russia reliably, so on Cloud.ru the bot is polled instead: this
process long-polls getUpdates and hands every update to the local eve exactly as Telegram's webhook would,
a POST of the update's JSON to TG_BRIDGE_EVE_URL with X-Telegram-Bot-Api-Secret-Token. eve answers 200 as
soon as the secret checks out and runs the turn afterwards, so a 200 means "taken", not "answered".

Guarantees:
  - an update is confirmed to Telegram (the next getUpdates' offset) and in the state file only after eve
    took it: the offset is the lowest update still undelivered, and ids above it already delivered are kept
    in the state file, so a restart of the bridge neither loses nor repeats one. What eve took (200) is eve's:
    eve answers before the turn starts, so an update taken just before eve itself restarts can be lost;
  - one chat's updates go to eve one at a time and in order (TG_BRIDGE_CHAT_GAP_MS between them), different
    chats in parallel (at most TG_BRIDGE_PARALLEL), so a chat stuck in retries holds no one else up;
  - eve down is retried with a growing pause for as long as it takes. An update is dropped only after
    TG_BRIDGE_ATTEMPTS failures in a row that are its own: an HTTP error from eve while eve's health check
    (TG_BRIDGE_EVE_HEALTH) answers 200. 401/403 is the secret: delivery waits, nothing is dropped. Either
    wait shows in /health (503 once an update has waited TG_BRIDGE_STUCK_S);
  - a webhook set on the bot or a second poller (getUpdates 409) stops polling: one line in the log, a pause
    of TG_BRIDGE_CONFLICT_PAUSE_S, no tight loop. The bridge never deletes a webhook itself (switch-to-bridge).

The log has update ids, update types and HTTP statuses. Never the token, the secret or an update's content.

  python3 tg_bridge.py run                       poll and deliver (bro-tg-bridge.service)
  python3 tg_bridge.py check                     the health check: exit 0 when polling and delivering
  python3 tg_bridge.py status                    getWebhookInfo, read only: which way updates go now
  python3 tg_bridge.py switch-to-bridge          deleteWebhook (pending updates kept), then start the bridge
  python3 tg_bridge.py switch-to-webhook URL     stop the bridge, confirm what it delivered, setWebhook URL
                                                 with the secret, verify; the bridge back if Telegram fails

Settings (environment; the unit reads /etc/bro/env, then /etc/bro/tg-bridge.env; the switch commands read
the same files for names not in their environment):
  TELEGRAM_BOT_TOKEN              the bot
  TELEGRAM_WEBHOOK_SECRET_TOKEN   what eve checks, sent byte for byte
  TG_BRIDGE_EVE_URL          http://127.0.0.1:4274/eve/v1/telegram   eve itself, not Next (proxy.ts sends it
                                                                     to /sign-in)
  TG_BRIDGE_API              https://api.telegram.org   (the host's /etc/hosts sends it to tg-egress)
  TG_BRIDGE_PROXY            (unset)   http://<login>:<password>@<host>:<port> or host:port:user:pass: getUpdates and the
                                       switch commands CONNECT through it; for a host without tg-egress
  TG_BRIDGE_EVE_HEALTH       the eve URL's origin + /eve/v1/health
  TG_BRIDGE_STATE            /var/lib/bro/tg-bridge/state.json   (another bot's file is set aside)
  TG_BRIDGE_STUCK_S          120    an update waiting longer makes /health 503
  TG_BRIDGE_HEALTH           127.0.0.1:7445   GET /health: JSON, 200 when polling and delivering, else 503
  TG_BRIDGE_POLL_TIMEOUT     50     getUpdates' long-poll seconds
  TG_BRIDGE_PARALLEL         8      chats delivered at once
  TG_BRIDGE_CHAT_GAP_MS      300    pause between two updates of one chat
  TG_BRIDGE_ATTEMPTS         5      failures before an update is dropped (see above)
  TG_BRIDGE_RETRY_MAX_S      60     the longest pause between two attempts
  TG_BRIDGE_CONFLICT_PAUSE_S 60     after a 409 or with a webhook set
"""

import argparse
import base64
import collections
import concurrent.futures
import hashlib
import http.client
import json
import os
import re
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ALLOWED_UPDATES = ["message", "callback_query"]
SERVICE = "bro-tg-bridge.service"
ENV_FILES = ("/etc/bro/env", "/etc/bro/tg-bridge.env")
TOKEN = re.compile(r"[0-9]+:[A-Za-z0-9_-]+")
# Telegram accepts only these in secret_token; anything else would not survive a switch back to the webhook.
SECRET = re.compile(r"[A-Za-z0-9_-]{1,256}")
CONFIG_EXIT = 2


def log(message):
    print(message, flush=True)


# --- Settings -------------------------------------------------------------------------------------------------


def parse_env(text):
    """NAME=value lines as systemd's EnvironmentFile reads the subset deployd writes ("…" with \\ escapes)."""
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, raw = line.partition("=")
        name, raw = name.strip(), raw.strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
            raw = re.sub(r"\\(.)", r"\1", raw[1:-1]) if raw[0] == '"' else raw[1:-1]
        values[name] = raw
    return values


def environment(files=ENV_FILES):
    """The process environment, names it lacks filled from the env files (later files win among them)."""
    merged = {}
    for path in files:
        try:
            merged.update(parse_env(Path(path).read_text()))
        except OSError:
            pass
    merged.update(os.environ)
    return merged


def proxy_from(text):
    """(host, port, Proxy-Authorization value or None) from either proxy form; None when unset."""
    text = (text or "").strip()
    if not text:
        return None
    if "://" in text:
        parsed = urllib.parse.urlsplit(text)
        if parsed.scheme != "http" or not parsed.hostname or not parsed.port:
            raise ValueError("TG_BRIDGE_PROXY must be http://<login>:<password>@<host>:<port>")
        user = urllib.parse.unquote(parsed.username or "")
        password = urllib.parse.unquote(parsed.password or "")
        host, port = parsed.hostname, parsed.port
    else:
        parts = text.split(":", 3)
        if len(parts) not in (2, 4) or not parts[1].isdigit():
            raise ValueError("TG_BRIDGE_PROXY must be host:port:user:pass")
        host, port = parts[0], int(parts[1])
        user, password = (parts[2], parts[3]) if len(parts) == 4 else ("", "")
    auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode() if user or password else None
    return host, port, auth


def address(text):
    host, _, port = text.rpartition(":")
    return host or "127.0.0.1", int(port)


class Settings:
    def __init__(self, env):
        self.token = env.get("TELEGRAM_BOT_TOKEN", "")
        self.secret = env.get("TELEGRAM_WEBHOOK_SECRET_TOKEN", "")
        self.eve_url = env.get("TG_BRIDGE_EVE_URL") or "http://127.0.0.1:4274/eve/v1/telegram"
        self.api = env.get("TG_BRIDGE_API") or "https://api.telegram.org"
        self.proxy = env.get("TG_BRIDGE_PROXY", "")
        self.state = Path(env.get("TG_BRIDGE_STATE") or "/var/lib/bro/tg-bridge/state.json")
        self.health = env.get("TG_BRIDGE_HEALTH") or "127.0.0.1:7445"
        self.poll_timeout = int(env.get("TG_BRIDGE_POLL_TIMEOUT") or 50)
        self.parallel = int(env.get("TG_BRIDGE_PARALLEL") or 8)
        self.chat_gap = int(env.get("TG_BRIDGE_CHAT_GAP_MS") or 300) / 1000
        self.attempts = int(env.get("TG_BRIDGE_ATTEMPTS") or 5)
        self.retry_base = float(env.get("TG_BRIDGE_RETRY_BASE_S") or 1)
        self.retry_max = float(env.get("TG_BRIDGE_RETRY_MAX_S") or 60)
        self.conflict_pause = float(env.get("TG_BRIDGE_CONFLICT_PAUSE_S") or 60)
        # While an update is in retries, getUpdates from the lowest undelivered id answers at once: poll that
        # often instead of long-polling, so other chats' new messages still come in.
        self.busy_poll = float(env.get("TG_BRIDGE_BUSY_POLL_S") or 2)
        # eve's own health check, asked before an update is blamed for a failure: the eve URL's origin.
        self.eve_health = env.get("TG_BRIDGE_EVE_HEALTH") or urllib.parse.urljoin(self.eve_url, "/eve/v1/health")
        # An update waiting longer than this makes /health 503: eve down, a broken release, a stuck chat.
        self.stuck_after = float(env.get("TG_BRIDGE_STUCK_S") or 120)

    def problems(self, *, eve=True):
        found = []
        if not TOKEN.fullmatch(self.token):
            found.append("TELEGRAM_BOT_TOKEN is missing or not a bot token")
        if eve and not SECRET.fullmatch(self.secret):
            found.append("TELEGRAM_WEBHOOK_SECRET_TOKEN is missing or has characters Telegram does not allow")
        try:
            proxy_from(self.proxy)
        except ValueError as error:
            found.append(str(error))
        return found


# --- Telegram -------------------------------------------------------------------------------------------------


class NetworkError(Exception):
    pass


class TelegramError(Exception):
    def __init__(self, status, description, retry_after=None):
        super().__init__(f"{status} {description}")
        self.status = status
        self.description = description
        self.retry_after = retry_after


class Telegram:
    """Bot API calls over one kept-alive connection, directly or through an HTTP CONNECT proxy."""

    def __init__(self, token, api="https://api.telegram.org", proxy=None):
        parsed = urllib.parse.urlsplit(api)
        self.token = token
        self.https = parsed.scheme == "https"
        self.host = parsed.hostname
        self.port = parsed.port or (443 if self.https else 80)
        self.base = parsed.path.rstrip("/")
        self.proxy = proxy_from(proxy)
        self.connection = None
        self.lock = threading.Lock()
        self.interrupted = False

    def interrupt(self):
        """From a signal handler: ends a long poll in flight and refuses further calls; takes no lock."""
        self.interrupted = True
        connection = self.connection
        if connection is not None and connection.sock is not None:
            try:
                connection.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def redact(self, text):
        return str(text).replace(self.token, "<token>") if self.token else str(text)

    def _connect(self, timeout):
        if not self.https:
            return http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        context = ssl.create_default_context()
        if self.proxy is None:
            return http.client.HTTPSConnection(self.host, self.port, timeout=timeout, context=context)
        host, port, auth = self.proxy
        connection = http.client.HTTPSConnection(host, port, timeout=timeout, context=context)
        connection.set_tunnel(self.host, self.port, headers={"Proxy-Authorization": auth} if auth else None)
        return connection

    def _close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def close(self):
        with self.lock:
            self._close()

    def call(self, method, params=None, timeout=30):
        body = json.dumps(params or {}).encode()
        path = f"{self.base}/bot{self.token}/{method}"
        headers = {"Content-Type": "application/json", "Connection": "keep-alive"}
        with self.lock:
            for attempt in (1, 2):
                if self.interrupted:
                    self._close()
                    raise NetworkError("interrupted")
                reused = self.connection is not None
                if not reused:
                    self.connection = self._connect(timeout)
                connection = self.connection
                connection.timeout = timeout
                if connection.sock is not None:
                    connection.sock.settimeout(timeout)
                try:
                    connection.request("POST", path, body, headers)
                    response = connection.getresponse()
                    data = response.read()
                    status = response.status
                    if response.will_close:
                        self._close()
                    break
                except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError) as error:
                    self._close()
                    # A kept-alive connection the other side closed meanwhile: once more on a new one.
                    if attempt == 1 and reused:
                        continue
                    raise NetworkError(self.redact(f"{type(error).__name__}: {error}")) from None
                except (OSError, http.client.HTTPException) as error:
                    self._close()
                    raise NetworkError(self.redact(f"{type(error).__name__}: {error}")) from None
        try:
            payload = json.loads(data)
        except ValueError:
            raise TelegramError(status, "the answer is not JSON") from None
        if not payload.get("ok"):
            parameters = payload.get("parameters") or {}
            raise TelegramError(payload.get("error_code") or status,
                                self.redact(payload.get("description") or "no description")[:200],
                                parameters.get("retry_after"))
        return payload.get("result")


def webhook_host(info):
    """Where a webhook points, for the log: the host and path only (the URL may carry a secret)."""
    url = (info or {}).get("url") or ""
    parsed = urllib.parse.urlsplit(url)
    return f"{parsed.hostname}{parsed.path}" if parsed.hostname else ""


# --- eve ------------------------------------------------------------------------------------------------------


def post_to_eve(url, secret, body, timeout=30):
    """The webhook's request: Telegram's own headers. The HTTP status, or OSError when eve did not answer."""
    parsed = urllib.parse.urlsplit(url)
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout)
    try:
        connection.request("POST", parsed.path or "/", body, {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": secret,
        })
        response = connection.getresponse()
        response.read()
        return response.status
    except http.client.HTTPException as error:
        raise OSError(f"{type(error).__name__}") from None
    finally:
        connection.close()


def update_kind(update):
    return next((key for key in update if key != "update_id"), "empty")


def chat_key(update):
    """What orders updates: the chat for messages and buttons; for anything else its sender."""
    kind = update_kind(update)
    item = update.get(kind)
    if not isinstance(item, dict):
        return f"update:{update.get('update_id')}"
    chat = item.get("chat") or (item.get("message") or {}).get("chat") or {}
    if "id" in chat:
        return f"chat:{chat['id']}"
    sender = item.get("from") or item.get("user") or {}
    if "id" in sender:
        return f"user:{sender['id']}"
    return f"update:{update.get('update_id')}"


# --- State ----------------------------------------------------------------------------------------------------


def bot_fingerprint(token):
    """Which bot a state file belongs to: update ids are per bot. A hash of the bot id, never the token."""
    return hashlib.sha256(token.split(":", 1)[0].encode()).hexdigest()[:16]


class State:
    """{"bot", "offset": lowest undelivered update id, "done": delivered ids above it}, replaced atomically.

    Starting from offset 0 is always safe enough: Telegram returns only what it has not had confirmed, so the
    worst case is one more delivery of updates the bridge took but had not confirmed yet. Hence a state file
    of another bot (a rehearsal on the test bot, a token re-issued in BotFather) or an unreadable one is set
    aside with a line in the log rather than stopping the bridge."""

    def __init__(self, path, bot=None):
        self.path = Path(path)
        self.bot = bot
        self.offset = 0
        self.done = set()
        self.save_failed_logged = 0.0
        try:
            saved = json.loads(self.path.read_text())
            if not isinstance(saved, dict):
                raise TypeError("not an object")
            offset = int(saved.get("offset") or 0)
            done = {int(i) for i in saved.get("done") or [] if int(i) >= offset}
        except FileNotFoundError:
            return
        except (OSError, ValueError, TypeError) as error:
            aside = self.path.with_name(self.path.name + ".bad")
            try:
                os.replace(self.path, aside)
            except OSError:
                pass
            log(f"tg-bridge: unreadable state {self.path} ({type(error).__name__}), moved to {aside.name}: "
                f"starting from what Telegram has not had confirmed")
            return
        if bot and saved.get("bot") not in (None, bot):
            log("tg-bridge: the state file is another bot's (TELEGRAM_BOT_TOKEN changed): starting afresh")
            return
        self.offset, self.done = offset, done

    def save(self):
        """True when written. A failure (a full disk) is logged at most once a minute and not raised: the ids
        in memory still keep duplicates out, and the next delivery writes again."""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_name(self.path.name + ".tmp")
            with open(temporary, "w") as file:
                json.dump({"bot": self.bot, "offset": self.offset, "done": sorted(self.done)}, file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            return True
        except OSError as error:
            now = time.monotonic()
            if not self.save_failed_logged or now - self.save_failed_logged >= 60:
                self.save_failed_logged = now
                log(f"tg-bridge: cannot write {self.path}: {type(error).__name__}: {error.strerror}")
            return False


# --- The bridge -----------------------------------------------------------------------------------------------


class Bridge:
    def __init__(self, settings, telegram=None, deliver=None):
        self.settings = settings
        self.telegram = telegram or Telegram(settings.token, settings.api, settings.proxy)
        self.deliver = deliver or (lambda body: post_to_eve(settings.eve_url, settings.secret, body))
        self.state = State(settings.state, bot_fingerprint(settings.token))
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.progress = threading.Condition(self.lock)
        # Update id -> when it was queued (monotonic): the health check's "how long has the oldest waited".
        self.pending = {}
        self.queues = {}
        self.max_seen = max([self.state.offset - 1, *self.state.done])
        self.pool = concurrent.futures.ThreadPoolExecutor(settings.parallel, thread_name_prefix="deliver")
        self.status = "starting"
        self.last_poll_ok = None
        self.completions = 0
        self.eve_refused = None
        self.counters = collections.Counter()
        self.telegram_failures = 0
        self.telegram_logged = 0.0
        self.fatal = None

    def count(self, name):
        with self.lock:
            self.counters[name] += 1

    # Health -------------------------------------------------------------------------------------------------

    def health(self):
        now = time.monotonic()
        with self.lock:
            pending = len(self.pending)
            oldest = now - min(self.pending.values()) if self.pending else None
            counters = dict(self.counters)
        fresh = self.last_poll_ok is not None and now - self.last_poll_ok < self.settings.poll_timeout + 60
        stuck = oldest is not None and oldest > self.settings.stuck_after
        healthy = self.status == "polling" and fresh and self.eve_refused is None and not stuck
        return healthy, {
            "status": self.status,
            "healthy": healthy,
            "lastPollAgoS": None if self.last_poll_ok is None else round(now - self.last_poll_ok, 1),
            "pending": pending,
            "oldestPendingAgeS": None if oldest is None else round(oldest, 1),
            "eveRefused": self.eve_refused,
            "offset": self.state.offset,
            **counters,
        }

    # Polling ------------------------------------------------------------------------------------------------

    def run(self):
        log(f"tg-bridge: from offset {self.state.offset}, {len(self.state.done)} delivered above it")
        while not self.stop.is_set():
            if not self.webhook_clear():
                continue
            self.poll_until_conflict()
        self.pool.shutdown(wait=True)
        self.telegram.close()

    def telegram_failed(self, status, what, error):
        """A failed call to Telegram: the first in a row and then one a minute go to the log (Telegram out of
        reach from Russia is an ordinary state, not an event), and the pause grows up to TG_BRIDGE_RETRY_MAX_S."""
        self.telegram_failures += 1
        self.count("pollErrors")
        self.status = status
        now = time.monotonic()
        if self.telegram_failures == 1 or now - self.telegram_logged >= 60:
            self.telegram_logged = now
            log(f"tg-bridge: {what} failed ({self.telegram_failures} in a row): {error}")
        self.stop.wait(self.backoff(self.telegram_failures))

    def webhook_clear(self):
        """getUpdates while a webhook is set is a 409: look first, and wait while one is there."""
        try:
            info = self.telegram.call("getWebhookInfo", timeout=30)
        except (NetworkError, TelegramError) as error:
            self.telegram_failed("telegram-unreachable", "getWebhookInfo", error)
            return False
        host = webhook_host(info)
        if host:
            self.status = "webhook-set"
            log(f"tg-bridge: a webhook is set ({host}): not polling; switch-to-bridge removes it. "
                f"Next look in {self.settings.conflict_pause:g} s")
            self.stop.wait(self.settings.conflict_pause)
            return False
        return True

    def poll_until_conflict(self):
        while not self.stop.is_set():
            with self.lock:
                busy = bool(self.pending)
                completions = self.completions
                # The lowest undelivered id (from the state file at start): Telegram drops what is below.
                offset = self.state.offset
            timeout = 0 if busy else self.settings.poll_timeout
            try:
                updates = self.telegram.call("getUpdates", {
                    "offset": offset,
                    "timeout": timeout,
                    "allowed_updates": ALLOWED_UPDATES,
                }, timeout=timeout + 15)
            except TelegramError as error:
                if error.status == 409:
                    self.count("pollErrors")
                    self.status = "conflict"
                    log(f"tg-bridge: getUpdates 409 (a webhook was set or another bridge polls): "
                        f"pausing {self.settings.conflict_pause:g} s")
                    self.stop.wait(self.settings.conflict_pause)
                    return
                if error.status == 429:
                    self.count("pollErrors")
                    self.stop.wait(float(error.retry_after or 5))
                    continue
                self.telegram_failed("telegram-error", "getUpdates", error)
                continue
            except NetworkError as error:
                self.telegram_failed("telegram-unreachable", "getUpdates", error)
                continue
            self.telegram_failures = 0
            self.status = "polling"
            self.last_poll_ok = time.monotonic()
            fresh = self.accept(updates or [])
            if busy and not fresh:
                # Nothing new behind an update still in delivery: wait until one completes (counted, so a
                # completion during the getUpdates above is not missed) or the next look. With the queue
                # empty the next round is a long poll again.
                with self.progress:
                    self.progress.wait_for(
                        lambda: self.completions != completions or not self.pending or self.stop.is_set(),
                        self.settings.busy_poll)

    def backoff(self, failures):
        # The exponent is capped: 2 ** 1025 does not fit a float (17 hours of a failing Telegram at 60 s).
        return min(self.settings.retry_max, self.settings.retry_base * 2 ** min(max(failures - 1, 0), 16))

    def accept(self, updates):
        """Queue the updates not seen before, each behind its chat's earlier ones. How many were new."""
        fresh = 0
        now = time.monotonic()
        with self.lock:
            for update in updates:
                update_id = update.get("update_id") if isinstance(update, dict) else None
                if not isinstance(update_id, int):
                    continue
                if update_id < self.state.offset or update_id in self.state.done or update_id in self.pending:
                    self.counters["duplicates"] += 1
                    continue
                fresh += 1
                self.pending[update_id] = now
                self.max_seen = max(self.max_seen, update_id)
                key = chat_key(update)
                queue = self.queues.get(key)
                if queue is not None:
                    queue.append(update)
                else:
                    self.queues[key] = collections.deque([update])
                    self.pool.submit(self.drain, key)
        return fresh

    def drain(self, key):
        try:
            self.drain_queue(key)
        except Exception as error:  # noqa: BLE001 - a dead drain would hold its chat forever: restart instead
            self.fatal = f"{type(error).__name__}: {error}"
            log(f"tg-bridge: delivery failed unexpectedly ({self.fatal}): stopping for systemd to restart")
            self.stop.set()
            self.telegram.interrupt()

    def drain_queue(self, key):
        while True:
            with self.lock:
                queue = self.queues[key]
                if not queue or self.stop.is_set():
                    del self.queues[key]
                    return
                update = queue.popleft()
            if not self.deliver_one(update):
                with self.lock:
                    del self.queues[key]
                return
            with self.lock:
                more = bool(self.queues[key])
            if more:
                self.stop.wait(self.settings.chat_gap)

    def eve_alive(self):
        """eve's own health check answers 200: eve is up, so a failure to take an update is the update's."""
        parsed = urllib.parse.urlsplit(self.settings.eve_health)
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=5)
        try:
            connection.request("GET", parsed.path or "/")
            response = connection.getresponse()
            response.read()
            return response.status == 200
        except (OSError, http.client.HTTPException):
            return False
        finally:
            connection.close()

    def deliver_one(self, update):
        """Until eve takes it or it is dropped (True), or the bridge stops (False: it stays undelivered).

        An update is dropped only after TG_BRIDGE_ATTEMPTS failures in a row that are its own: eve answered
        with an HTTP error (not 401/403, the secret) and eve's health check said eve is up right after. eve not
        answering at all, or answering while its health check fails, is eve's trouble: retried for as long as
        it takes, and the health check reports the wait (oldestPendingAgeS)."""
        update_id, kind = update["update_id"], update_kind(update)
        failures = blamed = 0
        while not self.stop.is_set():
            try:
                # ASCII JSON: a lone surrogate (half an emoji in a cut name) is a valid \ud83d escape there,
                # while encoding it as UTF-8 raises.
                status = self.deliver(json.dumps(update).encode())
            except OSError as error:
                status, reason, own = None, type(error).__name__, False
            except Exception as error:  # noqa: BLE001 - one odd update must not stop every chat's delivery
                status, reason, own = None, f"bridge {type(error).__name__}", True
            else:
                reason, own = str(status), False
            if status is not None and 200 <= status < 300:
                if self.eve_refused is not None:
                    log("tg-bridge: eve accepts the secret again")
                self.eve_refused = None
                self.complete(update_id, delivered=True)
                return True
            if status in (401, 403):
                # The secret: eve and the bridge read different values. Wait for a fix, drop nothing.
                if self.eve_refused is None:
                    log(f"tg-bridge: eve answered {status} to update {update_id}: TELEGRAM_WEBHOOK_SECRET_TOKEN "
                        f"differs; delivery waits (restart both after fixing /etc/bro/env)")
                self.eve_refused = status
                self.stop.wait(self.settings.retry_max)
                continue
            failures += 1
            self.count("deliveryRetries")
            if own or (status is not None and self.eve_alive()):
                blamed += 1
            else:
                blamed = 0
            if blamed >= self.settings.attempts:
                log(f"tg-bridge: update {update_id} ({kind}) dropped after {failures} attempts, last {reason}")
                self.complete(update_id, delivered=False)
                return True
            if failures == 1 or failures % 10 == 0:
                log(f"tg-bridge: update {update_id} ({kind}): eve {reason}, attempt {failures}")
            self.stop.wait(self.backoff(failures))
        return False

    def complete(self, update_id, *, delivered):
        with self.progress:
            self.pending.pop(update_id, None)
            self.state.done.add(update_id)
            self.state.offset = min(self.pending) if self.pending else self.max_seen + 1
            self.state.done = {i for i in self.state.done if i >= self.state.offset}
            if not self.state.save():
                self.counters["stateWriteErrors"] += 1
            self.counters["delivered" if delivered else "dropped"] += 1
            self.completions += 1
            self.progress.notify_all()


def serve_health(bridge, listen):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/health":
                self.send_error(404)
                return
            healthy, body = bridge.health()
            data = json.dumps(body).encode()
            self.send_response(200 if healthy else 503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(address(listen), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True, name="health").start()
    return server


# --- Commands -------------------------------------------------------------------------------------------------


def command_run(settings):
    problems = settings.problems()
    if problems:
        for problem in problems:
            log(f"tg-bridge: {problem}")
        return CONFIG_EXIT
    bridge = Bridge(settings)
    server = serve_health(bridge, settings.health)

    def stop(signum, frame):
        bridge.stop.set()
        bridge.telegram.interrupt()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        bridge.run()
    finally:
        server.shutdown()
    log("tg-bridge: stopped")
    return 1 if bridge.fatal else 0


def command_check(settings):
    host, port = address(settings.health)
    try:
        connection = http.client.HTTPConnection(host, port, timeout=5)
        connection.request("GET", "/health")
        response = connection.getresponse()
        print(response.read().decode())
        return 0 if response.status == 200 else 1
    except OSError as error:
        print(f"tg-bridge is not answering on {settings.health}: {type(error).__name__}")
        return 1


def systemctl(*args):
    return subprocess.run(["systemctl", *args], check=False).returncode


def describe(info):
    host = webhook_host(info)
    pending = info.get("pending_update_count", 0)
    way = f"webhook {host}" if host else "no webhook (getUpdates)"
    error = info.get("last_error_message")
    return f"{way}; {pending} pending" + (f"; last error: {error}" if error else "")


def command_status(settings, telegram):
    info = telegram.call("getWebhookInfo")
    print(describe(info))
    return 0


def command_switch_to_bridge(settings, telegram, *, start=True, wait_s=120):
    problems = settings.problems()
    if problems:
        print("\n".join(problems))
        return CONFIG_EXIT
    info = telegram.call("getWebhookInfo")
    print(f"before: {describe(info)}")
    if info.get("url"):
        # drop_pending_updates=false: what Telegram holds for the webhook is the bridge's first batch.
        telegram.call("deleteWebhook", {"drop_pending_updates": False})
        info = telegram.call("getWebhookInfo")
        print(f"after:  {describe(info)}")
        if info.get("url"):
            print("the webhook is still set: not starting the bridge")
            return 1
    if not start:
        return 0
    if systemctl("enable", "--now", SERVICE) != 0:
        print(f"systemctl enable --now {SERVICE} failed")
        return 1
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        if command_check(settings) == 0:
            print("the bridge polls and delivers")
            return 0
        time.sleep(3)
    print(f"the bridge is not healthy after {wait_s} s: journalctl -u {SERVICE}")
    return 1


def confirm_delivered(settings, telegram):
    """Tell Telegram what the stopped bridge delivered: the offset goes out only with the next getUpdates,
    so without this a webhook would get those updates once more (eve does not check update_id). Updates
    above one still undelivered (the state's "done") cannot be confirmed: they come again by the webhook."""
    state = State(settings.state, bot_fingerprint(settings.token))
    if not state.offset:
        return
    try:
        telegram.call("getUpdates", {"offset": state.offset, "limit": 1, "timeout": 0}, timeout=30)
    except TelegramError as error:
        if error.status != 409:  # a webhook already set: nothing is polled, nothing to confirm
            raise
    print(f"confirmed to Telegram up to update {state.offset - 1}"
          + (f"; {len(state.done)} delivered above an undelivered one come again" if state.done else ""))


def command_switch_to_webhook(settings, telegram, url):
    problems = settings.problems()
    if problems:
        print("\n".join(problems))
        return CONFIG_EXIT
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or not parsed.path.endswith("/eve/v1/telegram"):
        print("the webhook must be https://<host>/eve/v1/telegram")
        return CONFIG_EXIT
    # The bridge first, so the state file is final and no getUpdates races setWebhook.
    if systemctl("disable", "--now", SERVICE) != 0:
        print(f"systemctl disable --now {SERVICE} failed: the bridge may still poll")
        return 1
    try:
        confirm_delivered(settings, telegram)
        telegram.call("setWebhook", {
            "url": url,
            "secret_token": settings.secret,
            "allowed_updates": ALLOWED_UPDATES,
            "drop_pending_updates": False,
        })
    except (NetworkError, TelegramError) as error:
        # Telegram out of reach from here is just when a rollback is likely: put the bridge back rather than
        # leave the bot with neither. setWebhook works from any machine that reaches Telegram (README.md).
        print(f"Telegram: {error}: no webhook set, starting the bridge again")
        if systemctl("enable", "--now", SERVICE) != 0:
            print(f"systemctl enable --now {SERVICE} failed too: NEITHER the bridge NOR a webhook takes updates")
        return 1
    info = telegram.call("getWebhookInfo")
    print(f"now: {describe(info)}")
    if info.get("url") != url:
        print("Telegram reports another webhook than the one set")
        return 1
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Telegram updates for eve by getUpdates instead of a webhook.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("run", help="poll and deliver (the service)")
    commands.add_parser("check", help="the health check")
    commands.add_parser("status", help="getWebhookInfo: which way updates go now")
    to_bridge = commands.add_parser("switch-to-bridge", help="deleteWebhook (pending kept), start the bridge")
    to_bridge.add_argument("--no-start", action="store_true", help="only remove the webhook")
    to_webhook = commands.add_parser("switch-to-webhook", help="stop the bridge, setWebhook with the secret")
    to_webhook.add_argument("url", help="https://<host>/eve/v1/telegram")
    args = parser.parse_args(argv)

    settings = Settings(environment() if args.command != "run" else os.environ)
    if args.command == "run":
        return command_run(settings)
    if args.command == "check":
        return command_check(settings)
    problems = settings.problems(eve=False)
    if problems:
        print("\n".join(problems))
        return CONFIG_EXIT
    telegram = Telegram(settings.token, settings.api, settings.proxy)
    try:
        if args.command == "status":
            return command_status(settings, telegram)
        if args.command == "switch-to-bridge":
            return command_switch_to_bridge(settings, telegram, start=not args.no_start)
        return command_switch_to_webhook(settings, telegram, args.url)
    except (NetworkError, TelegramError) as error:
        print(f"Telegram: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
