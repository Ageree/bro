"""solve_captcha's token captchas against a real Chrome: python -m unittest test_captcha_tokens (in browser-vm/worker).

Needs browser-use 0.13.10 and a Chromium, so CI skips it: set BRO_CARD_FORMS_CHROME to the Chromium binary,
as for test_card_forms. The pages copy how sign-up forms carry a captcha — reCAPTCHA rendered explicitly
into a form that sits in a frame of another origin (out of process, as a real embedded form is), its
picture challenge still open; an hCaptcha in a same-origin frame; reCAPTCHA v3 — with fake widgets in place
of the vendors' scripts, and 2Captcha's API served locally.
"""

import asyncio
import logging
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import worker  # noqa: E402

CHROME = os.environ.get("BRO_CARD_FORMS_CHROME")
RECAPTCHA_KEY = "6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"
HCAPTCHA_KEY = "10000000-ffff-ffff-ffff-000000000001"
SOLVER_KEY = "stand-solver-key-0123456789"
TOKEN = "03AFcWeA-stand-token-" + "y" * 200

# The sign-up form as reCAPTCHA leaves it after an explicit render: the key and the callback only in
# ___grecaptcha_cfg (no data-sitekey), the hidden response field, and the challenge popup at the body.
RECAPTCHA_FORM = f"""
<form id="signup" action="/done"><input name="email" value="owner@example.com">
  <div id="captcha"><textarea id="g-recaptcha-response" name="g-recaptcha-response" style="display:none"></textarea></div>
  <button>Sign up</button>
</form>
<div id="popup"><div><iframe src="/recaptcha/api2/bframe?k={RECAPTCHA_KEY}" width=300 height=300></iframe></div></div>
<script>
window.___grecaptcha_cfg = {{clients: {{0: {{id: 0, Xa: {{el: document.getElementById('captcha'),
  Ya: {{sitekey: '{RECAPTCHA_KEY}', size: 'normal', callback: (token) => {{ window.solvedWith = token; }}}}}}}}}}}};
</script>
"""

HCAPTCHA_FORM = f"""
<form><div class="h-captcha" data-sitekey="{HCAPTCHA_KEY}" data-callback="onCaptcha">
  <textarea name="h-captcha-response" style="display:none"></textarea>
  <textarea name="g-recaptcha-response" style="display:none"></textarea></div></form>
<script>function onCaptcha(token) {{ window.solvedWith = token; }}</script>
"""

V3_PAGE = f"""<form><input name="email"></form>
<script src="http://127.0.0.1:8731/recaptcha/api.js?render={RECAPTCHA_KEY}"></script>"""

# What the form's documents read after a solve: the response fields, the callback's token, the popup.
READ_FORM = """(() => ({
  url: location.href,
  fields: [...document.querySelectorAll('textarea')].map((t) => t.value),
  solvedWith: window.solvedWith || null,
  popup: document.getElementById('popup') ? getComputedStyle(document.getElementById('popup')).visibility : null,
}))()"""


def page(body):
    return f"<!doctype html><meta charset=utf-8><body>{body}</body>"


