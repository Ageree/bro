"""Worker unit tests: python -m unittest browser-vm/worker/test_worker.py (needs aiohttp).

The token vector is shared with Bro's `tests/agent/browser-vm/token.test.ts`: both sides must agree on
the exact bytes, or every call from Bro to a VM is refused. Runs are tested against a fake Chrome and a
fake browser_use (replaced at its import), so browser-use itself need not be installed.
"""

import asyncio
import base64
import contextlib
import hashlib
import hmac
import importlib.util
import itertools
import json
import os
import re
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

import aiohttp
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).parent))
import worker  # noqa: E402

SIGNING = bytes.fromhex("11" * 32)
WORKSPACE = "ws_test_123"
KEY = hmac.new(SIGNING, f"bro-browser-vm:{WORKSPACE}".encode(), hashlib.sha256).digest()
CONFIG = {"environment": WORKSPACE, "key": KEY}
TOKEN = "v1.eyJlbnYiOiJ3c190ZXN0XzEyMyIsImdlbiI6MywiZXhwIjoxNzkwMDAwMzAwfQ.sounRHPylHeCoYxmM2jPawS3Bh0zE45yyIKv54MsuL8"
SESSION_TOKEN = ("v1.eyJlbnYiOiJ3c190ZXN0XzEyMyIsImdlbiI6MywiZXhwIjoxNzkwMDAwMzAwLCJzZXMiOiJ2bTp3c190ZXN0XzEyMzpzOmFiYyJ9"
                 ".BXSmPnEMmg0KrJrCg1FDFLgyF6EQ0qXdjHeIe7oPMbY")
NOW = 1790000300 - 60


class TokenTest(unittest.TestCase):
    def test_vm_key_derivation_matches_bro(self):
        self.assertEqual(KEY.hex(), "b62a60b9925024534507acf039e236b698c33866d8e18c727661251748984301")

    def test_accepts_bro_token_and_session_scope(self):
        self.assertEqual(worker.verify_token(TOKEN, CONFIG, 0, NOW)["gen"], 3)
        self.assertEqual(worker.verify_token(SESSION_TOKEN, CONFIG, 3, NOW)["ses"], "vm:ws_test_123:s:abc")

    def test_refuses_tampering_other_vm_expiry_and_stale_generation(self):
        cases = {
            "bad signature": (TOKEN[:-2] + "AA", CONFIG, 0, NOW),
            "token for another environment": (TOKEN, {"environment": "other", "key": KEY}, 0, NOW),
            "expired token": (TOKEN, CONFIG, 0, 1790000300 + 1),
            "stale generation": (TOKEN, CONFIG, 4, NOW),
            "worker not configured": (TOKEN, None, 0, NOW),
        }
        for reason, (token, config, generation, now) in cases.items():
            with self.subTest(reason), self.assertRaisesRegex(worker.Unauthorized, reason):
                worker.verify_token(token, config, generation, now)

    def test_refuses_a_token_that_lives_too_long(self):
        with self.assertRaisesRegex(worker.Unauthorized, "expired token"):
            worker.verify_token(TOKEN, CONFIG, 0, 1790000300 - worker.MAX_TOKEN_LIFETIME_S - 5)


class BrowserUseSettingsTest(unittest.TestCase):
    def test_nothing_of_browser_use_goes_out_but_the_run(self):
        # From Cloud.ru PyPI and GitHub accept and never answer: pricing held runs for minutes, the version
        # check (PyPI) delays every start. A `true` from the unit's environment is overridden.
        environ = {"BROWSER_USE_CALCULATE_COST": "true", "BROWSER_USE_VERSION_CHECK": "true",
                   "ANONYMIZED_TELEMETRY": "true"}
        worker.quiet_browser_use(environ)
        self.assertEqual(environ, {"BROWSER_USE_CALCULATE_COST": "false", "BROWSER_USE_VERSION_CHECK": "false",
                                   "ANONYMIZED_TELEMETRY": "true", "BROWSER_USE_CLOUD_SYNC": "false",
                                   "BROWSER_USE_SETUP_LOGGING": "false"})
        self.assertIn("    quiet_browser_use(os.environ)\n", Path(worker.__file__).read_text())


class ListenTest(unittest.TestCase):
    def listen_host(self, **env):
        # A fresh copy of the module, since the address is read once at import.
        base = {k: v for k, v in os.environ.items() if k != "BRO_WORKER_BIND"}
        with mock.patch.dict(os.environ, {**base, **env}, clear=True):
            spec = importlib.util.spec_from_file_location("worker_listen_probe", worker.CODE)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        return module.LISTEN_HOST

    def test_loopback_behind_caddy_unless_the_sandbox_asks_for_its_interface(self):
        self.assertEqual(self.listen_host(), "127.0.0.1")
        self.assertEqual(self.listen_host(BRO_WORKER_BIND="0.0.0.0"), "0.0.0.0")


class SecretsTest(unittest.TestCase):
    def test_bindings_become_domain_scoped_sensitive_data(self):
        data = worker.secrets_to_sensitive_data([
            {"alias": "signin_phone", "allowedDomains": ["wildberries.ru"], "value": "9001234567"},
            {"alias": "card_number", "allowedDomains": ["shop.ru", "yookassa.ru"], "value": "4111"},
            {"alias": "Bad Alias", "allowedDomains": ["x.ru"], "value": "v"},
            {"alias": "login_password", "allowedDomains": ["no-dot", "evil.ru/path"], "value": "p"},
        ])
        self.assertEqual(data, {
            "https://*.wildberries.ru": {"signin_phone": "9001234567"},
            "https://*.shop.ru": {"card_number": "4111"},
            "https://*.yookassa.ru": {"card_number": "4111"},
        })


