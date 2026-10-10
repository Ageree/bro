"""enter_code against real code forms in Chrome: python -m unittest test_code_boxes (in browser-vm/worker).

Needs browser-use 0.13.10 and a Chromium, so CI skips it: set BRO_CODE_BOXES_CHROME to the Chromium binary
(in a cloud session: /opt/pw-browsers/chromium-*/chrome-linux/chrome). The pages copy how sites lay a
one-time code out: playerok.com's six one-digit boxes in a shadow root that move focus on input but do not
spread a longer text, WB ID's boxes that do spread it, a single one-time-code field, and a form that submits
on the last character and empties itself.
"""

import asyncio
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker  # noqa: E402

CHROME = os.environ.get("BRO_CODE_BOXES_CHROME")

BOXES_IN_SHADOW = """
<div id="host"></div>
<script>
const root = document.getElementById('host').attachShadow({mode: 'open'});
root.innerHTML = '<div>' + '<input maxlength="1" inputmode="numeric">'.repeat(6) + '</div>';
const boxes = [...root.querySelectorAll('input')];
%s
window.read = () => boxes.map((b) => b.value).join('');
</script>
"""

# playerok.com: a digit moves focus to the next box; a longer text is not spread, the box keeps its first.
MOVES_ON = """
boxes.forEach((box, i) => box.addEventListener('input', () => {
  box.value = box.value.replace(/\\D/g, '').slice(0, 1);
  if (box.value && boxes[i + 1]) boxes[i + 1].focus();
}));
"""

# WB ID: the box that gets a longer text spreads it over the boxes from itself on.
SPREADS = """
boxes.forEach((box, i) => {
  box.removeAttribute('maxlength'); box.name = 'code';
  box.addEventListener('input', () => {
    const text = box.value.replace(/\\D/g, '');
    boxes.forEach((b, j) => { if (j >= i && text[j - i] !== undefined) b.value = text[j - i]; });
    if (i === 0 || text.length === 1) box.value = text[0] || '';
    const next = boxes[Math.min(i + text.length, 5)]; next.focus();
  });
});
"""

# The page drops the digit of any box that is not its next one: a mismatch enter_code has to see.
REWRITES = """
boxes.forEach((box, i) => box.addEventListener('input', () => { box.value = '7'; }));
"""

SUBMITS = """
const done = document.createElement('p'); done.id = 'done'; document.body.append(done);
boxes.forEach((box, i) => box.addEventListener('input', () => {
  if (boxes[i + 1]) boxes[i + 1].focus();
  if (boxes.every((b) => b.value)) { done.textContent = 'sent ' + boxes.map((b) => b.value).join(''); host.remove(); }
}));
"""

SINGLE = '<input name="otp" autocomplete="one-time-code" id="c"><script>window.read = () => c.value</script>'


def page(body):
    return f"<!doctype html><meta charset=utf-8><body>{body}</body>"


class CodeBoxes(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not CHROME:
            self.skipTest("set BRO_CODE_BOXES_CHROME to a Chromium binary")
        from aiohttp import web
        from browser_use import BrowserSession

        self.pages = {}

        async def serve(request):
            body = self.pages.get(request.path)
            return web.Response(text=page(body), content_type="text/html") if body else web.Response(status=404)

        app = web.Application()
        app.router.add_get("/{tail:.*}", serve)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        await web.TCPSite(self.runner, "127.0.0.1", 8703).start()
        self.browser = BrowserSession(executable_path=CHROME, headless=True, keep_alive=True,
                                      chromium_sandbox=os.geteuid() != 0)
        await self.browser.start()

    async def asyncTearDown(self):
        await self.browser.kill()
        await self.runner.cleanup()

    async def enter(self, body, code="844174"):
        from browser_use.browser.events import NavigateToUrlEvent

        self.pages["/"] = body
        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url="http://127.0.0.1:8703/"))
        await asyncio.sleep(1.5)
        cdp = await self.browser.get_or_create_cdp_session()
        return await worker.enter_one_time_code(cdp, code)

    async def read(self, expression="window.read()"):
        cdp = await self.browser.get_or_create_cdp_session()
        answer = await cdp.cdp_client.send.Runtime.evaluate(
            params={"expression": expression, "returnByValue": True}, session_id=cdp.session_id)
        return (answer.get("result") or {}).get("value")

    async def test_one_digit_boxes_that_do_not_spread_a_pasted_code(self):
        entered, message = await self.enter(BOXES_IN_SHADOW % MOVES_ON)
        self.assertTrue(entered, message)
        self.assertEqual(await self.read(), "844174")
        self.assertNotIn("844174", message)

    async def test_the_whole_code_in_the_first_box_keeps_one_digit(self):
        # What enter_code did before (RU 10.10): the case this stand exists for.
        from browser_use.browser.events import NavigateToUrlEvent

        self.pages["/"] = BOXES_IN_SHADOW % MOVES_ON
        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url="http://127.0.0.1:8703/"))
        await asyncio.sleep(1.5)
        cdp = await self.browser.get_or_create_cdp_session()
        await cdp.cdp_client.send.Runtime.evaluate(
            params={"expression": worker.FIND_CODE_FIELD, "returnByValue": True}, session_id=cdp.session_id)
        await cdp.cdp_client.send.Input.insertText(params={"text": "844174"}, session_id=cdp.session_id)
        self.assertEqual(await self.read(), "8")

    async def test_boxes_that_spread_the_code_themselves(self):
        entered, message = await self.enter(BOXES_IN_SHADOW % SPREADS)
        self.assertTrue(entered, message)
        self.assertEqual(await self.read(), "844174")

    async def test_boxes_that_rewrite_what_they_get_are_refused(self):
        entered, message = await self.enter(BOXES_IN_SHADOW % REWRITES)
        self.assertFalse(entered)
        self.assertNotIn("844174", message)

    async def test_a_form_that_submits_on_the_last_digit_and_goes_away(self):
        entered, message = await self.enter(BOXES_IN_SHADOW % SUBMITS)
        self.assertTrue(entered, message)
        self.assertEqual(await self.read("document.getElementById('done').textContent"), "sent 844174")

    async def test_a_single_one_time_code_field(self):
        entered, message = await self.enter(SINGLE, "482913")
        self.assertTrue(entered, message)
        self.assertEqual(await self.read(), "482913")

    async def test_no_code_field(self):
        entered, _ = await self.enter("<p>Nothing here</p>")
        self.assertFalse(entered)


if __name__ == "__main__":
    unittest.main()
