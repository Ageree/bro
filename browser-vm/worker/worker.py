"""Bro browser worker: the only service a person's Cloud.ru VM exposes (127.0.0.1:8080, behind Caddy).

It replaces the pilot's `control.py`, which ran arbitrary commands. Here every route is a typed
operation on the one Chrome of this VM, modelled on the Browser Use Cloud surface Bro already speaks
(runs, sessions, files, CDP), so Bro keeps its consent, spend and delivery code unchanged.

Auth: `Authorization: Bearer v1.<payload>.<sig>` (or the token as the first path segment of
`/v1/cdp/<token>/...`, since a WebSocket URL carries no header). The signature is HMAC-SHA256 with
this VM's key, which Bro derives from its signing key and the environment id and hands over once in
cloud-init. The payload is `{"env": <environment id>, "gen": <generation>, "exp": <unix seconds>}`:
a token for another VM, an expired one, one valid for more than 15 minutes, or one from an older
generation (a controller that lost its lease) is refused.

Secrets never touch the disk: the proxy login arrives with `POST /v1/session`, the model key and the
site secrets with each run, and all stay in memory. Chrome always talks to the forwarder on
127.0.0.1:3128, which refuses to connect anywhere until Bro has set the residential proxy: the
profile never sees the VM's own datacenter address.

Routes (all but a plain /v1/health need a token):
  GET  /v1/health[?machine=1]             liveness, Chrome, busy flag (no secrets); `machine` (with a token):
                                          memory, load, disk, profile size
  POST /v1/session                        {proxy: {host, port, username, password}} → exit address and speed
                                          (`error`: no address; `speedError`: the address, speed unknown)
  GET  /v1/runs?contains=<line>           runs of this VM, newest first (adoption after a lost start)
  POST /v1/runs                           start an agent run (`tuning`: how its browser-use agent runs, which
                                          upstream hosts serve its model); idempotent
                                          on its id; 409 when busy
  GET  /v1/runs/<id>                      status, result, error, task, steps, final page, usage, traffic, unreadMessages
  POST /v1/runs/<id>/cancel               stop the agent (waits up to 20 s for it to end), keep the page
  GET  /v1/sessions/<id>                  latest run and its status
  POST /v1/sessions/<id>/messages         {text, tuning?}: join the live run (unread when it ends:
                                          unreadMessages), or start a follow-up in the tab with `tuning` over the
                                          session's; 409 while the live run cancels
  POST /v1/sessions/<id>/release          close the session's tab (the page is no longer kept)
  POST /v1/sessions/<id>/open {url}       direct mode, no agent: open a page in the session's tab
  GET  /v1/sessions/<id>/state            address, title, indexed interactive elements
  POST /v1/sessions/<id>/action           {action, params}: click/input/select/scroll/keys/back/navigate
  GET  /v1/sessions/<id>/screenshot       JPEG of the session's tab
  GET  /v1/files?session=&prefix=         files a run saved (report/…), newest first
                                          (trail/<run id>/: each step's shot and steps.jsonl, for developers)
  GET  /v1/files/<session>/<path>         download one
  GET  /v1/dl/<token>/<session>/<path>    the same by URL alone (token scoped to the session)
  PUT  /v1/uploads/<name>                 a file for the agent to upload to a site
  POST /v1/tabs, DELETE /v1/tabs/<id>     a blank tab for a keep-alive visit, and closing it
  POST /v1/browser/stop | /v1/browser/start | /v1/browser/restart
  POST /v1/profile/reset                  wipe the Chrome profile (forget every sign-in)
  POST /v1/park                           before a pool host freezes this sandbox: forget the model key, the
                                          proxy login and site secrets (409 while a run works or cancels);
                                          {"closeChrome": true} (runc) also closes Chrome through CDP so
                                          its cookies are written before the host's SIGTERM
  POST /v1/admin/worker                   replace this worker's code (checksummed, must load, only when idle)
  GET  /v1/cdp/<token>/json[/version]     CDP discovery, socket URLs rewritten to this endpoint
  WS   /v1/cdp/<token>/devtools/...       CDP socket to one target of this VM's Chrome
"""

import asyncio
import base64
import contextlib
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import types
import urllib.parse
import uuid
from pathlib import Path

import aiohttp
from aiohttp import web

VERSION = "2026-10-05.4"
CODE = Path(__file__).resolve()
# The code an update replaced, kept until the new code is up: if that keeps failing to start, systemd's
# bro-worker-rollback (provision.sh) brings this back. The VM has no other way in.
PREVIOUS_CODE = CODE.with_name(CODE.name + ".prev")
# Loads a new worker.py as a module in a separate Python: its imports and top-level code run, `main` does not.
LOAD_CHECK = "import runpy, sys; runpy.run_path(sys.argv[1], run_name='candidate')"
# What worker.py imports only inside functions: browser-use (and httpx, which it brings) when a run starts, OpenCV
# and numpy for a captcha.
# LOAD_CHECK (of the worker a new file replaces, whichever version that is) runs top-level code only, so a
# candidate imports these there itself (`check_candidate_imports`): a file that needs a package or an API the
# VM's image lacks is refused, not started to fail every errand. Keep it in step with the lazy imports.
CANDIDATE_IMPORTS = (
    ("browser_use", ("ActionResult", "Agent", "BrowserSession", "ChatOpenRouter", "Tools")),
    ("browser_use.browser.events", ("SwitchTabEvent",)),
    ("browser_use.agent.message_manager.views", ("HistoryItem",)),
    ("browser_use.agent.views", ("AgentState",)),
    ("browser_use.utils", ("match_url_with_domain_pattern",)),
    ("httpx", ("AsyncClient", "Timeout")),
    ("cv2", ()),
    ("numpy", ()),
)
ROOT = Path(os.environ.get("BRO_STATE_DIR", "/var/lib/bro"))
CONFIG_FILE = Path(os.environ.get("BRO_WORKER_CONFIG", "/etc/bro/worker.json"))
IMAGE_FILE = Path("/etc/bro/image")
PROFILE = ROOT / "profile"
RUNS = ROOT / "runs"
SESSIONS = ROOT / "sessions"
UPLOADS = ROOT / "uploads"
GENERATION_FILE = ROOT / "generation"
TABS_FILE = ROOT / "tabs.json"
CDP_HTTP = "http://127.0.0.1:9222"
LISTEN_PORT = int(os.environ.get("BRO_WORKER_PORT", "8080"))
# Behind Caddy on the VM the worker listens on loopback only; in a gVisor sandbox (browser-vm/image/sandbox)
# the host reaches it over the sandbox's own network namespace, so there it listens on that interface.
LISTEN_HOST = os.environ.get("BRO_WORKER_BIND", "127.0.0.1")
FORWARD_PORT = 3128
MAX_TOKEN_LIFETIME_S = 900
# The profile's size is a walk over tens of thousands of cache files: done at most once a minute.
PROFILE_WALK_S = 60
# The agent must not "find" the site in an archive or a cache: in the pilot it answered from a 2024
# snapshot of ozon.ru on web.archive.org and called that success.
PROHIBITED_DOMAINS = [
    "*.archive.org", "archive.ph", "archive.today", "archive.is", "*.archive.ph", "cachedview.nl",
    "webcache.googleusercontent.com", "*.translate.goog", "yandexwebcache.net", "*.yandexwebcache.net",
]
TERMINAL = {"completed", "failed", "cancelled"}
# Bro starts its follow-up in the same session right after a cancel: the cancel answers once the agent's
# step has ended, so that start is not refused as busy, but a step that hangs does not hold the answer.
CANCEL_WAIT_S = 20
# A run past its own budget by this much is cut off. browser-use checks the budget only between steps, and a
# step it could not time out (an Avito run hung after its 34th step for over half an hour) kept the worker busy:
# the VM never idled off and every errand of the workspace queued behind it.
OVERRUN_S = 90
# How long a cut-off step gets to unwind before Chrome is restarted under it, failing whatever it awaits.
UNWIND_S = 15
# Where restored memory ends: the steps before it served an earlier request of the session.
NEW_REQUEST = "<sys>A new request starts here: the steps above served an earlier one in this session.</sys>"
# What Bro may tune of the browser-use agent per run (`tuning`); a run without it is the agent as before.
REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high")
TUNING_LIMITS = {"maxActionsPerStep": (1, 10)}
# Bro's `tuning.provider`: which upstream hosts of the model's service (RouterAI, OpenRouter) may serve the
# run, in the service's own `provider` routing names. A slug may name a variant (`deepinfra/fp8`).
PROVIDER_SLUG = re.compile(r"^[a-z0-9][a-z0-9._/-]{0,63}$")
PROVIDER_HOSTS_MAX = 32
PROVIDER_FIELDS = {"order": "order", "ignore": "ignore", "requireParameters": "require_parameters"}
# How many distinct hosts a run's bill names; a host past them is not counted by name.
BILLED_HOSTS_MAX = 16
BATCH_HINT = """
Put the actions of one step together when the later ones do not depend on what the page shows after the
earlier ones: type into a field and press Enter or its search button, fill several fields of one form, tick
a filter and apply it. Look at the page between steps whenever an action opens, submits or changes it.
""".strip()
FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
log = logging.getLogger("bro-worker")


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def load_config():
    """The environment id and key come from cloud-init; an image under construction has neither."""
    try:
        config = json.loads(CONFIG_FILE.read_text())
        return {"environment": str(config["environment"]), "key": bytes.fromhex(config["key"])}
    except (OSError, ValueError, KeyError):
        return None


def read_generation():
    try:
        return int(GENERATION_FILE.read_text().strip())
    except (OSError, ValueError):
        return 0


class Unauthorized(Exception):
    pass


def verify_token(token, config, generation, now=None):
    """Return the token's payload, or raise Unauthorized. Mirrors `signBrowserVmToken` in Bro
    (`agent/lib/browser-vm/token.ts`). `ses`, when present, scopes a CDP or download URL to one session
    (or to one keep-alive tab, `b:<targetId>`)."""
    if config is None:
        raise Unauthorized("worker not configured")
    now = time.time() if now is None else now
    try:
        version, payload_part, signature_part = token.split(".")
    except ValueError:
        raise Unauthorized("malformed token") from None
    if version != "v1":
        raise Unauthorized("unknown token version")
    expected = hmac.new(config["key"], f"{version}.{payload_part}".encode(), hashlib.sha256).digest()
    try:
        signature = unb64url(signature_part)
        payload = json.loads(unb64url(payload_part))
    except ValueError:
        raise Unauthorized("malformed token") from None
    if not hmac.compare_digest(signature, expected):
        raise Unauthorized("bad signature")
    if not isinstance(payload, dict) or payload.get("env") != config["environment"]:
        raise Unauthorized("token for another environment")
    expires = payload.get("exp")
    if not isinstance(expires, (int, float)) or expires <= now or expires > now + MAX_TOKEN_LIFETIME_S:
        raise Unauthorized("expired token")
    token_generation = payload.get("gen", 0)
    if not isinstance(token_generation, int) or token_generation < generation:
        raise Unauthorized("stale generation")
    return payload


# --- Residential proxy forwarder -------------------------------------------------------------------


class Forwarder:
    """127.0.0.1:3128 → the workspace's residential proxy, adding its login (Chrome cannot send one
    from the command line). Until Bro sets the upstream every request gets 502, so Chrome never
    reaches a site from the VM's own address. Counts bytes: residential traffic is billed per GB."""

    def __init__(self):
        self.upstream = None
        self.totals = {"up": 0, "down": 0, "connections": 0, "refused": 0}
        self.open = set()  # writers of tunnels in flight: each handler holds the login in its locals

    def drop(self):
        """Forget the login and close every tunnel carrying it, so their handlers end and let it go."""
        self.upstream = None
        for writer in list(self.open):
            with contextlib.suppress(Exception):
                writer.close()

    def configure(self, proxy):
        host, port = str(proxy["host"]), int(proxy["port"])
        username, password = proxy.get("username"), proxy.get("password")
        auth = b64encode_text(f"{username}:{password}") if username else None
        self.upstream = (host, port, auth)

    async def pipe(self, reader, writer, key):
        try:
            while data := await reader.read(65536):
                self.totals[key] += len(data)
                writer.write(data)
                await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError, OSError):
            pass
        finally:
            with contextlib.suppress(Exception):
                writer.close()

    async def handle(self, client_reader, client_writer):
        try:
            head = await asyncio.wait_for(client_reader.readuntil(b"\r\n\r\n"), 30)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError):
            client_writer.close()
            return
        if self.upstream is None:
            self.totals["refused"] += 1
            client_writer.write(b"HTTP/1.1 502 Proxy Not Configured\r\nContent-Length: 0\r\n\r\n")
            with contextlib.suppress(Exception):
                await client_writer.drain()
            client_writer.close()
            return
        host, port, auth = self.upstream
        lines = head.decode("latin-1").split("\r\n")
        dropped = ("proxy-authorization:", "proxy-connection:", "connection:")
        kept = [line for line in lines[1:] if line and not line.lower().startswith(dropped)]
        if not lines[0].startswith("CONNECT"):
            kept.append("Connection: close")  # one request per connection, each with the login
        if auth:
            kept.append(f"Proxy-Authorization: Basic {auth}")
        request = "\r\n".join([lines[0], *kept, "", ""]).encode("latin-1")
        try:
            up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(host, port), 20)
        except (OSError, asyncio.TimeoutError):
            client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            client_writer.close()
            return
        self.totals["connections"] += 1
        self.totals["up"] += len(request)
        self.open.update((client_writer, up_writer))
        try:
            up_writer.write(request)
            await up_writer.drain()
            await asyncio.gather(self.pipe(client_reader, up_writer, "up"), self.pipe(up_reader, client_writer, "down"))
        except (ConnectionError, OSError):
            pass
        finally:
            self.open.difference_update((client_writer, up_writer))
            with contextlib.suppress(Exception):
                up_writer.close()


def b64encode_text(text):
    return base64.b64encode(text.encode()).decode()


# --- Chrome ------------------------------------------------------------------------------------------


async def chrome_json(path, timeout=5):
    async with aiohttp.ClientSession() as http:
        async with http.get(CDP_HTTP + path, timeout=aiohttp.ClientTimeout(total=timeout)) as response:
            return await response.json(content_type=None)


async def chrome_ready():
    try:
        await chrome_json("/json/version", 2)
        return True
    except Exception:
        return False