class ForwarderTest(unittest.IsolatedAsyncioTestCase):
    async def test_refuses_to_browse_before_the_proxy_is_set(self):
        forwarder = worker.Forwarder()
        server = await asyncio.start_server(forwarder.handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
        await writer.drain()
        answer = await reader.read(200)
        writer.close()
        server.close()
        self.assertTrue(answer.startswith(b"HTTP/1.1 502"))
        self.assertEqual(forwarder.totals["refused"], 1)

    async def test_adds_the_login_for_the_upstream(self):
        seen = []

        async def upstream(reader, writer):
            seen.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            writer.close()

        up = await asyncio.start_server(upstream, "127.0.0.1", 0)
        forwarder = worker.Forwarder()
        forwarder.configure({"host": "127.0.0.1", "port": up.sockets[0].getsockname()[1],
                             "username": "user-session-abc", "password": "p:w"})
        server = await asyncio.start_server(forwarder.handle, "127.0.0.1", 0)
        reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
        writer.write(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: x\r\n\r\n")
        await writer.drain()
        await reader.read(100)
        writer.close()
        server.close()
        up.close()
        head = seen[0].decode()
        login = base64.b64encode(b"user-session-abc:p:w").decode()
        self.assertIn(f"Proxy-Authorization: Basic {login}", head)
        self.assertEqual(head.count("Proxy-Authorization"), 1)

    async def test_drop_closes_the_tunnels_that_carry_the_login(self):
        held = asyncio.Event()

        async def upstream(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            held.set()
            await reader.read()  # keeps the tunnel open until the forwarder closes it
            writer.close()

        up = await asyncio.start_server(upstream, "127.0.0.1", 0)
        forwarder = worker.Forwarder()
        forwarder.configure({"host": "127.0.0.1", "port": up.sockets[0].getsockname()[1], "username": "u",
                             "password": "p"})
        server = await asyncio.start_server(forwarder.handle, "127.0.0.1", 0)
        reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
        writer.write(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
        await writer.drain()
        await asyncio.wait_for(held.wait(), 5)
        await reader.readuntil(b"\r\n\r\n")
        self.assertEqual(len(forwarder.open), 2)
        forwarder.drop()
        self.assertEqual(await asyncio.wait_for(reader.read(), 5), b"")  # the tunnel is gone
        for _ in range(50):
            if not forwarder.open:
                break
            await asyncio.sleep(0.02)
        self.assertEqual((forwarder.open, forwarder.upstream), (set(), None))
        writer.close()
        server.close()
        up.close()


LLM = {"baseUrl": "https://llm.test/v1", "apiKey": "k", "model": "m"}
# Bro's routing of the model's hosts (`tuning.provider`) and what the worker sends the service for it.
ROUTING = {"order": ["deepinfra"], "ignore": ["deepseek", "sail-research"], "requireParameters": True, "later": 1}
SENT_ROUTING = {"order": ["deepinfra"], "ignore": ["deepseek", "sail-research"], "require_parameters": True}


def fresh_token():
    return signed_token({"env": WORKSPACE, "gen": 0, "exp": int(time.time()) + 600})


def signed_token(claims):
    def part(data):
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    payload = part(json.dumps(claims).encode())
    return f"v1.{payload}.{part(hmac.new(KEY, f'v1.{payload}'.encode(), hashlib.sha256).digest())}"


def cdp_token(ses=None):
    """A token as `browserVmCdpUrl` mints it: unscoped for none, else scoped to one session (or, as
    `b:<targetId>`, one keep-alive tab)."""
    claims = {"env": WORKSPACE, "gen": 0, "exp": int(time.time()) + 600}
    if ses is not None:
        claims["ses"] = ses
    return signed_token(claims)


class FakeChrome:
    """The VM's Chrome as the worker sees it over CDP: its page tabs."""

    def __init__(self):
        self.tabs, self.closed, self.shots, self.opened = [], [], [], 0

    async def page_targets(self):
        return [{"id": tab, "type": "page"} for tab in self.tabs]

    async def new_tab(self):
        self.opened += 1
        self.tabs.append(f"T{self.opened}")
        return self.tabs[-1]

    async def close_tab(self, target):
        if target in self.tabs:
            self.tabs.remove(target)
            self.closed.append(target)

    async def screenshot(self, target, quality=80):
        self.shots.append(target)
        return b"jpeg"


class FakeAgentState:
    def __init__(self, n_steps=1, history=()):
        self.n_steps, self.stopped, self.paused, self.follow_up_task, self.consecutive_failures = \
            n_steps, False, False, False, 0
        # Non-None so a test can tell whether the worker reset them (W2): browser-use's own counters,
        # relative to n_steps, that a reset run must not carry over from a previous run's step count.
        self.plan_generation_step = 7
        # The messages browser-use saved with the memory: its system message would win over the run's own.
        saved = types.SimpleNamespace(system_message="saved system", state_message="saved state",
                                      context_messages=["saved context"])
        self.message_manager_state = types.SimpleNamespace(agent_history_items=list(history),
                                                            last_compaction_step=12, history=saved)

    @classmethod
    def model_validate(cls, data):
        return cls(data["n_steps"], data["history"])

    def model_dump(self, mode=None):
        return {"n_steps": self.n_steps, "history": list(self.message_manager_state.agent_history_items)}


class FakeHistory:
    usage = None

    def __init__(self, done, result="done"):
        self.done, self.result = done, result

    def final_result(self):
        return self.result if self.done else None

    def is_successful(self):
        return self.done

    def is_done(self):
        return self.done

    def errors(self):
        return []


class FakeAgent:
    """browser_use.Agent: `script(agent, on_step_start)` plays its steps."""

    built = []
    script = None

    def __init__(self, **options):
        self.options, self.added = options, []
        self.state = options["injected_agent_state"] or FakeAgentState()
        FakeAgent.built.append(self)

    def add_new_task(self, text):
        self.added.append(text)

    def stop(self):
        self.state.stopped = True

    async def run(self, max_steps, on_step_start=None, on_step_end=None):
        self.max_steps, self.on_step_end = max_steps, on_step_end or FakeAgent.no_hook
        return await FakeAgent.script(self, on_step_start or FakeAgent.no_hook)

    @staticmethod
    async def no_hook(agent):
        pass


class FakeBrowser:
    """The agent's BrowserSession: `agent_focus_target_id` is the tab it works in."""

    def __init__(self, focus, on_stop):
        self.agent_focus_target_id, self.on_stop = focus, on_stop

    async def get_current_page_url(self):
        return "https://shop.test/"

    async def get_current_page_title(self):
        return "Shop"

    async def stop(self):
        await self.on_stop()


async def one_step(agent, on_step_start):
    await on_step_start(agent)
    agent.state.n_steps += 1
    return FakeHistory(True)


class RunsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.chrome = FakeChrome()
        self.stop_hook = None
        self.exits = mock.Mock()  # os._exit after an update
        FakeAgent.built, FakeAgent.script = [], one_step
        views = types.SimpleNamespace(AgentState=FakeAgentState)
        message_views = types.SimpleNamespace(HistoryItem=lambda system_message: system_message)
        browser_use = types.SimpleNamespace(Agent=FakeAgent, ChatOpenRouter=lambda **options: options,
                                            ActionResult=lambda **fields: fields)
        test = self

        async def browser_session(self, session, options):
            await self.ensure_tab(session)
            return FakeBrowser(session.tab, test.stopping)

        for target, name, value in [
            (worker, "ROOT", root), (worker, "RUNS", root / "runs"), (worker, "SESSIONS", root / "sessions"),
            (worker, "UPLOADS", root / "uploads"), (worker, "GENERATION_FILE", root / "generation"),
            (worker, "TABS_FILE", root / "tabs.json"), (worker, "load_config", lambda: CONFIG),
            (worker, "chrome_ready", mock.AsyncMock(return_value=True)),
            (worker, "page_targets", self.chrome.page_targets), (worker, "new_tab", self.chrome.new_tab),
            (worker, "close_tab", self.chrome.close_tab), (worker, "screenshot", self.chrome.screenshot),
            (worker, "worker", None), (worker.Worker, "browser_session", browser_session),
            (worker.Worker, "tools", lambda self, session, run: None),
            (worker, "CODE", root / "worker.py"), (worker, "PREVIOUS_CODE", root / "worker.py.prev"),
            (worker.os, "_exit", self.exits),
        ]:
            self.enterContext(mock.patch.object(target, name, value))
        # httpx comes with browser-use on the image; the run's billing hook only needs its client built.
        class AsyncClient(dict):
            async def aclose(self):
                pass

        httpx = types.SimpleNamespace(AsyncClient=AsyncClient, Timeout=lambda *args, **kwargs: None)
        self.enterContext(mock.patch.dict(sys.modules, {
            "httpx": httpx, "browser_use": browser_use, "browser_use.agent": types.SimpleNamespace(),
            "browser_use.agent.views": views, "browser_use.agent.message_manager": types.SimpleNamespace(),
            "browser_use.agent.message_manager.views": message_views,
        }))
        self.worker = self.restart()
        self.client = TestClient(TestServer(worker.application()))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    def restart(self):
        worker.worker = worker.Worker()
        worker.worker.forwarder.upstream = ("proxy.test", 3128, None)
        return worker.worker

    async def stopping(self):
        if self.stop_hook is not None:
            await self.stop_hook()

    async def call(self, method, path, body=None):
        response = await self.client.request(method, path, json=body,
                                             headers={"Authorization": f"Bearer {fresh_token()}"})
        return response.status, await response.json()

    async def update(self, source):
        response = await self.client.post("/v1/admin/worker", data=source, headers={
            "Authorization": f"Bearer {fresh_token()}", "X-Content-Sha256": hashlib.sha256(source).hexdigest()})
        return response.status, await response.text()

    def on_disk(self, run_id):
        return json.loads((worker.RUNS / f"{worker.disk_name(run_id)}.json").read_text())

    async def reached(self, event):
        await asyncio.wait_for(event.wait(), 5)

    async def settled(self, run_id):
        for _ in range(500):
            run = self.worker.runs.get(run_id)
            if run is not None and run.status in worker.TERMINAL:
                return run
            await asyncio.sleep(0.01)
        self.fail(f"run {run_id} did not end")

    async def test_a_follow_up_run_has_its_own_request_and_step_budget(self):
        async def forty_five_steps(agent, on_step_start):
            await on_step_start(agent)
            agent.state.n_steps += 45
            return FakeHistory(True)

        FakeAgent.script = forty_five_steps
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM,
                                     "task": "Order the kettle. You may pay. Ivan, +7 900 000-00-00."})
        await self.settled("r1")

        # Captured before this run's own script advances the counters further, to check what the run
        # started from (W2's reset), not what it ends at.
        started = {}

        async def one_step_from_reset(agent, on_step_start):
            started["n_steps"] = agent.state.n_steps
            started["plan_generation_step"] = agent.state.plan_generation_step
            started["last_compaction_step"] = agent.state.message_manager_state.last_compaction_step
            await on_step_start(agent)
            agent.state.n_steps += 1
            return FakeHistory(True)

        FakeAgent.script = one_step_from_reset
        await self.worker.start_run({"id": "r2", "sessionId": "s1", "llm": LLM, "task": "Enter the code 1234."})
        await self.settled("r2")
        first, second = FakeAgent.built
        self.assertEqual(first.max_steps, 60)
        self.assertEqual(second.options["task"], "Enter the code 1234.")
        self.assertEqual(second.added, [])
        memory = second.options["injected_agent_state"]
        self.assertTrue(memory.follow_up_task)
        self.assertEqual(memory.message_manager_state.agent_history_items, [worker.NEW_REQUEST])
        # The follow-up's own budget, not offset by the session's total steps so far (W2): a chain of
        # follow-ups would otherwise carry a high n_steps into an offset max_steps and hit browser-use's
        # 75% budget warning on its very first step. The counters this run started from are reset, not
        # the first run's 46 steps carried over.
        self.assertEqual(second.max_steps, 60)
        self.assertEqual(started, {"n_steps": 1, "plan_generation_step": None, "last_compaction_step": None})

    async def test_a_run_without_tuning_runs_the_agent_as_before(self):
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        await self.settled("r1")
        options = FakeAgent.built[0].options
        self.assertEqual(options["extend_system_message"], worker.EXTEND_SYSTEM)
        self.assertFalse({"flash_mode", "max_actions_per_step", "max_history_items"} & options.keys())
        self.assertNotIn("extra_body", options["llm"])

    async def test_tuning_reaches_the_agent_and_the_model(self):
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle.",
                                     "tuning": {"flashMode": True, "maxActionsPerStep": 8, "reasoning": "none",
                                                "provider": ROUTING, "later": 1}})
        await self.settled("r1")
        options = FakeAgent.built[0].options
        self.assertEqual({k: options[k] for k in ("flash_mode", "max_actions_per_step")},
                         {"flash_mode": True, "max_actions_per_step": 8})
        self.assertNotIn("max_history_items", options)  # a trimmed history loses the prompt cache
        self.assertEqual(options["llm"]["extra_body"],
                         {"extra_body": {"reasoning": {"enabled": False}, "provider": SENT_ROUTING}})
        self.assertEqual(options["extend_system_message"], f"{worker.EXTEND_SYSTEM}\n\n{worker.BATCH_HINT}")
        self.assertEqual(worker.tuned_llm_options({"reasoning": "low"}),
                         {"extra_body": {"extra_body": {"reasoning": {"effort": "low"}}}})

    def test_routing_alone_reaches_the_model_and_an_empty_one_changes_nothing(self):
        self.assertEqual(worker.tuned_llm_options(worker.agent_tuning({"provider": {"requireParameters": True}})),
                         {"extra_body": {"extra_body": {"provider": {"require_parameters": True}}}})
        self.assertEqual(worker.agent_tuning({"provider": {"order": [], "later": 1}}), {})
        self.assertEqual(worker.tuned_llm_options(worker.agent_tuning({"provider": {"order": []}})), {})

    def test_checked_tuning_passes_the_check_again_unchanged(self):
        # A follow-up runs the session's stored tuning through the same check.
        tuning = worker.agent_tuning({"reasoning": "none", "provider": {
            "order": ["deepinfra", "deepinfra"], "ignore": ["deepseek", "deepinfra/fp8"], "requireParameters": False}})
        self.assertEqual(tuning["provider"], {"order": ["deepinfra"], "ignore": ["deepseek", "deepinfra/fp8"],
                                              "requireParameters": False})
        self.assertEqual(worker.agent_tuning(tuning), tuning)

    async def test_a_wrong_tuning_is_refused_before_anything_starts(self):
        for tuning in ({"maxActionsPerStep": 50}, {"flashMode": "yes"}, {"reasoning": "lots"},
                       {"maxActionsPerStep": True}, [], {"provider": "deepinfra"}, {"provider": []},
                       {"provider": {"order": "deepinfra"}}, {"provider": {"order": [1]}},
                       {"provider": {"order": ["Deep Infra"]}}, {"provider": {"ignore": [""]}}, {"provider": {"order": ["deepinfra\n"]}},
                       {"provider": {"ignore": [f"host{i}" for i in range(33)]}},
                       {"provider": {"requireParameters": "yes"}}, {"provider": {"requireParameters": 1}}):
            with self.subTest(tuning=tuning):
                response = await self.client.post("/v1/runs", json={
                    "id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle.", "tuning": tuning},
                    headers={"Authorization": f"Bearer {fresh_token()}"})
                self.assertEqual(response.status, 400)
        self.assertEqual((FakeAgent.built, self.worker.runs), ([], {}))

    async def test_a_follow_up_keeps_the_sessions_tuning_and_gets_its_own_system_message(self):
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle.",
                                     "tuning": {"flashMode": True, "reasoning": "none", "provider": ROUTING}})
        await self.settled("r1")
        status, answer = await self.call("POST", "/v1/sessions/s1/messages",
                                         {"text": "Take the red one.", "runId": "r2"})
        self.assertEqual((status, answer["status"]), (200, "started"))
        await self.settled("r2")
        follow_up = FakeAgent.built[-1]
        self.assertEqual(follow_up.options["task"], "Take the red one.")
        self.assertIs(follow_up.options["flash_mode"], True)
        self.assertEqual(follow_up.options["llm"]["extra_body"],
                         {"extra_body": {"reasoning": {"enabled": False}, "provider": SENT_ROUTING}})
        # browser-use would keep the system message saved with the memory over the one this run builds.
        saved = follow_up.options["injected_agent_state"].message_manager_state.history
        self.assertEqual((saved.system_message, saved.state_message, saved.context_messages), (None, None, []))

    async def test_a_follow_up_after_a_restart_runs_with_the_tuning_it_carries(self):
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        await self.settled("r1")
        self.worker.sessions["s1"].options = {}  # what a restarted worker knows of the session
        status, answer = await self.call("POST", "/v1/sessions/s1/messages", {
            "text": "Take the red one.", "runId": "r2", "llm": LLM,
            "tuning": {"reasoning": "none", "provider": ROUTING}})
        self.assertEqual((status, answer["status"]), (200, "started"))
        await self.settled("r2")
        self.assertEqual(FakeAgent.built[-1].options["llm"]["extra_body"],
                         {"extra_body": {"reasoning": {"enabled": False}, "provider": SENT_ROUTING}})
        built = len(FakeAgent.built)
        response = await self.client.post("/v1/sessions/s1/messages", json={
            "text": "And the blue one.", "runId": "r3", "tuning": {"provider": {"order": "deepinfra"}}},
            headers={"Authorization": f"Bearer {fresh_token()}"})
        self.assertEqual(response.status, 400)
        self.assertEqual((len(FakeAgent.built), "r3" in self.worker.runs), (built, False))

    async def test_each_step_records_the_tokens_since_the_last_one(self):
        def entry(prompt, cached, completion):
            return types.SimpleNamespace(usage=types.SimpleNamespace(
                prompt_tokens=prompt, prompt_cached_tokens=cached, completion_tokens=completion))

        async def two_steps(agent, on_step_start):
            agent.token_cost_service = types.SimpleNamespace(usage_history=[entry(20_000, 0, 300)])
            step = agent.options["register_new_step_callback"]
            await step(types.SimpleNamespace(url="https://shop.test/"), types.SimpleNamespace(memory="Search."), 1)
            # The step's own call and an extraction in between.
            agent.token_cost_service.usage_history += [entry(5_000, 0, 100), entry(21_000, 19_000, 250)]
            await step(types.SimpleNamespace(url="https://shop.test/"), types.SimpleNamespace(next_goal="Read."), 2)
            return FakeHistory(True)

        FakeAgent.script = two_steps
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        run = await self.settled("r1")
        self.assertEqual([step["tokens"] for step in run.steps],
                         [{"in": 20_000, "cached": 0, "out": 300, "calls": 1},
                          {"in": 26_000, "cached": 19_000, "out": 350, "calls": 2}])
        self.assertEqual([step["goal"] for step in run.steps], ["Search.", "Read."])

    async def test_the_site_refusing_a_write_reaches_the_next_step_and_each_step_leaves_a_trail(self):
        refused = "The site's server refused POST https://shop.test/api/order: 400 — Введите корректный номер."
        told = [["A line before any step."], [refused], []]

        class Refusals:
            def start(self, url, target=None):
                pass

            def watches(self, target):
                return True

            async def stop(self):
                pass

            def notices(self, secrets):
                return told.pop(0) if told else []

            def report(self, secrets):
                return ""

        async def jpeg(browser):
            return b"\xff\xd8small"

        self.enterContext(mock.patch.object(worker, "SiteErrors", Refusals))
        self.enterContext(mock.patch.object(worker, "page_jpeg", jpeg))
        seen = {}

        async def two_steps(agent, on_step_start):
            step = agent.options["register_new_step_callback"]
            # Step 1: no step before it to hang a line on, so the line is a history item of its own.
            await on_step_start(agent)
            seen["history"] = list(agent.state.message_manager_state.agent_history_items)
            await step(types.SimpleNamespace(url="https://shop.test/cart", title="Корзина"),
                       types.SimpleNamespace(next_goal="Pay as owner-pass.", action=[]), 1)
            agent.state.last_model_output = object()
            agent.state.last_result = [types.SimpleNamespace(error="Typing owner-pass failed.")]
            await agent.on_step_end(agent)
            # Step 2: the refusal goes on step 1's result, which the model reads next. Its output fails.
            await on_step_start(agent)
            seen["result"] = list(agent.state.last_result)
            agent.state.last_result = []
            await agent.on_step_end(agent)
            return FakeHistory(True)

        FakeAgent.script = two_steps
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Order the kettle.",
                                     "secrets": [{"alias": "password", "value": "owner-pass",
                                                  "allowedDomains": ["shop.test"]}]})
        await self.settled("r1")
        self.assertEqual(seen["history"], ["<sys>A line before any step.</sys>"])
        self.assertEqual(seen["result"][-1], {"long_term_memory": refused})
        trail = worker.SESSIONS / worker.disk_name("s1") / worker.TRAIL / "r1"
        lines = [json.loads(line) for line in (trail / "steps.jsonl").read_text().splitlines()]
        self.assertEqual([(line["step"], line.get("shot")) for line in lines], [(1, "001.jpg"), (2, "002.jpg")])
        self.assertEqual((lines[0]["goal"], lines[0]["errors"], lines[0]["url"]),
                         ("Pay as <secret>.", ["Typing <secret> failed."], "https://shop.test/"))
        self.assertNotIn("goal", lines[1])  # a step whose output failed has no summary of its own
        self.assertEqual((trail / "002.jpg").read_bytes(), b"\xff\xd8small")
        self.assertNotIn("owner-pass", (trail / "steps.jsonl").read_text())

    async def test_a_tab_the_agent_moves_into_is_listened_to_from_its_next_step(self):
        # A DeepSeek run on the checkout harness's shop opened the site in a new tab and ordered there: two of
        # its three refused orders were never seen while only the first tab was listened to.
        started = []

        class Listener:
            def __init__(self):
                self.tabs = set()

            def start(self, url, target=None):
                started.append((url, target))
                self.tabs.add(target)

            def watches(self, target):
                return target in self.tabs

            async def stop(self):
                pass

            def notices(self, secrets):
                return []

            def report(self, secrets):
                return ""

        async def page_targets():
            return [{"id": tab, "type": "page", "webSocketDebuggerUrl": f"ws://cdp/{tab}"} for tab in self.chrome.tabs]

        self.enterContext(mock.patch.object(worker, "SiteErrors", Listener))
        self.enterContext(mock.patch.object(worker, "page_targets", page_targets))

        async def moves_to_a_new_tab(agent, on_step_start):
            browser = agent.options["browser_session"]
            await on_step_start(agent)
            browser.agent_focus_target_id = await self.chrome.new_tab()
            await on_step_start(agent)
            await on_step_start(agent)
            return FakeHistory(True)

        FakeAgent.script = moves_to_a_new_tab
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Order the kettle."})
        await self.settled("r1")
        self.assertEqual(started, [("ws://cdp/T1", "T1"), ("ws://cdp/T2", "T2")])

    def test_the_agent_types_a_phone_after_the_fields_own_country_code(self):
        # 04.10: «+7 921 781-88-76» typed after a field's fixed +7 became +7 79217818876, a Kazakh number.
        self.assertIn("type 9217818876", worker.EXTEND_SYSTEM)
        self.assertIn("read the errors the\nform shows", worker.EXTEND_SYSTEM)
        # GPT Luna ended runs with done right before «К оплате» or «Заплатить» (harness, 05.10).
        self.assertIn("Call done only when the request is finished", worker.EXTEND_SYSTEM)

    async def test_a_run_records_the_proxy_bytes_it_moved_and_keeps_them_across_a_restart(self):
        async def browse(agent, on_step_start):
            await on_step_start(agent)
            self.worker.forwarder.totals["up"] += 1_000
            self.worker.forwarder.totals["down"] += 250_000
            return FakeHistory(True)

        self.worker.forwarder.totals.update({"up": 7, "down": 70})  # the exit check before the run
        FakeAgent.script = browse
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        run = await self.settled("r1")
        self.assertEqual(run.public()["traffic"], {"up": 1_000, "down": 250_000})
        self.assertEqual(self.on_disk("r1")["traffic"], {"up": 1_000, "down": 250_000})
        self.assertEqual(worker.Run.load(self.on_disk("r1")).traffic, {"up": 1_000, "down": 250_000})

    async def test_a_run_reports_its_tokens_without_waiting_for_a_price_list(self):
        # browser-use prices usage only with calculate_cost, fetching LiteLLM's list from GitHub and then
        # openrouter.ai: both silent from Cloud.ru, which held finished runs for minutes. Tokens it counts
        # regardless, and Bro prices them itself.
        class Usage:
            def model_dump(self):
                return {"total_prompt_tokens": 12_000, "total_completion_tokens": 800, "total_tokens": 12_800,
                        "total_prompt_cached_tokens": 9_000, "total_cost": 0.0, "entry_count": 4}

        async def counted(agent, on_step_start):
            await on_step_start(agent)
            history = FakeHistory(True)
            history.usage = Usage()
            return history

        FakeAgent.script = counted
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        run = await self.settled("r1")
        self.assertIs(FakeAgent.built[0].options["calculate_cost"], False)
        self.assertEqual(run.public()["usage"], {"total_prompt_tokens": 12_000, "total_completion_tokens": 800,
                                                 "total_tokens": 12_800, "total_prompt_cached_tokens": 9_000})

    async def test_a_run_reports_what_the_service_billed_for_every_call_it_made(self):
        # browser-use counts only the answers it could parse; the service bills the others too.
        class Response:
            def __init__(self, path, body, method="POST"):
                self.request = types.SimpleNamespace(method=method, url=types.SimpleNamespace(path=path))
                self.body = body

            async def aread(self):
                return b""

            def json(self):
                return self.body

        class Usage:
            def model_dump(self):
                return {"total_prompt_tokens": 20_000, "total_completion_tokens": 300, "total_tokens": 20_300,
                        "total_prompt_cached_tokens": 12_000}

        async def billed(agent, on_step_start):
            count = agent.options["llm"]["http_client"]["event_hooks"]["response"][0]
            for response in (Response("/api/v1/chat/completions", {"usage": {"cost": 0.25}, "provider": "DeepInfra"}),
                             # unparsed, billed
                             Response("/api/v1/chat/completions", {"usage": {"cost": 0.5}, "provider": "DeepInfra"}),
                             Response("/api/v1/chat/completions", {"provider": "DeepSeek"}),  # served, no cost
                             Response("/api/v1/chat/completions", {"error": "overloaded"}),
                             Response("/api/v1/chat/completions", {"provider": 7}),
                             Response("/api/v1/models", {"usage": {"cost": 9}, "provider": "X"}, method="GET")):
                await count(response)
            history = FakeHistory(True)
            history.usage = Usage()
            return history

        FakeAgent.script = billed
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        run = await self.settled("r1")
        self.assertEqual(run.public()["usage"], {"total_prompt_tokens": 20_000, "total_completion_tokens": 300,
                                                 "total_tokens": 20_300, "total_prompt_cached_tokens": 12_000,
                                                 "billed": 0.75, "billed_calls": 2,
                                                 "hosts": {"DeepInfra": 2, "DeepSeek": 1}})

    async def test_a_runs_bill_names_a_bounded_number_of_hosts(self):
        billed = worker.Billed()

        class Response:
            request = types.SimpleNamespace(method="POST", url=types.SimpleNamespace(path="/api/v1/chat/completions"))

            def __init__(self, host):
                self.host = host

            async def aread(self):
                return b""

            def json(self):
                return {"provider": self.host}

        for host in [f"Host{i}" for i in range(worker.BILLED_HOSTS_MAX + 3)] + ["Host0", "x" * 65]:
            await billed.count(Response(host))
        self.assertEqual(len(billed.hosts), worker.BILLED_HOSTS_MAX)
        self.assertEqual(billed.hosts["Host0"], 2)
        # Answers that carried no cost at all still say which host served the run.
        self.assertEqual(worker.usage_summary(FakeHistory(False), None, billed), {"hosts": billed.hosts})

    async def test_a_run_without_parsed_usage_still_reports_its_bill(self):
        # Every answer unparseable: browser-use has no usage, the service billed every call all the same.
        class Response:
            request = types.SimpleNamespace(method="POST", url=types.SimpleNamespace(path="/api/v1/chat/completions"))

            async def aread(self):
                return b""

            def json(self):
                return {"usage": {"cost": 0.4}}

        async def unparsed(agent, on_step_start):
            count = agent.options["llm"]["http_client"]["event_hooks"]["response"][0]
            await count(Response())
            return FakeHistory(False)

        FakeAgent.script = unparsed
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        run = await self.settled("r1")
        self.assertEqual(run.public()["usage"], {"billed": 0.4, "billed_calls": 1})

    async def test_a_restart_takes_the_newest_run_and_the_newest_memory(self):
        worker.RUNS.mkdir(parents=True)
        records = [("r1", "2026-09-28T10:00:00Z", {"n_steps": 5, "history": []}),
                   ("r2", "2026-09-28T10:05:00Z", {"n_steps": 9, "history": []}),
                   ("r3", "2026-09-28T10:09:00Z", None)]  # killed before its first step: no checkpoint
        paths = []
        for run_id, created, memory in records:
            record = worker.Run(run_id, "s1", run_id).public() | {"status": "failed", "createdAt": created}
            if memory is not None:
                record["agentState"] = memory
            paths.append(worker.RUNS / f"{run_id}.json")
            paths[-1].write_text(json.dumps(record))
        for order in itertools.permutations(paths):
            with self.subTest([path.stem for path in order]), \
                    mock.patch.object(worker.Path, "glob", lambda self, pattern, order=order: iter(order)):
                session = worker.Worker().sessions["s1"]
                self.assertEqual(session.latest_run_id, "r3")
                self.assertEqual(session.agent_state["n_steps"], 9)

    async def test_a_restart_keeps_true_order_when_runs_tie_on_the_second(self):
        # now_iso() only has 1-second resolution, so a follow-up dispatched right after the
        # previous run settles, or a retried start after a lost create-answer, can share the same
        # createdAt/startedAt with an earlier run of the same session. Ids are random UUIDs with no
        # chronological meaning, so a tie-break that falls back to comparing them (as the old sort
        # key did) picks the wrong "latest" run about as often as the right one. Here the ids are
        # chosen so a plain string sort disagrees with the true creation order, which only `seq`
        # (persisted at creation, restart-independent) can recover.
        worker.RUNS.mkdir(parents=True)
        same = "2026-09-28T10:00:00Z"
        records = [("r-z-older", 0, {"n_steps": 5}), ("r-a-newer", 1, {"n_steps": 9})]
        for run_id, seq, memory in records:
            record = worker.Run(run_id, "s1", run_id).public() | {
                "status": "failed", "createdAt": same, "startedAt": same,
                "seq": seq, "agentState": memory,
            }
            (worker.RUNS / f"{run_id}.json").write_text(json.dumps(record))
        session = worker.Worker().sessions["s1"]
        self.assertEqual(session.latest_run_id, "r-a-newer")
        self.assertEqual(session.agent_state["n_steps"], 9)

    async def test_a_message_is_read_before_the_next_step_and_never_on_the_last(self):
        for max_steps, read in [(3, True), (2, False)]:
            with self.subTest(max_steps=max_steps):
                in_step, go_on = asyncio.Event(), asyncio.Event()

                async def two_steps(agent, on_step_start):
                    for _ in range(2):
                        await on_step_start(agent)
                        if agent.state.n_steps == 1:
                            in_step.set()
                            await go_on.wait()
                        agent.state.n_steps += 1
                    return FakeHistory(True)

                FakeAgent.built, FakeAgent.script = [], two_steps
                run_id, session_id = f"r-{max_steps}", f"s-{max_steps}"
                await self.worker.start_run({"id": run_id, "sessionId": session_id, "llm": LLM,
                                             "task": "Find a kettle.", "maxSteps": max_steps})
                await self.reached(in_step)
                self.assertEqual(await self.call("POST", f"/v1/sessions/{session_id}/messages", {"text": "Red one."}),
                                 (200, {"sessionId": session_id, "status": "queued", "runId": run_id}))
                go_on.set()
                run = await self.settled(run_id)
                self.assertEqual(FakeAgent.built[0].added, ["Red one."] if read else [])
                self.assertEqual(run.unread_messages, [] if read else ["Red one."])
                if not read:
                    # The worker never starts a follow-up itself (D1): the message stays only on the
                    # terminal record, for Bro to act on.
                    self.assertIsNone(self.worker.runs.get(f"{run_id}.next"))

    async def test_messages_the_run_never_read_are_recorded_as_unread_not_started(self):
        in_step, go_on, in_teardown, finish = asyncio.Event(), asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def last_step(agent, on_step_start):
            await on_step_start(agent)
            in_step.set()
            await go_on.wait()  # the model already chose `done`
            agent.state.n_steps += 1
            return FakeHistory(True)

        async def teardown():
            in_teardown.set()
            await finish.wait()

        FakeAgent.script, self.stop_hook = last_step, teardown
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        await self.reached(in_step)
        queued = (200, {"sessionId": "s1", "status": "queued", "runId": "r1"})
        self.assertEqual(await self.call("POST", "/v1/sessions/s1/messages", {"text": "Red one."}), queued)
        go_on.set()
        await self.reached(in_teardown)
        self.assertEqual(await self.call("POST", "/v1/sessions/s1/messages", {"text": "Under 3000."}), queued)
        finish.set()
        run = await self.settled("r1")
        # D1: the worker itself never starts a follow-up run; the unread texts sit on r1's own record,
        # for Bro to start "r1.next" (or not) itself.
        self.assertEqual(run.unread_messages, ["Red one.", "Under 3000."])
        self.assertEqual((await self.call("GET", "/v1/runs/r1"))[1]["unreadMessages"],
                         ["Red one.", "Under 3000."])
        self.assertEqual(self.on_disk("r1")["unreadMessages"], ["Red one.", "Under 3000."])
        self.assertIsNone(self.worker.runs.get("r1.next"))
        self.assertEqual(len(FakeAgent.built), 1)
        self.assertEqual((await self.call("GET", "/v1/sessions/s1"))[1]["latestRunId"], "r1")
        self.assertFalse(self.worker.busy())

    async def test_a_message_read_just_before_a_cancel_lands_mid_step_is_not_lost(self):
        in_step, go_on = asyncio.Event(), asyncio.Event()

        async def interrupted_after_reading(agent, on_step_start):
            await on_step_start(agent)  # step 1: nothing queued yet
            in_step.set()
            await go_on.wait()
            agent.state.n_steps += 1
            await on_step_start(agent)  # step 2: "Red one." is queued now, and gets drained here
            # A cancel (or the deadline) lands here, mid-step, after `read_messages` already checked
            # `should_stop()` and handed the message to the live agent: browser_use's own
            # `_check_stop_or_pause` raises InterruptedError during the LLM call or an action, and
            # `_handle_step_error` swallows it, only marking `agent.state.stopped` and ending the run
            # without ever finishing this step.
            self.worker.runs["r1"].cancel_requested = True
            agent.state.stopped = True
            agent.state.n_steps += 1
            return FakeHistory(False)

        FakeAgent.built, FakeAgent.script = [], interrupted_after_reading
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        await self.reached(in_step)
        self.assertEqual(await self.call("POST", "/v1/sessions/s1/messages", {"text": "Red one."}),
                         (200, {"sessionId": "s1", "status": "queued", "runId": "r1"}))
        go_on.set()
        run = await self.settled("r1")
        # It really was handed to the live agent's history (the read that can no longer be undone)...
        self.assertEqual(FakeAgent.built[0].added, ["Red one."])
        # ...but the step that read it never finished, so it must still be visible to Bro, not silently
        # dropped just because it is no longer sitting in `run.messages`.
        self.assertEqual(run.unread_messages, ["Red one."])
        self.assertEqual(self.on_disk("r1")["unreadMessages"], ["Red one."])

    async def test_a_message_after_the_run_is_terminal_starts_like_an_idle_session(self):
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        await self.settled("r1")
        status, answer = await self.call("POST", "/v1/sessions/s1/messages", {"text": "Track my order."})
        self.assertEqual(status, 200)
        self.assertEqual(answer["status"], "started")
        self.assertNotEqual(answer["runId"], "r1")  # not queued into the run that already ended
        await self.settled(answer["runId"])
        self.assertEqual(FakeAgent.built[-1].options["task"], "Track my order.")
        self.assertEqual((await self.call("GET", "/v1/sessions/s1"))[1]["latestRunId"], answer["runId"])

    async def test_a_follow_up_into_an_idle_session_keeps_the_secrets_the_session_already_has(self):
        # The idle-session path (`session_message`) never resends `secrets` — its constructed body
        # carries only `session.options` — so an omitted `secrets` on the follow-up run this starts
        # must not wipe the binding the first run was created with.
        binding = [{"alias": "site_password", "allowedDomains": ["shop.test"], "value": "hunter2"}]
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle.",
                                     "secrets": binding})
        await self.settled("r1")
        status, answer = await self.call("POST", "/v1/sessions/s1/messages", {"text": "Finish signing in."})
        self.assertEqual(status, 200)
        self.assertEqual(answer["status"], "started")
        await self.settled(answer["runId"])
        self.assertEqual(FakeAgent.built[0].options["sensitive_data"], {"https://*.shop.test": {
            "site_password": "hunter2"}})
        # The follow-up run must resolve the same secret, not silently lose it.
        self.assertEqual(FakeAgent.built[-1].options["sensitive_data"], {"https://*.shop.test": {
            "site_password": "hunter2"}})

    async def test_park_forgets_every_secret_in_memory(self):
        binding = [{"alias": "site_password", "allowedDomains": ["shop.test"], "value": "hunter2"}]
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle.",
                                     "secrets": binding, "captcha": {"twoCaptchaKey": "2c"},
                                     "jev": {"apiKey": "jev-key"}, "maxSteps": 5})
        await self.settled("r1")
        tunnel = mock.Mock()
        self.worker.forwarder.open.add(tunnel)  # a CONNECT in flight holds the login in its handler
        self.assertEqual(await self.call("POST", "/v1/park"), (200, {"parked": True}))
        tunnel.close.assert_called_once()
        session = self.worker.sessions["s1"]
        self.assertIsNone(self.worker.forwarder.upstream)  # Chrome gets 502 until the next POST /v1/session
        self.assertEqual((session.llm, session.captcha, session.sensitive_data), (None, None, None))
        self.assertEqual(session.options["maxSteps"], 5)
        self.assertNotIn("jev", session.options)
        # After the restore Bro sends the model again: until then a follow-up is refused, not run keyless.
        status, answer = await self.call("POST", "/v1/sessions/s1/messages", {"text": "Go on."})
        self.assertEqual((status, answer["error"]), (409, "session has no model; start a run"))

    async def test_park_under_runc_closes_chrome_and_waits_for_the_next_one(self):
        # SIGTERM makes Chrome end the session without writing its cookie store; Browser.close writes it.
        answers = iter([True, True, False, False, True])
        ready = mock.AsyncMock(side_effect=lambda *args: next(answers))
        closed = mock.AsyncMock(return_value={})
        with mock.patch.object(worker, "chrome_ready", ready), \
                mock.patch.object(worker, "cdp_command", closed), \
                mock.patch.object(worker, "browser_socket", mock.AsyncMock(return_value="ws://chrome")):
            self.assertEqual(await self.call("POST", "/v1/park", {"closeChrome": True}),
                             (200, {"parked": True, "chrome": "closed"}))
        closed.assert_awaited_once_with("ws://chrome", "Browser.close", timeout=10)
        self.assertEqual(ready.await_count, 5)  # old one gone, new one up
        self.assertIsNone(self.worker.forwarder.upstream)

    async def test_park_without_close_leaves_chrome_alone(self):
        closed = mock.AsyncMock()
        with mock.patch.object(worker, "cdp_command", closed):
            self.assertEqual(await self.call("POST", "/v1/park", {}), (200, {"parked": True}))
            self.assertEqual(await self.call("POST", "/v1/park", [1]), (400, {"error": "body must be an object"}))
        closed.assert_not_awaited()

    async def test_park_is_refused_while_a_run_works(self):
        in_step, go_on = asyncio.Event(), asyncio.Event()

        async def held(agent, on_step_start):
            await on_step_start(agent)
            in_step.set()
            await go_on.wait()
            agent.state.n_steps += 1
            return FakeHistory(True)

        FakeAgent.script = held
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        await self.reached(in_step)
        self.assertEqual(await self.call("POST", "/v1/park"), (409, {"error": "busy"}))
        self.assertIsNotNone(self.worker.forwarder.upstream)
        self.worker.runs["r1"].cancel_requested = True  # cancelling is still working
        self.assertEqual((await self.call("POST", "/v1/park"))[0], 409)
        go_on.set()
        await self.settled("r1")
        self.assertEqual((await self.call("POST", "/v1/park"))[0], 200)

    async def test_a_second_post_runs_in_the_same_session_without_secrets_keeps_the_first_ones(self):
        # A retried `POST /v1/runs` in the same session whose caller happens not to resend `secrets`
        # must not clear the session's binding either — only a request that actually supplies `secrets`
        # (even `[]`, to clear them on purpose) may change it.
        binding = [{"alias": "site_password", "allowedDomains": ["shop.test"], "value": "hunter2"}]
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle.",
                                     "secrets": binding})
        await self.settled("r1")
        await self.worker.start_run({"id": "r2", "sessionId": "s1", "llm": LLM, "task": "Enter the code 1234."})
        await self.settled("r2")
        self.assertEqual(FakeAgent.built[-1].options["sensitive_data"], {"https://*.shop.test": {
            "site_password": "hunter2"}})

    async def test_a_message_after_the_run_is_terminal_is_409_when_the_worker_is_busy(self):
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        await self.settled("r1")
        in_step, go_on = asyncio.Event(), asyncio.Event()

        async def holds(agent, on_step_start):
            await on_step_start(agent)
            in_step.set()
            await go_on.wait()
            agent.state.n_steps += 1
            return FakeHistory(True)

        FakeAgent.script = holds
        await self.worker.start_run({"id": "r2", "sessionId": "s2", "llm": LLM, "task": "Track it."})
        await self.reached(in_step)
        # r1 is terminal, but a different session's run holds the one browser: not queued into r1 either.
        self.assertEqual(await self.call("POST", "/v1/sessions/s1/messages", {"text": "Cancel my order."}),
                         (409, {"error": "busy", "runId": "r2"}))
        go_on.set()
        await self.settled("r2")

    async def test_a_cancel_waits_for_the_run_and_refuses_messages_meanwhile(self):
        in_step, step_ends = asyncio.Event(), asyncio.Event()

        async def until_stopped(agent, on_step_start):
            await on_step_start(agent)
            in_step.set()
            await step_ends.wait()  # the step in flight when the cancel came
            return FakeHistory(False)

        FakeAgent.script = until_stopped
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        await self.reached(in_step)
        cancel = asyncio.create_task(self.call("POST", "/v1/runs/r1/cancel"))
        for _ in range(500):
            if self.worker.runs["r1"].cancel_requested:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(await self.call("POST", "/v1/sessions/s1/messages", {"text": "Red one."}),
                         (409, {"error": "busy", "runId": "r1"}))
        self.assertFalse(cancel.done())
        step_ends.set()
        status, run = await cancel
        self.assertEqual((status, run["status"], run["unreadMessages"]), (200, "cancelled", []))
        FakeAgent.script = one_step
        follow_up, created = await self.worker.start_run({"id": "r2", "sessionId": "s1", "llm": LLM,
                                                          "task": "Pay with the card."})
        self.assertTrue(created)
        await self.settled("r2")

    async def test_a_step_that_hangs_past_the_budget_is_cut_off_and_frees_the_browser(self):
        self.enterContext(mock.patch.object(worker, "OVERRUN_S", 0))
        in_step = asyncio.Event()

        async def hangs(agent, on_step_start):
            await on_step_start(agent)
            in_step.set()
            await asyncio.Event().wait()  # a step browser-use could not time out

        FakeAgent.script = hangs
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a phone.",
                                     "timeoutSeconds": 1})
        await self.reached(in_step)
        run = await self.settled("r1")
        self.assertEqual((run.status, run.error), ("failed", "The run ran out of its time budget."))
        self.assertFalse(self.worker.busy())
        FakeAgent.script = one_step
        _, created = await self.worker.start_run({"id": "r2", "sessionId": "s1", "llm": LLM,
                                                  "task": "Open the first one."})
        self.assertTrue(created)
        self.assertEqual((await self.settled("r2")).status, "completed")

    async def test_a_cancel_cuts_off_a_hung_step_and_restarts_chrome_under_one_that_ignores_it(self):
        self.enterContext(mock.patch.object(worker, "CANCEL_WAIT_S", 0.2))
        self.enterContext(mock.patch.object(worker, "UNWIND_S", 0.2))
        chrome_gone, in_step = asyncio.Event(), asyncio.Event()

        async def restart(action, unit="bro-chrome"):
            chrome_gone.set()
            return 0, ""

        self.enterContext(mock.patch.object(worker, "systemctl", restart))

        async def ignores_the_cancel(agent, on_step_start):
            await on_step_start(agent)
            in_step.set()
            while not chrome_gone.is_set():  # a CDP call that swallows the cancel
                with contextlib.suppress(asyncio.CancelledError):
                    await asyncio.sleep(0.05)
            raise ConnectionError("CDP connection closed")

        FakeAgent.script = ignores_the_cancel
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a phone."})
        await self.reached(in_step)
        status, run = await self.call("POST", "/v1/runs/r1/cancel")
        self.assertEqual((status, run["status"], run["error"]), (200, "cancelled", "Stopped by Bro."))
        self.assertTrue(chrome_gone.is_set())
        self.assertFalse(self.worker.busy())

    async def test_the_session_follows_the_agent_into_a_tab_it_opened(self):
        async def opens_a_tab(agent, on_step_start):
            await on_step_start(agent)
            self.chrome.tabs.append("T-new")  # a link with target=_blank
            agent.options["browser_session"].agent_focus_target_id = "T-new"
            await self.call("POST", "/v1/tabs")  # meanwhile Bro opens a tab for a keep-alive visit
            agent.state.n_steps += 1
            return FakeHistory(True)

        FakeAgent.script = opens_a_tab
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Open the offer."})
        await self.settled("r1")
        session = self.worker.sessions["s1"]
        self.assertEqual((session.tab, session.tabs), ("T-new", {"T1", "T-new"}))
        self.assertEqual(self.chrome.shots, ["T-new"])  # the result's screenshot is of the agent's page
        self.assertEqual((await self.call("POST", "/v1/sessions/s1/release"))[1], {"status": "stopped"})
        self.assertEqual(sorted(self.chrome.closed), ["T-new", "T1"])
        self.assertEqual(self.chrome.tabs, ["T2"])  # the keep-alive tab is not the errand's

    async def test_a_restarted_worker_keeps_the_session_tab_chrome_still_has(self):
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Sign in."})
        await self.settled("r1")
        self.worker = self.restart()
        await self.worker.adopt_tabs()
        self.assertEqual((await self.call("GET", "/v1/sessions/s1"))[1]["tabOpen"], True)
        self.assertEqual(self.worker.sessions["s1"].tab, "T1")
        self.chrome.tabs.clear()  # the VM restarted too: its Chrome has none of the tabs
        self.worker = self.restart()
        await self.worker.adopt_tabs()
        self.assertEqual((await self.call("GET", "/v1/sessions/s1"))[1]["tabOpen"], False)

    async def test_the_machine_details_need_a_token_and_walk_the_profile_off_the_loop(self):
        walks = []

        def walk():
            walks.append(threading.get_ident())
            return 12.5

        with mock.patch.object(worker, "profile_mb", walk):
            self.assertEqual((await self.client.get("/v1/health?machine=1")).status, 401)
            plain = await self.client.get("/v1/health")
            self.assertNotIn("profileMb", await plain.json())
            for _ in range(2):
                status, details = await self.call("GET", "/v1/health?machine=1")
                self.assertEqual((status, details["profileMb"]), (200, 12.5))
                self.assertIn("memoryMb", details)
        self.assertEqual(len(walks), 1)  # the minute's second answer reuses the walk
        self.assertNotEqual(walks[0], threading.get_ident())  # not on the loop the forwarder shares

    async def test_an_exit_whose_megabyte_did_not_come_through_keeps_its_address(self):
        ipinfo = {"ip": "95.24.1.1", "city": "Moscow", "region": "Moscow", "country": "RU", "org": "AS8402"}
        megabyte = b"x" * 1_000_000
        cases = {
            "slow megabyte": (ipinfo, asyncio.TimeoutError(), {**ipinfo, "speedError": "TimeoutError: "}),
            "no ipinfo": (aiohttp.ClientConnectionError("refused"), megabyte,
                          {"error": "ClientConnectionError: refused"}),
            "both": (ipinfo, megabyte, ipinfo),
        }
        for case, (address, speed, expected) in cases.items():
            with self.subTest(case), mock.patch.object(worker, "aiohttp", ExitProbe(address, speed)):
                status, answer = await self.call("POST", "/v1/session", {"proxy": {"host": "proxy.test", "port": 1}})
                exit_address = answer["exit"]
                self.assertEqual(status, 200)
                self.assertEqual({k: v for k, v in exit_address.items() if k not in ("latencyMs", "mbps")}, expected)
                self.assertEqual("mbps" in exit_address, case == "both")
                self.assertEqual("latencyMs" in exit_address, case != "no ipinfo")

    async def test_a_run_the_disk_cannot_record_fails_and_lets_go_of_the_browser(self):
        worker.RUNS.mkdir(parents=True)
        stale = worker.Run("r0", "s0", "Sign in.").public() | {"status": "running"}
        (worker.RUNS / "r0.json").write_text(json.dumps(stale))
        with mock.patch.object(worker.Run, "save", side_effect=OSError(28, "No space left on device")), \
                self.assertLogs("bro-worker", "ERROR"):
            self.worker = self.restart()  # a record it cannot rewrite does not keep the worker from starting
            self.assertEqual(self.worker.runs["r0"].status, "failed")
            run, created = await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM,
                                                        "task": "Find a kettle."})
            self.assertTrue(created)
            await self.settled("r1")
            self.assertEqual((run.status, run.error), ("failed", "OSError: [Errno 28] No space left on device"))
            self.assertEqual(FakeAgent.built, [])
            self.assertFalse(self.worker.busy())
        await self.worker.start_run({"id": "r2", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        self.assertEqual((await self.settled("r2")).status, "completed")

    async def test_a_run_whose_page_text_holds_half_an_emoji_is_still_recorded(self):
        # An agent's `evaluate` that cut a product name with `.slice(0, 80)` returns half a surrogate pair.
        async def half_an_emoji(agent, on_step_start):
            await on_step_start(agent)
            agent.state.n_steps += 1
            agent.state.message_manager_state.agent_history_items.append("Чайник \ud83d")
            return FakeHistory(True, result="Чайник \ud83d")

        FakeAgent.script = half_an_emoji
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        await self.settled("r1")
        restarted = self.restart()
        self.assertEqual((restarted.runs["r1"].status, restarted.runs["r1"].result), ("completed", "Чайник \ud83d"))
        self.assertEqual(restarted.sessions["s1"].agent_state["history"], ["Чайник \ud83d"])

    async def test_an_update_does_not_cut_off_a_run_that_started_while_it_was_checked(self):
        worker.CODE.write_text("OLD = 1\n")
        in_step, go_on = asyncio.Event(), asyncio.Event()

        async def held(agent, on_step_start):
            await on_step_start(agent)
            in_step.set()
            await go_on.wait()
            agent.state.n_steps += 1
            return FakeHistory(True)

        FakeAgent.script = held
        update = asyncio.create_task(self.update(b"import time\ntime.sleep(1)\n"))  # a check that takes a second
        for _ in range(500):
            if worker.CODE.with_suffix(".new").exists():
                break
            await asyncio.sleep(0.01)
        await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        await self.reached(in_step)
        self.assertEqual((await update)[0], 409)
        self.assertEqual(worker.CODE.read_text(), "OLD = 1\n")
        go_on.set()
        await self.settled("r1")
        self.exits.assert_not_called()

    async def test_an_update_first_writes_the_end_of_a_run_the_disk_refused(self):
        worker.CODE.write_text("OLD = 1\n")
        save, refusing = worker.Run.save, [True]
        in_step, go_on = asyncio.Event(), asyncio.Event()

        def flaky_save(run, agent_state=None):
            if refusing[0] and run.status in worker.TERMINAL:
                raise OSError(5, "Input/output error")
            save(run, agent_state)

        async def last_step(agent, on_step_start):
            await on_step_start(agent)
            in_step.set()
            await go_on.wait()  # the model already chose `done`
            agent.state.n_steps += 1
            return FakeHistory(True)

        FakeAgent.script = last_step
        with mock.patch.object(worker.Run, "save", flaky_save), self.assertLogs("bro-worker", "ERROR"):
            await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
            await self.reached(in_step)
            await self.call("POST", "/v1/sessions/s1/messages", {"text": "Red one."})
            go_on.set()
            run = await self.settled("r1")
            # The refused write neither holds the browser nor drops the message the run never read: it
            # stays on the record, in memory, as unread (D1 — the worker does not start a follow-up).
            self.assertEqual(run.unread_messages, ["Red one."])
            self.assertFalse(self.worker.busy())
            self.assertEqual(self.on_disk("r1")["status"], "running")  # the disk still has the stale record
            self.assertEqual((await self.update(b"NEW = 1\n"))[0], 503)
            self.assertEqual(worker.CODE.read_text(), "OLD = 1\n")
            refusing[0] = False
            self.assertEqual((await self.update(b"NEW = 1\n"))[0], 200)
        self.assertEqual(self.on_disk("r1")["status"], "completed")
        self.assertEqual(self.on_disk("r1")["unreadMessages"], ["Red one."])

    async def test_a_stop_during_the_last_screenshot_records_what_the_run_came_to(self):
        shooting, shot = asyncio.Event(), asyncio.Event()

        async def slow_screenshot(target, quality=80):
            shooting.set()
            await shot.wait()
            return b"jpeg"

        with mock.patch.object(worker, "screenshot", slow_screenshot):
            await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
            await self.reached(shooting)
            self.worker.stop_runs()  # systemd stops the worker (a power-off) meanwhile
            self.assertEqual((self.on_disk("r1")["status"], self.on_disk("r1")["result"]), ("completed", "done"))
            shot.set()
            await self.settled("r1")

    async def test_a_stop_during_the_last_screenshot_does_not_drop_a_message_it_captured(self):
        shooting, shot = asyncio.Event(), asyncio.Event()
        saves, save = [], worker.Run.save

        def counting_save(run, agent_state=None):
            save(run, agent_state)
            saves.append(run.unread_messages)

        async def slow_screenshot(target, quality=80):
            shooting.set()
            await shot.wait()
            return b"jpeg"

        with mock.patch.object(worker, "screenshot", slow_screenshot), \
             mock.patch.object(worker.Run, "save", counting_save):
            await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
            await self.reached(shooting)
            await self.call("POST", "/v1/sessions/s1/messages", {"text": "Red one."})
            self.worker.stop_runs()  # systemd stops the worker (a power-off) meanwhile: it captures the
            # message correctly, on disk and in memory, before the screenshot below ever resolves.
            self.assertEqual(self.on_disk("r1")["unreadMessages"], ["Red one."])
            baseline = len(saves)
            shot.set()  # now let `execute`'s own coroutine resume and reach its finally block's tail
            for _ in range(500):
                if len(saves) > baseline:
                    break
                await asyncio.sleep(0.01)
            else:
                self.fail("the paused screenshot's coroutine never resumed")
            # The resumed coroutine must not re-derive `unreadMessages` from `run.messages`, which
            # `stop_runs` already drained to `[]`, overwriting the message it correctly captured (D1).
            self.assertEqual(self.worker.runs["r1"].unread_messages, ["Red one."])
            self.assertEqual(self.on_disk("r1")["unreadMessages"], ["Red one."])

    async def test_a_stop_while_run_agent_is_still_in_flight_is_not_overwritten_when_it_resumes(self):
        in_step, go_on = asyncio.Event(), asyncio.Event()
        saves, save = [], worker.Run.save

        def counting_save(run, agent_state=None):
            save(run, agent_state)
            saves.append((run.status, run.error))

        async def held_mid_step(agent, on_step_start):
            await on_step_start(agent)
            in_step.set()
            await go_on.wait()
            agent.state.n_steps += 1
            return FakeHistory(True)  # once released, the stray coroutine decides it is done

        FakeAgent.script = held_mid_step
        with mock.patch.object(worker.Run, "save", counting_save):
            await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
            await self.reached(in_step)
            # systemd's SIGTERM path (`stop_runs`) finalizes the run synchronously while this coroutine is
            # still suspended earlier, inside `run_agent` (e.g. an in-flight LLM call): `run.outcome` is
            # not set yet, so it falls back to its own generic status and writes that to disk right away.
            self.worker.stop_runs()
            self.assertEqual(self.worker.runs["r1"].status, "failed")
            stopped_error = self.on_disk("r1")["error"]
            self.assertEqual(self.on_disk("r1")["status"], "failed")
            baseline = len(saves)
            go_on.set()  # the stray coroutine resumes and, on its own, concludes the run is "cancelled"
            # `settled()` alone would return the instant `stop_runs` set `run.status`, before the resumed
            # coroutine even reaches its own finally block: wait for that coroutine's own save instead.
            for _ in range(500):
                if len(saves) > baseline:
                    break
                await asyncio.sleep(0.01)
            else:
                self.fail("the stray coroutine never resumed")
        run = self.worker.runs["r1"]
        # `stop_runs`'s write (already on disk) must not be silently replaced by the resumed coroutine's
        # own, different conclusion (`run.cancel_requested` makes `run_agent` report "cancelled", not
        # the "completed" its own `FakeHistory(True)` would otherwise mean).
        self.assertEqual(run.status, "failed")
        self.assertEqual(run.error, stopped_error)
        self.assertNotEqual(run.error, "Stopped by Bro.")  # run_agent's own conclusion, not stop_runs's
        self.assertEqual(self.on_disk("r1")["status"], "failed")
        self.assertEqual(self.on_disk("r1")["error"], stopped_error)

    async def test_an_update_that_does_not_load_is_refused_and_one_that_does_keeps_the_code_it_replaced(self):
        worker.CODE.write_text("OLD = 1\n")
        status, errors = await self.update(b"import no_such_module_of_bro\n")  # compiles, fails on import
        self.assertEqual(status, 400)
        self.assertIn("No module named 'no_such_module_of_bro'", errors)
        self.assertEqual(worker.CODE.read_text(), "OLD = 1\n")
        self.assertFalse(worker.PREVIOUS_CODE.exists())
        status, answer = await self.update(b"NEW = 1\n")
        self.assertEqual((status, json.loads(answer)), (200, {"updated": True, "restarting": True}))
        self.assertEqual((worker.CODE.read_text(), worker.PREVIOUS_CODE.read_text()), ("NEW = 1\n", "OLD = 1\n"))
        # Nothing starts in the moment before the exit, and no second update replaces the kept code.
        with self.assertRaises(worker.web.HTTPConflict):
            await self.worker.start_run({"id": "r1", "sessionId": "s1", "llm": LLM, "task": "Find a kettle."})
        self.assertEqual((await self.update(b"NEWER = 1\n"))[0], 409)
        await asyncio.sleep(0.6)
        self.exits.assert_called_once_with(0)

    async def test_an_update_whose_lazy_imports_the_image_lacks_is_refused(self):
        # The load check runs top-level code only, and browser-use, OpenCV and numpy are imported inside
        # functions: the worker itself, as a candidate, imports them there, so a file the image cannot run
        # (here, where browser-use is not installed) is refused instead of started to fail every errand.
        worker.CODE.write_text("OLD = 1\n")
        status, errors = await self.update(Path(worker.__file__).read_bytes())
        self.assertEqual(status, 400)
        self.assertIn("No module named 'browser_use'", errors)
        self.assertEqual(worker.CODE.read_text(), "OLD = 1\n")

    def test_the_candidate_check_imports_every_lazy_import_and_its_names(self):
        modules = {name: types.SimpleNamespace(**{attr: object() for attr in attrs})
                   for name, attrs in worker.CANDIDATE_IMPORTS}
        with mock.patch.dict(sys.modules, modules):
            worker.check_candidate_imports()
            del modules["browser_use.agent.views"].AgentState
            with self.assertRaises(AttributeError):
                worker.check_candidate_imports()
        source = Path(worker.__file__).read_text()
        lazy = set(re.findall(r"^\s+(?:from ([\w.]+) import|import ([\w.]+))", source, re.MULTILINE))
        top = set(re.findall(r"^(?:from|import) ([\w.]+)", source, re.MULTILINE))
        lazy = {module or plain for module, plain in lazy} - top - {"random", "importlib"}
        self.assertEqual(lazy, {name for name, _ in worker.CANDIDATE_IMPORTS})


class CdpTest(unittest.IsolatedAsyncioTestCase):
    """The CDP endpoint's own scoping. A token minted for one session, or for one keep-alive tab
    (`b:<targetId>`), is handed to code that should reach nothing else (`signBrowserVmToken`'s own doc
    comment) — its signature checks out the same as any other token, so `cdp_json` and `cdp_socket`
    must themselves refuse a target or a browser-level socket outside that scope."""

    async def asyncSetUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for target, name, value in [
            (worker, "ROOT", root), (worker, "RUNS", root / "runs"), (worker, "SESSIONS", root / "sessions"),
            (worker, "UPLOADS", root / "uploads"), (worker, "GENERATION_FILE", root / "generation"),
            (worker, "TABS_FILE", root / "tabs.json"), (worker, "load_config", lambda: CONFIG),
            (worker, "chrome_ready", mock.AsyncMock(return_value=True)), (worker, "worker", None),
        ]:
            self.enterContext(mock.patch.object(target, name, value))
        worker.worker = worker.Worker()
        # What chrome_json("/json/list") and ("/json/version") would answer, kept in step with the
        # sessions this test opens below.
        self.tabs = {}

        async def fake_chrome_json(path, timeout=5):
            if path == "/json/version":
                return {"webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/BROWSER-ID"}
            self.assertEqual(path, "/json/list")
            return list(self.tabs.values())

        self.enterContext(mock.patch.object(worker, "chrome_json", fake_chrome_json))
        self.client = TestClient(TestServer(worker.application()))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    def open_tab(self, tab, session_id=None):
        """A page target Chrome holds, kept in a session's own tab when `session_id` is given."""
        self.tabs[tab] = {"id": tab, "type": "page",
                           "webSocketDebuggerUrl": f"ws://127.0.0.1:9222/devtools/page/{tab}"}
        if session_id is not None:
            session = worker.worker.sessions[session_id] = worker.Session(session_id)
            session.tab = tab

    async def json_list(self, token):
        response = await self.client.get(f"/v1/cdp/{token}/json")
        return response.status, await response.json()

    async def json_version(self, token):
        return await self.client.get(f"/v1/cdp/{token}/json/version")

    async def devtools(self, token, kind, target):
        # The handler raises before ever upgrading the connection when the scope check fails, so a
        # plain GET (no WebSocket handshake) is enough to read that refusal.
        return await self.client.get(f"/v1/cdp/{token}/devtools/{kind}/{target}")

    async def test_json_list_hides_another_sessions_tab_from_a_session_scoped_token(self):
        self.open_tab("T1", "s1")
        self.open_tab("T2", "s2")

        status, targets = await self.json_list(cdp_token(ses="s1"))

        self.assertEqual(status, 200)
        self.assertEqual([t["id"] for t in targets], ["T1"])

    async def test_json_list_hides_every_tab_from_a_keep_alive_scoped_token_whose_tab_is_gone(self):
        self.open_tab("T1", "s1")

        # The keep-alive tab this token names has since been closed: nothing is left to show, rather
        # than falling back to another session's page.
        status, targets = await self.json_list(cdp_token(ses="b:T9"))

        self.assertEqual((status, targets), (200, []))

    async def test_json_list_keeps_its_own_full_listing_for_an_unscoped_token(self):
        self.open_tab("T1", "s1")
        self.open_tab("T2", "s2")

        status, targets = await self.json_list(cdp_token())

        self.assertEqual(status, 200)
        self.assertEqual({t["id"] for t in targets}, {"T1", "T2"})

    async def test_json_version_refuses_a_session_scoped_token(self):
        self.open_tab("T1", "s1")

        response = await self.json_version(cdp_token(ses="s1"))

        self.assertEqual(response.status, 403)

    async def test_json_version_allows_an_unscoped_token(self):
        response = await self.json_version(cdp_token())

        self.assertEqual(response.status, 200)
        data = await response.json()
        self.assertIn("/devtools/browser/BROWSER-ID", data["webSocketDebuggerUrl"])

    async def test_socket_urls_keep_the_pool_hosts_sandbox_prefix(self):
        # Behind a pool host's Caddy the worker lives under /g/<sandbox>/, which Caddy strips.
        self.open_tab("T1", "s1")
        token = cdp_token()

        response = await self.client.get(f"/v1/cdp/{token}/json", headers={"X-Forwarded-Prefix": "/g/ws-abc"})
        targets = await response.json()
        version = await (await self.client.get(f"/v1/cdp/{token}/json/version",
                                                headers={"X-Forwarded-Prefix": "/g/ws-abc"})).json()

        self.assertTrue(targets[0]["webSocketDebuggerUrl"].endswith(f"/g/ws-abc/v1/cdp/{token}/devtools/page/T1"))
        self.assertIn(f"/g/ws-abc/v1/cdp/{token}/devtools/browser/", version["webSocketDebuggerUrl"])

    async def test_socket_urls_ignore_a_prefix_that_is_not_a_sandbox_path(self):
        self.open_tab("T1", "s1")
        token = cdp_token()

        response = await self.client.get(f"/v1/cdp/{token}/json", headers={"X-Forwarded-Prefix": "//evil.example"})
        targets = await response.json()

        self.assertRegex(targets[0]["webSocketDebuggerUrl"], rf"^wss://[^/]+/v1/cdp/{token}/devtools/page/T1$")

    async def test_devtools_socket_refuses_another_sessions_tab(self):
        self.open_tab("T1", "s1")
        self.open_tab("T2", "s2")

        response = await self.devtools(cdp_token(ses="s1"), "page", "T2")

        self.assertEqual(response.status, 403)

    async def test_devtools_socket_refuses_the_browser_level_socket_for_a_scoped_token(self):
        self.open_tab("T1", "s1")

        response = await self.devtools(cdp_token(ses="s1"), "browser", "BROWSER-ID")

        self.assertEqual(response.status, 403)


class ExitProbe:
    """aiohttp as the exit check sees it: ipinfo.io's answer and the megabyte, each a value or an error."""

    ClientTimeout = aiohttp.ClientTimeout

    def __init__(self, ipinfo, megabyte):
        self.answers = {"https://ipinfo.io/": ipinfo, "https://speed.cloudflare.com/": megabyte}

    def ClientSession(self):  # noqa: N802 - aiohttp's name
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *error):
        return False

    @contextlib.asynccontextmanager
    async def get(self, url, **options):
        answer = next(value for prefix, value in self.answers.items() if url.startswith(prefix))
        if isinstance(answer, Exception):
            raise answer
        yield types.SimpleNamespace(json=mock.AsyncMock(return_value=answer), read=mock.AsyncMock(return_value=answer))


class FakeHttp:
    """aiohttp.ClientSession for the slider solver: puzzle pictures by URL, 2Captcha answers in turn."""

    def __init__(self, pictures=None, answers=()):
        self.pictures, self.answers, self.posted = pictures or {}, list(answers), []

    @contextlib.asynccontextmanager
    async def get(self, url):
        yield types.SimpleNamespace(read=mock.AsyncMock(return_value=self.pictures[url]))

    @contextlib.asynccontextmanager
    async def post(self, url, json):
        self.posted.append((url, json))
        yield types.SimpleNamespace(json=mock.AsyncMock(return_value=self.answers.pop(0)))


PUZZLE = {"bg": {"x": 100, "y": 200, "w": 300, "h": 200}, "bgUrl": "https://static.test/bg.png",
          "sliceUrl": "https://static.test/slice.png", "btn": {"x": 100, "y": 410, "w": 80, "h": 50},
          "captchaId": "c1d2", "url": "https://shop.test/blocked"}


def synthetic_puzzle(gap_x):
    """A 300x200 textured background with a darkened square gap at `gap_x` and the matching piece."""
    import cv2
    import numpy as np

    rng = np.random.default_rng(7)
    background = cv2.GaussianBlur(rng.integers(0, 255, (200, 300, 3), dtype=np.uint8), (5, 5), 0)
    piece = np.zeros((200, 80, 4), np.uint8)
    piece[60:120, 10:70, :3] = background[60:120, gap_x:gap_x + 60]
    piece[60:120, 10:70, 3] = 255
    background[60:120, gap_x:gap_x + 60] //= 3
    cv2.rectangle(background, (gap_x, 60), (gap_x + 59, 119), (255, 255, 255), 1)
    cv2.rectangle(piece, (10, 60), (69, 119), (255, 255, 255, 255), 1)
    return cv2.imencode(".png", background)[1].tobytes(), cv2.imencode(".png", piece)[1].tobytes()


CLOSED = {"bg": None, "btn": None, "bgUrl": None, "passed": False}


def check_page(states, button=None, answer=True):
    """`evaluate` for a check page: its puzzle state in turn (the last one stays), its check button, and
    whether it took an answer."""
    states, calls = list(states), []

    async def evaluate(expression):
        calls.append(expression)
        if expression == worker.GEETEST_STATE:
            return states.pop(0) if len(states) > 1 else states[0]
        if expression == worker.CHECK_BUTTON:
            return button
        return answer

    evaluate.calls = calls
    return evaluate


class SliderTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.enterContext(mock.patch.object(worker.asyncio, "sleep", mock.AsyncMock()))
        self.moves = []

    async def mouse(self, params):
        self.moves.append(params)

    async def test_a_page_whose_check_brings_no_puzzle_is_reported_as_another_kind(self):
        solved, message = await worker.solve_slider(check_page([CLOSED]), self.mouse, FakeHttp())
        self.assertEqual((solved, message), (False, "No slider puzzle opened on this page: its check is of another kind."))
        self.assertEqual(self.moves, [])

    async def test_a_check_that_lets_the_page_through_without_a_puzzle_is_passed(self):
        page = check_page([CLOSED, {**CLOSED, "passed": True}], button={"x": 500, "y": 190})
        solved, message = await worker.solve_slider(page, self.mouse, FakeHttp())
        self.assertEqual((solved, message), (True, "The check passed without a puzzle; the page is moving on."))
        self.assertEqual([m["type"] for m in self.moves], ["mouseMoved", "mousePressed", "mouseReleased"])

    @unittest.skipUnless(importlib.util.find_spec("cv2"), "OpenCV is installed on the VM image")
    async def test_presses_the_check_button_and_drags_the_piece_into_the_gap_it_finds(self):
        background, piece = synthetic_puzzle(170)
        http = FakeHttp({PUZZLE["bgUrl"]: background, PUZZLE["sliceUrl"]: piece})
        page = check_page([CLOSED, CLOSED, PUZZLE, CLOSED], button={"x": 500, "y": 190})
        solved, message = await worker.solve_slider(page, self.mouse, http)
        self.assertEqual((solved, message), (True, "The puzzle was accepted; the page is moving on."))
        self.assertEqual((self.moves[1]["type"], self.moves[1]["x"]), ("mousePressed", 500))
        released = [m for m in self.moves if m["type"] == "mouseReleased"][-1]
        start = PUZZLE["btn"]["x"] + PUZZLE["btn"]["w"] / 2
        # The piece's left edge sits 10 px into its picture; the gap's is at 170.
        self.assertAlmostEqual(released["x"] - start, 160, delta=3)

    async def test_hands_a_puzzle_it_cannot_place_to_2captcha_and_submits_its_answer_as_the_page_would(self):
        answered = {"lot_number": "l1", "pass_token": "p1", "gen_time": "1", "captcha_output": "o1"}
        http = FakeHttp(answers=[{"errorId": 0, "taskId": 5}, {"errorId": 0, "status": "processing"},
                                 {"errorId": 0, "status": "ready", "solution": answered}])
        page = check_page([PUZZLE])
        with mock.patch.object(worker, "slider_gap", side_effect=ValueError("bad picture")):
            solved, message = await worker.solve_slider(page, self.mouse, http, "key-1")
        self.assertTrue(solved)
        task = http.posted[0][1]["task"]
        self.assertEqual((task["websiteURL"], task["gt"], task["version"]), (PUZZLE["url"], "c1d2", 4))
        submitted = page.calls[-1]
        self.assertIn('\\"captcha_id\\": \\"c1d2\\"', submitted)
        self.assertIn('\\"pass_token\\": \\"p1\\"', submitted)

    async def test_without_a_key_a_puzzle_it_cannot_place_is_reported_not_accepted(self):
        with mock.patch.object(worker, "slider_gap", side_effect=ValueError("bad picture")):
            solved, message = await worker.solve_slider(check_page([PUZZLE]), self.mouse, FakeHttp())
        self.assertEqual((solved, message), (False, "The puzzle was not accepted."))


def card_field(field_id, kind, sure=True, tag="input", max_length=None, placeholder=""):
    return {"id": field_id, "kind": kind, "sure": sure, "tag": tag, "type": "text", "maxLength": max_length,
            "placeholder": placeholder, "options": None}


CARD = {"number": "4276550101324310", "month": "01", "year": "31", "cvc": "249", "holder": "SAVELY SOLOVYEV"}


class FakeCardFrame:
    """A frame of fields as FIND_CARD_FIELDS lists them; typing keeps at most `maxLength` characters, as the
    browser does, and a field in `refuses` keeps nothing."""

    def __init__(self, url, fields, refuses=()):
        self.url, self.fields, self.refuses = url, fields, set(refuses)
        self.values = {field["id"]: "" for field in fields}
        self.focused = None

    async def call(self, expression, *args):
        if expression == worker.FIND_CARD_FIELDS:
            return self.fields
        if expression == worker.CARD_FIELD_FOCUS:
            self.focused = args[0]
            return True
        if expression == worker.CARD_FIELD_CLEAR:
            self.values[args[0]] = ""
            return ""
        if expression == worker.CARD_FIELD_VALUE:
            return self.values[args[0]]
        return True

    async def send(self, *_):
        return {}

    async def type(self, text):
        field = next(f for f in self.fields if f["id"] == self.focused)
        if field["id"] not in self.refuses:
            self.values[field["id"]] = (self.values[field["id"]] + text)[:field["maxLength"] or None]


class CardFormTest(unittest.IsolatedAsyncioTestCase):
    """fill_card's choices, without a browser: `test_card_forms.py` runs the same against Chrome."""

    def setUp(self):
        utils = types.SimpleNamespace(match_url_with_domain_pattern=lambda url, pattern: False)
        self.enterContext(mock.patch.dict(sys.modules, {"browser_use": types.SimpleNamespace(utils=utils),
                                                        "browser_use.utils": utils}))

    def test_the_card_comes_from_the_secrets_of_the_top_pages_site_only(self):
        def matches(url, pattern):
            host = urllib.parse.urlsplit(url).hostname
            return host == pattern.removeprefix("https://*.") or host.endswith("." + pattern.removeprefix("https://*."))

        sensitive = {"https://*.shop.ru": {"card_number": "4276 5501 0132 4310", "card_expiry": "1/31",
                                           "card_cvc": "249", "card_holder": "SAVELY SOLOVYEV"},
                     "https://*.yoomoney.ru": {"login_password": "x"}}
        fake = types.SimpleNamespace(match_url_with_domain_pattern=matches)
        with mock.patch.dict(sys.modules, {"browser_use": types.SimpleNamespace(utils=fake), "browser_use.utils": fake}):
            self.assertEqual(worker.card_secrets(sensitive, "https://pay.shop.ru/checkout"),
                             {**CARD, "sites": ["https://*.shop.ru"]})
            self.assertIsNone(worker.card_secrets(sensitive, "https://other.ru/checkout"))

    def test_two_expiry_boxes_take_the_month_and_the_year(self):
        # RU 04.10: ЮKassa's boxes each took «01/31» whole and kept 01/01.
        frames = [[], [card_field(0, "number"), card_field(1, "exp", max_length=2), card_field(2, "exp", max_length=2),
                       card_field(3, "cvc", sure=False)]]
        steps = worker.card_plan(frames, CARD)
        self.assertEqual([(step["frame"], step["kind"], step["texts"]) for step in steps],
                         [(1, "number", ["4276550101324310"]), (1, "month", ["01"]), (1, "year", ["31", "2031"]),
                          (1, "cvc", ["249"])])

    def test_a_loose_field_counts_only_beside_the_card_number(self):
        # «Код домофона» on the shop's own page is not the CVC of a card form in the processor's frame.
        frames = [[card_field(0, "cvc", sure=False)], [card_field(0, "number"), card_field(1, "exp")]]
        self.assertEqual([(step["frame"], step["kind"]) for step in worker.card_plan(frames, CARD)],
                         [(1, "number"), (1, "exp")])
        # The card number's own frame first; another frame of the same origin only for what it lacks (Stripe
        # keeps each field in a frame of its own), never the shop's page around a processor's frame.
        frames = [[card_field(0, "number"), card_field(1, "cvc", sure=False)], [card_field(0, "cvc")]]
        self.assertEqual([(step["frame"], step["kind"]) for step in worker.card_plan(frames, CARD)],
                         [(0, "number"), (0, "cvc")])
        frames = [[card_field(0, "exp")], [card_field(0, "number")], [card_field(0, "exp")], [card_field(0, "cvc")]]
        origins = [("https", "shop.ru"), ("https", "js.stripe.com"), ("https", "js.stripe.com"), ("https", "js.stripe.com")]
        self.assertEqual([(step["frame"], step["kind"]) for step in worker.card_plan(frames, CARD, origins)],
                         [(1, "number"), (2, "exp"), (3, "cvc")])

    def test_the_field_nearest_to_the_card_number_wins(self):
        frames = [[card_field(0, "cvc", sure=False), card_field(1, "number"), card_field(2, "cvc", sure=False)]]
        frames[0][0]["distance"], frames[0][1]["distance"], frames[0][2]["distance"] = 6, 0, 2
        self.assertEqual([step["field"]["id"] for step in worker.card_plan(frames, CARD)], [1, 2])

    def test_a_number_on_a_site_the_card_is_bound_to_comes_first(self):
        frames = [[card_field(0, "number")], [card_field(0, "number"), card_field(1, "cvc")]]
        self.assertEqual(worker.card_plan(frames, CARD, bound=[True, False])[0]["frame"], 0)
        self.assertEqual(worker.card_plan(frames, CARD, bound=[False, True])[0]["frame"], 1)
        self.assertEqual(worker.card_plan([[card_field(0, "cvc"), card_field(1, "exp")]], CARD), [])

    def test_each_expiry_field_wants_its_own_shape(self):
        single = {"kind": "exp", "field": card_field(0, "exp", placeholder="MM/YY")}
        self.assertTrue(worker.card_value_ok(single, CARD, "01/31"))
        self.assertTrue(worker.card_value_ok(single, CARD, "01 / 31"))
        self.assertFalse(worker.card_value_ok(single, CARD, "0131"))
        self.assertFalse(worker.card_value_ok(single, CARD, "01/01"))
        self.assertFalse(worker.card_value_ok({"kind": "exp", "field": card_field(0, "exp")}, CARD, "0131"))
        self.assertTrue(worker.card_value_ok({"kind": "exp", "field": card_field(0, "exp", max_length=4)}, CARD, "0131"))
        long_year = {"kind": "year", "field": card_field(0, "year", max_length=4)}
        self.assertTrue(worker.card_value_ok(long_year, CARD, "2031"))
        self.assertFalse(worker.card_value_ok(long_year, CARD, "31"))
        self.assertEqual(worker.card_plan([[card_field(0, "number"), card_field(1, "exp", placeholder="ММ/ГГГГ")]],
                                          CARD)[1]["texts"][0], "01/2031")

    async def test_fills_the_boxes_and_says_so_without_a_value(self):
        frame = FakeCardFrame("https://yoomoney.ru/checkout", [
            card_field(0, "number"), card_field(1, "exp", max_length=2), card_field(2, "exp", max_length=2),
            card_field(3, "cvc")])
        filled, message = await worker.fill_card_form([FakeCardFrame("https://shop.ru/", []), frame], CARD)
        self.assertTrue(filled, message)
        self.assertEqual(frame.values, {0: "4276550101324310", 1: "01", 2: "31", 3: "249"})
        self.assertIn("in yoomoney.ru", message)
        self.assertIn("Do not check or retype the fields", message)
        for secret in ("4276550101324310", "249"):
            self.assertNotIn(secret, message)

    async def test_a_box_that_keeps_nothing_is_reported_with_what_to_do(self):
        frame = FakeCardFrame("https://shop.ru/", [
            card_field(0, "number"), card_field(1, "exp", max_length=2), card_field(2, "exp", max_length=2),
            card_field(3, "cvc")], refuses={2})
        filled, message = await worker.fill_card_form([frame], CARD)
        self.assertFalse(filled)
        self.assertIn("Could not fill expiry year", message)
        self.assertIn("NEEDS: info", message)
        self.assertNotIn("card_expiry_year", message)

    async def test_no_card_form_fills_nothing(self):
        frame = FakeCardFrame("https://shop.ru/", [card_field(0, "cvc", sure=False)])
        filled, message = await worker.fill_card_form([frame], CARD)
        self.assertFalse(filled)
        self.assertIn("No card number field", message)
        self.assertEqual(frame.values, {0: ""})


class FakeSocket:
    """The CDP socket SiteErrors listens on: what it sends."""

    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


class SiteErrorsUnitTest(unittest.IsolatedAsyncioTestCase):
    """SiteErrors fed CDP events by hand; test_site_errors runs it against a real Chrome."""

    PAGE = "https://shop.ru/checkout"

    async def asyncSetUp(self):
        self.errors = worker.SiteErrors()
        self.errors.ws = FakeSocket()
        self.ids = itertools.count(1)

    async def request(self, method, url, status, body=None, kind="XHR"):
        request_id = f"q{next(self.ids)}"
        await self.errors.handle({"method": "Network.requestWillBeSent", "params": {
            "requestId": request_id, "type": kind, "documentURL": self.PAGE,
            "request": {"method": method, "url": url}}})
        await self.errors.handle({"method": "Network.responseReceived",
                                  "params": {"requestId": request_id, "response": {"status": status}}})
        await self.errors.handle({"method": "Network.loadingFinished", "params": {"requestId": request_id}})
        if body is not None and status >= 400:
            command = self.errors.ws.sent[-1]["id"]
            await self.errors.handle({"id": command, "result": {"body": body}})

    async def test_a_refused_write_is_told_once_and_a_probe_never(self):
        secrets = {"https://*.shop.ru": {"phone": "+79217818876"}}
        await self.request("GET", "https://shop.ru/api/user", 401, '{"error": "unauthorized"}')
        await self.request("GET", "https://api.shop.ru/api/user/cart?x=1", 404, "")
        await self.request("POST", "https://api.shop.ru/api/orders?session=s3cr3t", 400,
                           '{"errors": ["Пожалуйста, введите корректный номер телефона +79217818876",'
                           ' "deliveryMethod must be a valid enum value"]}')
        notices = self.errors.notices(secrets)
        self.assertEqual(len(notices), 1)
        self.assertIn("refused POST https://api.shop.ru/api/orders: 400 — ", notices[0])
        self.assertIn("Пожалуйста, введите корректный номер телефона <secret>", notices[0])
        self.assertIn("deliveryMethod must be a valid enum value", notices[0])
        self.assertIn("do not report success", notices[0])
        for hidden in ("s3cr3t", "79217818876", "/api/user"):
            self.assertNotIn(hidden, notices[0])
        self.assertEqual(self.errors.notices(secrets), [])
        # The same refusal again with the same answer is not told twice; a new answer is.
        await self.request("POST", "https://api.shop.ru/api/orders", 400,
                           '{"errors": ["deliveryMethod must be a valid enum value"]}')
        await self.request("POST", "https://api.shop.ru/api/orders", 400,
                           '{"errors": ["Пожалуйста, введите корректный номер телефона +79217818876",'
                           ' "deliveryMethod must be a valid enum value"]}')
        self.assertEqual(len(self.errors.notices(secrets)), 1)
        # The report keeps everything, the probes too.
        report = self.errors.report(secrets)
        self.assertIn("401 GET https://shop.ru/api/user", report)
        self.assertIn("404 GET https://api.shop.ru/api/user/cart", report)

    async def test_a_third_party_request_or_a_read_is_not_told_and_notices_are_capped(self):
        await self.request("POST", "https://mc.yandex.ru/watch", 403, "forbidden")
        await self.request("PUT", "https://shop.ru/api/cart", 500, "")
        await self.request("GET", "https://shop.ru/api/slots", 500, "oops")
        notices = self.errors.notices()
        self.assertEqual(len(notices), 1)
        self.assertIn("refused PUT https://shop.ru/api/cart: 500 (no answer text)", notices[0])
        for number in range(5):
            await self.request("DELETE", f"https://shop.ru/api/cart/{number}", 409, "gone")
        self.assertEqual(len(self.errors.notices()), worker.SiteErrors.NOTICES - 1)

    async def test_a_notice_waits_a_moment_for_its_answer(self):
        await self.errors.handle({"method": "Network.requestWillBeSent", "params": {
            "requestId": "q", "type": "Fetch", "documentURL": self.PAGE,
            "request": {"method": "POST", "url": "https://shop.ru/api/orders"}}})
        await self.errors.handle({"method": "Network.responseReceived",
                                  "params": {"requestId": "q", "response": {"status": 422}}})
        self.assertEqual(self.errors.notices(), [])
        with mock.patch.object(worker.SiteErrors, "BODY_WAIT_S", 0):
            self.assertIn("422 (no answer text)", self.errors.notices()[0])

    async def test_two_tabs_number_their_commands_apart(self):
        # Each tab's socket asks for bodies with its own command ids, from 1: an answer goes to its own request.
        tabs = [types.SimpleNamespace(ws=FakeSocket(), next_id=1) for _ in range(2)]
        for tab, (request_id, body) in zip(tabs, (("a", "phone must be a valid phone number"),
                                                 ("b", "deliveryMethod must be a valid enum value"))):
            await self.errors.handle({"method": "Network.requestWillBeSent", "params": {
                "requestId": request_id, "type": "XHR", "documentURL": self.PAGE,
                "request": {"method": "POST", "url": f"https://shop.ru/api/{request_id}"}}}, tab)
            await self.errors.handle({"method": "Network.responseReceived",
                                      "params": {"requestId": request_id, "response": {"status": 400}}}, tab)
            await self.errors.handle({"method": "Network.loadingFinished", "params": {"requestId": request_id}}, tab)
            self.assertEqual(tab.ws.sent[-1]["id"], 1)
        await self.errors.handle({"id": 1, "result": {"body": "deliveryMethod must be a valid enum value"}}, tabs[1])
        await self.errors.handle({"id": 1, "result": {"body": "phone must be a valid phone number"}}, tabs[0])
        report = self.errors.report()
        self.assertIn("POST https://shop.ru/api/a — phone must be a valid phone number", report)
        self.assertIn("POST https://shop.ru/api/b — deliveryMethod must be a valid enum value", report)

    async def test_probes_never_crowd_a_refused_write_out_of_the_report(self):
        for number in range(worker.SiteErrors.LIMIT + 2):
            await self.request("GET", f"https://shop.ru/api/probe{number}", 404, "")
            await self.request("GET", f"https://shop.ru/api/probe{number}", 404, "")
        await self.request("POST", "https://shop.ru/api/orders", 400, "bad phone")
        report = self.errors.report()
        self.assertIn("400 POST https://shop.ru/api/orders — bad phone", report)
        self.assertIn("404 GET https://shop.ru/api/probe1 (×2)", report)
        self.assertEqual(len(self.errors.entries), worker.SiteErrors.LIMIT)


class StepTrailTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(mock.patch.object(worker, "SESSIONS", self.root / "sessions"))
        self.secrets = {"https://*.shop.ru": {"password": "hunter22", "card_cvc": "249"}}

    def lines(self, trail):
        return [json.loads(line) for line in (trail.directory / "steps.jsonl").read_text().splitlines()]

    async def test_a_step_line_has_no_secret_no_query_and_no_typed_text(self):
        trail = worker.StepTrail(self.root / "t", self.secrets)
        summary = worker.step_summary(
            types.SimpleNamespace(url="https://shop.ru/pay?token=t0k", title="Оплата hunter22"),
            types.SimpleNamespace(next_goal="Type hunter22 and 249.", action=[types.SimpleNamespace(
                model_dump=lambda exclude_none: {"input": {"index": 7, "text": "hunter22"}})]), 3)

        async def shoot():
            return b"\xff\xd8jpeg"

        await trail.record(shoot, summary, "https://shop.ru/pay?token=t0k#x", ["Field rejected hunter22"])
        line = self.lines(trail)[0]
        self.assertEqual(line["step"], 1)
        self.assertEqual((line["url"], line["goal"], line["title"], line["errors"], line["actions"], line["shot"]),
                         ("https://shop.ru/pay", "Type <secret> and <secret>.", "Оплата <secret>",
                          ["Field rejected <secret>"], [{"action": "input", "index": 7}], "001.jpg"))
        written = (trail.directory / "steps.jsonl").read_text()
        for secret in ("hunter22", "249", "t0k"):
            self.assertNotIn(secret, written)
        self.assertEqual((trail.directory / "001.jpg").read_bytes(), b"\xff\xd8jpeg")

    async def test_only_the_last_shots_are_kept_and_a_failed_or_slow_shot_skips_only_the_picture(self):
        trail = worker.StepTrail(self.root / "t")

        async def shoot():
            return b"jpeg"

        async def broken():
            raise RuntimeError("tab is gone")

        async def slow():
            await asyncio.sleep(5)

        self.enterContext(mock.patch.object(worker, "TRAIL_SHOTS", 3))
        self.enterContext(mock.patch.object(worker, "TRAIL_SHOT_S", 0.05))
        for _ in range(5):
            await trail.record(shoot)
        await trail.record(broken)
        await trail.record(slow)
        self.assertEqual(sorted(p.name for p in trail.directory.glob("*.jpg")), ["003.jpg", "004.jpg", "005.jpg"])
        self.assertEqual([line.get("shot") for line in self.lines(trail)],
                         ["001.jpg", "002.jpg", "003.jpg", "004.jpg", "005.jpg", None, None])

    async def test_a_trail_that_cannot_be_written_does_not_fail_the_step(self):
        (self.root / "file").write_text("")
        trail = worker.StepTrail(self.root / "file" / "t")

        async def shoot():
            return b"jpeg"

        await trail.record(shoot)  # no exception

    def test_only_the_newest_run_trails_stay_on_the_vm(self):
        for number, session in enumerate(["a", "b", "a", "c"]):
            path = worker.SESSIONS / session / worker.TRAIL / f"r{number}"
            path.mkdir(parents=True)
            os.utime(path, (1000 + number, 1000 + number))
        worker.prune_trails(2)
        kept = sorted(p.name for p in worker.SESSIONS.glob(f"*/{worker.TRAIL}/*"))
        self.assertEqual(kept, ["r2", "r3"])


if __name__ == "__main__":
    unittest.main()
