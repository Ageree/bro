"""SiteErrors against a real Chrome: python -m unittest test_site_errors (in browser-vm/worker).

Needs browser-use 0.13.10 and a Chromium, so CI skips it: set BRO_CARD_FORMS_CHROME to the Chromium
binary, as for test_card_forms. The page copies PREDUBEZHDAI's checkout (RU 04.10): «Оплатить» posts the
order with axios, the server refuses it, and the page moves to /order/error with no reason shown. As every
page of the site, it first asks for the account in the background, which a guest gets 401 for.
"""

import asyncio
import io
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker  # noqa: E402

CHROME = os.environ.get("BRO_CARD_FORMS_CHROME")

# Red at the top, blue from 1500 px down: scrolled to 2000, the visible page is blue.
TALL = """<!doctype html><meta charset=utf-8><body style="margin:0">
<div style="height:1500px;background:#f00"></div><div style="height:3000px;background:#00f"></div>"""

CHECKOUT = """<!doctype html><meta charset=utf-8><body>
<button id="pay">Оплатить</button>
<script>
fetch('/api/user');
pay.onclick = async () => {
  await fetch('/api/cart?token=abc');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/orders/create?session=s3cr3t');
  xhr.onloadend = () => history.pushState({}, '', '/order/error');
  xhr.send(JSON.stringify({phone: '+79217818876'}));
};
</script>"""


class SiteErrorsTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not CHROME:
            self.skipTest("set BRO_CARD_FORMS_CHROME to a Chromium binary")
        from aiohttp import web
        from browser_use import BrowserSession

        async def checkout(_):
            return web.Response(text=CHECKOUT, content_type="text/html")

        async def cart(_):
            return web.json_response({"items": 1})

        async def create(_):
            return web.json_response(
                {"message": "Пользователь is not a valid patronymic", "login": "owner@example.com"}, status=422)

        async def user(_):
            return web.json_response({"error": "unauthorized"}, status=401)

        async def tall(_):
            return web.Response(text=TALL, content_type="text/html")

        app = web.Application()
        app.router.add_get("/order", checkout)
        app.router.add_get("/api/user", user)
        app.router.add_get("/tall", tall)
        app.router.add_get("/api/cart", cart)
        app.router.add_post("/api/orders/create", create)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        await web.TCPSite(self.runner, "127.0.0.1", 8703).start()
        self.browser = BrowserSession(executable_path=CHROME, headless=True, keep_alive=True,
                                      chromium_sandbox=os.geteuid() != 0)
        await self.browser.start()

    async def asyncTearDown(self):
        await self.browser.kill()
        await self.runner.cleanup()

    async def page_socket(self):
        import aiohttp

        host = self.browser.cdp_url.split("://", 1)[1].split("/", 1)[0]
        async with aiohttp.ClientSession() as http:
            async with http.get(f"http://{host}/json/list") as response:
                targets = await response.json(content_type=None)
        return next(t["webSocketDebuggerUrl"] for t in targets if t.get("type") == "page")

    async def test_the_refused_order_and_its_answer_reach_the_report(self):
        from browser_use.browser.events import NavigateToUrlEvent

        errors = worker.SiteErrors()
        errors.start(await self.page_socket())
        await asyncio.sleep(0.5)
        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url="http://127.0.0.1:8703/order"))
        await asyncio.sleep(1.5)
        cdp = await self.browser.get_or_create_cdp_session()
        await cdp.cdp_client.send.Runtime.evaluate(params={"expression": "pay.click()"}, session_id=cdp.session_id)
        await asyncio.sleep(1.5)
        await errors.stop()

        report = errors.report({"https://*.example.com": {"login_username": "owner@example.com"}})
        self.assertIn("422 POST http://127.0.0.1:8703/api/orders/create — ", report)
        self.assertIn("Пользователь is not a valid patronymic", report)
        # Neither the answered request, nor the query, nor a secret's value, nor what the page sent.
        self.assertNotIn("/api/cart", report)
        self.assertNotIn("s3cr3t", report)
        self.assertNotIn("owner@example.com", report)
        self.assertIn("<secret>", report)
        self.assertNotIn("79217818876", report)

    async def open_and_pay(self, errors):
        from browser_use.browser.events import NavigateToUrlEvent

        errors.start(await self.page_socket())
        await asyncio.sleep(0.5)
        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url="http://127.0.0.1:8703/order"))
        await asyncio.sleep(1.5)
        cdp = await self.browser.get_or_create_cdp_session()
        await cdp.cdp_client.send.Runtime.evaluate(params={"expression": "pay.click()"}, session_id=cdp.session_id)
        await asyncio.sleep(1.5)

    async def test_the_agent_is_told_of_the_refused_order_and_not_of_the_account_probe(self):
        errors = worker.SiteErrors()
        await self.open_and_pay(errors)
        secrets = {"https://*.example.com": {"login_username": "owner@example.com"}}
        notices = errors.notices(secrets)
        await errors.stop()
        self.assertEqual(len(notices), 1, notices)
        self.assertIn("The site's server refused POST http://127.0.0.1:8703/api/orders/create: 422 — ", notices[0])
        self.assertIn("Пользователь is not a valid patronymic", notices[0])
        self.assertIn("do not report success", notices[0])
        for hidden in ("/api/user", "s3cr3t", "owner@example.com", "79217818876"):
            self.assertNotIn(hidden, notices[0])
        self.assertEqual(errors.notices(secrets), [])  # told once
        # The account probe stays in the report only.
        self.assertIn("401 GET http://127.0.0.1:8703/api/user", errors.report(secrets))

    async def test_the_step_shot_is_the_visible_page_at_half_scale(self):
        from browser_use.browser.events import NavigateToUrlEvent

        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url="http://127.0.0.1:8703/tall"))
        await asyncio.sleep(1)
        cdp = await self.browser.get_or_create_cdp_session()
        size = await cdp.cdp_client.send.Runtime.evaluate(
            # The viewport without its scrollbar.
            params={"expression": "window.scrollTo(0, 2000); const root = document.documentElement; "
                                  "[root.clientWidth, root.clientHeight]", "returnByValue": True},
            session_id=cdp.session_id)
        width, height = size["result"]["value"]
        await asyncio.sleep(0.3)
        shot = await worker.page_jpeg(self.browser)
        self.assertEqual(shot[:2], b"\xff\xd8")
        self.assertLess(len(shot), 60_000)
        try:
            from PIL import Image
        except ImportError:
            return
        image = Image.open(io.BytesIO(shot)).convert("RGB")
        self.assertLessEqual(abs(image.width - width * worker.TRAIL_SCALE), 2)
        self.assertLessEqual(abs(image.height - height * worker.TRAIL_SCALE), 2)
        red, _green, blue = image.getpixel((image.width // 2, image.height // 2))
        self.assertGreater(blue, 200)
        self.assertLess(red, 60)

    async def test_a_run_whose_requests_all_went_through_reports_nothing(self):
        errors = worker.SiteErrors()
        errors.start(await self.page_socket())
        await asyncio.sleep(0.5)
        from browser_use.browser.events import NavigateToUrlEvent

        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url="http://127.0.0.1:8703/tall"))
        await asyncio.sleep(1)
        await errors.stop()
        self.assertEqual(errors.report(), "")


if __name__ == "__main__":
    unittest.main()