async def systemctl(action, unit="bro-chrome"):
    process = await asyncio.create_subprocess_exec(
        "sudo", "-n", "/usr/bin/systemctl", action, unit,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    output, _ = await process.communicate()
    return process.returncode, output.decode(errors="replace")[-500:]


async def wait_chrome(seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if await chrome_ready():
            return True
        await asyncio.sleep(0.5)
    return False


async def cdp_command(websocket_url, method, params=None, timeout=15):
    """One CDP command over a fresh socket: enough for tab housekeeping and screenshots."""
    async with aiohttp.ClientSession() as http:
        async with http.ws_connect(websocket_url, max_msg_size=64 * 1024 * 1024, timeout=10) as ws:
            await ws.send_json({"id": 1, "method": method, "params": params or {}})
            async with asyncio.timeout(timeout):
                async for message in ws:
                    data = json.loads(message.data)
                    if data.get("id") == 1:
                        if "error" in data:
                            raise RuntimeError(f"{method}: {data['error'].get('message')}")
                        return data.get("result", {})
    raise RuntimeError(f"{method}: no answer")


async def browser_socket():
    return (await chrome_json("/json/version"))["webSocketDebuggerUrl"]


async def page_targets():
    return [t for t in await chrome_json("/json/list") if t.get("type") == "page"]


async def page_ids():
    return {t["id"] for t in await page_targets()}


async def new_tab():
    result = await cdp_command(await browser_socket(), "Target.createTarget", {"url": "about:blank"})
    return result["targetId"]


async def close_tab(target_id):
    with contextlib.suppress(Exception):
        await cdp_command(await browser_socket(), "Target.closeTarget", {"targetId": target_id})


class SiteErrors:
    """The site's own requests (XHR and fetch) that its server refused during a run, read off the tab's CDP
    socket beside the agent's. PREDUBEZHDAI sent «Оплатить» to /order/error on every run for two hours
    (RU 04.10) while the same order went through on the person's phone: the page showed no reason, the
    agent was asked twice to hook the requests with `evaluate` and did not, and nobody ever saw the
    server's answer. Now the report carries it, whatever the agent does.

    Kept small and blind to what was sent: the address without its query, the status and the start of the
    answer, with every secret's value cut out of it.

    The report alone came too late: on 04.10 the server answered the order with 400 «Пожалуйста, введите
    корректный номер телефона», «deliveryMethod must be a valid enum value», the page silently went to
    /order/error, and the run's model, never shown the answer, retried blindly and reported what it had not
    done. So a refusal of the site's own write (POST, PUT, PATCH, DELETE to the page's own site) is also told
    to the agent at its next step (`notices`), a few per run, each answer once. A refused GET is the page
    probing the account in the background (/api/user, /api/user/cart answer 401 or 404 to a guest on every
    page): it stays in the report, never in front of the agent, and never crowds a refused write out of it."""

    LIMIT = 8
    BODY = 600
    NOTICES = 3  # told to the agent per run
    NOTICE_BODY = 400
    # How long a notice waits for the refused answer's body before it goes without it.
    BODY_WAIT_S = 3
    WRITES = ("POST", "PUT", "PATCH", "DELETE")

    def __init__(self):
        self.entries = []
        self.requests = {}  # requestId → (method, address, the page's own site) of the site's own requests
        self.refused = {}  # requestId → entry still waiting for its body
        self.tasks = {}  # the tabs listened to (target id, or socket address) → their listening task
        self.ws = None  # the socket `handle` and `send` use when not given one (a test feeds events by hand)
        self.next_id = 1
        self.bodies = {}  # (socket, command id) → requestId
        self.told = set()  # (method, address, status, answer) the agent was already told
        self.notices_sent = 0

    def start(self, websocket_url, target=None):
        """Listen to one more tab of the run. The agent moves into a tab a link opens, or opens one itself
        (`navigate` with `new_tab`), and the checkout happens there: on the checkout harness's shop
        (checkout_harness.py, 04.10) a DeepSeek run did, and two of its three refused orders were never seen."""
        key = target or websocket_url
        if key not in self.tasks:
            self.tasks[key] = asyncio.create_task(self.listen(websocket_url))

    def watches(self, target):
        return target in self.tasks

    async def stop(self):
        if self.tasks:
            # Bodies asked for just before the end still come in: give them a moment.
            await asyncio.sleep(0.3)
            for task in self.tasks.values():
                task.cancel()
            for task in self.tasks.values():
                with contextlib.suppress(BaseException):
                    await task

    async def listen(self, websocket_url):
        with contextlib.suppress(Exception):
            async with aiohttp.ClientSession() as http:
                async with http.ws_connect(websocket_url, max_msg_size=64 * 1024 * 1024, timeout=10) as ws:
                    # Each socket numbers its own commands.
                    socket = types.SimpleNamespace(ws=ws, next_id=1)
                    await self.send("Network.enable", {"maxTotalBufferSize": 2_000_000}, socket)
                    async for message in ws:
                        with contextlib.suppress(Exception):
                            await self.handle(json.loads(message.data), socket)

    async def send(self, method, params, socket=None):
        socket = socket or self
        command = socket.next_id
        socket.next_id += 1
        await socket.ws.send_json({"id": command, "method": method, "params": params})
        return command

    async def handle(self, data, socket=None):
        socket = socket or self
        method, params = data.get("method"), data.get("params") or {}
        request_id = params.get("requestId")
        if method == "Network.requestWillBeSent" and params.get("type") in ("XHR", "Fetch"):
            request = params.get("request") or {}
            url = request.get("url", "")
            self.requests[request_id] = (request.get("method", "GET").upper(), url,
                                         same_site(url, params.get("documentURL") or ""))
        elif method == "Network.responseReceived" and request_id in self.requests:
            status = (params.get("response") or {}).get("status") or 0
            if status >= 400:
                self.refused[request_id] = self.record(request_id, str(status))
        elif method == "Network.loadingFinished" and request_id in self.refused:
            command = await self.send("Network.getResponseBody", {"requestId": request_id}, socket)
            self.bodies[(id(socket), command)] = request_id
        elif method == "Network.loadingFailed" and request_id in self.requests:
            if not params.get("canceled"):
                self.record(request_id, params.get("errorText") or "failed")
        elif "id" in data and (id(socket), data["id"]) in self.bodies:
            entry = self.refused.pop(self.bodies.pop((id(socket), data["id"])), None)
            result = data.get("result") or {}
            if entry is not None and not result.get("base64Encoded"):
                body = result.get("body", "")
                # JSON as servers send it often escapes every Cyrillic letter: read it as the person would.
                with contextlib.suppress(ValueError):
                    body = json.dumps(json.loads(body), ensure_ascii=False)
                entry["answer"] = body[: self.BODY]

    def record(self, request_id, status):
        method, url, own = self.requests.get(request_id, ("GET", "", False))
        address = url.split("?")[0].split("#")[0]
        # A write of the page's own site its server answered with an HTTP status: what the agent is told.
        write = own and method in self.WRITES and status.isdigit()
        entry = {"status": status, "method": method, "address": address, "answer": "", "write": write,
                 "count": 1, "at": time.monotonic()}
        if not write:
            # The same probe refused on every page is one line of the report.
            for kept in self.entries:
                if not kept["write"] and (kept["status"], kept["method"], kept["address"]) == (status, method, address):
                    kept["count"] += 1
                    return entry
        if len(self.entries) < self.LIMIT:
            self.entries.append(entry)
        elif write:
            # Background probes filled the report first: a refused write takes the oldest one's place.
            probe = next((kept for kept in self.entries if not kept["write"]), None)
            if probe is not None:
                self.entries.remove(probe)
                self.entries.append(entry)
        return entry

    def notices(self, secrets=None):
        """What to tell the agent before its next step: each refused write of the site not told yet, once its
        answer is in (or did not come within `BODY_WAIT_S`), each distinct answer once, `NOTICES` a run."""
        clean = secret_cleaner(secrets)
        waiting = [id(entry) for entry in self.refused.values()]
        told = []
        for entry in self.entries:
            if not entry["write"] or entry.get("told") or self.notices_sent >= self.NOTICES:
                continue
            if id(entry) in waiting and time.monotonic() - entry["at"] < self.BODY_WAIT_S:
                continue
            entry["told"] = True
            answer = clean(entry["answer"])[: self.NOTICE_BODY]
            key = (entry["method"], entry["address"], entry["status"], answer)
            if key in self.told:
                continue
            self.told.add(key)
            self.notices_sent += 1
            told.append(f"The site's server refused {entry['method']} {clean(entry['address'])}: {entry['status']}"
                        + (f" — {answer}" if answer else " (no answer text)")
                        + ". The browser saw this request; the page may not show why. Fix what the answer names "
                          "(a field, a choice, a format) before trying again, and do not report success for it.")
        return told

    def report(self, secrets=None):
        if not self.entries:
            return ""
        clean = secret_cleaner(secrets)

        def line(e):
            times = f" (×{e['count']})" if e["count"] > 1 else ""
            return (f"- {e['status']} {e['method']} {clean(e['address'])}{times}"
                    + (f" — {clean(e['answer'])}" if e["answer"] else ""))

        return ("SITE ERRORS (recorded by the browser itself, not by the agent: the site's own requests its "
                "server refused during this run):\n" + "\n".join(map(line, self.entries)) + "\n\n")


def secret_cleaner(secrets):
    """A function that cuts every secret's value (three characters or longer) out of a text and folds its
    whitespace: what the worker writes or tells from a page passes through it."""
    values = sorted({str(v) for v in flat_secret_values(secrets) if len(str(v)) >= 3}, key=len, reverse=True)

    def clean(text):
        text = str(text or "")
        for value in values:
            text = text.replace(value, "<secret>")
        return " ".join(text.split())

    return clean


def same_site(url, document_url):
    """Whether a request goes to the page's own site: the same host or one under the same last two labels
    (api.shop.ru for shop.ru). A tracker's or a payment processor's request is not the site's own."""
    def site(address):
        try:
            host = (urllib.parse.urlsplit(address).hostname or "").rstrip(".")
        except ValueError:
            return None
        return ".".join(host.split(".")[-2:]) if host else None

    request_site = site(url)
    return request_site is not None and request_site == site(document_url)


def flat_secret_values(secrets):
    """Every value of sensitive_data, flat or keyed by domain."""
    for value in (secrets or {}).values():
        if isinstance(value, dict):
            yield from value.values()
        elif value:
            yield value


async def screenshot(target_id, quality=80):
    targets = {t["id"]: t for t in await page_targets()}
    target = targets.get(target_id)
    if not target:
        raise LookupError("tab is gone")
    with contextlib.suppress(Exception):
        await cdp_command(await browser_socket(), "Target.activateTarget", {"targetId": target_id})
    shot = await cdp_command(target["webSocketDebuggerUrl"], "Page.captureScreenshot",
                             {"format": "jpeg", "quality": quality}, timeout=20)
    return base64.b64decode(shot["data"])


def tell_agent(agent, text):
    """Put a line of the worker's in front of the agent at the step about to start, in its history for good: on
    the result of the step before, as browser-use itself reports a captcha it waited for, or, when that step
    left no output to hang it on (its answer failed to parse, or none came before), as a line of its own."""
    if getattr(agent.state, "last_model_output", None) is not None:
        from browser_use import ActionResult

        agent.state.last_result = [*(agent.state.last_result or []), ActionResult(long_term_memory=text)]
    else:
        from browser_use.agent.message_manager.views import HistoryItem

        agent.state.message_manager_state.agent_history_items.append(HistoryItem(system_message=f"<sys>{text}</sys>"))


# --- Step trail ----------------------------------------------------------------------------------------

# What each step of a run did, for developers: nobody could tell afterwards what a run had seen and done at
# each step (RU 04.10: an order sent to /order/error while the run claimed success). A small JPEG of the
# page after each step and a line of steps.jsonl, under trail/<run id>/ of the session's workspace. Not
# under report/: Bro sends every picture there to the person, and lists only that folder (newest first,
# a hundred at most) — step shots there would crowd out the item photos. Read like report files, with a
# worker token: GET /v1/files?session=<id>&prefix=trail/<run id>/ and GET /v1/files/<session>/<path>.
TRAIL = "trail"
TRAIL_SHOTS = 40  # the last shots of a run kept; steps.jsonl keeps every line
TRAIL_RUNS = 20  # run trails kept on the VM, the newest
TRAIL_QUALITY = 35
TRAIL_SCALE = 0.5
TRAIL_SHOT_S = 3  # a shot that takes longer is skipped, the line still written
TRAIL_TEXT = 300


def prune_trails(keep=TRAIL_RUNS):
    """Keep the newest `keep` run trails of the VM, whatever their session: older ones are removed."""
    trails = [path for path in SESSIONS.glob(f"*/{TRAIL}/*") if path.is_dir()]
    trails.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    for path in trails[keep:]:
        shutil.rmtree(path, ignore_errors=True)


def trail_line(summary, url, errors, clean):
    """A step's line of steps.jsonl: Bro's step summary (action names and element indexes, never what was
    typed), the page after the step without its query, and the step's errors, each with every secret's
    value cut out."""
    line = {}
    if summary:
        line.update(goal=clean(summary.get("goal"))[:TRAIL_TEXT], title=clean(summary.get("title"))[:200],
                    actions=summary.get("actions") or [])
        if summary.get("tokens") is not None:
            line["tokens"] = summary["tokens"]
    if url:
        line["url"] = clean(str(url).split("?")[0].split("#")[0])[:500]
    if errors:
        line["errors"] = [clean(error)[:TRAIL_TEXT] for error in errors[:5]]
    return line


class StepTrail:
    """One run's trail: `record` writes a step's shot and line, skipping what fails or takes too long. A
    trail never fails or holds a run."""

    def __init__(self, directory, secrets=None):
        self.directory = Path(directory)
        self.clean = secret_cleaner(secrets)
        self.count = 0
        self.shots = []  # file names of the shots on disk, oldest first

    async def record(self, shoot, summary=None, url=None, errors=()):
        """`shoot()` answers the page's JPEG. Runs right after a step, between the agent's steps."""
        self.count += 1
        number = self.count
        shot = None
        try:
            shot = await asyncio.wait_for(shoot(), TRAIL_SHOT_S)
        except Exception:  # a slow or failed shot: the line goes without one
            pass
        line = {"step": number, "at": now_iso(), **trail_line(summary, url, list(errors), self.clean)}
        if shot:
            line["shot"] = f"{number:03d}.jpg"
        try:
            await asyncio.to_thread(self.write, line, shot)
        except Exception:
            log.warning("trail: step %s was not written", number)

    def write(self, line, shot):
        self.directory.mkdir(parents=True, exist_ok=True)
        if shot:
            (self.directory / line["shot"]).write_bytes(shot)
            self.shots.append(line["shot"])
            while len(self.shots) > TRAIL_SHOTS:
                (self.directory / self.shots.pop(0)).unlink(missing_ok=True)
        with (self.directory / "steps.jsonl").open("a") as steps:
            steps.write(json.dumps(line) + "\n")


async def page_jpeg(browser):
    """A small JPEG of what the agent's tab shows: its viewport at half scale, low quality (tens of KB)."""
    cdp = await browser.get_or_create_cdp_session()
    params = {"format": "jpeg", "quality": TRAIL_QUALITY}
    with contextlib.suppress(Exception):
        metrics = await cdp.cdp_client.send.Page.getLayoutMetrics(session_id=cdp.session_id)
        view = metrics.get("cssVisualViewport") or {}
        if view.get("clientWidth") and view.get("clientHeight"):
            params["clip"] = {"x": view.get("pageX", 0), "y": view.get("pageY", 0), "width": view["clientWidth"],
                              "height": view["clientHeight"], "scale": TRAIL_SCALE}
    shot = await cdp.cdp_client.send.Page.captureScreenshot(params=params, session_id=cdp.session_id)
    return base64.b64decode(shot["data"])


# --- Runs ----------------------------------------------------------------------------------------------


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value):
        raise web.HTTPBadRequest(text="bad id")
    return value


def disk_name(value):
    return hashlib.sha256(value.encode()).hexdigest()[:32]


class Session:
    """One errand's tab and the agent memory that follow-ups continue from."""

    def __init__(self, session_id):
        self.id = session_id
        self.tab = None  # the tab the agent works in (it follows the agent into a tab it opened)
        self.tabs = set()  # every tab the session opened, closed together on release
        self.latest_run_id = None
        self.agent_state = None  # browser_use AgentState JSON of the last finished run
        self.llm = None
        self.captcha = None  # {"twoCaptchaKey": ...} when Bro lets a puzzle go to 2Captcha; memory only
        self.sensitive_data = None
        self.options = {}
        self.released = False
        self.direct = None  # a BrowserSession for direct operations (open/state/action) between runs

    @property
    def workspace(self):
        path = SESSIONS / disk_name(self.id)
        path.mkdir(parents=True, exist_ok=True)
        return path


class Run:
    def __init__(self, run_id, session_id, task):
        self.id = run_id
        self.session_id = session_id
        self.task = task
        self.status = "queued"
        self.result = None
        self.error = None
        self.success = None
        self.created_at = now_iso()
        self.started_at = None
        self.finished_at = None
        self.steps = []
        self.final_url = None
        self.final_title = None
        self.usage = None
        self.traffic = None  # bytes through the residential proxy while it ran: {"up", "down"}, once it ended
        self.engine = "agent"
        self.jev = None
        self.messages = []
        self.cancel_requested = False
        self.agent = None
        self.work = None  # the task working the run, while it does: a cut-off or a cancel stops it
        self.unread_messages = []  # messages queued into this run the agent never read (set once terminal)
        self.outcome = None  # (status, result, error) the run came to, while it still lets go of the browser
        self.stored = None  # the status its record on disk has
        # Creation order, restart-independent and gapless: now_iso() only has 1-second resolution, so
        # two runs dispatched within the same second (a follow-up right after settle, a retried start
        # after a lost create-answer) tie on created_at/started_at, and the run id is a random UUID
        # with no chronological meaning. Assigned from Worker.run_seq under its lock at creation, and
        # persisted, so load_runs() can still tell them apart correctly after a restart.
        self.seq = 0

    def public(self):
        return {
            "id": self.id, "sessionId": self.session_id, "status": self.status, "task": self.task,
            "result": self.result, "error": self.error, "success": self.success,
            "createdAt": self.created_at, "startedAt": self.started_at, "finishedAt": self.finished_at,
            "steps": self.steps[-50:], "stepCount": len(self.steps), "finalUrl": self.final_url,
            "finalTitle": self.final_title, "usage": self.usage, "traffic": self.traffic, "engine": self.engine,
            "jev": self.jev,
            "unreadMessages": self.unread_messages,
        }

    def save(self, agent_state=None):
        RUNS.mkdir(parents=True, exist_ok=True)
        record = self.public() | {"steps": self.steps, "seq": self.seq}
        if agent_state is not None:
            record["agentState"] = agent_state
        path = RUNS / f"{disk_name(self.id)}.json"
        temporary = path.with_suffix(".tmp")
        # ASCII escapes: text an agent's `evaluate` cut mid-emoji holds a lone surrogate, which UTF-8
        # cannot encode, and every save of the run would fail on it.
        temporary.write_text(json.dumps(record))
        temporary.replace(path)
        self.stored = self.status

    @classmethod
    def load(cls, record):
        run = cls(record["id"], record["sessionId"], record["task"])
        for key, attribute in [("status", "status"), ("result", "result"), ("error", "error"),
                               ("success", "success"), ("createdAt", "created_at"),
                               ("startedAt", "started_at"), ("finishedAt", "finished_at"),
                               ("steps", "steps"), ("finalUrl", "final_url"), ("finalTitle", "final_title"),
                               ("usage", "usage"), ("traffic", "traffic"), ("engine", "engine"), ("jev", "jev"),
                               ("unreadMessages", "unread_messages"), ("seq", "seq")]:
            if key in record:
                setattr(run, attribute, record[key])
        run.stored = run.status
        return run


def step_summary(state, output, number, tokens=None):
    actions = []
    for action in getattr(output, "action", None) or []:
        data = action.model_dump(exclude_none=True) if hasattr(action, "model_dump") else {}
        for name, params in data.items():
            # Inputs can carry what the person typed or a secret placeholder: keep only the action name
            # and its element index.
            actions.append({"action": name, "index": (params or {}).get("index") if isinstance(params, dict) else None})
    summary = {
        "number": number, "at": now_iso(), "url": getattr(state, "url", None),
        "title": (getattr(state, "title", None) or "")[:200],
        # Flash mode has no next goal: its memory says where the step was going.
        "goal": (getattr(output, "next_goal", None) or getattr(output, "memory", None) or "")[:300],
        "actions": actions[:10],
    }
    if tokens is not None:
        summary["tokens"] = tokens
    return summary


def step_tokens(entries):
    """The model's tokens since the last step was counted (browser-use's own usage records): the step's call
    and any extraction or compaction calls in between. What a step costs, and how much of it the prompt
    cache took, is read from these."""
    total = {"in": 0, "cached": 0, "out": 0, "calls": 0}
    for entry in entries:
        usage = getattr(entry, "usage", None)
        total["in"] += getattr(usage, "prompt_tokens", 0) or 0
        total["cached"] += getattr(usage, "prompt_cached_tokens", 0) or 0
        total["out"] += getattr(usage, "completion_tokens", 0) or 0
        total["calls"] += 1
    return total


def agent_tuning(value):
    """Bro's `tuning` of the browser-use agent, checked: an unknown key is ignored (a newer Bro), a wrong
    value refused. Absent, the agent runs with browser-use's defaults, as it always did."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise web.HTTPBadRequest(text="tuning must be an object")
    tuning = {}
    if value.get("flashMode") is not None:
        if not isinstance(value["flashMode"], bool):
            raise web.HTTPBadRequest(text="tuning.flashMode must be a boolean")
        tuning["flashMode"] = value["flashMode"]
    for key, (low, high) in TUNING_LIMITS.items():
        number = value.get(key)
        if number is None:
            continue
        if isinstance(number, bool) or not isinstance(number, int) or not low <= number <= high:
            raise web.HTTPBadRequest(text=f"tuning.{key} must be a whole number from {low} to {high}")
        tuning[key] = number
    if value.get("reasoning") is not None:
        if value["reasoning"] not in REASONING_EFFORTS:
            raise web.HTTPBadRequest(text=f"tuning.reasoning must be one of {', '.join(REASONING_EFFORTS)}")
        tuning["reasoning"] = value["reasoning"]
    if value.get("provider") is not None:
        routing = provider_routing(value["provider"])
        if routing:
            tuning["provider"] = routing
    return tuning


def provider_routing(value):
    """Bro's `tuning.provider`, checked and kept in Bro's names, so that a session's stored tuning passes this
    check again as a follow-up's: `order` and `ignore` lists of host slugs, `requireParameters`. An unknown
    key is ignored, an empty list dropped."""
    if not isinstance(value, dict):
        raise web.HTTPBadRequest(text="tuning.provider must be an object")
    routing = {}
    for key in ("order", "ignore"):
        hosts = value.get(key)
        if hosts is None:
            continue
        if (not isinstance(hosts, list) or len(hosts) > PROVIDER_HOSTS_MAX
                or not all(isinstance(host, str) and PROVIDER_SLUG.fullmatch(host) for host in hosts)):
            raise web.HTTPBadRequest(text=f"tuning.provider.{key} must be a list of up to "
                                          f"{PROVIDER_HOSTS_MAX} host slugs")
        if hosts:
            routing[key] = list(dict.fromkeys(hosts))
    if value.get("requireParameters") is not None:
        if not isinstance(value["requireParameters"], bool):
            raise web.HTTPBadRequest(text="tuning.provider.requireParameters must be a boolean")
        routing["requireParameters"] = value["requireParameters"]
    return routing


def system_extension(tuning):
    """Bro's part of the agent's system message: the workspace rules, and the batching hint when a step may
    hold more actions than browser-use's default. Bro's own rules of the errand stay in the task: moved
    here, the report's labelled footer went missing from the answers (bench of 01.10.2026,
    docs/agent-costs.md, section 3.3)."""
    return f"{EXTEND_SYSTEM}\n\n{BATCH_HINT}" if "maxActionsPerStep" in tuning else EXTEND_SYSTEM


def tuned_llm_options(tuning):
    """ChatOpenRouter's options for the run's reasoning and routing. DeepSeek V4.1 Flash on RouterAI reasons
    before it answers unless told not to, and those tokens are billed as output and slow every step. Left to
    pick a host itself, RouterAI served it from hosts without structured outputs (its own `deepseek` among
    them): browser-use asks for a strict JSON schema, and their answers failed `AgentOutput` four times in a
    row until browser-use ended the run (six errands on 03.10.2026). browser-use passes `extra_body` on to
    the OpenAI client, which merges its own `extra_body` into the request."""
    body = {}
    reasoning = tuning.get("reasoning")
    if reasoning is not None:
        body["reasoning"] = {"enabled": False} if reasoning == "none" else {"effort": reasoning}
    if tuning.get("provider"):
        body["provider"] = {PROVIDER_FIELDS[key]: value for key, value in tuning["provider"].items()}
    return {"extra_body": {"extra_body": body}} if body else {}


def tuned_agent_options(tuning):
    """browser-use's own names for what Bro tuned. Its history is never trimmed (`max_history_items`): a
    trimmed history changes the prompt right after the task at every step, and the prompt cache that holds
    two thirds of every step's input is lost (docs/agent-costs.md, section 3.3)."""
    names = {"flashMode": "flash_mode", "maxActionsPerStep": "max_actions_per_step"}
    return {name: tuning[key] for key, name in names.items() if key in tuning}


def usage_summary(history, agent, billed=None):
    """The run's tokens, which Bro prices itself (shared/costs/prices.ts), and what the model's service billed
    for them (`Billed`) when it says. browser-use counts tokens whether or not it prices them; its
    `total_cost` is left out: runs never let it price (`calculate_cost=False`, see `run_agent`), so it is 0,
    and a 0 would read as a free run."""
    usage = getattr(history, "usage", None)
    has_billed = billed is not None and billed.calls
    hosts = dict(billed.hosts) if billed is not None and billed.hosts else None
    if usage is None and not has_billed and not hosts:
        return None
    # No usage of browser-use's own when it could parse no answer at all: the service's bill still counts.
    data = usage.model_dump() if hasattr(usage, "model_dump") else {}
    summary = {k: data.get(k) for k in ("total_prompt_tokens", "total_completion_tokens", "total_tokens",
                                           "total_prompt_cached_tokens") if k in data}
    if has_billed:
        summary.update(billed=round(billed.total, 6), billed_calls=billed.calls)
    if hosts:
        summary["hosts"] = hosts
    return summary