class TokenCaptchas(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not CHROME:
            self.skipTest("set BRO_CARD_FORMS_CHROME to a Chromium binary")
        from aiohttp import web
        from browser_use import BrowserSession

        pages = {}
        self.pages = pages
        self.tasks = []

        async def serve(request):
            if request.path.endswith("api.js"):
                return web.Response(text="window.grecaptcha = {};", content_type="application/javascript")
            body = pages.get(request.path, "<p>challenge</p>" if "bframe" in request.path else None)
            return web.Response(text=page(body), content_type="text/html") if body else web.Response(status=404)

        async def create_task(request):
            body = await request.json()
            self.tasks.append(body)
            ok = body.get("clientKey") == SOLVER_KEY
            return web.json_response({"errorId": 0, "taskId": len(self.tasks)} if ok
                                     else {"errorId": 1, "errorCode": "ERROR_KEY_DOES_NOT_EXIST"})

        polls = {}

        async def task_result(request):
            task_id = (await request.json())["taskId"]
            polls[task_id] = polls.get(task_id, 0) + 1
            if polls[task_id] < 2:
                return web.json_response({"errorId": 0, "status": "processing"})
            return web.json_response({"errorId": 0, "status": "ready", "solution": {"gRecaptchaResponse": TOKEN}})

        self.runners = []
        for port, routes in ((8731, None), (8732, None), (8733, "solver")):
            app = web.Application()
            if routes:
                app.router.add_post("/createTask", create_task)
                app.router.add_post("/getTaskResult", task_result)
            else:
                app.router.add_get("/{tail:.*}", serve)
            runner = web.AppRunner(app)
            await runner.setup()
            await web.TCPSite(runner, "127.0.0.1", port).start()
            self.runners.append(runner)
        self.enterContext(mock.patch.object(worker, "TWO_CAPTCHA_API", "http://127.0.0.1:8733"))
        self.enterContext(mock.patch.object(worker, "TOKEN_POLL_S", 0.2))
        self.browser = BrowserSession(executable_path=CHROME, headless=True, keep_alive=True,
                                      chromium_sandbox=os.geteuid() != 0, args=["--site-per-process"])
        await self.browser.start()

    async def asyncTearDown(self):
        await self.browser.kill()
        for runner in self.runners:
            await runner.cleanup()

    async def open(self, path):
        from browser_use.browser.events import NavigateToUrlEvent

        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url=f"http://127.0.0.1:8731{path}"))
        await asyncio.sleep(1.5)

    async def solve(self, key=SOLVER_KEY):
        import aiohttp

        worlds, frame_urls = await worker.captcha_worlds(self.browser)
        async with aiohttp.ClientSession() as http:
            return await worker.solve_token_captcha(worlds, frame_urls, await self.browser.get_current_page_url(),
                                                    http, key)

    async def read(self, needle):
        """READ_FORM in the document whose address has `needle`, wherever in the tab it sits."""
        worlds, _ = await worker.captcha_worlds(self.browser)
        for evaluate in worlds:
            state = await evaluate(f"(() => {{ const r = {READ_FORM}; return r.url.includes({needle!r}) ? r : null; }})()")
            if state:
                return state
            nested = await evaluate(f"""(() => {{ for (const f of document.querySelectorAll('iframe')) {{
                try {{ const w = f.contentWindow; if (w.location.href.includes({needle!r}))
                  return w.eval({READ_FORM!r}); }} catch (e) {{}} }} return null; }})()""")
            if nested:
                return nested
        raise AssertionError(f"no document {needle}")

    async def test_recaptcha_in_a_cross_origin_form_with_its_challenge_open(self):
        self.pages["/form"] = RECAPTCHA_FORM
        self.pages["/signup"] = '<h1>Sign up</h1><iframe src="http://localhost:8732/form" width=600 height=500></iframe>'
        await self.open("/signup")
        records = []
        handler = logging.Handler(logging.DEBUG)
        handler.emit = lambda record: records.append(handler.format(record))
        logging.getLogger().addHandler(handler)
        try:
            solved, message = await self.solve()
        finally:
            logging.getLogger().removeHandler(handler)
        self.assertTrue(solved, message)
        self.assertEqual(len(self.tasks), 1)
        task = self.tasks[0]["task"]
        self.assertEqual((task["type"], task["websiteKey"], task["websiteURL"]),
                         ("RecaptchaV2TaskProxyless", RECAPTCHA_KEY, "http://localhost:8732/form"))
        self.assertIn("Chrome", task["userAgent"])
        form = await self.read("8732/form")
        self.assertEqual((form["fields"], form["solvedWith"], form["popup"]), ([TOKEN], TOKEN, "hidden"))
        for text in [message, *records]:
            self.assertNotIn(SOLVER_KEY, text)
            self.assertNotIn(TOKEN, text)

    async def test_hcaptcha_in_a_same_origin_frame_with_a_data_callback(self):
        self.pages["/form"] = HCAPTCHA_FORM
        self.pages["/signup"] = '<iframe src="/form" width=600 height=500></iframe>'
        await self.open("/signup")
        solved, message = await self.solve()
        self.assertTrue(solved, message)
        self.assertEqual(self.tasks[0]["task"]["type"], "HCaptchaTaskProxyless")
        self.assertEqual(self.tasks[0]["task"]["websiteURL"], "http://127.0.0.1:8731/form")
        form = await self.read("8731/form")
        self.assertEqual((form["fields"], form["solvedWith"]), ([TOKEN, TOKEN], TOKEN))

    async def test_v3_a_wrong_key_and_a_page_without_a_captcha(self):
        self.pages["/v3"] = V3_PAGE
        await self.open("/v3")
        solved, message = await self.solve()
        self.assertEqual((solved, "reCAPTCHA v3" in message, self.tasks), (False, True, []))
        self.pages["/form"] = RECAPTCHA_FORM
        await self.open("/form")
        solved, message = await self.solve("wrong")
        self.assertEqual((solved, message),
                         (False, "The solving service could not solve the page's reCAPTCHA (ERROR_KEY_DOES_NOT_EXIST)."))
        self.pages["/plain"] = "<form><input name=q></form>"
        await self.open("/plain")
        self.assertIsNone(await self.solve())


if __name__ == "__main__":
    unittest.main()
