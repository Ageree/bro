"""The login handoff against a real Chrome: python -m unittest test_handoff (in browser-vm/worker).

Needs a Chromium, so CI skips it: set BRO_HANDOFF_CHROME to the binary (in a cloud session:
/opt/pw-browsers/chromium-*/chrome-linux/chrome). A person's side is played by a WebSocket client that
speaks the viewer protocol: it sees frames, taps a form, types, and is stopped at a link that leaves the
site. `*.localhost` names stand in for the site and for another one: Chrome resolves them to loopback.
"""

import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).parent))
import worker  # noqa: E402

CHROME = os.environ.get("BRO_HANDOFF_CHROME")
KEY = hmac.new(bytes.fromhex("22" * 32), b"bro-browser-vm:ws_handoff", hashlib.sha256).digest()
CONFIG = {"environment": "ws_handoff", "key": KEY}
ORIGIN = "https://bro.test"
HANDOFF_ID = "handoff_abc123"


def sign(session=None, ttl=300):
    claims = {"env": "ws_handoff", "gen": 1, "exp": int(time.time()) + ttl}
    if session is not None:
        claims["ses"] = session
    payload = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).rstrip(b"=").decode()
    signature = hmac.new(KEY, f"v1.{payload}".encode(), hashlib.sha256).digest()
    return f"v1.{payload}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


# Elements sit at fixed places so the test can tap them by coordinates.
LOGIN = """<!doctype html><meta charset=utf-8><body style="margin:0">
<form method=post action=/login>
<input id=u name=u style="position:absolute;left:40px;top:40px;width:300px;height:40px">
<input id=p name=p type=password style="position:absolute;left:40px;top:100px;width:300px;height:40px">
<button type=submit style="position:absolute;left:400px;top:100px">Войти</button>
</form>
<div id=track style="position:absolute;left:40px;top:460px;width:400px;height:40px;background:#ddd"></div>
<div id=knob style="position:absolute;left:40px;top:460px;width:40px;height:40px;background:#36c;touch-action:none"></div>
<script>
// A slider like a captcha's: counts only when the knob is pressed, led by a held button and let go.
const knob = document.getElementById('knob'); let from = null;
knob.addEventListener('pointerdown', e => { from = e.clientX; });
addEventListener('pointermove', e => {
  if (from !== null && e.buttons === 1) knob.style.left = Math.min(Math.max(40 + e.clientX - from, 40), 400) + 'px';
});
addEventListener('pointerup', () => {
  if (from === null) return; from = null;
  fetch('/slid?left=' + parseInt(knob.style.left || '40', 10), {method: 'POST'});
});
</script>
<a href="http://other.localhost:{port}/" style="position:absolute;left:40px;top:200px;font-size:30px">elsewhere</a>
<button type=button onclick="window.open('/popup')" style="position:absolute;left:40px;top:300px;width:200px;height:50px">provider</button>
<a href="/slow" style="position:absolute;left:40px;top:250px;font-size:30px">slow</a>
<button type=button onclick="window.open('http://other.localhost:{port}/other')" style="position:absolute;left:40px;top:380px;width:200px;height:50px">stranger</button>
</body>"""
POPUP = """<!doctype html><meta charset=utf-8><body style="margin:0">
<button type=button onclick="window.close()" style="position:absolute;left:40px;top:40px;width:200px;height:50px">allow</button></body>"""
HOME = "<!doctype html><meta charset=utf-8><body style='margin:0'><h1>signed in</h1></body>"