class Billed:
    """What the model's service billed for each call of a run, in its own currency (roubles at RouterAI): the
    `usage.cost` of every answer, read off the HTTP client. browser-use's own count misses the calls whose
    answer it could not parse — with DeepSeek's reasoning on, up to half the calls of a run (01.10.2026),
    billed all the same — and the price changed within a morning (twice as much at 10:00 as at 08:40 MSK).
    `hosts` counts the answers by the upstream host that served them (the answer's `provider`, "DeepInfra"),
    with a cost or without: which host a run got shows whether Bro's routing held (`tuning.provider`)."""

    def __init__(self):
        self.total, self.calls, self.hosts = 0.0, 0, {}

    async def count(self, response):
        if response.request.method != "POST" or not response.request.url.path.endswith("/chat/completions"):
            return
        with contextlib.suppress(Exception):
            await response.aread()
            answer = response.json()
            host = answer.get("provider")
            if (isinstance(host, str) and 0 < len(host) <= 64
                    and (host in self.hosts or len(self.hosts) < BILLED_HOSTS_MAX)):
                self.hosts[host] = self.hosts.get(host, 0) + 1
            cost = (answer.get("usage") or {}).get("cost")
            if isinstance(cost, (int, float)) and not isinstance(cost, bool):
                self.total += cost
                self.calls += 1

    def client(self):
        import httpx

        # The OpenAI client's own timeouts and retries still apply per request; only the hook is added.
        return httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10), event_hooks={"response": [self.count]})


