"""Downloads against a real Chromium: python -m unittest test_downloads (in browser-vm/worker).

Needs browser-use 0.13.10 and a Chromium, so CI skips it: set BRO_DOWNLOADS_CHROME to the Chromium binary.
Chrome runs on its own and the worker attaches over CDP, as on the pool's VM (browser-use takes it for a remote
browser then). The book comes as Z-Library's does (24.10): the site's link redirects to a file host on another
domain, which serves it as an attachment.
"""

import asyncio
import contextlib
import os
import ssl
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aiohttp import web

sys.path.insert(0, str(Path(__file__).parent))
import worker  # noqa: E402

CHROME = os.environ.get("BRO_DOWNLOADS_CHROME")
BOOK = b"PK\x03\x04" + bytes(range(256)) * 4096  # a megabyte that starts as a ZIP does
CDP_PORT = 9341


class RealDownloads(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not CHROME:
            self.skipTest("set BRO_DOWNLOADS_CHROME to a Chromium binary")
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(mock.patch.object(worker, "SESSIONS", root / "sessions"))
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(root / "key.pem"),
                        "-out", str(root / "cert.pem"), "-days", "1", "-subj", "/CN=localhost"],
                       check=True, capture_output=True)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(root / "cert.pem", root / "key.pem")
        self.file_requests = []

        async def book(request):
            self.file_requests.append(request.headers.get("Sec-Fetch-Mode"))
            response = web.StreamResponse(headers={
                "Content-Type": "application/epub+zip", "Content-Length": str(len(BOOK)),
                "Content-Disposition": 'attachment; filename="Pride and Prejudice.epub"'})
            await response.prepare(request)
            pause = float(request.query.get("pause", "0"))
            for start in range(0, len(BOOK), 128 * 1024):
                await response.write(BOOK[start:start + 128 * 1024])
                await asyncio.sleep(pause)
            return response

        files = web.Application()
        files.router.add_get("/books-files/redirection", book)
        await self.serve(files, "127.0.0.2", 8711, tls)

        async def page(request):
            pause = request.query.get("pause", "0")
            return web.Response(content_type="text/html",
                                text=f'<!doctype html><a id="dl" href="/dl/1?pause={pause}">Скачать epub</a>')

        async def dl(request):
            raise web.HTTPFound(f"https://127.0.0.2:8711/books-files/redirection?pause={request.query['pause']}")

        site = web.Application()
        site.router.add_get("/book", page)
        site.router.add_get("/dl/1", dl)
        await self.serve(site, "127.0.0.1", 8712, tls)

        self.chrome = subprocess.Popen(
            [CHROME, "--headless=new", "--ignore-certificate-errors", f"--remote-debugging-port={CDP_PORT}",
             f"--user-data-dir={root / 'profile'}", *(["--no-sandbox"] if os.geteuid() == 0 else []),
             "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop_chrome)
        self.enterContext(mock.patch.object(worker, "CDP_HTTP", f"http://127.0.0.1:{CDP_PORT}"))
        for _ in range(50):
            with contextlib.suppress(Exception):
                await worker.page_ids()
                break
            await asyncio.sleep(0.2)
        self.runtime = worker.Worker()
        self.session = worker.Session("downloads")
        self.folder = self.session.workspace / worker.DOWNLOADS
        self.before = worker.download_snapshot(self.folder)
        self.browser = await self.runtime.browser_session(self.session, {})
        self.addAsyncCleanup(self.browser.stop)

    def stop_chrome(self):
        self.chrome.kill()
        self.chrome.wait()

    async def serve(self, app, host, port, tls):
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, host, port, ssl_context=tls).start()
        self.addAsyncCleanup(runner.cleanup)

    async def click_download(self, pause):
        from browser_use import Tools
        from browser_use.browser.events import NavigateToUrlEvent

        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url=f"https://127.0.0.1:8712/book?pause={pause}"))
        await self.browser.get_browser_state_summary()
        index = next(index for index, node in (await self.browser.get_selector_map()).items()
                     if node.attributes.get("id") == "dl")
        click = Tools().registry.registry.actions["click"]
        return await click.function(params=click.param_model(index=index), browser_session=self.browser)

    async def test_a_book_behind_a_redirect_to_another_host_lands_in_the_folder_once(self):
        result = await self.click_download(0)
        self.assertFalse(result.error, result.error)
        after = await worker.finished_downloads(self.folder, self.before, 20)
        self.assertEqual(worker.run_downloads(self.before, after),
                         [{"path": "downloads/Pride and Prejudice.epub", "size": len(BOOK)}])
        self.assertEqual((self.folder / "Pride and Prejudice.epub").read_bytes(), BOOK)
        await asyncio.sleep(1)
        # Chrome's own download alone: browser-use's second, cross-origin fetch of the attachment is gone.
        self.assertEqual(self.file_requests, ["navigate"])

    async def test_a_download_slower_than_a_click_still_arrives(self):
        notices = worker.DownloadNotices(self.folder, self.before)
        result = await self.click_download(2.5)  # 20 s: browser-use's click gives up first
        self.assertIn("timed out", result.error or "")
        self.assertIn("goes on in the background", notices.notices()[0])
        after = await worker.finished_downloads(self.folder, self.before, 40)
        self.assertEqual(worker.run_downloads(self.before, after),
                         [{"path": "downloads/Pride and Prejudice.epub", "size": len(BOOK)}])
        done = notices.notices()
        self.assertEqual(len(done), 1)
        self.assertIn("Downloaded", done[0])
        self.assertEqual(notices.notices(), [])
