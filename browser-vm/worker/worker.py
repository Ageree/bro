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
  POST /v1/runs                           start an agent run; idempotent on its id; 409 when busy
  GET  /v1/runs/<id>                      status, result, error, task, steps, final page, usage, unreadMessages
  POST /v1/runs/<id>/cancel               stop the agent (waits up to 20 s for it to end), keep the page
  GET  /v1/sessions/<id>                  latest run and its status
  POST /v1/sessions/<id>/messages         {text}: join the live run (unread when it ends: unreadMessages),
                                          or start a follow-up in the tab; 409 while the live run cancels
  POST /v1/sessions/<id>/release          close the session's tab (the page is no longer kept)
  POST /v1/sessions/<id>/open {url}       direct mode, no agent: open a page in the session's tab
  GET  /v1/sessions/<id>/state            address, title, indexed interactive elements
  POST /v1/sessions/<id>/action           {action, params}: click/input/select/scroll/keys/back/navigate
  GET  /v1/sessions/<id>/screenshot       JPEG of the session's tab
  GET  /v1/files?session=&prefix=         files a run saved (report/…), newest first
  GET  /v1/files/<session>/<path>         download one
  GET  /v1/dl/<token>/<session>/<path>    the same by URL alone (token scoped to the session)
  PUT  /v1/uploads/<name>                 a file for the agent to upload to a site
  POST /v1/tabs, DELETE /v1/tabs/<id>     a blank tab for a keep-alive visit, and closing it
  POST /v1/browser/stop | /v1/browser/start | /v1/browser/restart
  POST /v1/profile/reset                  wipe the Chrome profile (forget every sign-in)
  POST /v1/park                           before a pool host freezes this sandbox: forget the model key, the
                                          proxy login and site secrets (409 while a run works or cancels)
  POST /v1/admin/worker                   replace this worker's code (checksummed, must load, only when idle)
  GET  /v1/cdp/<token>/json[/version]     CDP discovery, socket URLs rewritten to this endpoint
  WS   /v1/cdp/<token>/devtools/...       CDP socket to one target of this VM's Chrome