class Worker:
    def __init__(self):
        self.config = load_config()
        self.generation = read_generation()
        self.forwarder = Forwarder()
        self.runs = {}
        self.sessions = {}
        self.current = None  # the run holding the browser
        self.lock = asyncio.Lock()
        self.started = time.time()
        self.vm_address = None
        self.visit_tabs = set()  # blank tabs Bro opened for a keep-alive visit (POST /v1/tabs)
        self.restarting = False  # new code is in place and the worker exits: no run starts
        self.profile_walk = (float("-inf"), None)  # (monotonic time, MB) of the last walk of the profile
        self.run_seq = 0  # next Run.seq to hand out; resumed past every seq load_runs() found on disk
        self.load_runs()
        self.load_tabs()

    # Persistence: a run's record survives a worker or VM restart; one that was running then is
    # reported as failed with its last checkpoint, never resumed behind Bro's back.
    def load_runs(self):
        if not RUNS.exists():
            return
        loaded = []
        for path in RUNS.glob("*.json"):
            try:
                record = json.loads(path.read_text())
                loaded.append((Run.load(record), record))
            except (OSError, ValueError, KeyError):
                continue
        # Oldest first, since the glob's order is arbitrary: the newest run is the session's latest, and
        # its memory is the newest checkpoint a run left (a run killed before its first step left none).
        # created_at/started_at only have 1-second resolution, so two runs of one session dispatched
        # within the same second tie on both; `seq` (assigned in creation order, restart-independent)
        # breaks that tie correctly where the run id — a random UUID — could not.
        loaded.sort(key=lambda item: (item[0].created_at or "", item[0].started_at or "", item[0].seq))
        self.run_seq = max((run.seq for run, _record in loaded), default=-1) + 1
        for run, record in loaded:
            if run.status not in TERMINAL:
                run.status = "failed"
                run.error = ("The browser worker restarted while the run was working (VM or Chrome restart); "
                             f"the last checkpoint was step {len(run.steps)} on {run.final_url or run.steps[-1]['url'] if run.steps else 'no page'}.")
                run.finished_at = now_iso()
                # A disk that refuses the write (full) must not keep the worker from starting: the
                # record is written again before the next exit (`persist_ended`).
                with contextlib.suppress(OSError):
                    run.save(record.get("agentState"))
            self.runs[run.id] = run
            session = self.sessions.setdefault(run.session_id, Session(run.session_id))
            session.latest_run_id = run.id
            if record.get("agentState") is not None:
                session.agent_state = record["agentState"]

    # Chrome outlives a worker restart (a code update, a crash): the sessions' tabs are kept on disk, so a
    # page waiting for a code is still the errand's afterwards, not an orphan the next run replaces.
    def load_tabs(self):
        try:
            kept = {session_id: (tabs.get("tab"), set(tabs.get("tabs") or []))
                    for session_id, tabs in json.loads(TABS_FILE.read_text()).items()}
        except (OSError, ValueError, AttributeError, TypeError):  # none kept, or a file the worker cannot read
            return
        for session_id, (tab, tabs) in kept.items():
            session = self.sessions.setdefault(session_id, Session(session_id))
            session.tab, session.tabs = tab, tabs

    def save_tabs(self):
        kept = {session.id: {"tab": session.tab, "tabs": sorted(session.tabs)}
                for session in self.sessions.values() if session.tabs and not session.released}
        with contextlib.suppress(OSError):
            temporary = TABS_FILE.with_suffix(".tmp")
            temporary.write_text(json.dumps(kept))
            temporary.replace(TABS_FILE)

    async def adopt_tabs(self):
        """At start: a tab Chrome still has is the session's again; one it lost (Chrome or the VM
        restarted too, or Chrome does not answer) is forgotten."""
        try:
            live = await page_ids()
        except Exception:
            live = set()
        for session in self.sessions.values():
            session.tabs &= live
            if session.tab not in session.tabs:
                session.tab = None
        self.save_tabs()

    def accept_generation(self, generation):
        if generation > self.generation:
            self.generation = generation
            GENERATION_FILE.write_text(str(generation))

    def busy(self):
        return self.current is not None and self.current.status not in TERMINAL

    def persist_ended(self):
        """Write again the ends of runs the disk refused (a full or failing disk): after an exit the worker
        would read them as interrupted, and a completed run as failed. True once every end is on disk."""
        for run in self.runs.values():
            if run.status in TERMINAL and run.stored != run.status:
                session = self.sessions.get(run.session_id)
                memory = session.agent_state if session and session.latest_run_id == run.id else None
                with contextlib.suppress(Exception):
                    run.save(memory)
        return all(run.stored == run.status for run in self.runs.values() if run.status in TERMINAL)

    def stop_runs(self):
        """Stopping (power-off, restart): a working run is recorded right away as interrupted, with its
        checkpoint, or as what it came to when it was only letting go of the browser; the agent is not
        waited for, since systemd would kill it mid-step anyway."""
        for run in list(self.runs.values()):
            if run.status in TERMINAL:
                continue
            run.cancel_requested = True
            run.status, run.result, run.error = run.outcome or (
                "failed", run.result, f"The browser worker stopped while the run was working (step {len(run.steps)}).")
            run.finished_at = now_iso()
            run.unread_messages = list(run.messages)
            run.messages = []
            session = self.sessions.get(run.session_id)
            with contextlib.suppress(Exception):
                agent_state = run.agent.state.model_dump(mode="json") if run.agent else None
                run.save(agent_state or (session.agent_state if session else None))
        self.persist_ended()

    async def profile_size(self):
        """The profile's size for /v1/health?machine: walked in a thread, since this loop also runs the
        forwarder and the agent, and at most once a minute."""
        walked_at, size = self.profile_walk
        if time.monotonic() - walked_at > PROFILE_WALK_S:
            size = await asyncio.to_thread(profile_mb)
            self.profile_walk = (time.monotonic(), size)
        return size

    async def ensure_tab(self, session):
        if session.tab not in await page_ids():
            session.tab = await new_tab()
            session.tabs.add(session.tab)
            self.save_tabs()
        return session.tab

    async def follow_focus(self, session, browser, before):
        """Clicking a link that opens a new tab moves the agent there (browser-use switches its focus): the
        session follows it, so the result's screenshot, a code typed over CDP and the next run all use the
        page the agent ended on. Every tab that appeared since `before` (the tabs open when the agent
        took the browser) is the session's too, so releasing it closes them all."""
        try:
            after = await page_ids()
        except Exception:
            return
        others = set(self.visit_tabs)
        for other in self.sessions.values():
            if other is not session:
                others |= other.tabs
        session.tabs = (session.tabs | (after - before - others)) & after
        focus = getattr(browser, "agent_focus_target_id", None)
        if focus in after and focus not in others:
            session.tab = focus
            session.tabs.add(focus)
        self.save_tabs()

    async def browser_session(self, session, options):
        from browser_use import BrowserSession

        tab = await self.ensure_tab(session)
        with contextlib.suppress(Exception):
            await cdp_command(await browser_socket(), "Target.activateTarget", {"targetId": tab})
        downloads = session.workspace / "downloads"
        downloads.mkdir(exist_ok=True)
        browser = BrowserSession(
            cdp_url=CDP_HTTP, keep_alive=True, downloads_path=str(downloads),
            prohibited_domains=PROHIBITED_DOMAINS, allowed_domains=options.get("allowedDomains") or None,
        )
        await browser.start()
        with contextlib.suppress(Exception):
            from browser_use.browser.events import SwitchTabEvent

            await browser.event_bus.dispatch(SwitchTabEvent(target_id=tab))
        return browser

    def tools(self, session, run):
        from browser_use import ActionResult, Tools

        tools = Tools()
        report = session.workspace / "report"

        def saved_picture(name):
            # The agent looked for the picture in its own file system, which lists only its agent-files, did not
            # find it and saved it again, up to seven times a run (bench of 01.10.2026): the result says why.
            text = (f"Saved report/{name}. Pictures under report/ go to Bro, not to your file system, so they never "
                    "show in its listing: this one is done, do not save it again.")
            return ActionResult(extracted_content=text, long_term_memory=text)

        @tools.action("Save a screenshot of the visible page as a file in your workspace, for example "
                      "report/final.png. Use it whenever the task asks to save a screenshot or a picture.")
        async def save_screenshot(file_name: str, browser_session):
            name = Path(file_name).name
            if not FILE_NAME.match(name):
                return ActionResult(error="Use a short Latin file name such as final.png.")
            report.mkdir(parents=True, exist_ok=True)
            image_format = "png" if name.lower().endswith(".png") else "jpeg"
            await browser_session.take_screenshot(path=str(report / name), format=image_format,
                                                  quality=None if image_format == "png" else 85)
            return saved_picture(name)

        @tools.action("Save a picture of one element of the page (an item photo) as a file in your workspace, "
                      "for example report/red-kettle.jpg. Give the element index from the page state.")
        async def save_element_picture(index: int, file_name: str, browser_session):
            name = Path(file_name).name
            if not FILE_NAME.match(name):
                return ActionResult(error="Use a short Latin file name such as red-kettle.jpg.")
            node = await browser_session.get_element_by_index(index)
            rect = getattr(node, "absolute_position", None) if node else None
            if not rect or rect.width < 8 or rect.height < 8:
                return ActionResult(error=f"Element {index} has no visible area to capture.")
            report.mkdir(parents=True, exist_ok=True)
            image_format = "png" if name.lower().endswith(".png") else "jpeg"
            await browser_session.take_screenshot(
                path=str(report / name), format=image_format, quality=None if image_format == "png" else 85,
                clip={"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height})
            return saved_picture(name)

        @tools.action("Enter a one-time code (from an SMS, a letter or an app) into the page's code field. Always use "
                      "this for codes instead of typing digits yourself: it finds the field even when it is split into "
                      "boxes or sits inside a web component, and enters the whole code at once.")
        async def enter_code(code: str, browser_session):
            digits = re.sub(r"\s+", "", code or "")
            if not re.fullmatch(r"[0-9A-Za-z-]{3,12}", digits):
                return ActionResult(error="A code is 3 to 12 letters or digits.")
            cdp = await browser_session.get_or_create_cdp_session()
            found = await cdp.cdp_client.send.Runtime.evaluate(
                params={"expression": FIND_CODE_FIELD, "returnByValue": True}, session_id=cdp.session_id)
            where = (found.get("result") or {}).get("value")
            if not where:
                return ActionResult(error="No code field on this page; if it sits in a frame, type into it yourself.")
            await cdp.cdp_client.send.Input.insertText(params={"text": digits}, session_id=cdp.session_id)
            await asyncio.sleep(2)
            # The code itself stays out of the agent's memory and the run record.
            return ActionResult(extracted_content=f"Entered the code into {where}.",
                                long_term_memory="Entered the one-time code.")

        @tools.action("Fill the page's bank card form (number, expiry, CVC, cardholder) with the saved card. Always "
                      "use this for a card form instead of typing card secrets yourself: it finds the fields in the "
                      "payment processor's frame too, types each one (a month box, a year box, a single MM/YY field, "
                      "a select) the way that field takes it, and checks each kept its value.")
        async def fill_card(browser_session):
            card = card_secrets(session.sensitive_data, await browser_session.get_current_page_url())
            if card is None:
                return ActionResult(error="No saved card is bound to this site for this run.")
            filled, message = await fill_card_form(await card_frames(browser_session), card)
            return (ActionResult(extracted_content=message, long_term_memory=message) if filled
                    else ActionResult(error=message))

        @tools.action("Get past a captcha: a reCAPTCHA («I'm not a robot», visible or invisible), an hCaptcha, a "
                      "Cloudflare Turnstile or a Yandex SmartCaptcha check on a form, or an anti-bot page with a slider puzzle (GeeTest), "
                      "such as Avito's «Доступ ограничен». Call it once on the page with the check, before you tick "
                      "the check or open its pictures or audio: it has the check solved (up to two minutes), puts "
                      "the answer into the page and says whether to submit the form; a slider page it presses, "
                      "solves and says whether the page let it through.")
        async def solve_captcha(browser_session):
            cdp = await browser_session.get_or_create_cdp_session()

            async def evaluate(expression):
                answer = await cdp.cdp_client.send.Runtime.evaluate(
                    params={"expression": expression, "returnByValue": True, "awaitPromise": True},
                    session_id=cdp.session_id)
                return (answer.get("result") or {}).get("value")

            async def mouse(params):
                await cdp.cdp_client.send.Input.dispatchMouseEvent(params=params, session_id=cdp.session_id)

            key = (session.captcha or {}).get("twoCaptchaKey")
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as http:

                async def token_check():
                    worlds, frame_urls = await captcha_worlds(browser_session)
                    return await solve_token_captcha(worlds, frame_urls, await browser_session.get_current_page_url(),
                                                     http, key, solver_proxy(self.forwarder.upstream))

                solved, message = await solve_page_captcha(evaluate, mouse, http, key, token_check)
            return (ActionResult(extracted_content=message, long_term_memory=message) if solved
                    else ActionResult(error=message))

        return tools

    async def release_direct(self, session):
        """One controller per tab: direct operations hand the tab back before an agent takes it."""
        if session.direct is not None:
            with contextlib.suppress(Exception):
                await session.direct.stop()
            session.direct = None

    async def direct_browser(self, session):
        if self.busy():
            raise web.HTTPConflict(text=json.dumps({"error": "busy", "runId": self.current.id}),
                                   content_type="application/json")
        if session.direct is None:
            session.direct = await self.browser_session(session, session.options or {})
        return session.direct

    async def run_agent(self, run, session, text):
        from browser_use import Agent, ChatOpenRouter
        from browser_use.agent.message_manager.views import HistoryItem
        from browser_use.agent.views import AgentState

        await self.release_direct(session)

        tuning = session.options.get("tuning") or {}
        llm_config = session.llm
        billed = Billed()
        http = billed.client()
        llm = ChatOpenRouter(model=llm_config["model"], base_url=llm_config["baseUrl"], api_key=llm_config["apiKey"],
                             http_client=http, **tuned_llm_options(tuning))
        browser = await self.browser_session(session, session.options)
        before = await page_ids()
        uploads = sorted(str(p) for p in UPLOADS.glob("*")) if UPLOADS.exists() else []
        injected = None
        if session.agent_state and session.options.get("continueMemory") is not False:
            with contextlib.suppress(Exception):
                injected = AgentState.model_validate_json(session.agent_state) \
                    if isinstance(session.agent_state, str) else AgentState.model_validate(session.agent_state)
                injected.stopped = False
                injected.paused = False
                injected.consecutive_failures = 0
                # A follow-up's own text is its whole request: an earlier run's task (its consent, cap and
                # the person's details) is not carried over as the "initial request", and the page it
                # continues on is not left for a URL found in the text.
                injected.follow_up_task = True
                injected.message_manager_state.agent_history_items.append(HistoryItem(system_message=NEW_REQUEST))
                # Reset the counters instead of offsetting them: browser-use's 75% budget warning divides
                # the session's *total* n_steps by max_steps, so a long chain of follow-ups carried a high
                # n_steps into a max_steps offset to match, and warned the model to wrap up before its
                # first step. A fresh count keeps the warning tied to this run's own budget; the history
                # and memory above are untouched, so the model still sees everything the session learned.
                injected.n_steps = 1
                if hasattr(injected.message_manager_state, "last_compaction_step"):
                    injected.message_manager_state.last_compaction_step = None
                if hasattr(injected, "plan_generation_step"):
                    injected.plan_generation_step = None
                # This run's own system message, not the one the memory was saved with: browser-use keeps a
                # restored one over its own, and a follow-up's tuning (flash mode has a prompt of its own) or
                # a newer worker's rules may differ from the run it continues. The state message is rebuilt
                # at the first step anyway.
                history = getattr(injected.message_manager_state, "history", None)
                if history is not None:
                    history.system_message = history.state_message = None
                    history.context_messages = []
        # Each run gets its own step budget, counted from its own first step, injected or not.
        max_steps = int(session.options.get("maxSteps") or 60)
        deadline = time.monotonic() + int(session.options.get("timeoutSeconds") or 1500)

        counted = 0  # browser-use's usage records already put on a step

        async def on_step(state, output, number):
            nonlocal counted
            tokens = None
            with contextlib.suppress(Exception):
                entries = agent.token_cost_service.usage_history[counted:]
                counted += len(entries)
                tokens = step_tokens(entries)
            run.steps.append(step_summary(state, output, number, tokens))
            run.final_url = getattr(state, "url", None) or run.final_url
            with contextlib.suppress(Exception):
                run.save(agent.state.model_dump(mode="json"))

        async def should_stop():
            return run.cancel_requested or time.monotonic() > deadline

        pending_messages = []  # this step's batch: folded back if the step is cut off before it finishes
        site_errors = SiteErrors()
        trail = StepTrail(session.workspace / TRAIL / run.id, session.sensitive_data)
        with contextlib.suppress(Exception):
            await asyncio.to_thread(prune_trails, TRAIL_RUNS - 1)
        steps_before = 0  # run.steps when the current step started: a step whose output failed adds none

        async def read_messages(_):
            nonlocal steps_before
            steps_before = len(run.steps)
            # A tab the agent moved into (a link that opens one, its own `navigate` with `new_tab`) is listened to
            # from now on: the checkout it goes through there is the run's too.
            with contextlib.suppress(Exception):
                focus = getattr(browser, "agent_focus_target_id", None)
                if focus and not site_errors.watches(focus):
                    targets = {t["id"]: t for t in await page_targets()}
                    site_errors.start(targets[focus]["webSocketDebuggerUrl"], focus)
            # The site's refusals of what the last step sent: the next model call sees them, whatever the
            # page shows (it may show nothing and move on).
            with contextlib.suppress(Exception):
                for notice in site_errors.notices(session.sensitive_data):
                    tell_agent(agent, notice)
            # Read right before the model's next call, so that call can act on them. The last step (only
            # `done` is left) and one about to be stopped leave them for the follow-up run instead.
            pending_messages.clear()
            if run.messages and agent.state.n_steps < max_steps and not await should_stop():
                pending_messages.extend(run.messages)
                run.messages = []
                for message in pending_messages:
                    agent.add_new_task(message)

        async def step_ended(_):
            summary = run.steps[-1] if len(run.steps) > steps_before else None
            errors = [result.error for result in (getattr(agent.state, "last_result", None) or [])
                      if getattr(result, "error", None)]
            url = None
            with contextlib.suppress(Exception):
                url = await asyncio.wait_for(browser.get_current_page_url(), 2)
            with contextlib.suppress(Exception):
                await trail.record(lambda: page_jpeg(browser), summary, url, errors)

        agent = Agent(
            task=text, llm=llm, browser_session=browser, tools=self.tools(session, run),
            sensitive_data=session.sensitive_data or None, use_vision=bool(session.options.get("vision", False)),
            # No pricing: browser-use would fetch LiteLLM's price list from raw.githubusercontent.com and
            # then openrouter.ai for every model call of the run, 30 s each, after `done` — both silent from
            # Cloud.ru (30.09), which held a finished run for minutes. Tokens are counted anyway.
            calculate_cost=False, use_judge=False, available_file_paths=uploads,
            injected_agent_state=injected, register_new_step_callback=on_step,
            register_should_stop_callback=should_stop,
            extend_system_message=system_extension(tuning),
            # A restored state carries its own file system; browser-use refuses both at once.
            file_system_path=None if injected is not None else str(session.workspace / "agent-files"),
            max_failures=4,
            enable_signal_handler=False,
            **tuned_agent_options(tuning),
        )
        run.agent = agent
        with contextlib.suppress(Exception):
            targets = {t["id"]: t for t in await page_targets()}
            site_errors.start(targets[session.tab]["webSocketDebuggerUrl"], session.tab)
        try:
            history = await agent.run(max_steps=max_steps, on_step_start=read_messages, on_step_end=step_ended)
        finally:
            await site_errors.stop()
            # browser-use swallows an InterruptedError raised by `should_stop` mid-step (a cancel or the
            # deadline landing while the LLM call or an action was in flight) and returns normally, with
            # `agent.state.stopped` the only sign that the step which just read `pending_messages` never
            # ran to completion: put them back so they are not silently dropped from `unreadMessages`.
            if pending_messages and getattr(agent.state, "stopped", False):
                run.messages = pending_messages + run.messages
            run.agent = None
            await self.follow_focus(session, browser, before)
            with contextlib.suppress(Exception):
                await http.aclose()
        with contextlib.suppress(Exception):
            session.agent_state = agent.state.model_dump(mode="json")
        final = history.final_result()
        errors_seen = site_errors.report(session.sensitive_data)
        if errors_seen:
            final = errors_seen + (final or "")
        run.success = history.is_successful()
        run.usage = usage_summary(history, agent, billed)
        with contextlib.suppress(Exception):
            run.final_url = await browser.get_current_page_url()
            run.final_title = await browser.get_current_page_title()
        with contextlib.suppress(Exception):
            await browser.stop()
        if run.cancel_requested:
            return "cancelled", final, "Stopped by Bro."
        if time.monotonic() > deadline and not history.is_done():
            return "failed", final, "The run ran out of its time budget."
        if history.is_done():
            return "completed", final, None
        errors = [e for e in history.errors() if e]
        return "failed", final, (errors[-1] if errors else "The agent stopped without finishing.")[:2000]

    async def run_jev(self, run, session, text):
        """A bounded jev-ultrafast segment on the same Chrome; jev returns BLOCKED on widgets it cannot
        read (calendars, masked inputs), and the agent then continues from the same page."""
        config = session.options.get("jev") or {}
        tab = await self.ensure_tab(session)
        with contextlib.suppress(Exception):
            await cdp_command(await browser_socket(), "Target.activateTarget", {"targetId": tab})
        env = {**os.environ, "BU_CDP_URL": CDP_HTTP, "BH_UPDATE_CHECK": "0", "TYPESAFE_MODEL": "jev-latest",
               "TYPESAFE_API_KEY": config.get("apiKey", ""), "TEXT_MODEL_API_KEY": session.llm["apiKey"],
               "TEXT_MODEL_BASE_URL": session.llm["baseUrl"], "TEXT_MODEL": session.llm["model"],
               "TEXT_MODEL_REASONING": "none"}
        started = time.monotonic()
        process = await asyncio.create_subprocess_exec(
            "/opt/bro/jev-ultrafast/.venv/bin/python", "/opt/bro/worker/jev_segment.py",
            "--url", config.get("startUrl") or "about:blank", "--goal", config.get("goal") or text,
            "--deadline", str(int(config.get("timeoutSeconds") or 60)),
            env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, cwd="/opt/bro/jev-ultrafast")
        try:
            output, _ = await asyncio.wait_for(process.communicate(), int(config.get("timeoutSeconds") or 60) + 15)
        except asyncio.TimeoutError:
            process.kill()
            output = b""
        lines = [line for line in output.decode(errors="replace").splitlines() if line.startswith("{")]
        result = json.loads(lines[-1]) if lines else {"status": "no_output"}
        result["seconds"] = round(time.monotonic() - started, 2)
        if result.get("target"):
            # The agent continues on jev's page; the blank tab the session had is closed.
            if session.tab and session.tab != result["target"]:
                await close_tab(session.tab)
                session.tabs.discard(session.tab)
            session.tab = result["target"]
            session.tabs.add(session.tab)
            self.save_tabs()
        return result

    async def execute(self, run, session, text):
        run.status = "running"
        run.started_at = now_iso()
        # One run holds the browser at a time, so the proxy's bytes while it works are its own: Bro prices them.
        traffic_start = dict(self.forwarder.totals)
        # The outcome is set only once the run has let go of the browser: until then a message still
        # joins it (and, if the agent never reads it, is recorded below as unread).
        status, result, error = "failed", None, "The run was interrupted."
        try:
            run.save()  # a disk that refuses the record fails the run with the reason, never holds the browser
            if not await chrome_ready():
                await systemctl("start")
                if not await wait_chrome(30):
                    raise RuntimeError("Chrome did not start on the VM.")
            if self.forwarder.upstream is None:
                raise RuntimeError("The residential proxy is not configured; the browser has no network.")
            if run.engine == "jev-then-agent":
                run.jev = await self.run_jev(run, session, text)
                run.save()
                if run.jev.get("status") == "DONE" and session.options.get("jevCanFinish"):
                    status, result, error = "completed", run.jev.get("visible_text", "")[:3000], None
                    run.final_url = run.jev.get("final_url")
                    return
            if run.cancel_requested:  # stopped during the jev segment: the agent does not start
                status, result, error = "cancelled", None, "Stopped by Bro."
            else:
                limit = int(session.options.get("timeoutSeconds") or 1500) + OVERRUN_S
                outcome = await self.bounded(run, self.run_agent(run, session, text), limit)
                status, result, error = outcome or (
                    ("cancelled", None, "Stopped by Bro.") if run.cancel_requested
                    else ("failed", None, "The run ran out of its time budget."))
        except Exception as crash:  # a crash is a failed run with its reason, never a silent loss
            log.exception("run %s failed", run.id)
            status, error = "failed", f"{type(crash).__name__}: {crash}"[:2000]
        finally:
            run.outcome = status, result, error  # what a worker stopped during the screenshot records
            with contextlib.suppress(Exception):
                report = session.workspace / "report"
                if not (report / "final.png").exists() and not (report / "final.jpg").exists() and session.tab:
                    report.mkdir(parents=True, exist_ok=True)
                    (report / "final.jpg").write_bytes(await screenshot(session.tab))
            # From here to `run.messages = []` nothing waits, so no message slips in as read and then
            # dropped: one that arrives after this point finds the run already terminal, and
            # `session_message` starts a follow-up itself (the idle-session rule) instead of queuing here.
            # `stop_runs()` can itself finalize the run first, while this coroutine only sat awaiting the
            # screenshot above: if it did, `run.messages` is already the empty list `stop_runs` drained
            # into `run.unread_messages`, so re-deriving from it here would silently replace the correctly
            # captured messages with `[]`.
            already_finalized = run.status in TERMINAL
            if not already_finalized:
                run.status, run.result, run.error = status, result, error
                run.finished_at = now_iso()
                # Messages the agent never read (the run was finishing when they came) are not dropped:
                # they go on the terminal record as `unreadMessages`, for Bro to act on. The worker itself
                # never starts a follow-up run.
                run.unread_messages = list(run.messages)
                run.messages = []
            if run.traffic is None:
                run.traffic = {key: max(0, self.forwarder.totals[key] - traffic_start[key]) for key in ("up", "down")}
            try:
                run.save(session.agent_state)
            except Exception:  # Bro reads the end from memory; an update or a stop writes it again first
                log.exception("run %s: its end was not written", run.id)
            if self.current is run:
                self.current = None

    async def bounded(self, run, work, limit):
        """Work a run for at most `limit` seconds, or until a cancel cuts it off (`cut_off`). A cut-off run
        answers None; its agent's memory is kept for a follow-up, as a finished run's is."""
        run.work = asyncio.ensure_future(work)
        try:
            await asyncio.wait({run.work}, timeout=limit)
            overran = not run.work.done()
            if overran:
                log.warning("run %s: cut off past its budget", run.id)
                await self.cut_off(run)
            work = run.work
            if not work.done() or work.cancelled():
                return None
            # A step failing under a cut-off (Chrome restarted beneath it) ended by the cut-off, not a crash.
            if (overran or run.cancel_requested) and work.exception() is not None:
                return None
            return work.result()
        finally:
            run.work = None

    async def cut_off(self, run):
        """Stop the task working `run`, if it still does. A step that ignores the cancel is failed from under
        it by a Chrome restart, and is left behind only if even that does not end it."""
        work = run.work
        if work is None or work.done():
            return
        agent = run.agent
        if agent is not None:
            # Stopped, the agent folds the messages its cut-off step had read back into the run's unread.
            with contextlib.suppress(Exception):
                agent.stop()
        work.cancel()
        await asyncio.wait({work}, timeout=UNWIND_S)
        if not work.done():
            log.warning("run %s: the cut-off step did not unwind; restarting Chrome", run.id)
            await systemctl("restart")
            await asyncio.wait({work}, timeout=UNWIND_S)
        session = self.sessions.get(run.session_id)
        if agent is not None and session is not None:
            with contextlib.suppress(Exception):
                session.agent_state = agent.state.model_dump(mode="json")

    def begin(self, run, session):
        """Hand the browser to a run. Nothing here waits, so no other start slips in between the caller's
        busy check and this. The run's record is written as it starts (`execute`), where a write the disk
        refuses fails the run and lets go of the browser."""
        self.runs[run.id] = run
        session.latest_run_id = run.id
        self.current = run
        asyncio.get_running_loop().create_task(self.execute(run, session, run.task))

    async def start_run(self, body):
        run_id = safe_id(body.get("id"))
        existing = self.runs.get(run_id)
        if existing is not None:
            return existing, False  # idempotent: a retried start after a lost answer adopts the run
        task = body.get("task")
        if not isinstance(task, str) or not task.strip() or len(task) > 60000:
            raise web.HTTPBadRequest(text="task is required")
        llm = body.get("llm") or {}
        if not all(isinstance(llm.get(k), str) and llm.get(k) for k in ("baseUrl", "apiKey", "model")):
            raise web.HTTPBadRequest(text="llm {baseUrl, apiKey, model} is required")
        tuning = agent_tuning(body.get("tuning"))
        async with self.lock:
            if self.busy():
                raise web.HTTPConflict(text=json.dumps({"error": "busy", "runId": self.current.id}),
                                       content_type="application/json")
            if self.restarting:
                raise web.HTTPConflict(text=json.dumps({"error": "busy"}), content_type="application/json")
            session_id = safe_id(body.get("sessionId") or f"s-{uuid.uuid4()}")
            session = self.sessions.get(session_id)
            if session is None:
                session = self.sessions[session_id] = Session(session_id)
            elif body.get("freshMemory"):
                session.agent_state = None
            session.released = False
            session.llm = llm
            # An omitted `secrets` means "keep what the session already has", not "clear it": a
            # follow-up into the same session — a live-run queue joins without ever calling this, but an
            # idle-session message or a retried `POST /v1/runs` reaches here — must not silently wipe a
            # binding the person is still mid-flow with (a login finished after an SMS code, a saved
            # password, a payment field) just because its caller did not resend `secrets`.
            if "secrets" in body:
                session.sensitive_data = secrets_to_sensitive_data(body.get("secrets") or [])
            if "captcha" in body:
                captcha = body.get("captcha") or {}
                key = captcha.get("twoCaptchaKey") if isinstance(captcha, dict) else None
                session.captcha = {"twoCaptchaKey": key} if isinstance(key, str) and key else None
            session.options = {k: body.get(k) for k in ("maxSteps", "timeoutSeconds", "allowedDomains", "vision",
                                                         "jev", "jevCanFinish", "continueMemory")}
            session.options["tuning"] = tuning or None
            run = Run(run_id, session_id, task)
            run.seq, self.run_seq = self.run_seq, self.run_seq + 1
            run.engine = body.get("engine") if body.get("engine") in ("agent", "jev-then-agent") else "agent"
            self.begin(run, session)
            return run, True


def secrets_to_sensitive_data(bindings):
    """Bro's secret bindings ({alias, allowedDomains, value}) → browser_use sensitive_data, keyed by a
    domain pattern: the agent writes <secret>alias</secret> and the value is typed only on those sites.
    `*.example.com` covers example.com and its subdomains, as a Browser Use Cloud binding did."""
    data = {}
    for binding in bindings:
        alias, value = binding.get("alias"), binding.get("value")
        if not isinstance(alias, str) or not isinstance(value, str) or not re.fullmatch(r"[a-z0-9_]{1,40}", alias):
            continue
        for domain in (binding.get("allowedDomains") or [])[:10]:
            domain = str(domain).strip().lower()
            if not re.fullmatch(r"[a-z0-9.-]{1,253}", domain) or "." not in domain:
                continue
            data.setdefault(f"https://*.{domain}", {})[alias] = value
    return data


# Focus the field a one-time code goes into, looking inside open shadow roots too (WB ID keeps its code
# boxes in a web component): the site's own full-code box (`autocomplete=one-time-code`) first, else the
# first of 4–8 one-character boxes, else a field named like a code. Typing the digits box by box raced the
# boxes' own focus moves and scrambled the code (365578 arrived as 336655); one trusted insertText does not.
FIND_CODE_FIELD = r"""(() => {
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('input')) all.push(el);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  const usable = all.filter((el) => !el.disabled && !el.readOnly && el.type !== 'hidden' && el.type !== 'password'
    && el.getClientRects().length > 0);
  const named = (el) => /otp|sms|code|pin|код/i.test([el.name, el.id, el.placeholder, el.getAttribute('aria-label')].join(' '));
  const boxes = usable.filter((el) => el.maxLength === 1);
  const field = usable.find((el) => (el.autocomplete || '').includes('one-time-code'))
    || (boxes.length >= 4 && boxes.length <= 8 ? boxes[0] : null)
    || usable.find(named);
  if (!field) return null;
  field.focus();
  if (field.value) field.select();
  return (field.autocomplete || '').includes('one-time-code') ? 'the one-time-code field'
    : field.maxLength === 1 ? 'the first of the code boxes' : 'the code field';
})()"""

# A GeeTest v4 slider puzzle on the page: the background with the gap, the piece and the knob (by their
# class names, which end in a per-page hash), and the captcha id its loader script was given.
GEETEST_STATE = r"""(() => {
  const first = re => [...document.querySelectorAll('[class*=geetest_]')]
    .find(e => re.test(e.className.toString().split(' ')[0]));
  const box = e => { if (!e) return null; const b = e.getBoundingClientRect();
    return b.width && b.height ? {x: b.x, y: b.y, w: b.width, h: b.height} : null; };
  const url = e => { const m = e && /url\("?([^")]+)"?\)/.exec(getComputedStyle(e).backgroundImage);
    return m ? m[1] : null; };
  const bg = first(/^geetest_bg_[0-9a-f]+$/), slice = first(/^geetest_slice_bg_[0-9a-f]+$/),
    btn = first(/^geetest_btn_[0-9a-f]+$/);
  const loader = [...document.scripts].map(s => s.src).find(s => /geetest\.com\/load\?.*captcha_id=/.test(s));
  const text = document.body ? document.body.innerText : '';
  return {bg: box(bg), bgUrl: url(bg), sliceUrl: url(slice), btn: box(btn),
          captchaId: loader ? new URL(loader).searchParams.get('captcha_id') : null, url: location.href,
          passed: /Проверка пройдена|Verification Success/i.test(text)};
})()"""

# The button a check page puts in front of its puzzle («Продолжить» on Avito's IP wall): its centre, to be
# pressed with a real click, since the puzzle's script ignores synthetic ones.
CHECK_BUTTON = r"""(() => {
  const button = [...document.querySelectorAll('button, a, [role=button], div')].find(e => {
    const label = (e.innerText || '').trim();
    const b = e.getBoundingClientRect();
    return /^(Продолжить|Continue|Click to verify|Нажмите, чтобы пройти проверку)$/i.test(label) && b.width > 0 && b.height > 0
      && ![...e.children].some(c => (c.innerText || '').trim() === label);
  });
  if (!button) return null;
  const b = button.getBoundingClientRect();
  return {x: b.x + b.width / 2, y: b.y + b.height / 2};
})()"""

# Where a page takes a GeeTest v4 answer: its hidden response field, the form of which is then submitted.
GEETEST_ANSWER = r"""((answer) => {
  const field = document.querySelector('input[name=captcha-response]');
  const form = field && field.closest('form');
  if (!form) return false;
  field.value = answer;
  form.dispatchEvent(new Event('submit', {cancelable: true}));
  return true;
})"""

# --- Token captchas (reCAPTCHA v2, hCaptcha, Cloudflare Turnstile, Yandex SmartCaptcha) -------------------

# A token captcha is answered by a string the site's server checks with the captcha's vendor: 2Captcha solves
# it from the widget's sitekey and the page's address, and the answer goes where the widget itself puts it
# (its hidden response field) and to the callback the page gave the widget. Opening the picture challenge
# and then its audio one got the exit flagged by reCAPTCHA (iNaturalist sign-up, RU 05.10), so the run asks
# for this first. Both scripts run in the page's own world (the callbacks live there) of one document and
# reach its same-origin frames themselves; a cross-origin frame is another target, evaluated on its own.
CAPTCHA_DOCUMENTS = r"""
  const documents = [];
  const visit = (win, depth) => {
    let doc;
    try { doc = win.document; if (!doc || !doc.documentElement) return; } catch (e) { return; }
    if (documents.some((d) => d.doc === doc)) return;
    documents.push({win, doc});
    if (depth < 5) for (let i = 0; i < Math.min(win.frames.length, 40); i++) visit(win.frames[i], depth + 1);
  };
  visit(window, 0);
  const deep = (doc, selector) => {
    const found = [];
    const walk = (root) => {
      found.push(...root.querySelectorAll(selector));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(doc);
    return found;
  };
  // The parameter objects reCAPTCHA keeps per widget (sitekey, size, callback, s) in ___grecaptcha_cfg.
  const recaptchaParams = (win) => {
    const params = [];
    let clients = null;
    try { clients = win.___grecaptcha_cfg && win.___grecaptcha_cfg.clients; } catch (e) { return params; }
    if (!clients) return params;
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || seen.has(node) || depth > 6 || seen.size > 3000) return;
      seen.add(node);
      if ('nodeType' in node || node === win) return;
      if (typeof node.sitekey === 'string') params.push(node);
      for (const key of Object.keys(node)) { try { walk(node[key], depth + 1); } catch (e) {} }
    };
    for (const id of Object.keys(clients)) walk(clients[id], 0);
    return params;
  };
"""

# What token captchas the documents hold: sitekeys from the widgets' own attributes, reCAPTCHA's config
# and the vendors' frames (whose addresses Python reads, `captcha_in_frame_url`); a reCAPTCHA v3 key is
# the one its script is loaded with (`render=<key>`), which v2 never is.
TOKEN_CAPTCHA_STATE = "(() => {" + CAPTCHA_DOCUMENTS + r"""
  const widgets = [];
  for (const {win, doc} of documents) {
    let url = '';
    try { url = String(win.location.href); } catch (e) {}
    let enterprise = false;
    try { enterprise = Boolean(win.grecaptcha && win.grecaptcha.enterprise); } catch (e) {}
    const add = (widget) => widgets.push({url, enterprise, ...widget});
    for (const el of deep(doc, '[data-sitekey]')) {
      const cls = String(el.className || '');
      add({sitekey: el.getAttribute('data-sitekey'), invisible: el.getAttribute('data-size') === 'invisible',
           hint: /h-captcha/.test(cls) ? 'hcaptcha' : /cf-turnstile/.test(cls) ? 'turnstile'
             : /smart-captcha/.test(cls) ? 'smartcaptcha' : /g-recaptcha/.test(cls) ? 'recaptcha' : null,
           s: el.getAttribute('data-s'), action: el.getAttribute('data-action'), cdata: el.getAttribute('data-cdata')});
    }
    for (const frame of deep(doc, 'iframe')) if (frame.src) add({frameUrl: frame.src});
    for (const script of doc.querySelectorAll('script[src]')) {
      const v3 = /\/recaptcha\/(api|enterprise)\.js\?(?:[^#]*&)?render=([\w-]{20,})/.exec(script.src);
      if (v3) add({sitekey: v3[2], hint: 'recaptcha', v3: true, enterprise: v3[1] === 'enterprise'});
    }
    for (const params of recaptchaParams(win)) {
      add({sitekey: params.sitekey, hint: 'recaptcha', invisible: params.size === 'invisible',
           s: typeof params.s === 'string' ? params.s : null});
    }
  }
  return {url: location.href, userAgent: navigator.userAgent, widgets};
})()"""

# Puts a solved token where the widget would (its response fields, in every document), hides a challenge
# the page still shows so the run does not go on working it, and calls the page's callbacks for that
# sitekey after this script has returned (one may submit the form and take the document away).
TOKEN_CAPTCHA_ANSWER = "((kind, sitekey, token) => {" + CAPTCHA_DOCUMENTS + r"""
  const names = {recaptcha: ['g-recaptcha-response'], hcaptcha: ['h-captcha-response', 'g-recaptcha-response'],
                 turnstile: ['cf-turnstile-response', 'g-recaptcha-response'], smartcaptcha: ['smart-token']}[kind] || [];
  let fields = 0;
  const handlers = [];
  const handler = (win, fn) => {
    if (typeof fn === 'string') {
      try { fn = fn.split('.').reduce((object, key) => (object == null ? object : object[key]), win); } catch (e) { fn = null; }
    }
    if (typeof fn === 'function' && !handlers.some((h) => h.fn === fn)) handlers.push({win, fn});
  };
  for (const {win, doc} of documents) {
    for (const el of deep(doc, 'textarea, input')) {
      const id = el.id || '';
      if (!names.includes(el.name) && !names.some((name) => id === name || id.startsWith(name + '-'))) continue;
      el.value = token;
      el.dispatchEvent(new win.Event('input', {bubbles: true}));
      el.dispatchEvent(new win.Event('change', {bubbles: true}));
      fields += 1;
    }
    for (const el of deep(doc, '[data-sitekey]')) {
      if (el.getAttribute('data-sitekey') === sitekey && el.getAttribute('data-callback')) handler(win, el.getAttribute('data-callback'));
    }
    if (kind === 'recaptcha') for (const params of recaptchaParams(win)) if (params.sitekey === sitekey) handler(win, params.callback);
    for (const frame of deep(doc, 'iframe')) {
      if (!/\/recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com\/.*frame=challenge/.test(frame.src || '')) continue;
      let box = frame;
      while (box.parentElement && box.parentElement !== doc.body) box = box.parentElement;
      box.style.visibility = 'hidden';
    }
  }
  for (const {win, fn} of handlers) win.setTimeout(() => { try { fn(token); } catch (e) {} }, 0);
  return {fields, handlers: handlers.length};
})"""


# --- Bank card forms ------------------------------------------------------------------------------------

# The model never sees a card's values, so it cannot tell which field took what: on a ЮKassa checkout it
# typed card_expiry («01/31») into both two-character boxes of the expiry and got 01/01, read the CVC's
# dots as empty and told the person their saved card was wrong (RU 04.10). `fill_card` finds the fields
# itself, in every frame of the tab (a processor's own cross-origin frame too), types each the way that
# field takes it and reads it back.
CARD_ALIASES = {"number": "card_number", "expiry": "card_expiry", "cvc": "card_cvc", "holder": "card_holder"}
CARD_KINDS = ("number", "exp", "month", "year", "cvc", "holder")

# Runs in an isolated world of one frame: lists the card fields of that document, kept in a global of the
# world for the calls that follow. A field is named by its autocomplete token, its own attributes and
# labels, or else the text right before it. Words of the rest of a checkout (a passport, a loyalty card, a
# phone, an intercom or promo code) rule a field out; a loose word («код», «ММ», «номер») counts only after
# the card number of the same document, and a cardholder field needs words about the card itself. Each
# field says how far it sits from the card number in the DOM tree, for `card_plan` to take the nearest.
FIND_CARD_FIELDS = r"""(() => {
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('input, select')) all.push(el);
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  const skipped = /^(hidden|checkbox|radio|submit|button|reset|file|image|range|color|date|datetime-local|week|time|email|search|url)$/;
  const shown = (el) => {
    if (el.disabled || el.readOnly || skipped.test(el.type || '')) return false;
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    return box.width > 2 && box.height > 2 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const fields = all.filter(shown);
  const clean = (text) => (text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const own = (el) => {
    const parts = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.title,
      el.getAttribute('data-testid'), el.getAttribute('data-qa'), el.getAttribute('data-name')];
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const node = el.getRootNode().getElementById ? el.getRootNode().getElementById(id) : null;
      if (node) parts.push(node.textContent);
    }
    for (const label of el.labels || []) parts.push(label.textContent);
    return clean(parts.filter(Boolean).join(' | '));
  };
  // The text right before the field, as a label above or beside it reads: earlier siblings first, then
  // the parent's. A sibling that is another field is passed over (the «/» between two expiry boxes); one
  // that holds other fields belongs to them and ends the search.
  const before = (el) => {
    let node = el;
    for (let depth = 0; depth < 4 && node; depth += 1, node = node.parentElement) {
      for (let sib = node.previousSibling; sib; sib = sib.previousSibling) {
        if (sib.nodeType === 1 && sib.matches('input, select')) continue;
        if (sib.nodeType === 1 && sib.querySelector('input, select')) return '';
        const text = clean(sib.nodeType === 3 ? sib.textContent : sib.innerText);
        if (/[a-zа-я]/.test(text)) return text.length <= 60 ? text : '';
      }
    }
    return '';
  };
  const word = (source) => new RegExp('(?<![a-zа-я0-9])(?:' + source + ')(?![a-zа-я0-9])');
  const strong = {
    cvc: /cvc|cvv|cvn|security.?code|securitycode|card.?verif|код безопасности|код карты|секретный код|csc(?![a-z])|(?<![a-z])cid(?![a-z])/,
    holder: /cardholder|card.?holder|holder.?name|name.?on.?card|держател|владел.{0,12}карт|имя.{0,16}карт/,
    month: /exp.{0,8}month|expmonth|card.?month|cc.?month|месяц.{0,10}(срок|оконч)/,
    year: /exp.{0,8}year|expyear|card.?year|cc.?year|год.{0,10}(срок|оконч)/,
    exp: /expir|exp.?date|expdate|cc.?exp|card.?exp|valid.?(thru|till|until|to)|срок действия|действ\S* до|дата окончания/,
    number: /card.?num|cardnumber|card.?no(?![a-z])|ccnum|cc.?number|номер карты|номер банковской карты|card number|(?<![a-z])pan(?![a-z])/,
  };
  const loose = {
    cvc: word('код|code|cvc2|cvv2'),
    month: word('month|mm|мм|месяц|мес'),
    year: word('year|yy|yyyy|гг|гггг|год'),
    exp: word('exp|срок|valid|expiry'),
    number: word('номер|number|card|карта|карты'),
  };
  const both = (text) => loose.month.test(text) && loose.year.test(text);
  // A run of 13–19 digits or mask characters: a card number's placeholder. A phone's mask is a phone.
  const digitsLike = (el) => {
    const marks = ((el.placeholder || '').match(/[\d•*x·_]/g) || []).length;
    return el.type !== 'tel' && marks >= 13 && marks <= 19 && /^[\d•*x·_\s-]+$/.test(el.placeholder);
  };
  // Fields of the rest of a checkout that read like a card's: a passport's expiry, a loyalty or gift card's
  // number, a birth month, a phone, a promo or intercom code. None of them is ever the card.
  const elsewhere = /паспорт|passport|документ|рожд|birth|участник|лояльн|loyal|бонус|bonus|подароч|gift|сертификат|certificat|frequent|телефон|phone|mobile|промо|promo|купон|coupon|скидк|discount|(?<![a-z])sms|смс|домофон|intercom|подъезд|квартир|этаж|снилс|(?<![а-я])инн(?![а-я])|полис|пассажир|passenger|транспорт|тройк/;
  const byAutocomplete = (el) => {
    const token = clean(el.getAttribute('autocomplete'));
    if (/cc-number/.test(token)) return 'number';
    if (/cc-exp-month/.test(token)) return 'month';
    if (/cc-exp-year/.test(token)) return 'year';
    if (/cc-exp/.test(token)) return 'exp';
    if (/cc-csc/.test(token)) return 'cvc';
    if (/cc-name|cc-given-name|cc-family-name/.test(token)) return 'holder';
    return null;
  };
  const strongKind = (text) => {
    if (!text) return null;
    if (strong.cvc.test(text)) return 'cvc';
    if (strong.holder.test(text)) return 'holder';
    if (strong.month.test(text)) return 'month';
    if (strong.year.test(text)) return 'year';
    if (strong.exp.test(text) || /(?<![a-zа-я])(mm|мм) ?\/ ?(yy|гг)/.test(text)) return 'exp';
    if (strong.number.test(text)) return 'number';
    return null;
  };
  const looseKind = (text) => {
    if (!text) return null;
    if (both(text)) return 'exp';
    if (loose.cvc.test(text)) return 'cvc';
    if (loose.month.test(text)) return 'month';
    if (loose.year.test(text)) return 'year';
    if (loose.exp.test(text)) return 'exp';
    if (loose.number.test(text)) return 'number';
    return null;
  };
  const optionsKind = (el) => {
    if (el.tagName !== 'SELECT') return null;
    const numbers = [...el.options].map((option) => parseInt((option.value || option.text).replace(/\D/g, ''), 10))
      .filter((value) => !Number.isNaN(value));
    const months = new Set(numbers.filter((value) => value >= 0 && value <= 12));
    if (months.size >= 12 && numbers.length <= 13) return 'month';
    const years = numbers.filter((value) => (value >= 2020 && value <= 2099) || (value >= 20 && value <= 99));
    return years.length >= 3 && years.length >= numbers.length - 1 ? 'year' : null;
  };
  const rows = fields.map((el, index) => {
    const mine = own(el), around = before(el);
    let kind = byAutocomplete(el), sure = kind !== null, auto = sure;
    if (!kind && elsewhere.test(mine + ' | ' + around)) return {el, index, kind: null, sure: false, auto};
    // A select of months or years is the card's only beside words about the card or its expiry.
    if (!kind && el.tagName === 'SELECT') kind = optionsKind(el), sure = kind !== null && /exp|срок|card|карт/.test(mine + ' ' + around);
    if (!kind && (kind = strongKind(mine))) sure = true;
    if (!kind && digitsLike(el)) kind = 'number', sure = true;
    if (!kind && (kind = (both(mine) ? 'exp' : null) || strongKind(around))) sure = kind !== 'holder' || strong.holder.test(around);
    if (!kind) kind = looseKind(mine) || (el.tagName === 'SELECT' ? optionsKind(el) : null) || looseKind(around);
    return {el, index, kind, sure, auto};
  });
  // The card number the rest is measured from: one the page marks with autocomplete first, then a named one.
  const number = rows.find((row) => row.kind === 'number' && row.auto) || rows.find((row) => row.kind === 'number' && row.sure);
  const chain = (el) => { const up = []; for (let node = el; node; node = node.parentNode || node.host) up.push(node); return up; };
  const distance = (el) => {
    if (!number) return null;
    const mine = chain(el), theirs = new Map(chain(number.el).map((node, depth) => [node, depth]));
    const shared = mine.findIndex((node) => theirs.has(node));
    return shared < 0 ? null : shared + theirs.get(mine[shared]);
  };
  const after = (el) => {
    if (!number) return false;
    const position = number.el.compareDocumentPosition(el);
    return Boolean(position & Node.DOCUMENT_POSITION_DISCONNECTED || position & Node.DOCUMENT_POSITION_FOLLOWING);
  };
  // A field nothing names, after the card number in the same document: what its length allows.
  for (const row of rows) {
    if (row.kind || !number || !after(row.el) || row.el.tagName === 'SELECT' || elsewhere.test(own(row.el))) continue;
    const max = row.el.maxLength;
    if (max === 5 || max === 7) row.kind = 'exp';
    else if (max === 2) row.kind = rows.some((other) => other.kind === 'month') ? 'year' : 'month';
    else if (max === 3 || (max === 4 && row.el.type === 'password')) row.kind = 'cvc';
    else if (row.el.type === 'password') row.kind = 'cvc';
  }
  // A loosely named field counts only after the card number of its own document; a cardholder field only
  // when named for sure.
  const kept = rows.filter((row) => row.kind && (row.sure || (row.kind !== 'holder' && after(row.el))));
  globalThis.__broCard = kept.map((row) => row.el);
  return kept.map((row, id) => ({
    id, kind: row.kind, sure: row.sure, auto: row.auto, distance: row === number ? 0 : distance(row.el),
    tag: row.el.tagName.toLowerCase(), type: row.el.type || '',
    maxLength: row.el.maxLength > 0 ? row.el.maxLength : null, placeholder: row.el.placeholder || '',
    options: row.el.tagName === 'SELECT' ? [...row.el.options].map((o) => [o.value, o.text]).slice(0, 120) : null,
  }));
})()"""

# On one field the find call above kept, in the same isolated world. Focus also moves the frame's focus,
# so the key events that follow land in it.
CARD_FIELD_FOCUS = r"""((id) => { const el = (globalThis.__broCard || [])[id]; if (!el || !el.isConnected) return false;
  el.scrollIntoView({block: 'center', inline: 'nearest'}); el.focus(); return true; })"""
CARD_FIELD_CLEAR = r"""((id) => { const el = (globalThis.__broCard || [])[id]; if (!el) return null;
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
  el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true}));
  if (el.value && el.select) el.select(); return el.value; })"""
CARD_FIELD_VALUE = r"""((id) => { const el = (globalThis.__broCard || [])[id]; return el && el.isConnected ? el.value : null; })"""
CARD_FIELD_PICK = r"""((id, wanted) => { const el = (globalThis.__broCard || [])[id]; if (!el) return null;
  const option = [...el.options].find((o) => wanted.includes(o.value.trim()) || wanted.includes(o.text.trim()));
  if (!option) return null;
  el.focus(); el.value = option.value;
  el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true}));
  el.blur(); return el.value; })"""
CARD_FIELD_BLUR = r"""((id) => { const el = (globalThis.__broCard || [])[id]; if (el) el.blur(); return true; })"""
# The pay button of the card's own form («Заплатить 2 100 ₽»), named back to the run once the card is in.
CARD_PAY_BUTTON = r"""(() => {
  const pay = /^(заплатить|оплатить|подтвердить оплату|pay\b)/i;
  for (const el of document.querySelectorAll('button, [role=button], input[type=submit], input[type=button]')) {
    const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
    const box = el.getBoundingClientRect();
    if (text && pay.test(text) && !el.disabled && box.width > 0 && box.height > 0) return text.slice(0, 60);
  }
  return null;
})()"""


def card_secrets(sensitive_data, page_url):
    """The saved card as the run's secrets hold it for this page, or None: bound to the top page's site
    and its payment processors only, the same rule browser-use applies to a typed <secret>."""
    from browser_use.utils import match_url_with_domain_pattern

    values, patterns = {}, []
    for pattern, content in (sensitive_data or {}).items():
        if isinstance(content, dict) and page_url and match_url_with_domain_pattern(page_url, pattern):
            values.update(content)
        if isinstance(content, dict) and CARD_ALIASES["number"] in content:
            patterns.append(pattern)
    number = re.sub(r"\D", "", values.get(CARD_ALIASES["number"]) or "")
    expiry = re.fullmatch(r"\s*(\d{1,2})\s*/\s*(\d{2}|\d{4})\s*", values.get(CARD_ALIASES["expiry"]) or "")
    if not 12 <= len(number) <= 19 or not expiry:
        return None
    return {"number": number, "month": f"{int(expiry[1]):02d}", "year": expiry[2][-2:],
            "cvc": re.sub(r"\D", "", values.get(CARD_ALIASES["cvc"]) or ""),
            "holder": (values.get(CARD_ALIASES["holder"]) or "").strip(), "sites": patterns}


def card_digits(value):
    return re.sub(r"\D", "", value or "")


def four_digit_year(field):
    """A year box that wants 2031, not 31."""
    placeholder = (field.get("placeholder") or "").lower()
    return (field.get("maxLength") or 0) >= 4 or bool(re.search(r"yyyy|гггг", placeholder))


def expiry_with_long_year(field):
    """A single expiry field that wants 01/2031."""
    return bool(re.search(r"yyyy|гггг", (field.get("placeholder") or "").lower()))


def card_plan(frames, card, origins=None, bound=None):
    """Which field takes what. `frames` is each frame's list from FIND_CARD_FIELDS, top document first, and
    `origins` their origins. Everything is anchored to the card number: the one the page marks with
    autocomplete, else one named for sure, in a frame on a site the card is bound to (`bound`: the shop and
    its payment processors) before any other, then in the frame that holds the most of the card. Each other kind is
    the field nearest to it in its own frame; only a kind that frame lacks comes from another frame of the
    same origin (Stripe keeps each field in a frame of its own), and only when named for sure — never from
    the shop's page around a processor's frame. Two expiry boxes (selects, or inputs of up to 4 characters)
    beside the number are its month and year. Each step: the frame, the field, the kind and the texts to try
    in turn (a select: the option values or texts it may pick)."""
    numbers = [(index, field) for index, fields in enumerate(frames) for field in fields if field["kind"] == "number"
               and field["sure"]]
    if not numbers:
        return []

    def number_rank(item):
        index, field = item
        return (not field.get("auto"), not (bound or [True] * len(frames))[index],
                -len({other["kind"] for other in frames[index]}), index)

    home, number = min(numbers, key=number_rank)
    origin = (origins or [None] * len(frames))[home]
    local = [field for field in frames[home] if field is not number]
    boxes = [field for field in local if field["kind"] == "exp"
             and (field["tag"] == "select" or 0 < (field.get("maxLength") or 0) <= 4)]
    if len(boxes) == 2 and not any(field["kind"] in ("month", "year") for field in local):
        renamed = {id(boxes[0]): "month", id(boxes[1]): "year"}
        local = [{**field, "kind": renamed[id(field)]} if id(field) in renamed else field for field in local]

    def nearest(fields):
        return min(fields, key=lambda field: (field.get("distance") is None, field.get("distance") or 0,
                                              not field["sure"], field["id"]), default=None)

    chosen = {"number": (home, number)}
    for kind in CARD_KINDS[1:]:
        field = nearest([field for field in local if field["kind"] == kind])
        if field is not None:
            chosen[kind] = (home, field)
            continue
        others = [(index, field) for index, fields in enumerate(frames) if index != home
                  and (origins or [None] * len(frames))[index] == origin
                  for field in fields if field["kind"] == kind and field["sure"]]
        if others:
            chosen[kind] = others[0]
    # One expiry field and a box beside it: both boxes are the more specific reading, a lone box is not.
    if "exp" in chosen and ("month" in chosen) != ("year" in chosen):
        chosen.pop("month", None)
        chosen.pop("year", None)
    elif "month" in chosen and "year" in chosen:
        chosen.pop("exp", None)
    elif "exp" not in chosen:
        chosen.pop("month", None)
        chosen.pop("year", None)
    month, year = card["month"], card["year"]
    steps = []
    for kind in CARD_KINDS:
        if kind not in chosen or (kind == "holder" and not card["holder"]) or (kind == "cvc" and not card["cvc"]):
            continue
        frame_index, field = chosen[kind]
        if field["tag"] == "select":
            wanted = {"month": [month, str(int(month))], "year": [f"20{year}", year]}.get(kind)
            if wanted:
                steps.append({"frame": frame_index, "field": field, "kind": kind, "pick": wanted})
            continue
        long_year = [f"{month}/20{year}", f"{month} / 20{year}", f"{month}20{year}"]
        short_year = [f"{month}/{year}", f"{month} / {year}", f"{month}{year}"]
        texts = {
            "number": [card["number"]],
            "exp": long_year + short_year if expiry_with_long_year(field) else short_year + long_year,
            "month": [month],
            "year": [f"20{year}", year] if four_digit_year(field) else [year, f"20{year}"],
            "cvc": [card["cvc"]],
            "holder": [card["holder"]],
        }[kind]
        steps.append({"frame": frame_index, "field": field, "kind": kind, "texts": texts})
    return steps


def card_value_ok(step, card, value):
    """Whether the field now holds what it should, however the page formats it. A select holds the option
    picked for it (its value may be anything: 0 for January)."""
    if value is None:
        return False
    if "pick" in step:
        return value == step.get("picked")
    kind, digits = step["kind"], card_digits(value)
    month, year = card["month"], card["year"]
    if kind == "number":
        return digits == card["number"]
    if kind == "cvc":
        return digits == card["cvc"]
    if kind == "holder":
        return re.sub(r"\s+", " ", value).strip().lower() == re.sub(r"\s+", " ", card["holder"]).lower()
    if kind == "month":
        return digits != "" and int(digits) == int(month)
    if kind == "year":
        if four_digit_year(step["field"]) and step["field"]["tag"] != "select":
            return digits == f"20{year}"
        return digits in (year, f"20{year}")
    # One expiry field: the month and the year, with a separator unless the field has room for four digits
    # only. A plain field keeps «0131» as typed, and a site reads it as no date.
    field = step["field"]
    if digits not in (f"{month}{year}", f"{month}20{year}"):
        return False
    return field.get("maxLength") in (4, 6) or not value.strip().isdigit()


CARD_KIND_NAMES = {"number": "card number", "exp": "expiry", "month": "expiry month", "year": "expiry year",
                   "cvc": "CVC", "holder": "cardholder name"}


def card_key_events(char):
    """keyDown, char and keyUp for one character, as a person's keyboard sends them."""
    if char.isdigit():
        key, code, vk = char, f"Digit{char}", ord(char)
    elif char == "/":
        key, code, vk = "/", "Slash", 191
    elif char == " ":
        key, code, vk = " ", "Space", 32
    elif char.isascii() and char.isalpha():
        key, code, vk = char, f"Key{char.upper()}", ord(char.upper())
    else:
        key, code, vk = char, "", 0
    down = {"type": "keyDown", "key": key, "code": code, "windowsVirtualKeyCode": vk}
    return [down, {"type": "char", "text": char, "key": char}, {**down, "type": "keyUp"}]


class CardFrame:
    """One frame of the tab, through the CDP session of the target that holds it (an out-of-process frame
    has its own), in an isolated world of its own: the page's scripts never see these calls."""

    def __init__(self, cdp_session, frame_id, url):
        self.cdp, self.frame_id, self.url, self.context = cdp_session, frame_id, url, None

    async def send(self, domain, method, params=None):
        return await getattr(getattr(self.cdp.cdp_client.send, domain), method)(
            params=params or {}, session_id=self.cdp.session_id)

    async def call(self, expression, *args):
        if self.context is None:
            world = await self.send("Page", "createIsolatedWorld", {"frameId": self.frame_id, "worldName": "bro-card"})
            self.context = world["executionContextId"]
        source = expression if not args else f"({expression})({', '.join(json.dumps(arg) for arg in args)})"
        answer = await self.send("Runtime", "evaluate", {"expression": source, "contextId": self.context,
                                                         "returnByValue": True})
        return (answer.get("result") or {}).get("value")

    async def type(self, text):
        for char in text:
            for event in card_key_events(char):
                await self.send("Input", "dispatchKeyEvent", event)
            await asyncio.sleep(0.03)


async def tab_frames(browser_session):
    """The frames of the agent's tab as browser-use lists them (dicts with `id`, `url`, `frameTargetId`),
    its own document first."""
    all_frames, _ = await browser_session.get_all_frames()
    tab = browser_session.agent_focus_target_id

    def root(frame):
        seen = set()
        while frame.get("parentFrameId") in all_frames and frame["id"] not in seen:
            seen.add(frame["id"])
            frame = all_frames[frame["parentFrameId"]]
        return frame

    def depth(frame):
        count = 0
        while frame.get("parentFrameId") in all_frames and count < 20:
            frame, count = all_frames[frame["parentFrameId"]], count + 1
        return count

    return [frame for frame in sorted(all_frames.values(), key=depth) if root(frame).get("frameTargetId") == tab]


async def card_frames(browser_session):
    """The frames of the agent's tab, its own document first."""
    frames = []
    for frame in await tab_frames(browser_session):
        if not str(frame.get("url", "")).startswith(("http", "about:")):
            continue
        with contextlib.suppress(Exception):
            cdp_session = await browser_session.get_or_create_cdp_session(frame["frameTargetId"], focus=False)
            frames.append(CardFrame(cdp_session, frame["id"], frame.get("url", "")))
    return frames


async def fill_card_form(frames, card):
    """Fill the card form across `frames` and say what happened, never with a value in it."""
    found = []
    for frame in frames:
        fields = None
        with contextlib.suppress(Exception):
            fields = await frame.call(FIND_CARD_FIELDS)
        found.append(fields if isinstance(fields, list) else [])
    from browser_use.utils import match_url_with_domain_pattern

    origins = [urllib.parse.urlsplit(frame.url)[:2] for frame in frames]
    bound = [any(match_url_with_domain_pattern(frame.url, site) for site in card.get("sites") or [])
             for frame in frames]
    steps = card_plan(found, card, origins, bound)
    if not steps:
        return False, ("No card number field on this page or in its frames. Open the payment step with the card "
                       "form (choose «Банковская карта» if the site asks how to pay) and call fill_card again.")
    done, failed = [], []
    typed = False  # whether any field needed typing: a second call finds the form already filled
    for step in steps:
        frame = frames[step["frame"]]
        field_id = step["field"]["id"]
        ok = False
        try:
            if "pick" in step:
                step["picked"] = await frame.call(CARD_FIELD_PICK, field_id, step["pick"])
                ok = step["picked"] is not None
            else:
                value = await frame.call(CARD_FIELD_VALUE, field_id)
                ok = card_value_ok(step, card, value)
                for text in [] if ok else step["texts"]:
                    if not await frame.call(CARD_FIELD_FOCUS, field_id):
                        break
                    if await frame.call(CARD_FIELD_VALUE, field_id):
                        await frame.call(CARD_FIELD_CLEAR, field_id)
                        if await frame.call(CARD_FIELD_VALUE, field_id):
                            await frame.send("Input", "dispatchKeyEvent", {"type": "keyDown", "key": "Backspace",
                                                                         "code": "Backspace", "windowsVirtualKeyCode": 8})
                            await frame.send("Input", "dispatchKeyEvent", {"type": "keyUp", "key": "Backspace",
                                                                         "code": "Backspace", "windowsVirtualKeyCode": 8})
                    await frame.type(text)
                    typed = True
                    await asyncio.sleep(0.2)
                    if card_value_ok(step, card, await frame.call(CARD_FIELD_VALUE, field_id)):
                        ok = True
                        break
        except Exception:  # noqa: BLE001 - a frame that navigated away or detached
            ok = False
        (done if ok else failed).append(step)
    # The last field's own checks run when it loses focus; a page may also reformat or clear a field when
    # the next one fills, so every field is read once more at the end.
    with contextlib.suppress(Exception):
        last = steps[-1]
        await frames[last["frame"]].call(CARD_FIELD_BLUR, last["field"]["id"])
    await asyncio.sleep(0.3)
    for step in list(done):
        value = None
        with contextlib.suppress(Exception):
            value = await frames[step["frame"]].call(CARD_FIELD_VALUE, step["field"]["id"])
        if not card_value_ok(step, card, value):
            done.remove(step)
            failed.append(step)
    # Part of a card number or a code left in a field that did not take it is worth nothing to the form and
    # stays on the page for anyone to read.
    for step in failed:
        with contextlib.suppress(Exception):
            await frames[step["frame"]].call(CARD_FIELD_CLEAR, step["field"]["id"])
    names = lambda items: ", ".join(CARD_KIND_NAMES[step["kind"]] for step in items)  # noqa: E731
    hosts = sorted({urllib.parse.urlsplit(frames[step["frame"]].url).hostname or "the page" for step in done})
    text = f"Filled {names(done)} (card ending {card['number'][-4:]})" + (f" in {', '.join(hosts)}" if hosts else "") + "."
    kinds = {step["kind"] for step in steps}
    if not kinds & {"exp", "month"}:
        text += " This form shows no expiry field yet."
    if "cvc" not in kinds:
        text += " This form shows no CVC field yet."
    if failed:
        # Only the whole expiry is a secret: a month or a year alone would be hidden wherever those two digits
        # show on the page (agent/lib/browser-use/secrets.ts), so a box of them is left to the person.
        aliases = [CARD_ALIASES.get({"exp": "expiry"}.get(step["kind"], step["kind"])) for step in failed
                   if step["kind"] not in ("month", "year")]
        advice = (f" Type it yourself with its secret ({', '.join(aliases)})." if aliases else "")
        if any(step["kind"] in ("month", "year") for step in failed):
            advice += " The month and year boxes have no secrets of their own: stop with NEEDS: info and say which box."
        text = (text if done else "") + f" Could not fill {names(failed)}: the field did not keep the value.{advice}"
        return False, text.strip()
    # The run cannot see a password field's value: told only «filled», it spent twelve steps trying to read the
    # CVC out of the processor's frame, and opened that frame in a tab of its own (bench of 04.10.2026).
    text += (" Each field was read back from the page after typing and holds the card's value; a CVC field shows "
             "you nothing or dots, and that is the value. Do not check or retype the fields: go on with the errand, "
             "and pay only as your task allows.")
    if not typed:
        # GPT Luna, unable to see the values, called fill_card five times in a row and never paid (harness, 05.10).
        text = (f"Every field already held the saved card (card ending {card['number'][-4:]}), read back from the "
                "page just now: nothing needed typing, and calling fill_card again changes nothing.")
    button = None
    with contextlib.suppress(Exception):
        button = await frames[steps[0]["frame"]].call(CARD_PAY_BUTTON)
    if isinstance(button, str) and button:
        text += f" The form's pay button is «{button}»: press it to pay, as your task allows."
    return True, text


def slider_gap(background_png, piece_png):
    """Where the piece fits: the x of its left edge in the background's own pixels, the background's width
    and how well it matched. The piece is matched by its edges against the background's, which finds the
    cut-out outline whatever the picture."""
    import cv2
    import numpy as np

    background = cv2.imdecode(np.frombuffer(background_png, np.uint8), cv2.IMREAD_UNCHANGED)
    piece = cv2.imdecode(np.frombuffer(piece_png, np.uint8), cv2.IMREAD_UNCHANGED)
    left = 0
    if piece.ndim == 3 and piece.shape[2] == 4:
        ys, xs = np.nonzero(piece[:, :, 3] > 40)
        piece, left = piece[ys.min():ys.max() + 1, xs.min():xs.max() + 1], int(xs.min())

    def edges(image):
        colour = image[:, :, :3] if image.ndim == 3 else image
        grey = cv2.cvtColor(colour, cv2.COLOR_BGR2GRAY) if colour.ndim == 3 else colour
        return cv2.Canny(grey, 100, 200)

    scores = cv2.matchTemplate(edges(background), edges(piece), cv2.TM_CCOEFF_NORMED)
    _, score, _, (x, _) = cv2.minMaxLoc(scores)
    return x - left, background.shape[1], float(score)


async def drag_slider(mouse, knob, distance):
    """Drag the knob `distance` CSS pixels the way a hand does: eased, a little shaky, a small overshoot
    taken back. `mouse` sends one CDP Input.dispatchMouseEvent."""
    import random

    x0, y0 = knob["x"] + knob["w"] / 2, knob["y"] + knob["h"] / 2
    await mouse({"type": "mouseMoved", "x": x0 - 30, "y": y0 + 12})
    await asyncio.sleep(0.2)
    await mouse({"type": "mouseMoved", "x": x0, "y": y0})
    await asyncio.sleep(0.15)
    await mouse({"type": "mousePressed", "x": x0, "y": y0, "button": "left", "clickCount": 1})
    overshoot, steps = random.uniform(2, 5), random.randint(28, 38)
    for k in range(1, steps + 1):
        eased = 1 - (1 - k / steps) ** 3
        await mouse({"type": "mouseMoved", "x": x0 + (distance + overshoot) * eased,
                     "y": y0 + random.uniform(-1.5, 1.5), "button": "left", "buttons": 1})
        await asyncio.sleep(random.uniform(0.012, 0.03))
    for k in range(1, 5):
        await mouse({"type": "mouseMoved", "x": x0 + distance + overshoot * (1 - k / 4), "y": y0,
                     "button": "left", "buttons": 1})
        await asyncio.sleep(random.uniform(0.04, 0.08))
    await asyncio.sleep(random.uniform(0.1, 0.25))
    await mouse({"type": "mouseReleased", "x": x0 + distance, "y": y0, "button": "left", "clickCount": 1})


async def two_captcha_geetest(http, key, page_url, captcha_id, timeout=120):
    """A GeeTest v4 answer from 2Captcha: its workers see the captcha id and the page's address, nothing
    of the person."""
    api = "https://api.2captcha.com"
    async with http.post(f"{api}/createTask", json={"clientKey": key, "task": {
            "type": "GeeTestTaskProxyless", "websiteURL": page_url, "gt": captcha_id, "version": 4,
            "initParameters": {"captcha_id": captcha_id}}}) as response:
        task = await response.json(content_type=None)
    if task.get("errorId"):
        raise RuntimeError(f"2Captcha refused the task: {task.get('errorCode')}")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        await asyncio.sleep(5)
        async with http.post(f"{api}/getTaskResult", json={"clientKey": key, "taskId": task["taskId"]}) as response:
            result = await response.json(content_type=None)
        if result.get("errorId"):
            raise RuntimeError(f"2Captcha could not solve it: {result.get('errorCode')}")
        if result.get("status") == "ready":
            return result["solution"]
    raise RuntimeError("2Captcha did not answer in time")


def puzzle_open(state):
    return bool(state and state.get("bg") and state.get("btn") and state.get("bgUrl"))


async def open_puzzle(evaluate, mouse, wait=15):
    """The open slider puzzle's state, after pressing the page's check button when none is open yet;
    "passed" when the page let the check through without one; None when no puzzle came."""
    state = await evaluate(GEETEST_STATE)
    if puzzle_open(state):
        return state
    button = await evaluate(CHECK_BUTTON)
    if button:
        for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
            await mouse({"type": kind, "x": button["x"], "y": button["y"], "button": "left", "clickCount": 1})
            await asyncio.sleep(0.1)
    for _ in range(wait):
        await asyncio.sleep(1)
        state = await evaluate(GEETEST_STATE)
        if puzzle_open(state):
            return state
        if state and state.get("passed"):
            return "passed"
    return None


async def solve_slider(evaluate, mouse, http, two_captcha_key=None, attempts=2):
    """Get a page past its GeeTest v4 slider check and say how it went. The check button is pressed when
    the puzzle is not open yet. The piece is found in the puzzle's own pictures and dragged into place
    (free, a few seconds); a puzzle that is still there after `attempts` drags goes to 2Captcha when Bro
    gave a key, whose answer is put where the page's own success handler puts it. `evaluate` runs page
    JavaScript and returns its value; `mouse` sends one mouse event."""
    state = await open_puzzle(evaluate, mouse)
    if state == "passed":
        await asyncio.sleep(6)
        return True, "The check passed without a puzzle; the page is moving on."
    if state is None:
        return False, NO_SLIDER
    for _ in range(attempts):
        try:
            async with http.get(state["bgUrl"]) as response:
                background = await response.read()
            async with http.get(state["sliceUrl"]) as response:
                piece = await response.read()
            x, natural_width, _score = slider_gap(background, piece)
            distance = x * state["bg"]["w"] / natural_width
        except Exception as error:  # an image that would not load or decode: the next way is tried
            log.warning("slider puzzle not read: %s", error)
            break
        if 5 < distance < state["bg"]["w"]:
            await drag_slider(mouse, state["btn"], distance)
            await asyncio.sleep(4)
        after = await evaluate(GEETEST_STATE)
        if not puzzle_open(after):
            await asyncio.sleep(6)  # the page's own handler sends the answer and moves on
            return True, "The puzzle was accepted; the page is moving on."
        state = after  # a missed drag brings a new picture
    if two_captcha_key and state.get("captchaId"):
        try:
            answer = await two_captcha_geetest(http, two_captcha_key, state["url"], state["captchaId"])
        except Exception as error:
            return False, f"The puzzle was not accepted, and the solving service failed: {error}"
        placed = await evaluate(f"{GEETEST_ANSWER}({json.dumps(json.dumps({**answer, 'captcha_id': state['captchaId']}))})")
        if placed:
            await asyncio.sleep(6)
            return True, "The solving service's answer was sent; check that the page moved on."
        return False, "The service solved the puzzle, but this page has no field to take its answer."
    return False, "The puzzle was not accepted."


TWO_CAPTCHA_API = "https://api.2captcha.com"
# How long solve_captcha waits for a token from 2Captcha, both tasks together: it takes 15–90 s, and the
# action has to end inside browser-use's step timeout (180 s) with the model's own call in that step.
TOKEN_SOLVE_S = 120
TOKEN_POLL_S = 5
TOKEN_TASKS = 2  # a second task only after a proxy the service could not use, or an unsolvable answer
TOKEN_RETRIED = ("ERROR_CAPTCHA_UNSOLVABLE", "ERROR_NO_SLOT_AVAILABLE")
CAPTCHA_NAMES = {"recaptcha": "reCAPTCHA", "hcaptcha": "hCaptcha", "turnstile": "Cloudflare Turnstile check",
                 "smartcaptcha": "Yandex SmartCaptcha"}
RECAPTCHA_HOSTS = {"www.google.com", "google.com", "www.recaptcha.net", "recaptcha.net", "recaptcha.google.com"}
SITEKEY = re.compile(r"^[\w-]{20,100}$")
TURNSTILE_KEY = re.compile(r"^0x[\w-]{16,}$")
HCAPTCHA_KEY = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SMARTCAPTCHA_HOST = "smartcaptcha.yandexcloud.net"
SMARTCAPTCHA_KEY = re.compile(r"^ysc\d_[\w-]+$")
SOLVER_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
NO_SLIDER = "No slider puzzle opened on this page: its check is of another kind."
V3_UNSUPPORTED = ("This page uses reCAPTCHA v3, which scores the browser without any puzzle: solve_captcha "
                  "cannot answer it.")
NO_CAPTCHA = ("No captcha solve_captcha can answer is on this page (it answers reCAPTCHA v2, hCaptcha, Cloudflare "
              "Turnstile, Yandex SmartCaptcha and slider puzzles): the check is of another kind.")


class SolverRefused(Exception):
    """2Captcha's error code for a task: only the code, which never carries the key or an answer."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def solver_code(answer):
    code = answer.get("errorCode") if isinstance(answer, dict) else None
    return code if isinstance(code, str) and SOLVER_CODE.match(code) else "ERROR_UNKNOWN"


def captcha_in_frame_url(url):
    """The token captcha a vendor's frame belongs to, by the frame's address: {kind, sitekey, ...}, or None."""
    try:
        parsed = urllib.parse.urlsplit(str(url))
        host = (parsed.hostname or "").lower()
    except ValueError:
        return None
    query = urllib.parse.parse_qs(parsed.query)
    if host in RECAPTCHA_HOSTS:
        match = re.search(r"/recaptcha/(api2|enterprise)/(anchor|bframe)", parsed.path)
        if not match:
            return None
        return {"kind": "recaptcha", "sitekey": (query.get("k") or [None])[0],
                "invisible": (query.get("size") or [""])[0] == "invisible", "enterprise": match.group(1) == "enterprise"}
    if host == "hcaptcha.com" or host.endswith(".hcaptcha.com"):
        fragment = urllib.parse.parse_qs(parsed.fragment)
        key = (fragment.get("sitekey") or query.get("sitekey") or [None])[0]
        return {"kind": "hcaptcha", "sitekey": key, "invisible": (fragment.get("size") or [""])[0] == "invisible"} \
            if key else None
    if host == SMARTCAPTCHA_HOST:
        key = (query.get("sitekey") or [None])[0]
        return {"kind": "smartcaptcha", "sitekey": key} if key else None
    if host == "challenges.cloudflare.com" and "/turnstile/" in parsed.path:
        key = next((part for part in parsed.path.split("/") if TURNSTILE_KEY.match(part)), None)
        return {"kind": "turnstile", "sitekey": key} if key else None
    return None


def captcha_vendor_frame(url):
    """Whether a frame is a captcha vendor's own (its widget or challenge): never evaluated in."""
    try:
        host = (urllib.parse.urlsplit(str(url)).hostname or "").lower()
    except ValueError:
        return False
    return (host in RECAPTCHA_HOSTS or host == "hcaptcha.com" or host.endswith(".hcaptcha.com")
            or host == "challenges.cloudflare.com" or host == SMARTCAPTCHA_HOST)


def sitekey_kind(sitekey, hint):
    if hint in CAPTCHA_NAMES:
        return hint
    if TURNSTILE_KEY.match(sitekey):
        return "turnstile"
    if SMARTCAPTCHA_KEY.match(sitekey):
        return "smartcaptcha"
    return "hcaptcha" if HCAPTCHA_KEY.match(sitekey) else "recaptcha"


def pick_token_captcha(states, frame_urls, page_url):
    """The token captcha to solve from what the documents (`states`, TOKEN_CAPTCHA_STATE) and the tab's
    frame addresses show: {kind, sitekey, url, invisible, enterprise, v3, s, action, cdata}, a widget one
    can see before an invisible one; None when there is none."""
    top = next((s.get("url") for s in states if isinstance(s.get("url"), str)), None)
    fallback = top if str(top or "").startswith("http") else page_url
    found = {}
    sightings = [w for s in states for w in (s.get("widgets") or []) if isinstance(w, dict)]
    sightings += [{"frameUrl": url} for url in frame_urls]
    for sighting in sightings:
        if sighting.get("frameUrl"):
            framed = captcha_in_frame_url(sighting["frameUrl"])
            if not framed:
                continue
            sighting = {**{k: v for k, v in sighting.items() if k != "frameUrl"}, **framed, "hint": framed["kind"]}
        key = sighting.get("sitekey")
        if not isinstance(key, str) or not SITEKEY.match(key):
            continue
        kind = sitekey_kind(key, sighting.get("hint"))
        widget = found.setdefault((kind, key), {"kind": kind, "sitekey": key, "url": None, "invisible": False,
                                                "enterprise": False, "v3": False})
        url = sighting.get("url")
        if widget["url"] is None and isinstance(url, str) and url.startswith("http"):
            widget["url"] = url
        for flag in ("invisible", "enterprise", "v3"):
            widget[flag] = widget[flag] or sighting.get(flag) is True
        for field in ("s", "action", "cdata"):
            if isinstance(sighting.get(field), str) and sighting[field] and len(sighting[field]) < 4000:
                widget.setdefault(field, sighting[field])
    for widget in found.values():
        widget["url"] = widget["url"] or fallback
    widgets = [w for w in found.values() if w["url"]]
    widgets.sort(key=lambda w: (w["v3"], w["invisible"]))
    return widgets[0] if widgets else None


def solver_proxy(upstream):
    """The run's own exit for 2Captcha's proxy tasks, from the forwarder's upstream: the token then comes
    from the address the site sees the browser on. None when there is none the service could reach."""
    if not upstream:
        return None
    host, port, auth = upstream
    with contextlib.suppress(ValueError):
        if not ipaddress.ip_address(host).is_global:
            return None
    proxy = {"proxyType": "http", "proxyAddress": str(host), "proxyPort": int(port)}
    if auth:
        login, _, password = base64.b64decode(auth).decode().partition(":")
        proxy.update(proxyLogin=login, proxyPassword=password)
    return proxy


def token_task(widget, proxy=None, user_agent=None):
    """2Captcha's task for a token captcha, the proxy variant when `proxy` is given."""
    kind = widget["kind"]
    enterprise = kind == "recaptcha" and widget.get("enterprise")
    name = {"recaptcha": "RecaptchaV2EnterpriseTask" if enterprise else "RecaptchaV2Task",
            "hcaptcha": "HCaptchaTask", "turnstile": "TurnstileTask", "smartcaptcha": "YandexSmartCaptchaTask"}[kind]
    task = {"type": name if proxy else f"{name}Proxyless", "websiteURL": widget["url"], "websiteKey": widget["sitekey"]}
    if kind in ("recaptcha", "hcaptcha") and widget.get("invisible"):
        task["isInvisible"] = True
    if kind == "recaptcha" and widget.get("s"):
        task.update({"enterprisePayload": {"s": widget["s"]}} if enterprise else {"recaptchaDataSValue": widget["s"]})
    if kind == "turnstile":
        task.update({k: widget[f] for k, f in (("action", "action"), ("data", "cdata")) if widget.get(f)})
    if user_agent:
        task["userAgent"] = user_agent
    return {**task, **(proxy or {})}


async def two_captcha_task(http, key, task):
    """Run one 2Captcha task to its token; SolverRefused with the service's code when it gives none."""
    async with http.post(f"{TWO_CAPTCHA_API}/createTask", json={"clientKey": key, "task": task}) as response:
        created = await response.json(content_type=None)
    if not isinstance(created, dict) or created.get("errorId") or not created.get("taskId"):
        raise SolverRefused(solver_code(created))
    while True:
        await asyncio.sleep(TOKEN_POLL_S)
        async with http.post(f"{TWO_CAPTCHA_API}/getTaskResult",
                             json={"clientKey": key, "taskId": created["taskId"]}) as response:
            result = await response.json(content_type=None)
        if not isinstance(result, dict) or result.get("errorId"):
            raise SolverRefused(solver_code(result))
        if result.get("status") == "ready":
            solution = result.get("solution") if isinstance(result.get("solution"), dict) else {}
            token = solution.get("gRecaptchaResponse") or solution.get("token")
            if not isinstance(token, str) or not 0 < len(token) <= 20000:
                raise SolverRefused("ERROR_EMPTY_ANSWER")
            return token


async def two_captcha_token(http, key, widget, proxy=None, user_agent=None):
    """A token for `widget`, through the run's exit first: a proxy the service could not use is dropped for
    the second task, and an answer it found unsolvable is asked for once more. At most TOKEN_TASKS tasks."""
    for task_number in range(1, TOKEN_TASKS + 1):
        try:
            return await two_captcha_task(http, key, token_task(widget, proxy, user_agent))
        except SolverRefused as refused:
            if task_number == TOKEN_TASKS:
                raise
            if "PROXY" in refused.code and proxy:
                log.warning("2Captcha could not use the run's proxy (%s); asking without it", refused.code)
                proxy = None
            elif refused.code not in TOKEN_RETRIED:
                raise
    raise SolverRefused("ERROR_UNKNOWN")


async def solve_token_captcha(worlds, frame_urls, page_url, http, key, proxy=None):
    """Answer the reCAPTCHA v2, hCaptcha or Turnstile check of the page through 2Captcha and say how it went:
    (solved, message), or None when the page has no such check. `worlds` evaluate page JavaScript in the
    main world of each document the tab holds out of process; `frame_urls` are all its frames' addresses.
    The message never holds the key or the token."""
    states = []
    for evaluate in worlds:
        with contextlib.suppress(Exception):
            state = await asyncio.wait_for(evaluate(TOKEN_CAPTCHA_STATE), 10)
            if isinstance(state, dict):
                states.append(state)
    widget = pick_token_captcha(states, frame_urls, page_url)
    if widget is None:
        return None
    name = CAPTCHA_NAMES[widget["kind"]]
    if widget["v3"]:
        return False, V3_UNSUPPORTED
    if not key:
        return False, f"The page has a {name}, but this browser has no key for the solving service."
    user_agent = next((s["userAgent"] for s in states if isinstance(s.get("userAgent"), str)), None)
    try:
        token = await asyncio.wait_for(two_captcha_token(http, key, widget, proxy, user_agent), TOKEN_SOLVE_S)
    except asyncio.TimeoutError:
        return False, f"The solving service did not solve the page's {name} in time."
    except SolverRefused as refused:
        return False, f"The solving service could not solve the page's {name} ({refused.code})."
    except Exception as error:  # the service unreachable or answering nonsense: named by type only
        return False, f"The solving service could not be reached for the page's {name} ({type(error).__name__})."
    fields = handlers = 0
    answer = f"{TOKEN_CAPTCHA_ANSWER}({json.dumps(widget['kind'])}, {json.dumps(widget['sitekey'])}, {json.dumps(token)})"
    for evaluate in worlds:
        with contextlib.suppress(Exception):
            placed = await asyncio.wait_for(evaluate(answer), 10)
            if isinstance(placed, dict):
                fields += int(placed.get("fields") or 0)
                handlers += int(placed.get("handlers") or 0)
    if not fields and not handlers:
        return False, f"The solving service solved the page's {name}, but the page has no field to take its answer."
    await asyncio.sleep(3)  # a callback may submit the form or move the page on by itself
    return True, (f"The page's {name} is solved: its answer is in the page. Do not tick the check, open its "
                  "pictures or audio, or call solve_captcha again: submit the form now (press its button unless "
                  "the page has already moved on) and check that it went through.")


async def solve_page_captcha(evaluate, mouse, http, key, token_check):
    """solve_captcha: the page's GeeTest slider when it shows one, else its token captcha (`token_check()`,
    solve_token_captcha for the page), else the slider's way, which presses a check button first — not
    before the token captcha, since on a sign-up form that button would submit it. A page whose only
    captcha is reCAPTCHA v3 (sites load it everywhere) still gets the slider's way."""
    state = await evaluate(GEETEST_STATE)
    answered = None
    if not (puzzle_open(state) or (state or {}).get("captchaId")):
        try:
            answered = await token_check()
        except Exception as error:  # the page could not be read for one: the slider's way is tried
            log.warning("token captcha not looked for: %s", type(error).__name__)
        if answered is not None and answered[1] != V3_UNSUPPORTED:
            return answered
    solved, message = await solve_slider(evaluate, mouse, http, key)
    if message == NO_SLIDER:
        return False, answered[1] if answered else NO_CAPTCHA
    return solved, message


async def captcha_worlds(browser_session):
    """Main-world `evaluate`s of the agent's tab — its own document and each out-of-process frame of it but a
    captcha vendor's (a same-process frame is reached from its parent) — and the addresses of all its frames."""
    worlds, targets, urls = [], set(), []
    for frame in await tab_frames(browser_session):
        url = str(frame.get("url", ""))
        urls.append(url)
        target = frame.get("frameTargetId")
        if not target or target in targets:
            continue
        targets.add(target)
        if captcha_vendor_frame(url) or not url.startswith(("http", "about:")):
            continue
        with contextlib.suppress(Exception):
            worlds.append(main_world(await browser_session.get_or_create_cdp_session(target, focus=False)))
    return worlds, urls


def main_world(cdp_session):
    async def evaluate(expression):
        answer = await cdp_session.cdp_client.send.Runtime.evaluate(
            params={"expression": expression, "returnByValue": True}, session_id=cdp_session.session_id)
        return (answer.get("result") or {}).get("value")

    return evaluate

EXTEND_SYSTEM = """
Workspace: a file you are asked to save under report/ is saved with the save_screenshot action (a whole
visible page, e.g. report/final.png) or save_element_picture (one item photo, by element index). Never
use web archives, caches or mirrors (web.archive.org and the like) instead of the live site: if the live
site does not open, say so. Credentials and codes come as <secret>alias</secret> placeholders: type the
placeholder itself into the field; the browser types the real value only on the site it belongs to. A
one-time code you are given goes in with the enter_code action, never digit by digit. A bank card form goes in
with the fill_card action, never field by field; type a card secret yourself only into a field fill_card
says it could not fill. A phone field that already shows a country code (+7) or a mask keeps it: type only
the digits after it, never the +7 or 8 again (for +7 921 781-88-76, type 9217818876). Read a form back after
filling it: a phone with a doubled 7, extra digits or another country's flag was typed wrong, so type it again
that way rather than hunting the country list. When a form's button seems to do nothing, read the errors the
form shows before pressing it again. Fields fill_card filled may still look empty to you, since the browser hides
secret values from your view of the page: trust its answer and press the form's pay button when the request
allows paying. Call done only when the request is finished or one of its rules tells you to stop; while the page
offers the next step of what you were asked to do (a suggestion to pick, a store to choose, «К оплате»,
«Оплатить»), take that step instead. An anti-bot check
page with a slider puzzle (drag a piece into its gap) goes to the solve_captcha action, which presses its
button and solves it; never press or drag it yourself. A reCAPTCHA («I'm not a robot»), hCaptcha,
Cloudflare Turnstile or Yandex SmartCaptcha check goes to solve_captcha as well, before you tick it or open its pictures; never ask
for its audio challenge, which gets this network address flagged. Once solve_captcha says the check is
solved, leave the check alone and submit the form. To read a long list
or table, prefer one evaluate call that returns the data (wrap the code in an async IIFE:
(async () => { ... })()) over scrolling and reading it screen by screen, and take each option's link (the
href of its anchor) in that same call rather than hunting for the links one find_elements call at a time.
When the request asks your final answer to end with labelled lines (RESULT:, NEEDS:, LINKS:, ITEMS: and
the rest), the text of your done action ends with every one of them, after the report.
""".strip()


# --- HTTP ----------------------------------------------------------------------------------------------

worker = None


def token_from(request):
    header = request.headers.get("Authorization", "")
    return header.removeprefix("Bearer ").strip() if header.startswith("Bearer ") else ""


def authorize(request, token=None):
    try:
        payload = verify_token(token or token_from(request), worker.config, worker.generation)
    except Unauthorized as error:
        raise web.HTTPUnauthorized(text=json.dumps({"error": str(error)}), content_type="application/json")
    worker.accept_generation(payload.get("gen", 0))
    return payload


def machine():
    """Memory, load and disk of the VM: sizing the flavor and the disk is done from these."""
    info = {}
    with contextlib.suppress(Exception):
        meminfo = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        kib = lambda key: int(meminfo[key].split()[0])  # noqa: E731
        info["memoryMb"] = {"total": kib("MemTotal") // 1024, "available": kib("MemAvailable") // 1024}
    with contextlib.suppress(Exception):
        info["load"] = [float(x) for x in Path("/proc/loadavg").read_text().split()[:3]]
    with contextlib.suppress(Exception):
        usage = shutil.disk_usage("/")
        info["diskGb"] = {"total": round(usage.total / 2**30, 1), "used": round(usage.used / 2**30, 1)}
    return info


def profile_mb():
    """Size of the Chrome profile: its caches hold tens of thousands of files, a fraction of a second's walk."""
    try:
        return round(sum(f.stat().st_size for f in PROFILE.rglob("*") if f.is_file()) / 2**20, 1)
    except OSError:  # a file Chrome removed during the walk
        return None


async def health(request):
    details = {}
    if request.query.get("machine"):
        authorize(request)  # the details cost a walk of the profile: not for anyone who has the address
        details = {**machine(), "profileMb": await worker.profile_size()}
    stage_file = ROOT / "stage"
    return web.json_response({
        "worker": VERSION, "image": IMAGE_FILE.read_text().strip() if IMAGE_FILE.exists() else None,
        "configured": worker.config is not None, "uptimeSeconds": float(Path("/proc/uptime").read_text().split()[0]),
        "chrome": await chrome_ready(), "busy": worker.busy(), "proxy": worker.forwarder.upstream is not None,
        "stage": stage_file.read_text().strip() if stage_file.exists() else None, "generation": worker.generation,
        **details,
    })


async def configure_session(request):
    authorize(request)
    body = await request.json()
    proxy = body.get("proxy")
    if not isinstance(proxy, dict) or not proxy.get("host") or not proxy.get("port"):
        raise web.HTTPBadRequest(text="proxy {host, port, username?, password?} is required")
    worker.forwarder.configure(proxy)
    proxy_url = f"http://127.0.0.1:{FORWARD_PORT}"
    async with aiohttp.ClientSession() as http:
        try:
            started = time.monotonic()
            async with http.get("https://ipinfo.io/json", proxy=proxy_url, timeout=aiohttp.ClientTimeout(total=20)) as response:
                data = await response.json(content_type=None)
            exit_address = {k: data.get(k) for k in ("ip", "city", "region", "country", "org")}
            exit_address["latencyMs"] = round((time.monotonic() - started) * 1000)
        except Exception as error:  # `error` means no address
            exit_address = {"error": f"{type(error).__name__}: {error}"[:300]}
        else:
            # Residential exits differ tenfold in speed (the same Wildberries page took 3 s through one and
            # 70 s through another): measure a megabyte so Bro can move a slow exit before the errand. A
            # megabyte that did not come through leaves the address standing, with its speed unknown.
            try:
                started = time.monotonic()
                async with http.get("https://speed.cloudflare.com/__down?bytes=1000000", proxy=proxy_url,
                                    timeout=aiohttp.ClientTimeout(total=25)) as response:
                    size = len(await response.read())
                exit_address["mbps"] = round(size * 8 / 1e6 / max(time.monotonic() - started, 0.001), 2)
            except Exception as error:
                exit_address["speedError"] = f"{type(error).__name__}: {error}"[:300]
    if not await chrome_ready():
        await systemctl("start")
        await wait_chrome(30)
    return web.json_response({"exit": exit_address, "vmAddress": worker.vm_address, "chrome": await chrome_ready(),
                              "traffic": worker.forwarder.totals})


async def list_runs(request):
    authorize(request)
    line = request.query.get("contains")
    runs = sorted(worker.runs.values(), key=lambda r: r.created_at, reverse=True)
    if line:
        runs = [r for r in runs if line in r.task.split("\n")]
    return web.json_response({"runs": [{k: v for k, v in r.public().items() if k != "steps"} for r in runs[:50]]})


async def create_run(request):
    authorize(request)
    run, created = await worker.start_run(await request.json())
    return web.json_response({"id": run.id, "sessionId": run.session_id, "status": run.status},
                             status=202 if created else 200)


def find_run(request):
    run = worker.runs.get(request.match_info["run_id"])
    if run is None:
        raise web.HTTPNotFound(text=json.dumps({"error": "no such run"}), content_type="application/json")
    return run


async def read_run(request):
    authorize(request)
    return web.json_response(find_run(request).public())


async def cancel_run(request):
    authorize(request)
    run = find_run(request)
    if run.status not in TERMINAL:
        run.cancel_requested = True
        if run.agent is not None:
            with contextlib.suppress(Exception):
                run.agent.stop()
        # The agent stops once its step ends: the answer waits for that (bounded), so it reads cancelled
        # and a start in the same session right after it is not refused as busy.
        deadline = time.monotonic() + CANCEL_WAIT_S
        while run.status not in TERMINAL and time.monotonic() < deadline:
            await asyncio.sleep(0.2)
        # A step that did not end by then hangs: it is cut off rather than left to hold the browser.
        if run.status not in TERMINAL:
            await worker.cut_off(run)
            while run.status not in TERMINAL and time.monotonic() < deadline + UNWIND_S:
                await asyncio.sleep(0.2)
    return web.json_response(run.public())


def find_session(request):
    session = worker.sessions.get(request.match_info["session_id"])
    if session is None:
        raise web.HTTPNotFound(text=json.dumps({"error": "no such session"}), content_type="application/json")
    return session


async def read_session(request):
    authorize(request)
    session = find_session(request)
    latest = worker.runs.get(session.latest_run_id)
    status = "idle" if latest is None or latest.status in TERMINAL else "running"
    return web.json_response({"id": session.id, "latestRunId": session.latest_run_id, "status": status,
                              "tabOpen": session.tab is not None and not session.released})


async def session_message(request):
    """A message into a session: joins its live run (read before the agent's next step; one the run ends
    without reading is recorded on its terminal record as `unreadMessages`, for Bro to act on — the
    worker itself never starts a follow-up), or, when the session is idle — including right after its
    latest run went terminal — becomes a follow-up run in the same tab with the same memory (Browser
    Use's "idle session drains the message into a new run"), 409 if another run holds the browser. A run
    being cancelled reads nothing more: the message is refused as busy."""
    authorize(request)
    session = find_session(request)
    body = await request.json()
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise web.HTTPBadRequest(text="text is required")
    latest = worker.runs.get(session.latest_run_id)
    if latest is not None and latest.status not in TERMINAL:
        if latest.cancel_requested:
            raise web.HTTPConflict(text=json.dumps({"error": "busy", "runId": latest.id}),
                                   content_type="application/json")
        latest.messages.append(text)
        return web.json_response({"sessionId": session.id, "status": "queued", "runId": latest.id})
    llm = body.get("llm") or session.llm
    if llm is None:  # the worker restarted since the session's last run and forgot its model
        raise web.HTTPConflict(text=json.dumps({"error": "session has no model; start a run"}),
                               content_type="application/json")
    # Bro's `tuning` goes with the message, as `llm` does: a worker that restarted since the session's last
    # run forgot the session's own, and the follow-up would run unrouted, its hidden reasoning back on.
    run, _ = await worker.start_run({"id": body.get("runId") or f"{session.id[:40]}-{uuid.uuid4().hex[:12]}",
                                     "sessionId": session.id, "task": text, "llm": llm,
                                     **{k: v for k, v in session.options.items() if v is not None},
                                     **({"tuning": body["tuning"]} if "tuning" in body else {})})
    return web.json_response({"sessionId": session.id, "status": "started", "runId": run.id})


DIRECT_ACTIONS = {"click", "input", "scroll", "send_keys", "select_dropdown", "go_back", "navigate", "enter_code",
                  "save_screenshot"}


def direct_session(request):
    """Direct operations may open a session of their own (Bro drives the page without an agent)."""
    session_id = safe_id(request.match_info["session_id"])
    return worker.sessions.setdefault(session_id, Session(session_id))


async def open_page(request):
    authorize(request)
    session = direct_session(request)
    body = await request.json()
    url = body.get("url")
    if not isinstance(url, str) or not re.match(r"^https?://", url):
        raise web.HTTPBadRequest(text="url must be http(s)")
    started = time.monotonic()
    browser = await worker.direct_browser(session)
    before = await page_ids()
    await browser.navigate_to(url)
    await worker.follow_focus(session, browser, before)
    return web.json_response({"url": await browser.get_current_page_url(), "title": await browser.get_current_page_title(),
                              "ms": round((time.monotonic() - started) * 1000)})


async def page_state(request):
    """What the page offers right now: address, title and the indexed interactive elements an action
    refers to (browser-use's own page representation, the same an agent step sees)."""
    authorize(request)
    session = direct_session(request)
    browser = await worker.direct_browser(session)
    started = time.monotonic()
    state = await browser.get_browser_state_summary(include_screenshot=False)
    text = state.dom_state.llm_representation()
    return web.json_response({"url": state.url, "title": state.title, "elements": len(state.dom_state.selector_map),
                              "page": text[:30000], "truncated": len(text) > 30000,
                              "ms": round((time.monotonic() - started) * 1000)})


async def page_action(request):
    """One action on the last state's element indexes: click, input, select_dropdown, scroll, send_keys,
    go_back or navigate. Secrets typed as <secret>alias</secret> are resolved on their own sites only."""
    authorize(request)
    session = direct_session(request)
    body = await request.json()
    action, params = body.get("action"), body.get("params") or {}
    if action not in DIRECT_ACTIONS or not isinstance(params, dict):
        raise web.HTTPBadRequest(text=f"action must be one of {sorted(DIRECT_ACTIONS)}")
    browser = await worker.direct_browser(session)
    started = time.monotonic()
    before = await page_ids()
    result = await worker.tools(session, None).registry.execute_action(
        action, params, browser_session=browser, sensitive_data=session.sensitive_data or None)
    await worker.follow_focus(session, browser, before)
    return web.json_response({"error": getattr(result, "error", None),
                              "content": (getattr(result, "extracted_content", None) or "")[:5000],
                              "url": await browser.get_current_page_url(),
                              "ms": round((time.monotonic() - started) * 1000)})


async def page_screenshot(request):
    authorize(request)
    session = direct_session(request)
    if not session.tab:
        raise web.HTTPNotFound(text="the session has no tab")
    return web.Response(body=await screenshot(session.tab, int(request.query.get("quality", "80"))),
                        content_type="image/jpeg")


async def release_session(request):
    authorize(request)
    session = find_session(request)
    latest = worker.runs.get(session.latest_run_id)
    if latest is not None and latest.status not in TERMINAL:
        return web.json_response({"status": "running"})
    await worker.release_direct(session)
    for tab in session.tabs | ({session.tab} if session.tab else set()):
        await close_tab(tab)
    session.tab, session.tabs, session.released = None, set(), True
    worker.save_tabs()
    if not await page_targets():
        with contextlib.suppress(Exception):
            await new_tab()  # Chrome quits with its last tab
    return web.json_response({"status": "stopped"})


async def list_files(request):
    authorize(request)
    session = worker.sessions.get(request.query.get("session", ""))
    if session is None:
        return web.json_response({"files": []})
    prefix = request.query.get("prefix", "")
    root = session.workspace
    files = []
    for path in root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if path.is_file() and relative.startswith(prefix) and not relative.startswith("agent-files/"):
            stat = path.stat()
            files.append({"path": relative, "size": stat.st_size,
                          "lastModified": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime))})
    files.sort(key=lambda f: f["lastModified"], reverse=True)
    return web.json_response({"files": files[:100]})


async def read_file(request, authorized=False):
    if not authorized:
        authorize(request)
    session = find_session(request)
    root = session.workspace.resolve()
    path = (root / request.match_info["path"]).resolve()
    if root not in path.parents or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def download(request):
    """A file by a URL alone: the token in the path is scoped to the session (Bro fetches report images
    with a plain GET, as it did Browser Use's presigned URLs)."""
    token = request.match_info["token"]
    scope = authorize(request, token).get("ses")
    session_id = request.match_info["session_id"]
    if scope != session_id:
        raise web.HTTPForbidden()
    return await read_file(request, authorized=True)


async def open_tab(request):
    authorize(request)
    target = await new_tab()
    worker.visit_tabs.add(target)  # not a tab an errand's agent opened, even if one is running
    return web.json_response({"targetId": target})


async def delete_tab(request):
    authorize(request)
    target = request.match_info["target"]
    if any(target == session.tab or target in session.tabs for session in worker.sessions.values()):
        raise web.HTTPConflict(text=json.dumps({"error": "an errand's tab"}), content_type="application/json")
    await close_tab(target)
    worker.visit_tabs.discard(target)
    if not await page_targets():
        with contextlib.suppress(Exception):
            await new_tab()
    return web.json_response({"closed": target})


async def upload(request):
    authorize(request)
    name = request.match_info["name"]
    if not FILE_NAME.match(name):
        raise web.HTTPBadRequest(text="bad name")
    UPLOADS.mkdir(parents=True, exist_ok=True)
    data = await request.read()
    if len(data) > 50 * 1024 * 1024:
        raise web.HTTPRequestEntityTooLarge(max_size=50 * 1024 * 1024, actual_size=len(data))
    (UPLOADS / name).write_bytes(data)
    return web.json_response({"path": str(UPLOADS / name), "size": len(data)})


async def browser_action(request):
    authorize(request)
    action = request.match_info["action"]
    if worker.busy() and action != "start":
        raise web.HTTPConflict(text=json.dumps({"error": "busy"}), content_type="application/json")
    code, output = await systemctl(action)
    ready = await wait_chrome(30) if action != "stop" else False
    if action != "start":
        for session in worker.sessions.values():
            session.tab, session.tabs = None, set()
        worker.save_tabs()
    return web.json_response({"rc": code, "chrome": ready, "output": output})


async def update_worker(request):
    """Replace this worker's own code (Bro rolls a fix out to VMs that were created from an older image;
    their disks carry the person's profile, so they are not re-created for a code change). The body is
    the new worker.py; it must match `X-Content-Sha256` and load (`LOAD_CHECK`: an import that fails would
    crash-loop the VM's only way in; it runs top-level code only, and a candidate with `CANDIDATE_IMPORTS`
    checks its lazy imports there too), and the worker must be idle. The code it replaces stays as
    `PREVIOUS_CODE` until the new code is up. The worker then exits and systemd starts the new code."""
    authorize(request)
    if worker.busy() or worker.restarting:
        raise web.HTTPConflict(text=json.dumps({"error": "busy"}), content_type="application/json")
    source = await request.read()
    if hashlib.sha256(source).hexdigest() != request.headers.get("X-Content-Sha256", ""):
        raise web.HTTPBadRequest(text="checksum mismatch")
    candidate = CODE.with_suffix(".new")
    candidate.write_bytes(source)
    # From the code's folder, which `python worker.py` puts first on the import path, as `-c` puts the cwd.
    check = await asyncio.create_subprocess_exec(sys.executable, "-B", "-c", LOAD_CHECK, str(candidate),
                                                 cwd=CODE.parent, stderr=asyncio.subprocess.PIPE)
    _, errors = await check.communicate()
    if check.returncode != 0:
        candidate.unlink(missing_ok=True)
        raise web.HTTPBadRequest(text=errors.decode(errors="replace")[-500:])
    # The checks waited: a run may have started meanwhile, and the exit must cut off neither it nor the end
    # of a run that is not on disk yet (a restart would read it as interrupted).
    if worker.busy() or worker.restarting:
        candidate.unlink(missing_ok=True)
        raise web.HTTPConflict(text=json.dumps({"error": "busy"}), content_type="application/json")
    if not worker.persist_ended():
        candidate.unlink(missing_ok=True)
        raise web.HTTPServiceUnavailable(text=json.dumps({"error": "a finished run could not be written to disk"}),
                                         content_type="application/json")
    shutil.copyfile(CODE, PREVIOUS_CODE)
    candidate.replace(CODE)
    worker.restarting = True  # nothing starts in the moment before the exit
    asyncio.get_running_loop().call_later(0.5, os._exit, 0)
    return web.json_response({"updated": True, "restarting": True})


async def reset_profile(request):
    authorize(request)
    if worker.busy():
        raise web.HTTPConflict(text=json.dumps({"error": "busy"}), content_type="application/json")
    await systemctl("stop")
    for child in PROFILE.glob("*"):
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)
    for session in worker.sessions.values():
        session.tab, session.tabs, session.agent_state = None, set(), None
    worker.save_tabs()
    await systemctl("start")
    return web.json_response({"reset": True, "chrome": await wait_chrome(30)})


