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

Routes (all but /v1/health need a token):
  GET  /v1/health                         liveness, Chrome, busy flag (no secrets)
  POST /v1/session                        {proxy: {host, port, username, password}} → exit address
  GET  /v1/runs?contains=<line>           runs of this VM, newest first (adoption after a lost start)
  POST /v1/runs                           start an agent run; idempotent on its id; 409 when busy
  GET  /v1/runs/<id>                      status, result, error, task, steps, final page, usage
  POST /v1/runs/<id>/cancel               stop the agent, keep the page
  GET  /v1/sessions/<id>                  latest run and its status
  POST /v1/sessions/<id>/messages         {text}: join the live run, or start a follow-up in the tab
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
  POST /v1/admin/worker                   replace this worker's code (checksummed, only when idle)
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

VERSION = "2026-09-28.5"
ROOT = Path(os.environ.get("BRO_STATE_DIR", "/var/lib/bro"))
CONFIG_FILE = Path(os.environ.get("BRO_WORKER_CONFIG", "/etc/bro/worker.json"))
IMAGE_FILE = Path("/etc/bro/image")
PROFILE = ROOT / "profile"
RUNS = ROOT / "runs"
SESSIONS = ROOT / "sessions"
UPLOADS = ROOT / "uploads"
GENERATION_FILE = ROOT / "generation"
CDP_HTTP = "http://127.0.0.1:9222"
LISTEN_PORT = int(os.environ.get("BRO_WORKER_PORT", "8080"))
FORWARD_PORT = 3128
MAX_TOKEN_LIFETIME_S = 900
# The agent must not "find" the site in an archive or a cache: in the pilot it answered from a 2024
# snapshot of ozon.ru on web.archive.org and called that success.
PROHIBITED_DOMAINS = [
    "*.archive.org", "archive.ph", "archive.today", "archive.is", "*.archive.ph", "cachedview.nl",
    "webcache.googleusercontent.com", "*.translate.goog", "yandexwebcache.net", "*.yandexwebcache.net",
]
TERMINAL = {"completed", "failed", "cancelled"}
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
        up_writer.write(request)
        await up_writer.drain()
        await asyncio.gather(self.pipe(client_reader, up_writer, "up"), self.pipe(up_reader, client_writer, "down"))


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
        self.tab = None
        self.latest_run_id = None
        self.agent_state = None  # browser_use AgentState JSON of the last finished run
        self.llm = None
        self.sensitive_data = None
        self.options = {}
        self.released = False
        self.root_task = None  # the errand as first given: a follow-up joins it as a follow-up request
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

    def public(self):
        return {
            "id": self.id, "sessionId": self.session_id, "status": self.status, "task": self.task,
            "result": self.result, "error": self.error, "success": self.success,
            "createdAt": self.created_at, "startedAt": self.started_at, "finishedAt": self.finished_at,
            "steps": self.steps[-50:], "stepCount": len(self.steps), "finalUrl": self.final_url,
            "finalTitle": self.final_title, "usage": self.usage, "engine": self.engine, "jev": self.jev,
        }

    def save(self, agent_state=None):
        RUNS.mkdir(parents=True, exist_ok=True)
        record = self.public() | {"steps": self.steps}
        if agent_state is not None:
            record["agentState"] = agent_state
        path = RUNS / f"{disk_name(self.id)}.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, ensure_ascii=False))
        temporary.replace(path)

    @classmethod
    def load(cls, record):
        run = cls(record["id"], record["sessionId"], record["task"])
        for key, attribute in [("status", "status"), ("result", "result"), ("error", "error"),
                               ("success", "success"), ("createdAt", "created_at"),
                               ("startedAt", "started_at"), ("finishedAt", "finished_at"),
                               ("steps", "steps"), ("finalUrl", "final_url"), ("finalTitle", "final_title"),
                               ("usage", "usage"), ("engine", "engine"), ("jev", "jev")]:
            if key in record:
                setattr(run, attribute, record[key])
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
        self.load_runs()

    # Persistence: a run's record survives a worker or VM restart; one that was running then is
    # reported as failed with its last checkpoint, never resumed behind Bro's back.
    def load_runs(self):
        if not RUNS.exists():
            return
        for path in RUNS.glob("*.json"):
            try:
                record = json.loads(path.read_text())
                run = Run.load(record)
            except (OSError, ValueError, KeyError):
                continue
            if run.status not in TERMINAL:
                run.status = "failed"
                run.error = ("The browser worker restarted while the run was working (VM or Chrome restart); "
                             f"the last checkpoint was step {len(run.steps)} on {run.final_url or run.steps[-1]['url'] if run.steps else 'no page'}.")
                run.finished_at = now_iso()
                run.save(record.get("agentState"))
            self.runs[run.id] = run
            session = self.sessions.setdefault(run.session_id, Session(run.session_id))
            first = self.runs.get(session.latest_run_id) if session.latest_run_id else None
            if session.root_task is None or (first and run.created_at < first.created_at):
                session.root_task = run.task
            if session.latest_run_id is None or (self.runs.get(session.latest_run_id) and
                                                 self.runs[session.latest_run_id].created_at <= run.created_at):
                session.latest_run_id = run.id
                session.agent_state = record.get("agentState")

    def accept_generation(self, generation):
        if generation > self.generation:
            self.generation = generation
            GENERATION_FILE.write_text(str(generation))

    def busy(self):
        return self.current is not None and self.current.status not in TERMINAL

    async def ensure_tab(self, session):
        tabs = {t["id"] for t in await page_targets()}
        if session.tab not in tabs:
            session.tab = await new_tab()
        return session.tab

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
        from browser_use.agent.views import AgentState

        await self.release_direct(session)

        llm_config = session.llm
        llm = ChatOpenRouter(model=llm_config["model"], base_url=llm_config["baseUrl"], api_key=llm_config["apiKey"])
        browser = await self.browser_session(session, session.options)
        uploads = sorted(str(p) for p in UPLOADS.glob("*")) if UPLOADS.exists() else []
        injected = None
        if session.agent_state and session.options.get("continueMemory") is not False:
            with contextlib.suppress(Exception):
                injected = AgentState.model_validate_json(session.agent_state) \
                    if isinstance(session.agent_state, str) else AgentState.model_validate(session.agent_state)
                injected.stopped = False
                injected.paused = False
                injected.consecutive_failures = 0
        deadline = time.monotonic() + int(session.options.get("timeoutSeconds") or 1500)

        async def on_step(state, output, number):
            run.steps.append(step_summary(state, output, number))
            run.final_url = getattr(state, "url", None) or run.final_url
            with contextlib.suppress(Exception):
                run.save(agent.state.model_dump(mode="json"))
            while run.messages:
                agent.add_new_task(run.messages.pop(0))

        async def should_stop():
            return run.cancel_requested or time.monotonic() > deadline

        agent = Agent(
            task=(session.root_task or text) if injected is not None else text, llm=llm, browser_session=browser, tools=self.tools(session, run),
            sensitive_data=session.sensitive_data or None, use_vision=bool(session.options.get("vision", False)),
            calculate_cost=True, use_judge=False, available_file_paths=uploads,
            injected_agent_state=injected, register_new_step_callback=on_step,
            register_should_stop_callback=should_stop, extend_system_message=EXTEND_SYSTEM,
            # A restored state carries its own file system; browser-use refuses both at once.
            file_system_path=None if injected is not None else str(session.workspace / "agent-files"),
            max_failures=4,
            enable_signal_handler=False,
        )
        if injected is not None:
            agent.add_new_task(text)
        run.agent = agent
        try:
            history = await agent.run(max_steps=int(session.options.get("maxSteps") or 60))
        finally:
            run.agent = None
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
            session.tab = result["target"]
        return result

    async def execute(self, run, session, text):
        run.status = "running"
        run.started_at = now_iso()
        run.save()
        try:
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
                    run.status, run.result = "completed", run.jev.get("visible_text", "")[:3000]
                    run.final_url = run.jev.get("final_url")
                    return
            status, result, error = await self.run_agent(run, session, text)
            run.status, run.result, run.error = status, result, error
        except Exception as error:  # a crash is a failed run with its reason, never a silent loss
            log.exception("run %s failed", run.id)
            run.status, run.error = "failed", f"{type(error).__name__}: {error}"[:2000]
        finally:
            with contextlib.suppress(Exception):
                report = session.workspace / "report"
                if not (report / "final.png").exists() and not (report / "final.jpg").exists() and session.tab:
                    report.mkdir(parents=True, exist_ok=True)
                    (report / "final.jpg").write_bytes(await screenshot(session.tab))
            run.finished_at = now_iso()
            run.save(session.agent_state)
            if self.current is run:
                self.current = None

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
            session_id = safe_id(body.get("sessionId") or f"s-{uuid.uuid4()}")
            session = self.sessions.get(session_id)
            if session is None:
                session = self.sessions[session_id] = Session(session_id)
            elif body.get("freshMemory"):
                session.agent_state = None
            session.released = False
            if session.root_task is None or session.agent_state is None:
                session.root_task = task
            session.llm = llm
            session.sensitive_data = secrets_to_sensitive_data(body.get("secrets") or [])
            session.options = {k: body.get(k) for k in ("maxSteps", "timeoutSeconds", "allowedDomains", "vision",
                                                         "jev", "jevCanFinish", "continueMemory")}
            run = Run(run_id, session_id, task)
            run.engine = body.get("engine") if body.get("engine") in ("agent", "jev-then-agent") else "agent"
            self.runs[run_id] = run
            session.latest_run_id = run_id
            self.current = run
            run.save()
            asyncio.get_running_loop().create_task(self.execute(run, session, task))
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

