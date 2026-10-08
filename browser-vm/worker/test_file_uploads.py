import asyncio
import io
import os
import ssl
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).parent))
import worker
from test_worker import CONFIG, fresh_token


class RealFileUploads(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        chrome = os.environ.get("BRO_FILE_UPLOADS_CHROME")
        if not chrome:
            self.skipTest("set BRO_FILE_UPLOADS_CHROME to run with real Chromium")
        from browser_use import BrowserSession

        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name, value in {
            "ROOT": root,
            "RUNS": root / "runs",
            "SESSIONS": root / "sessions",
            "UPLOADS": root / "uploads",
            "GENERATION_FILE": root / "generation",
            "TABS_FILE": root / "tabs.json",
            "load_config": lambda: CONFIG,
        }.items():
            self.enterContext(mock.patch.object(worker, name, value))
        runtime = worker.Worker()
        self.enterContext(mock.patch.object(worker, "worker", runtime))
        self.runtime = runtime
        self.received = []
        self.arrived = asyncio.Event()

        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-keyout", str(root / "key.pem"), "-out", str(root / "cert.pem"),
             "-days", "1", "-subj", "/CN=localhost"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(root / "cert.pem", root / "key.pem")

        async def form(_request):
            return web.Response(content_type="text/html", text="""
                <!doctype html><html><body>
                <label>Test document <input id="document" type="file"></label>
                <script>
                document.querySelector('input').addEventListener('change', async event => {
                    await fetch('/received', {method: 'POST', body: event.target.files[0]});
                });
                </script></body></html>
            """)

        async def receive(request):
            self.received.append(await request.read())
            self.arrived.set()
            return web.Response(text="received")

        site = web.Application(client_max_size=worker.MAX_UPLOAD_SIZE)
        site.router.add_get("/", form)
        site.router.add_post("/received", receive)
        self.site = TestServer(site)
        await self.site.start_server(ssl=tls)
        self.addAsyncCleanup(self.site.close)
        self.origin = str(self.site.make_url("/")).rstrip("/").replace("http:", "https:")
        self.browser = BrowserSession(
            executable_path=chrome, headless=True, keep_alive=True,
            chromium_sandbox=os.geteuid() != 0,
            args=["--ignore-certificate-errors", "--site-per-process"],
        )
        await self.browser.start()
        self.addAsyncCleanup(self.browser.kill)
        self.session = worker.Session("real-upload")
        self.session.tab = self.browser.agent_focus_target_id
        self.session.tabs.add(self.session.tab)
        runtime.sessions[self.session.id] = self.session
        self.client = TestClient(TestServer(worker.application()))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def stage(self, site=None):
        payload = b"%PDF-1.7\x00\xffSYNTHETIC DOCUMENT: no personal data\n"
        self.data = (payload * (11_347_345 // len(payload) + 1))[:11_347_345]
        response = await self.client.put(
            f"/v1/sessions/{self.session.id}/uploads/document.pdf",
            params={"site": site or self.origin},
            data=io.BytesIO(self.data),
            headers={"Authorization": f"Bearer {fresh_token()}", "Content-Type": "application/pdf"},
        )
        self.assertEqual(response.status, 200, await response.text())
        uploaded = await response.json()
        self.assertEqual(Path(uploaded["path"]).read_bytes(), self.data)
        self.assertEqual(uploaded["size"], len(self.data))
        return uploaded["path"]

    async def attach(self, path):
        from browser_use.browser.events import NavigateToUrlEvent
        from browser_use.filesystem.file_system import FileSystem

        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url=self.origin))
        await self.browser.get_browser_state_summary()
        selectors = await self.browser.get_selector_map()
        index = next(index for index, node in selectors.items()
                     if node.tag_name == "input" and node.attributes.get("type") == "file")
        tools = self.runtime.tools(self.session, worker.Run("attach", self.session.id, "Attach the requested file"))
        action = tools.registry.registry.actions["upload_file"]
        return await action.function(
            params=action.param_model(index=index, path=path),
            browser_session=self.browser,
            available_file_paths=[path],
            file_system=FileSystem(self.session.workspace),
        )

    async def test_real_http_bytes_reach_the_bound_https_form_through_chromium(self):
        path = await self.stage()
        result = await self.attach(path)
        self.assertFalse(result.error, result.error)
        await asyncio.wait_for(self.arrived.wait(), 10)
        self.assertEqual(self.received, [self.data])

    async def test_a_different_site_cannot_receive_the_document(self):
        path = await self.stage("https://other.test")
        result = await self.attach(path)
        self.assertIn("bound HTTPS site", result.error)
        self.assertEqual(self.received, [])


if __name__ == "__main__":
    unittest.main()