async def park(request):
    """Before a pool host parks this sandbox (browser-vm/host). Under runc (the pool's default) the host
    then stops the sandbox gracefully and keeps the Chrome profile alone: runs, sessions with their agent
    memory and saved tabs are gone after the restore, which starts this worker empty. Under gVisor the host
    freezes it (`runsc checkpoint`): the snapshot keeps everything in memory, so the worker drops what it
    holds of the secrets first. The proxy login goes with
    the forwarder's upstream and its open tunnels (Chrome gets 502 until the next POST /v1/session), the
    model key, 2Captcha key and site secrets with each session; after the restore Bro sends them again as
    after a worker restart. Best effort: Python does not zero freed strings, so copies may remain in the
    snapshot, which stays encrypted under the workspace's key. Never mid-run: a snapshot in the middle of a
    form is neither a success nor a failure."""
    authorize(request)
    body = await request.json() if request.can_read_body else {}
    if not isinstance(body, dict):
        raise web.HTTPBadRequest(text=json.dumps({"error": "body must be an object"}),
                                 content_type="application/json")
    if worker.busy() or any(run.status not in TERMINAL for run in worker.runs.values()):
        raise web.HTTPConflict(text=json.dumps({"error": "busy"}), content_type="application/json")
    worker.forwarder.drop()
    for session in worker.sessions.values():
        session.llm = session.captcha = session.sensitive_data = None
        session.options = {k: v for k, v in session.options.items() if k != "jev"}  # jev's own API key
    answer = {"parked": True}
    if body.get("closeChrome") is True:
        answer["chrome"] = await close_chrome_for_park()
    return web.json_response(answer)