EXTEND_SYSTEM = """
Workspace: a file you are asked to save under report/ is saved with the save_screenshot action (a whole
visible page, e.g. report/final.png) or save_element_picture (one item photo, by element index). Never
use web archives, caches or mirrors (web.archive.org and the like) instead of the live site: if the live
site does not open, say so. Credentials and codes come as <secret>alias</secret> placeholders: type the
placeholder itself into the field; the browser types the real value only on the site it belongs to. A
one-time code you are given goes in with the enter_code action, never digit by digit. To read a long list
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
    with contextlib.suppress(Exception):
        info["profileMb"] = round(sum(f.stat().st_size for f in PROFILE.rglob("*") if f.is_file()) / 2**20, 1)
    return info


async def health(request):
    stage_file = ROOT / "stage"
    return web.json_response({
        "worker": VERSION, "image": IMAGE_FILE.read_text().strip() if IMAGE_FILE.exists() else None,
        "configured": worker.config is not None, "uptimeSeconds": float(Path("/proc/uptime").read_text().split()[0]),
        "chrome": await chrome_ready(), "busy": worker.busy(), "proxy": worker.forwarder.upstream is not None,
        "stage": stage_file.read_text().strip() if stage_file.exists() else None, "generation": worker.generation,
        **(machine() if request.query.get("machine") else {}),
    })


async def configure_session(request):
    authorize(request)
    body = await request.json()
    proxy = body.get("proxy")
    if not isinstance(proxy, dict) or not proxy.get("host") or not proxy.get("port"):
        raise web.HTTPBadRequest(text="proxy {host, port, username?, password?} is required")
    worker.forwarder.configure(proxy)
    exit_address = None
    proxy_url = f"http://127.0.0.1:{FORWARD_PORT}"
    try:
        async with aiohttp.ClientSession() as http:
            started = time.monotonic()
            async with http.get("https://ipinfo.io/json", proxy=proxy_url, timeout=aiohttp.ClientTimeout(total=20)) as response:
                data = await response.json(content_type=None)
            exit_address = {k: data.get(k) for k in ("ip", "city", "region", "country", "org")}
            exit_address["latencyMs"] = round((time.monotonic() - started) * 1000)
            # Residential exits differ tenfold in speed (the same Wildberries page took 3 s through one and
            # 70 s through another): measure a megabyte so Bro can move a slow exit before the errand.
            started = time.monotonic()
            async with http.get("https://speed.cloudflare.com/__down?bytes=1000000", proxy=proxy_url,
                                timeout=aiohttp.ClientTimeout(total=25)) as response:
                size = len(await response.read())
            exit_address["mbps"] = round(size * 8 / 1e6 / max(time.monotonic() - started, 0.001), 2)
    except Exception as error:
        exit_address = {**(exit_address or {}), "error": f"{type(error).__name__}: {error}"[:300]}
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
    """A message into a session: joins its live run (read before the agent's next step), or, when the
    session is idle, becomes a follow-up run in the same tab with the same memory (Browser Use's
    "idle session drains the message into a new run")."""
    authorize(request)
    session = find_session(request)
    body = await request.json()
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise web.HTTPBadRequest(text="text is required")
    latest = worker.runs.get(session.latest_run_id)
    if latest is not None and latest.status not in TERMINAL:
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
    await browser.navigate_to(url)
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
    result = await worker.tools(session, None).registry.execute_action(
        action, params, browser_session=browser, sensitive_data=session.sensitive_data or None)
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
    if session.tab:
        await close_tab(session.tab)
    session.tab, session.released = None, True
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
    return web.json_response({"targetId": await new_tab()})


async def delete_tab(request):
    authorize(request)
    target = request.match_info["target"]
    if any(session.tab == target for session in worker.sessions.values()):
        raise web.HTTPConflict(text=json.dumps({"error": "an errand's tab"}), content_type="application/json")
    await close_tab(target)
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
            session.tab = None
    return web.json_response({"rc": code, "chrome": ready, "output": output})


async def update_worker(request):
    """Replace this worker's own code (Bro rolls a fix out to VMs that were created from an older image;
    their disks carry the person's profile, so they are not re-created for a code change). The body is
    the new worker.py; it must match `X-Content-Sha256` and compile, and the worker must be idle. The
    worker then exits and systemd starts the new code."""
    authorize(request)
    if worker.busy():
        raise web.HTTPConflict(text=json.dumps({"error": "busy"}), content_type="application/json")
    source = await request.read()
    if hashlib.sha256(source).hexdigest() != request.headers.get("X-Content-Sha256", ""):
        raise web.HTTPBadRequest(text="checksum mismatch")
    target = Path(__file__).resolve()
    candidate = target.with_suffix(".new")
    candidate.write_bytes(source)
    check = await asyncio.create_subprocess_exec(sys.executable, "-m", "py_compile", str(candidate),
                                                 stderr=asyncio.subprocess.PIPE)
    _, errors = await check.communicate()
    if check.returncode != 0:
        candidate.unlink(missing_ok=True)
        raise web.HTTPBadRequest(text=errors.decode(errors="replace")[-500:])
    candidate.replace(target)
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
        session.tab, session.agent_state = None, None
    await systemctl("start")
    return web.json_response({"reset": True, "chrome": await wait_chrome(30)})


# CDP over the endpoint: Bro's existing CDP client (code typing, viewport capture, keep-alive visits)
# works against this VM unchanged. The token sits in the path because a WebSocket URL has no headers.
def cdp_base(request, token):
    return f"wss://{request.host}/v1/cdp/{token}"


async def cdp_json(request):
    token = request.match_info["token"]
    scope = authorize(request, token).get("ses")
    suffix = request.match_info.get("tail", "")
    if suffix == "version":
        data = await chrome_json("/json/version")
        data["webSocketDebuggerUrl"] = cdp_base(request, token) + "/devtools/browser/" + \
            data["webSocketDebuggerUrl"].rsplit("/", 1)[-1]
        return web.json_response(data)
    targets = await chrome_json("/json/list")
    # The page the errand works in first: Bro's CDP client types into the first page target.
    focus = worker.current.session_id if worker.current else None
    focus_tab = worker.sessions[focus].tab if focus in worker.sessions else None
    if isinstance(scope, str) and scope.startswith("b:"):
        focus_tab = scope[2:]
    elif scope in worker.sessions:
        focus_tab = worker.sessions[scope].tab or focus_tab
    targets.sort(key=lambda t: (t.get("id") != focus_tab, t.get("type") != "page"))
    for target in targets:
        if target.get("webSocketDebuggerUrl"):
            target["webSocketDebuggerUrl"] = cdp_base(request, token) + "/devtools/page/" + target["id"]
        target.pop("devtoolsFrontendUrl", None)
    return web.json_response(targets)


async def cdp_socket(request):
    token = request.match_info["token"]
    authorize(request, token)
    kind, target = request.match_info["kind"], request.match_info["target"]
    if kind not in ("page", "browser") or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", target):
        raise web.HTTPNotFound()
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
    worker.vm_address = await vm_address()
    forward = await asyncio.start_server(worker.forwarder.handle, "127.0.0.1", FORWARD_PORT)
    runner = web.AppRunner(application(), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", LISTEN_PORT).start()
    log.info("worker %s listening; configured=%s", VERSION, worker.config is not None)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    async with forward:
        await stop.wait()
    # Stopping (power-off, restart): a working run is recorded as interrupted with its checkpoint
    # right away; the agent is not waited for, since systemd would kill it mid-step anyway.
    for run in list(worker.runs.values()):
        if run.status not in TERMINAL:
            run.cancel_requested = True
            run.status, run.finished_at = "failed", now_iso()
            run.error = f"The browser worker stopped while the run was working (step {len(run.steps)})."
            session = worker.sessions.get(run.session_id)
            with contextlib.suppress(Exception):
                agent_state = run.agent.state.model_dump(mode="json") if run.agent else None
                run.save(agent_state or (session.agent_state if session else None))
    with contextlib.suppress(Exception):
        await asyncio.wait_for(runner.cleanup(), 3)
    os._exit(0)


if __name__ == "__main__":
    asyncio.run(main())