class Handoff(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not CHROME:
            self.skipTest("set BRO_HANDOFF_CHROME to a Chromium binary")
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.seen = {}  # what the site's server was sent

        async def login_page(request):
            return web.Response(text=LOGIN.replace("{port}", str(self.site_port)), content_type="text/html")

        async def login(request):
            form = await request.post()
            self.seen["form"] = dict(form)
            response = web.HTTPSeeOther("/home")
            response.set_cookie("sid", "s3cret")  # no expiry: a session cookie
            return response

        async def home(request):
            self.seen["cookie"] = request.cookies.get("sid")
            return web.Response(text=HOME, content_type="text/html")

        async def other(request):
            self.seen["other"] = True
            return web.Response(text="<h1>other</h1>", content_type="text/html")

        site = web.Application()
        async def slow(request):
            # A page that sends itself away a moment after it loads, while nobody may be looking.
            return web.Response(
                text="<script>setTimeout(()=>{location='http://other.localhost:%d/other'},1500)</script>slow"
                % self.site_port, content_type="text/html")

        async def popup(request):
            return web.Response(text=POPUP, content_type="text/html")

        async def slid(request):
            self.seen["slid"] = int(request.query["left"])
            return web.Response(text="ok")

        site.add_routes([web.post("/slid", slid), web.get("/popup", popup), web.get("/slow", slow), web.get("/", login_page), web.post("/login", login), web.get("/home", home),
                         web.get("/other", other)])
        self.site = web.AppRunner(site)
        await self.site.setup()
        tcp = web.TCPSite(self.site, "127.0.0.1", 0)
        await tcp.start()
        self.site_port = tcp._server.sockets[0].getsockname()[1]
        self.addAsyncCleanup(self.site.cleanup)

        with socket.socket() as probe:  # a port nobody else has, asked of the system
            probe.bind(("127.0.0.1", 0))
            self.cdp_port = probe.getsockname()[1]
        profile = root / "profile"
        self.chrome = subprocess.Popen(
            [CHROME, f"--user-data-dir={profile}", f"--remote-debugging-port={self.cdp_port}", "--headless=new",
             "--no-sandbox", "--no-first-run", "--no-proxy-server", "--disable-gpu", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (self.chrome.kill(), self.chrome.wait()))
        for _ in range(100):
            try:
                async with aiohttp.ClientSession() as http:
                    async with http.get(f"http://127.0.0.1:{self.cdp_port}/json/version"):
                        break
            except aiohttp.ClientError:
                await asyncio.sleep(0.1)

        self.flushed = []

        async def flush(timeout=20):
            self.flushed.append(True)
            return "closed"

        for target, name, value in [
            (worker, "ROOT", root), (worker, "RUNS", root / "runs"), (worker, "SESSIONS", root / "sessions"),
            (worker, "UPLOADS", root / "uploads"), (worker, "GENERATION_FILE", root / "generation"),
            (worker, "TABS_FILE", root / "tabs.json"), (worker, "load_config", lambda: CONFIG),
            (worker, "CDP_HTTP", f"http://127.0.0.1:{self.cdp_port}"), (worker, "close_chrome_for_park", flush),
            (worker, "HANDOFF_SCHEMES", ("http", "https")), (worker, "HANDOFF_PORTS", (None, 80, 443, self.site_port)),
        ]:
            self.enterContext(mock.patch.object(target, name, value))
        worker.worker = worker.Worker()
        worker.worker.generation = 1
        self.server = TestServer(worker.application())
        self.client = TestClient(self.server)
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    def url(self, host, path="/"):
        return f"http://{host}.localhost:{self.site_port}{path}"

    async def open(self, **overrides):
        body = {"id": HANDOFF_ID, "url": self.url("app"), "domains": ["app.localhost"], "origin": ORIGIN, **overrides}
        return await self.client.post("/v1/handoff", json=body, headers={"Authorization": f"Bearer {sign()}"})

    async def viewer(self, token=None, origin=ORIGIN):
        socket = await self.client.ws_connect(f"/v1/handoff/{HANDOFF_ID}/ws", headers={"Origin": origin})
        await socket.send_json({"t": "auth", "token": token or sign(f"h:{HANDOFF_ID}")})
        return socket

    @staticmethod
    async def until(socket, kind, timeout=15, **match):
        """The next message of this kind (and fields), skipping frames and the rest."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = await asyncio.wait_for(socket.receive(), max(deadline - time.monotonic(), 0.1))
            if message.type != aiohttp.WSMsgType.TEXT:
                raise AssertionError(f"socket closed while waiting for {kind}: {message.type}")
            body = json.loads(message.data)
            if body.get("t") == kind and all(body.get(k) == v for k, v in match.items()):
                return body
        raise AssertionError(f"no {kind} {match}")

    async def test_the_person_signs_in_and_the_session_cookie_stays_in_the_profile(self):
        opened = await self.open()
        self.assertEqual(opened.status, 200, await opened.text())
        self.assertTrue(worker.worker.busy())  # no run, park or update while the person signs in
        socket = await self.viewer()
        url = await self.until(socket, "url", host="app.localhost")
        self.assertEqual((url["secure"], url["ok"]), (False, True))
        frame = await self.until(socket, "frame")
        self.assertGreater(frame["w"], 100)
        self.assertTrue(base64.b64decode(frame["d"]).startswith(b"\xff\xd8"))  # a JPEG
        await socket.send_json({"t": "tap", "x": 100, "y": 60})
        await socket.send_json({"t": "text", "s": "alice"})
        await socket.send_json({"t": "tap", "x": 100, "y": 120})
        await socket.send_json({"t": "text", "s": "pa55 word"})
        await socket.send_json({"t": "key", "k": "Enter"})
        for _ in range(100):  # the form posts and the site answers with the page after the sign-in
            if self.seen.get("cookie"):
                break
            await asyncio.sleep(0.1)
        self.assertEqual(self.seen["form"], {"u": "alice", "p": "pa55 word"})
        self.assertEqual(self.seen["cookie"], "s3cret")
        await socket.send_json({"t": "done"})
        await self.until(socket, "done")
        for _ in range(100):
            state = await (await self.client.get(f"/v1/handoff/{HANDOFF_ID}", headers={"Authorization": f"Bearer {sign()}"})).json()
            if state["state"] == "done":
                break
            await asyncio.sleep(0.1)
        self.assertEqual(state["state"], "done")
        self.assertEqual(state["result"]["host"], "app.localhost")
        self.assertEqual(state["result"]["passwordField"], False)
        self.assertTrue(state["result"]["allowed"])
        self.assertEqual(self.flushed, [True])  # Chrome was told to write the cookies
        self.assertFalse(worker.worker.busy())
        async with aiohttp.ClientSession() as http:
            async with http.get(f"http://127.0.0.1:{self.cdp_port}/json/list") as response:
                pages = [t for t in await response.json() if t["type"] == "page"]
        self.assertEqual(len(pages), 1)  # the sign-in tab is closed, one page is left for Chrome to live on

    async def test_a_slider_follows_a_held_button_and_nothing_else(self):
        await self.open()
        socket = await self.viewer()
        await self.until(socket, "frame")
        await socket.send_json({"t": "move", "x": 60, "y": 480})  # hovering does not slide
        await socket.send_json({"t": "drag", "x": 200, "y": 480})  # a drag with no press is dropped
        await socket.send_json({"t": "up", "x": 200, "y": 480})
        await asyncio.sleep(0.5)
        self.assertNotIn("slid", self.seen)
        await socket.send_json({"t": "down", "x": 60, "y": 480})
        for x in range(60, 261, 20):
            await socket.send_json({"t": "drag", "x": x, "y": 480})
        await socket.send_json({"t": "up", "x": 260, "y": 480})
        for _ in range(100):
            if "slid" in self.seen:
                break
            await asyncio.sleep(0.1)
        self.assertEqual(self.seen["slid"], 240)

    async def test_a_button_still_held_when_the_viewer_leaves_is_let_go(self):
        await self.open()
        socket = await self.viewer()
        await self.until(socket, "frame")
        await socket.send_json({"t": "down", "x": 60, "y": 480})
        await socket.send_json({"t": "drag", "x": 160, "y": 480})
        await asyncio.sleep(0.5)
        await socket.close()
        for _ in range(100):  # the release arrives from the worker: the page ends the drag
            if "slid" in self.seen:
                break
            await asyncio.sleep(0.1)
        self.assertIn("slid", self.seen)

    async def test_a_link_that_leaves_the_site_is_refused_before_it_loads(self):
        await self.open()
        socket = await self.viewer()
        await self.until(socket, "url", host="app.localhost")
        await socket.send_json({"t": "tap", "x": 60, "y": 215})
        blocked = await self.until(socket, "blocked")
        self.assertEqual(blocked["host"], "other.localhost")
        # The error page a refused link leaves is taken away: the page before it is back.
        back = await self.until(socket, "url", host="app.localhost", ok=True)
        self.assertEqual(back["ok"], True)
        await asyncio.sleep(0.5)
        self.assertNotIn("other", self.seen)  # the request never went out
        await socket.send_json({"t": "cancel"})
        await self.until(socket, "cancel")

    async def test_a_window_the_page_opens_is_followed_and_one_to_another_site_is_not(self):
        await self.open()
        socket = await self.viewer()
        await self.until(socket, "url", host="app.localhost")
        await socket.send_json({"t": "tap", "x": 100, "y": 325})  # «provider»: opens a page of the site
        await self.until(socket, "popup")
        await asyncio.sleep(0.5)
        await socket.send_json({"t": "tap", "x": 100, "y": 65})  # «allow»: the window closes itself
        await self.until(socket, "popup-closed")
        await socket.send_json({"t": "tap", "x": 100, "y": 405})  # «stranger»: a window on another site
        await self.until(socket, "blocked")
        await asyncio.sleep(0.5)
        self.assertNotIn("other", self.seen)
        await socket.send_json({"t": "cancel"})
        await self.until(socket, "cancel")

    async def test_the_fence_holds_while_nobody_is_looking(self):
        await self.open()
        socket = await self.viewer()
        await self.until(socket, "url", host="app.localhost")
        await socket.send_json({"t": "tap", "x": 60, "y": 268})  # «slow»: it sends itself off in 1.5 s
        await self.until(socket, "url", host="app.localhost", ok=True)
        await socket.close()  # the viewer goes before the page does
        await asyncio.sleep(3)
        self.assertNotIn("other", self.seen)  # the guard refused it with no viewer connected
        socket = await self.viewer()
        back = await self.until(socket, "url")
        self.assertTrue(back["ok"])  # what the person comes back to is a page of the site
        await asyncio.sleep(0.5)
        self.assertNotIn("other", self.seen)
        await socket.send_json({"t": "cancel"})
        await self.until(socket, "cancel")

    async def test_a_sign_in_provider_is_let_in_by_the_exact_host_only(self):
        await self.open(hosts=["id.provider.localhost"])
        handoff = worker.worker.handoff
        self.assertTrue(handoff.allows("https://id.provider.localhost/auth"))
        self.assertFalse(handoff.allows("https://mail.provider.localhost/"))
        self.assertFalse(handoff.allows("https://provider.localhost/"))
        self.assertTrue(handoff.allows("https://www.app.localhost/"))

    async def test_nothing_but_the_typed_messages_gets_through(self):
        await self.open()
        socket = await self.viewer()
        await self.until(socket, "url", host="app.localhost")
        for message in ({"t": "cdp", "method": "Network.getAllCookies"}, {"t": "key", "k": "F12"},
                        {"t": "key", "k": "a"}, {"t": "tap", "x": "10", "y": 5}, {"t": "text", "s": 5},
                        {"t": "navigate", "url": "file:///etc/passwd"}):
            await socket.send_json(message)
        await socket.send_json({"t": "tap", "x": 100, "y": 60})
        await socket.send_json({"t": "text", "s": "x\ny\x00z"})
        await socket.send_json({"t": "cancel"})
        await self.until(socket, "cancel")

    async def test_the_viewer_socket_wants_the_page_origin_and_its_own_token(self):
        await self.open()
        with self.assertRaises(aiohttp.WSServerHandshakeError):
            await self.client.ws_connect(f"/v1/handoff/{HANDOFF_ID}/ws", headers={"Origin": "https://evil.test"})
        for token in (sign(), sign("h:someone_else"), sign(f"h:{HANDOFF_ID}", ttl=-5), "nonsense"):
            socket = await self.viewer(token)
            message = await socket.receive()
            self.assertEqual(json.loads(message.data), {"t": "error", "reason": "unauthorized"})
            await socket.close()
        # What the person's browser holds opens no other route of the worker.
        scoped = {"Authorization": f"Bearer {sign(f'h:{HANDOFF_ID}')}"}
        for method, path in (("GET", "/v1/runs"), ("GET", f"/v1/handoff/{HANDOFF_ID}"), ("POST", "/v1/park"),
                             ("GET", "/v1/files?session=x")):
            response = await self.client.request(method, path, headers=scoped)
            self.assertEqual(response.status, 401, path)
        response = await self.client.get(f"/v1/cdp/{sign(f'h:{HANDOFF_ID}')}/json")
        self.assertEqual(response.status, 401)

    async def test_a_second_handoff_waits_and_the_same_id_is_answered_again(self):
        self.assertEqual((await self.open()).status, 200)
        self.assertEqual((await self.open()).status, 200)  # a lost answer, asked again
        other = await self.open(id="another_one_1")
        self.assertEqual(other.status, 409)

    async def start_run(self):
        return await self.client.post("/v1/runs", json={"id": f"run_{time.monotonic_ns()}", "sessionId": "s1",
                                                        "task": "Go.", "llm": {"baseUrl": "http://127.0.0.1:9", "apiKey": "k",
                                                                               "model": "m"}},
                                      headers={"Authorization": f"Bearer {sign()}"})

    async def test_a_run_is_told_busy_while_the_window_is_open_and_taken_after_every_kind_of_end(self):
        for ending in ("done", "cancel", "expired", "left"):
            with self.subTest(ending=ending):
                handoff_id = f"handoff_{ending}_1"
                self.assertEqual((await self.open(id=handoff_id)).status, 200)
                handoff = worker.worker.handoff
                response = await self.start_run()
                self.assertEqual((response.status, await response.json()), (409, {"error": "busy"}))
                if ending == "left":  # the person closed the tab: the socket goes, the window stays until it expires
                    socket = await self.client.ws_connect(f"/v1/handoff/{handoff_id}/ws", headers={"Origin": ORIGIN})
                    await socket.send_json({"t": "auth", "token": sign(f"h:{handoff_id}")})
                    await self.until(socket, "frame")
                    await socket.close()
                    await asyncio.sleep(0.3)
                    self.assertTrue(worker.worker.busy())
                    response = await self.start_run()
                    self.assertEqual(response.status, 409)
                    await worker.end_handoff(handoff, "expired")
                else:
                    await worker.end_handoff(handoff, ending)
                self.assertFalse(worker.worker.busy())
                response = await self.start_run()
                self.assertNotEqual(response.status, 409, await response.text())
                self.assertNotEqual(response.status, 500, await response.text())
                for _ in range(100):  # the run fails fast (no proxy here) and lets go of the browser
                    if not worker.worker.busy():
                        break
                    await asyncio.sleep(0.1)

    async def test_a_handoff_that_is_over_is_not_opened_again_by_its_id(self):
        await self.open()
        await worker.end_handoff(worker.worker.handoff, "cancel")
        self.assertEqual(worker.worker.handoff.state, "cancelled")
        again = await self.open()
        self.assertEqual((await again.json())["state"], "cancelled")
        self.assertFalse(worker.worker.busy())  # no tab, no hold on the browser

    async def test_it_expires_and_cancels(self):
        await self.open(ttlSeconds=60)
        handoff = worker.worker.handoff
        await worker.end_handoff(handoff, "expired")
        self.assertEqual(handoff.state, "expired")
        self.assertFalse(worker.worker.busy())
        self.assertEqual(self.flushed, [])  # nobody looked: no cookies to write
        self.assertEqual((await self.open(id="fresh_handoff_2")).status, 200)
        response = await self.client.post("/v1/handoff/fresh_handoff_2/cancel", headers={"Authorization": f"Bearer {sign()}"})
        self.assertEqual((await response.json())["state"], "cancelled")


if __name__ == "__main__":
    unittest.main()