async def close_chrome_for_park(timeout=20):
    """Under runc the host stops the sandbox with SIGTERM, which Chrome takes for the end of the session
    (`exit_type: SessionEnded`) and exits without writing its cookie store: cookies of the last 30 s (its
    commit interval) were lost with the park (e2e on Cloud.ru, 30.09). `Browser.close` is Chrome's own
    shutdown, which writes them. The init starts Chrome again once the old one has exited (RestartSec), so
    this waits for the old Chrome to go and the new one to answer: the SIGTERM then finds nothing unwritten,
    and a park that does not go through leaves a Chrome up. "closed", or "timeout" when Chrome did not
    come back in time (the park goes on: the profile was written by then or never will be)."""
    deadline = asyncio.get_running_loop().time() + timeout
    try:
        await cdp_command(await browser_socket(), "Browser.close", timeout=10)
    except Exception as error:  # the socket may close before the answer
        log.info("Browser.close: %s", error)
    while await chrome_ready():
        if asyncio.get_running_loop().time() >= deadline:
            return "timeout"
        await asyncio.sleep(0.1)
    while not await chrome_ready():
        if asyncio.get_running_loop().time() >= deadline:
            return "timeout"
        await asyncio.sleep(0.2)
    return "closed"


# CDP over the endpoint: Bro's existing CDP client (code typing, viewport capture, keep-alive visits)
# works against this VM unchanged. The token sits in the path because a WebSocket URL has no headers.
# In a sandbox of the pool the host's Caddy reaches the worker under /g/<sandbox id>/ with that prefix
# stripped, and says so in X-Forwarded-Prefix (browser-vm/host/caddy.py): the sockets handed out keep
# it. Only a prefix of that exact form is taken; it only shapes URLs returned to the token's holder.
FORWARDED_PREFIX = re.compile(r"/g/[a-z0-9-]{1,63}")


