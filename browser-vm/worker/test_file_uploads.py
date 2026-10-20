import asyncio
import io
import os
import ssl
import subprocess
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).parent))
import worker
from test_worker import CONFIG, fresh_token

# Upload widgets as sites build them. Each sends what it got to /received?field=<its name>.
SEND = "fetch('/received?field=' + field, {method: 'POST', body: file});"
PAGES = {
    "/": f"""
        <label>Test document <input id="document" type="file"></label>
        <script>
        document.querySelector('input').addEventListener('change', event => {{
            const field = 'document', file = event.target.files[0]; {SEND}
        }});
        </script>""",
    # The field exists only for the moment of the click (Product Radar's logo, many React widgets):
    # there is no file input in the page to set.
    "/button": f"""
        <button id="logo" style="width:240px;height:48px">Загрузить логотип</button>
        <button id="photo" style="width:240px;height:48px">Загрузить фото</button>
        <script>
        for (const field of ['logo', 'photo']) {{
            document.getElementById(field).addEventListener('click', () => {{
                const input = document.createElement('input');
                input.type = 'file';
                input.addEventListener('change', () => {{ const file = input.files[0]; {SEND} }});
                input.click();
            }});
        }}
        </script>""",
    # Only a drop zone (focusable, as drop zones are): a click opens nothing, there is no field. The button
    # beside it takes no drop.
    "/zone": f"""
        <div id="zone" tabindex="0" style="width:320px;height:140px;border:2px dashed #888;cursor:pointer">
            Перетащите файл сюда</div>
        <button id="text" style="width:320px;height:60px">Просто кнопка</button>
        <script>
        const zone = document.getElementById('zone');
        zone.addEventListener('dragover', event => event.preventDefault());
        zone.addEventListener('drop', event => {{
            event.preventDefault();
            const field = 'zone', file = event.dataTransfer.files[0]; {SEND}
        }});
        </script>""",
    # The page lets every drag over it (a document-wide handler) and takes a drop nowhere: Chrome would open the
    # dropped file itself.
    "/half": """
        <div id="area" tabindex="0" style="width:320px;height:140px;cursor:pointer">Сюда ничего не падает</div>
        <script>document.addEventListener('dragover', event => event.preventDefault());</script>""",
    # A form's own button without a type sends the form; a web component keeps its upload button in a shadow root.
    "/form": f"""
        <form action="/sent" method="post"><input name="title" value="Bro"><button id="send">Загрузить документы</button></form>
        <bro-upload id="component" tabindex="0" style="display:block;width:260px;height:60px;cursor:pointer"></bro-upload>
        <script>
        customElements.define('bro-upload', class extends HTMLElement {{
            connectedCallback() {{
                const button = document.createElement('button');
                button.textContent = 'Загрузить файл';
                button.style.cssText = 'width:240px;height:48px';
                button.addEventListener('click', () => {{
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.addEventListener('change', () => {{ const field = 'component', file = input.files[0]; {SEND} }});
                    input.click();
                }});
                this.attachShadow({{mode: 'open'}}).append(button);
            }}
        }});
        </script>""",
}


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

        def page(body):
            async def handler(_request):
                return web.Response(content_type="text/html", text=f"<!doctype html><html><body>{body}</body></html>")
            return handler

        async def receive(request):
            self.received.append((request.query.get("field"), await request.read()))
            self.arrived.set()
            return web.Response(text="received")

        # Another site: its page has an upload button of its own, and the errand's page frames it.
        other = web.Application()
        other.router.add_get("/button", page(PAGES["/button"]))
        other.router.add_post("/received", receive)
        self.other = TestServer(other)
        await self.other.start_server(ssl=tls)
        self.addAsyncCleanup(self.other.close)
        other_origin = str(self.other.make_url("/")).rstrip("/").replace("http:", "https:")

        site = web.Application(client_max_size=worker.MAX_UPLOAD_SIZE)
        for path, body in PAGES.items():
            site.router.add_get(path, page(body))
        site.router.add_get("/framed", page(
            f'<iframe id="frame" src="{other_origin}/button" style="width:600px;height:200px"></iframe>'))
        site.router.add_post("/received", receive)

        async def sent(_request):
            self.sent.append(True)
            return web.Response(text="sent")

        self.sent = []
        site.router.add_post("/sent", sent)
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
        # The worker's own sockets to the tab (its file pickers) go to this Chrome, not the VM's.
        address = urllib.parse.urlsplit(self.browser.cdp_url)
        self.enterContext(mock.patch.object(worker, "CDP_HTTP", f"http://{address.hostname}:{address.port}"))
        self.session = worker.Session("real-upload")
        self.session.tab = self.browser.agent_focus_target_id
        self.session.tabs.add(self.session.tab)
        runtime.sessions[self.session.id] = self.session
        self.run = worker.Run("attach", self.session.id, "Attach the requested file")
        self.addAsyncCleanup(self.stop_pickers)
        self.tools = runtime.tools(self.session, self.run)
        self.client = TestClient(TestServer(worker.application()))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def stop_pickers(self):
        if self.run.pickers is not None:
            await self.run.pickers.stop()

    async def stage(self, site=None, name="document.pdf", size=11_347_345):
        payload = b"%PDF-1.7\x00\xffSYNTHETIC DOCUMENT: no personal data\n"
        data = (payload * (size // len(payload) + 1))[:size]
        response = await self.client.put(
            f"/v1/sessions/{self.session.id}/uploads/{name}",
            params={"site": site or self.origin},
            data=io.BytesIO(data),
            headers={"Authorization": f"Bearer {fresh_token()}", "Content-Type": "application/pdf"},
        )
        self.assertEqual(response.status, 200, await response.text())
        uploaded = await response.json()
        self.assertEqual(Path(uploaded["path"]).read_bytes(), data)
        self.assertEqual(uploaded["size"], len(data))
        return uploaded["path"], data

    async def open(self, path="/"):
        from browser_use.browser.events import NavigateToUrlEvent

        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url=self.origin + path))
        await self.browser.get_browser_state_summary()

    async def index(self, test):
        selectors = await self.browser.get_selector_map()
        return next(index for index, node in selectors.items() if test(node))

    async def by_id(self, element_id):
        return await self.index(lambda node: node.attributes.get("id") == element_id)

    async def act(self, name, paths=(), **params):
        from browser_use.filesystem.file_system import FileSystem

        action = self.tools.registry.registry.actions[name]
        return await action.function(
            params=action.param_model(**params),
            browser_session=self.browser,
            available_file_paths=list(paths),
            file_system=FileSystem(self.session.workspace),
        )

    async def attach(self, path, index):
        return await self.act("upload_file", [path], index=index, path=path)

    async def received_one(self):
        await asyncio.wait_for(self.arrived.wait(), 10)
        await asyncio.sleep(0.5)  # a second, wrong delivery would show up by now
        return self.received

    async def test_real_http_bytes_reach_the_bound_https_form_through_chromium(self):
        path, data = await self.stage()
        await self.open()
        result = await self.attach(path, await self.index(
            lambda node: node.tag_name == "input" and node.attributes.get("type") == "file"))
        self.assertFalse(result.error, result.error)
        self.assertEqual(await self.received_one(), [("document", data)])

    async def test_a_different_site_cannot_receive_the_document(self):
        path, _ = await self.stage("https://other.test")
        await self.open()
        result = await self.attach(path, await self.index(
            lambda node: node.tag_name == "input" and node.attributes.get("type") == "file"))
        self.assertIn("bound HTTPS site", result.error)
        self.assertEqual(self.received, [])

    async def test_a_button_that_makes_its_field_on_click_gets_the_file_through_its_picker(self):
        path, data = await self.stage(name="logo.png", size=40_000)
        await self.open("/button")
        result = await self.attach(path, await self.by_id("logo"))
        self.assertFalse(result.error, result.error)
        self.assertIn("file picker", result.extracted_content)
        self.assertEqual(await self.received_one(), [("logo", data)])

    async def test_the_picker_the_agents_click_opened_is_answered_and_told_and_only_for_that_button(self):
        path, data = await self.stage(name="logo.png", size=40_000)
        await self.open("/button")
        logo = await self.by_id("logo")
        clicked = await self.act("click", [path], index=logo)
        self.assertFalse(clicked.error, clicked.error)
        await asyncio.sleep(0.3)
        told = clicked.extracted_content if worker.PICKER_OPENED in clicked.extracted_content \
            else self.run.pickers.notice(self.session.tab, True)
        self.assertIn(worker.PICKER_OPENED, told)
        # The photo's button is another upload: the logo's open picker does not get its file.
        photo_path, photo = await self.stage(name="photo.png", size=30_000)
        result = await self.attach(photo_path, await self.by_id("photo"))
        self.assertFalse(result.error, result.error)
        self.assertEqual(await self.received_one(), [("photo", photo)])
        self.arrived.clear()
        self.assertFalse((await self.act("click", [path], index=logo)).error)
        await asyncio.sleep(0.3)
        result = await self.attach(path, logo)
        self.assertFalse(result.error, result.error)
        self.assertIn("when you clicked", result.extracted_content)
        await asyncio.wait_for(self.arrived.wait(), 10)
        await asyncio.sleep(0.5)
        self.assertEqual(self.received, [("photo", photo), ("logo", data)])

    async def test_a_click_that_opens_a_picker_without_a_file_tells_the_agent_not_to_script_one(self):
        await self.open("/button")
        clicked = await self.act("click", index=await self.by_id("logo"))
        await asyncio.sleep(0.3)
        told = clicked.extracted_content if worker.PICKER_WITHOUT_FILE in clicked.extracted_content \
            else self.run.pickers.notice(self.session.tab, False)
        self.assertIn("never attach one with evaluate", told)
        self.assertIsNone(self.run.pickers.notice(self.session.tab, False))

    async def test_a_drop_zone_gets_the_file_dropped_and_text_that_takes_no_drop_keeps_the_page(self):
        path, data = await self.stage(name="logo.png", size=40_000)
        await self.open("/zone")
        result = await self.attach(path, await self.by_id("zone"))
        self.assertFalse(result.error, result.error)
        self.assertIn("Dropped", result.extracted_content)
        self.assertEqual(await self.received_one(), [("zone", data)])
        text = await self.index(lambda node: node.attributes.get("id") == "text")
        result = await self.attach(path, text)
        self.assertIn("takes no dropped file", result.error)
        self.assertEqual(await self.browser.get_current_page_url(), self.origin + "/zone")
        self.assertEqual(len(self.received), 1)

    async def test_a_page_that_lets_a_drag_over_but_takes_no_drop_does_not_open_the_file(self):
        path, _ = await self.stage(name="logo.png", size=40_000)
        await self.open("/half")
        tabs = await self.browser.get_tabs()
        result = await self.attach(path, await self.by_id("area"))
        self.assertIn("did not take the dropped file", result.error)
        await asyncio.sleep(1)
        self.assertEqual(len(await self.browser.get_tabs()), len(tabs))
        self.assertEqual(await self.browser.get_current_page_url(), self.origin + "/half")

    async def test_a_forms_send_button_is_never_pressed_and_a_web_components_button_is(self):
        path, data = await self.stage(name="logo.png", size=40_000)
        await self.open("/form")
        result = await self.attach(path, await self.by_id("send"))
        self.assertTrue(result.error)
        await asyncio.sleep(1)
        self.assertEqual((self.sent, self.received), ([], []))
        self.assertEqual(await self.browser.get_current_page_url(), self.origin + "/form")
        result = await self.attach(path, await self.by_id("component"))
        self.assertFalse(result.error, result.error)
        self.assertEqual(await self.received_one(), [("component", data)])

    async def test_another_sites_frame_never_gets_the_file_by_its_picker_or_a_drop(self):
        path, _ = await self.stage(name="logo.png", size=40_000)
        await self.open("/framed")
        button = await self.index(lambda node: node.attributes.get("id") == "logo")
        result = await self.attach(path, button)
        self.assertTrue(result.error)
        frame = await self.by_id("frame")
        result = await self.attach(path, frame)
        self.assertTrue(result.error)
        await asyncio.sleep(1)
        self.assertEqual(self.received, [])


if __name__ == "__main__":
    unittest.main()