"""

import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse
import uuid
from pathlib import Path

import aiohttp
from aiohttp import web

VERSION = "2026-09-29.1"
CODE = Path(__file__).resolve()
# The code an update replaced, kept until the new code is up: if that keeps failing to start, systemd's
# bro-worker-rollback (provision.sh) brings this back. The VM has no other way in.
PREVIOUS_CODE = CODE.with_name(CODE.name + ".prev")
# Loads a new worker.py as a module in a separate Python: its imports and top-level code run, `main` does not.
LOAD_CHECK = "import runpy, sys; runpy.run_path(sys.argv[1], run_name='candidate')"
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
            "finalTitle": self.final_title, "usage": self.usage, "engine": self.engine, "jev": self.jev,
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
                               ("usage", "usage"), ("engine", "engine"), ("jev", "jev"),
                               ("unreadMessages", "unread_messages"), ("seq", "seq")]:
            if key in record:
                setattr(run, attribute, record[key])
        run.stored = run.status
        return run


def step_summary(state, output, number):
    actions = []
    for action in getattr(output, "action", None) or []:
        data = action.model_dump(exclude_none=True) if hasattr(action, "model_dump") else {}
        for name, params in data.items():
            # Inputs can carry what the person typed or a secret placeholder: keep only the action name
            # and its element index.
            actions.append({"action": name, "index": (params or {}).get("index") if isinstance(params, dict) else None})
    return {
        "number": number, "at": now_iso(), "url": getattr(state, "url", None),
        "title": (getattr(state, "title", None) or "")[:200],
        "goal": (getattr(output, "next_goal", None) or "")[:300],
        "actions": actions[:10],
    }


def usage_summary(history, agent):
    usage = getattr(history, "usage", None)
    if usage is None:
        return None
    data = usage.model_dump() if hasattr(usage, "model_dump") else {}
    return {k: data.get(k) for k in ("total_prompt_tokens", "total_completion_tokens", "total_tokens",
                                        "total_cost", "total_prompt_cached_tokens") if k in data}


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
            return ActionResult(extracted_content=f"Saved report/{name}", long_term_memory=f"Saved report/{name}")

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
            return ActionResult(extracted_content=f"Saved report/{name}", long_term_memory=f"Saved report/{name}")

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

        @tools.action("Get past a site's anti-bot check with a slider puzzle (GeeTest), such as Avito's «Доступ "
                      "ограничен» page. Call it once on the check page: it presses the check's button itself, "
                      "waits for the puzzle, moves the slider and says whether the page let it through.")
        async def solve_captcha(browser_session):
            cdp = await browser_session.get_or_create_cdp_session()

            async def evaluate(expression):
                answer = await cdp.cdp_client.send.Runtime.evaluate(
                    params={"expression": expression, "returnByValue": True, "awaitPromise": True},
                    session_id=cdp.session_id)
                return (answer.get("result") or {}).get("value")

            async def mouse(params):
                await cdp.cdp_client.send.Input.dispatchMouseEvent(params=params, session_id=cdp.session_id)

            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as http:
                solved, message = await solve_slider(evaluate, mouse, http,
                                                     (session.captcha or {}).get("twoCaptchaKey"))
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

        llm_config = session.llm
        llm = ChatOpenRouter(model=llm_config["model"], base_url=llm_config["baseUrl"], api_key=llm_config["apiKey"])
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
        # Each run gets its own step budget, counted from its own first step, injected or not.
        max_steps = int(session.options.get("maxSteps") or 60)
        deadline = time.monotonic() + int(session.options.get("timeoutSeconds") or 1500)

        async def on_step(state, output, number):
            run.steps.append(step_summary(state, output, number))
            run.final_url = getattr(state, "url", None) or run.final_url
            with contextlib.suppress(Exception):
                run.save(agent.state.model_dump(mode="json"))

        async def should_stop():
            return run.cancel_requested or time.monotonic() > deadline

        pending_messages = []  # this step's batch: folded back if the step is cut off before it finishes

        async def read_messages(_):
            # Read right before the model's next call, so that call can act on them. The last step (only
            # `done` is left) and one about to be stopped leave them for the follow-up run instead.
            pending_messages.clear()
            if run.messages and agent.state.n_steps < max_steps and not await should_stop():
                pending_messages.extend(run.messages)
                run.messages = []
                for message in pending_messages:
                    agent.add_new_task(message)

        agent = Agent(
            task=text, llm=llm, browser_session=browser, tools=self.tools(session, run),
            sensitive_data=session.sensitive_data or None, use_vision=bool(session.options.get("vision", False)),
            calculate_cost=True, use_judge=False, available_file_paths=uploads,
            injected_agent_state=injected, register_new_step_callback=on_step,
            register_should_stop_callback=should_stop, extend_system_message=EXTEND_SYSTEM,
            # A restored state carries its own file system; browser-use refuses both at once.
            file_system_path=None if injected is not None else str(session.workspace / "agent-files"),
            max_failures=4,
            enable_signal_handler=False,
        )
        run.agent = agent
        try:
            history = await agent.run(max_steps=max_steps, on_step_start=read_messages)
        finally:
            # browser-use swallows an InterruptedError raised by `should_stop` mid-step (a cancel or the
            # deadline landing while the LLM call or an action was in flight) and returns normally, with
            # `agent.state.stopped` the only sign that the step which just read `pending_messages` never
            # ran to completion: put them back so they are not silently dropped from `unreadMessages`.
            if pending_messages and getattr(agent.state, "stopped", False):
                run.messages = pending_messages + run.messages
            run.agent = None
            await self.follow_focus(session, browser, before)
        with contextlib.suppress(Exception):
            session.agent_state = agent.state.model_dump(mode="json")
        final = history.final_result()
        run.success = history.is_successful()
        run.usage = usage_summary(history, agent)
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
        return False, "No slider puzzle opened on this page: its check is of another kind."
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

EXTEND_SYSTEM = """
Workspace: a file you are asked to save under report/ is saved with the save_screenshot action (a whole
visible page, e.g. report/final.png) or save_element_picture (one item photo, by element index). Never
use web archives, caches or mirrors (web.archive.org and the like) instead of the live site: if the live
site does not open, say so. Credentials and codes come as <secret>alias</secret> placeholders: type the
placeholder itself into the field; the browser types the real value only on the site it belongs to. A
one-time code you are given goes in with the enter_code action, never digit by digit. An anti-bot check
page with a slider puzzle (drag a piece into its gap) goes to the solve_captcha action, which presses its
button and solves it; never press or drag it yourself. To read a long list
or table, prefer one evaluate call that returns the data (wrap the code in an async IIFE:
(async () => { ... })()) over scrolling and reading it screen by screen.
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
    run, _ = await worker.start_run({"id": body.get("runId") or f"{session.id[:40]}-{uuid.uuid4().hex[:12]}",
                                     "sessionId": session.id, "task": text, "llm": llm,
                                     **{k: v for k, v in session.options.items() if v is not None}})
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
    crash-loop the VM's only way in), and the worker must be idle. The code it replaces stays as
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
    """Before a pool host freezes this sandbox (`runsc checkpoint`, browser-vm/host): the snapshot keeps
    everything in memory, so the worker drops what it holds of the secrets first. The proxy login goes with
    the forwarder's upstream and its open tunnels (Chrome gets 502 until the next POST /v1/session), the
    model key, 2Captcha key and site secrets with each session; after the restore Bro sends them again as
    after a worker restart. Best effort: Python does not zero freed strings, so copies may remain in the
    snapshot, which stays encrypted under the workspace's key. Never mid-run: a snapshot in the middle of a
    form is neither a success nor a failure."""
    authorize(request)
    if worker.busy() or any(run.status not in TERMINAL for run in worker.runs.values()):
        raise web.HTTPConflict(text=json.dumps({"error": "busy"}), content_type="application/json")
    worker.forwarder.drop()
    for session in worker.sessions.values():
        session.llm = session.captcha = session.sensitive_data = None
        session.options = {k: v for k, v in session.options.items() if k != "jev"}  # jev's own API key
    return web.json_response({"parked": True})


# CDP over the endpoint: Bro's existing CDP client (code typing, viewport capture, keep-alive visits)
# works against this VM unchanged. The token sits in the path because a WebSocket URL has no headers.
def cdp_base(request, token):
    return f"wss://{request.host}/v1/cdp/{token}"


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
    os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
    os.environ.setdefault("BROWSER_USE_CLOUD_SYNC", "false")
    os.environ.setdefault("BROWSER_USE_SETUP_LOGGING", "false")
    for directory in (RUNS, SESSIONS, UPLOADS):
        directory.mkdir(parents=True, exist_ok=True)
    worker = Worker()
    await worker.adopt_tabs()
    worker.vm_address = await vm_address()
    forward = await asyncio.start_server(worker.forwarder.handle, "127.0.0.1", FORWARD_PORT)
    runner = web.AppRunner(application(), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", LISTEN_PORT).start()
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


if __name__ == "__main__":
    asyncio.run(main())