def cdp_base(request, token):
    prefix = request.headers.get("X-Forwarded-Prefix", "")
    if not FORWARDED_PREFIX.fullmatch(prefix):
        prefix = ""
    return f"wss://{request.host}{prefix}/v1/cdp/{token}"


def scoped_tab(scope):
    """The one tab a `ses`-scoped token (one session, or one keep-alive tab, `b:<targetId>`) may reach,
    or None if that tab is not open. `scope` absent (an unscoped, VM-wide token) is not handled here:
    such a token is never handed to code that should reach only one page (`signBrowserVmToken`'s own
    doc comment), so callers gate on `isinstance(scope, str)` before trusting an unscoped token."""
    if not isinstance(scope, str):
        return None
    if scope.startswith("b:"):
        return scope[2:]
    session = worker.sessions.get(scope)
    return session.tab if session else None


async def cdp_json(request):
    token = request.match_info["token"]
    scope = authorize(request, token).get("ses")
    suffix = request.match_info.get("tail", "")
    if suffix == "version":
        # The browser-level socket this hands out reaches every target on the VM (the CDP `Target`
        # domain): a token scoped to one session or tab must not even discover it.
        if isinstance(scope, str):
            raise web.HTTPForbidden()
        data = await chrome_json("/json/version")
        data["webSocketDebuggerUrl"] = cdp_base(request, token) + "/devtools/browser/" + \
            data["webSocketDebuggerUrl"].rsplit("/", 1)[-1]
        return web.json_response(data)
    targets = await chrome_json("/json/list")
    if isinstance(scope, str):
        # Scoped to one session or keep-alive tab: list that tab alone, never another session's kept-
        # open page or another keep-alive visit, so this token cannot discover one to open next.
        allowed = scoped_tab(scope)
        targets = [t for t in targets if t.get("id") == allowed]
    else:
        # The page the errand works in first: Bro's CDP client types into the first page target.
        focus = worker.current.session_id if worker.current else None
        focus_tab = worker.sessions[focus].tab if focus in worker.sessions else None
        targets.sort(key=lambda t: (t.get("id") != focus_tab, t.get("type") != "page"))
    for target in targets:
        if target.get("webSocketDebuggerUrl"):
            target["webSocketDebuggerUrl"] = cdp_base(request, token) + "/devtools/page/" + target["id"]
        target.pop("devtoolsFrontendUrl", None)
    return web.json_response(targets)


async def cdp_socket(request):
    token = request.match_info["token"]
    scope = authorize(request, token).get("ses")
    kind, target = request.match_info["kind"], request.match_info["target"]
    if kind not in ("page", "browser") or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", target):
        raise web.HTTPNotFound()
    if isinstance(scope, str) and (kind != "page" or target != scoped_tab(scope)):
        # A session- or tab-scoped token reaches its own page alone: the browser-level socket, and any
        # other session's page, are out of its reach even though the signature checks out.
        raise web.HTTPForbidden()
    client = web.WebSocketResponse(max_msg_size=64 * 1024 * 1024)
    await client.prepare(request)
    async with aiohttp.ClientSession() as http:
        async with http.ws_connect(f"ws://127.0.0.1:9222/devtools/{kind}/{target}",
                                   max_msg_size=64 * 1024 * 1024) as chrome:
            async def forward(source, sink):
                async for message in source:
                    if message.type == aiohttp.WSMsgType.TEXT:
                        await sink.send_str(message.data)
                    elif message.type == aiohttp.WSMsgType.BINARY:
                        await sink.send_bytes(message.data)
                    else:
                        break

            tasks = [asyncio.create_task(forward(client, chrome)), asyncio.create_task(forward(chrome, client))]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in tasks:
                task.cancel()
    await client.close()
    return client


@web.middleware
async def errors(request, handler):
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception as error:  # an answer with the reason, never a dropped connection
        log.exception("%s %s", request.method, request.path)
        return web.json_response({"error": f"{type(error).__name__}: {error}"[:500]}, status=500)


def application():
    app = web.Application(middlewares=[errors], client_max_size=60 * 1024 * 1024)
    app.add_routes([
        web.get("/v1/health", health),
        web.post("/v1/session", configure_session),
        web.get("/v1/runs", list_runs),
        web.post("/v1/runs", create_run),
        web.get("/v1/runs/{run_id}", read_run),
        web.post("/v1/runs/{run_id}/cancel", cancel_run),
        web.get("/v1/sessions/{session_id}", read_session),
        web.post("/v1/sessions/{session_id}/messages", session_message),
        web.post("/v1/sessions/{session_id}/release", release_session),
        web.post("/v1/sessions/{session_id}/open", open_page),
        web.get("/v1/sessions/{session_id}/state", page_state),
        web.post("/v1/sessions/{session_id}/action", page_action),
        web.get("/v1/sessions/{session_id}/screenshot", page_screenshot),
        web.get("/v1/files", list_files),
        web.get("/v1/files/{session_id}/{path:.+}", read_file),
        web.get("/v1/dl/{token}/{session_id}/{path:.+}", download),
        web.put("/v1/uploads/{name}", upload),
        web.post("/v1/tabs", open_tab),
        web.delete("/v1/tabs/{target}", delete_tab),
        web.post("/v1/browser/{action:start|stop|restart}", browser_action),
        web.post("/v1/profile/reset", reset_profile),
        web.post("/v1/park", park),
        web.post("/v1/admin/worker", update_worker),
        web.get("/v1/cdp/{token}/json", cdp_json),
        web.get("/v1/cdp/{token}/json/{tail:list|version}", cdp_json),
        web.get("/v1/cdp/{token}/devtools/{kind}/{target}", cdp_socket),
    ])
    return app


def quiet_browser_use(environ):
    """browser-use's settings (read from the environment at use): nothing of it goes out but the run's
    own traffic. From Cloud.ru GitHub, PyPI and openrouter.ai accept connections and answer nothing
    (30.09.2026): pricing (LiteLLM's list from GitHub, then openrouter.ai) held finished runs for minutes,
    and the version check at every run start (PyPI, a 3 s timeout) delays each one. Tokens are counted
    either way; Bro prices them (shared/costs/prices.ts)."""
    environ.setdefault("ANONYMIZED_TELEMETRY", "false")
    environ.setdefault("BROWSER_USE_CLOUD_SYNC", "false")
    environ.setdefault("BROWSER_USE_SETUP_LOGGING", "false")
    # Not defaults: `true` in the unit's environment would turn the fetches back on.
    environ["BROWSER_USE_CALCULATE_COST"] = "false"
    environ["BROWSER_USE_VERSION_CHECK"] = "false"


async def vm_address():
    with contextlib.suppress(Exception):
        async with aiohttp.ClientSession() as http:
            async with http.get("https://api.ipify.org", timeout=aiohttp.ClientTimeout(total=10)) as response:
                return (await response.text()).strip()
    return None


async def main():
    global worker
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    for noisy in ("browser_use", "cdp_use", "bubus", "httpx"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    quiet_browser_use(os.environ)
    for directory in (RUNS, SESSIONS, UPLOADS):
        directory.mkdir(parents=True, exist_ok=True)
    worker = Worker()
    await worker.adopt_tabs()
    worker.vm_address = await vm_address()
    forward = await asyncio.start_server(worker.forwarder.handle, "127.0.0.1", FORWARD_PORT)
    runner = web.AppRunner(application(), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, LISTEN_HOST, LISTEN_PORT).start()
    log.info("worker %s listening; configured=%s", VERSION, worker.config is not None)
    with contextlib.suppress(OSError):  # up: the update that brought this code in is not rolled back
        PREVIOUS_CODE.unlink(missing_ok=True)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    async with forward:
        await stop.wait()
    worker.stop_runs()
    with contextlib.suppress(Exception):
        await asyncio.wait_for(runner.cleanup(), 3)
    os._exit(0)


def check_candidate_imports():
    """Import what the worker imports lazily, as a candidate in LOAD_CHECK: raises when something is missing."""
    import importlib
    for module_name, names in CANDIDATE_IMPORTS:
        module = importlib.import_module(module_name)
        for name in names:
            getattr(module, name)


if __name__ == "candidate":
    check_candidate_imports()

if __name__ == "__main__":
    asyncio.run(main())
