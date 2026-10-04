"""fill_card against real card forms in Chrome: python -m unittest test_card_forms (in browser-vm/worker).

Needs browser-use 0.13.10 and a Chromium, so CI skips it: set BRO_CARD_FORMS_CHROME to the Chromium
binary to run it (in a cloud session: /opt/pw-browsers/chromium-*/chrome-linux/chrome). The forms copy
how checkouts lay their card fields out — ЮKassa's month and year boxes in the processor's own frame, a
single masked MM/YY field, Stripe's one frame per field, selects — on two origins, so a frame of the
processor is out of process, as on a real checkout.
"""

import asyncio
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker  # noqa: E402

CHROME = os.environ.get("BRO_CARD_FORMS_CHROME")
CARD = {"number": "4276550101324310", "month": "01", "year": "31", "cvc": "249", "holder": "SAVELY SOLOVYEV"}

# A mask as checkouts write them: digits only, grouped, a separator put in by the page itself.
MASKS = """
<script>
function mask(input, groups, joiner) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\\D/g, '').slice(0, groups.reduce((a, b) => a + b, 0));
    const parts = []; let at = 0;
    for (const size of groups) { if (digits.length > at) parts.push(digits.slice(at, at + size)); at += size; }
    input.value = parts.join(joiner);
  });
}
function advance(input, next) {
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\\D/g, '');
    if (input.value.length >= input.maxLength && next) next.focus();
  });
}
</script>
"""

YOOKASSA_FRAME = MASKS + """
<form>
  <label>Номер карты</label><div><input id="n" inputmode="numeric" maxlength="19"></div>
  <div><span>Срок действия</span><div><input id="m" maxlength="2" inputmode="numeric"> / <input id="y" maxlength="2" inputmode="numeric"></div></div>
  <div><span>Код</span><input id="c" type="password" maxlength="3" inputmode="numeric"></div>
  <label><input type="checkbox"> Нужна квитанция</label>
  <button type="button">Заплатить 2 100 ₽</button>
</form>
<script>
mask(n, [4, 4, 4, 4], ' ');
n.addEventListener('input', () => { if (n.value.length === 19) m.focus(); });
advance(m, y); advance(y, c);
</script>
"""

SINGLE_MASKED_FRAME = MASKS + """
<input autocomplete="cc-number" placeholder="0000 0000 0000 0000" id="n">
<input placeholder="ММ/ГГ" id="e"><input placeholder="CVV" id="c" type="password">
<input placeholder="Имя владельца карты" id="h">
<script>mask(n, [4, 4, 4, 4], ' '); mask(e, [2, 2], '/');</script>
"""

SINGLE_PLAIN_FRAME = """
<div>Card number</div><div><input name="pan"></div>
<div>Expiry</div><div><input name="exp" placeholder="MM/YY" maxlength="5"></div>
<div>CVC</div><div><input name="code" maxlength="4"></div>
"""

STRIPE_NUMBER = MASKS + '<input autocomplete="cc-number" name="cardnumber" id="n"><script>mask(n,[4,4,4,4]," ")</script>'
STRIPE_EXPIRY = MASKS + '<input autocomplete="cc-exp" name="exp-date" placeholder="MM / YY" id="e"><script>mask(e,[2,2]," / ")</script>'
STRIPE_CVC = '<input autocomplete="cc-csc" name="cvc" placeholder="CVC">'

SELECTS_PAGE = """
<h2>Доставка</h2>
<label>Имя <input id="name"></label><label>Код домофона <input id="intercom"></label>
<h2>Оплата</h2>
<label>Card number <input id="number" name="card_number"></label>
<label>Expiration month <select id="month"><option value="">MM</option>""" + "".join(
    f'<option value="{m:02d}">{m:02d}</option>' for m in range(1, 13)) + """</select></label>
<label>Expiration year <select id="year"><option value="">YYYY</option>""" + "".join(
    f'<option value="{y}">{y}</option>' for y in range(2026, 2041)) + """</select></label>
<label>CVV <input id="cvv"></label>
"""

UNLABELLED_FRAME = """
<input name="cardNumber"><input name="expMonth" maxlength="2"><input name="expYear" maxlength="4"><input name="cvc">
"""

DELIVERY_PAGE = """<label>Имя <input id="name"></label><label>Код домофона <input id="intercom"></label>"""


def page(body):
    return f"<!doctype html><meta charset=utf-8><body>{body}</body>"


class CardForms(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        if not CHROME:
            self.skipTest("set BRO_CARD_FORMS_CHROME to a Chromium binary")
        from aiohttp import web
        from browser_use import BrowserSession

        pages = {}
        self.pages = pages

        async def serve(request):
            body = pages.get(request.path)
            return web.Response(text=page(body), content_type="text/html") if body else web.Response(status=404)

        self.runners = []
        for port in (8701, 8702):
            app = web.Application()
            app.router.add_get("/{tail:.*}", serve)
            runner = web.AppRunner(app)
            await runner.setup()
            await web.TCPSite(runner, "127.0.0.1", port).start()
            self.runners.append(runner)
        self.browser = BrowserSession(executable_path=CHROME, headless=True, keep_alive=True,
                                      chromium_sandbox=os.geteuid() != 0, args=["--site-per-process"])
        await self.browser.start()

    async def asyncTearDown(self):
        await self.browser.kill()
        for runner in self.runners:
            await runner.cleanup()

    async def open(self, path):
        from browser_use.browser.events import NavigateToUrlEvent

        await self.browser.event_bus.dispatch(NavigateToUrlEvent(url=f"http://127.0.0.1:8701{path}"))
        await asyncio.sleep(1.5)

    async def values(self, frame_path, ids):
        """The fields' values as the page itself reads them, from the frame at `frame_path`."""
        for frame in await worker.card_frames(self.browser):
            if frame.url.endswith(frame_path):
                return await frame.call("(ids) => ids.map((id) => document.getElementById(id).value)", ids)
        raise AssertionError(f"no frame {frame_path}")

    async def fill(self):
        return await worker.fill_card_form(await worker.card_frames(self.browser), CARD)

    async def test_yookassa_month_and_year_boxes_in_the_processors_frame(self):
        self.pages["/frame"] = YOOKASSA_FRAME
        self.pages["/"] = '<h1>PREDUBEZHDAI</h1><iframe src="http://localhost:8702/frame" width=500 height=400></iframe>'
        await self.open("/")
        filled, message = await self.fill()
        self.assertTrue(filled, message)
        self.assertEqual(await self.values("/frame", ["n", "m", "y", "c"]), ["4276 5501 0132 4310", "01", "31", "249"])
        self.assertIn("localhost", message)
        self.assertNotIn("249", message)

    async def test_the_whole_expiry_in_each_box_keeps_01_01(self):
        # What the run did before fill_card (RU 04.10): card_expiry, «01/31», typed into the month box and then
        # into the year box, each cleared first as browser-use's input does. Each keeps its first two characters.
        self.pages["/frame"] = YOOKASSA_FRAME
        self.pages["/"] = '<iframe src="http://localhost:8702/frame" width=500 height=400></iframe>'
        await self.open("/")
        frame = next(f for f in await worker.card_frames(self.browser) if f.url.endswith("/frame"))
        for box in ("m", "y"):
            await frame.call("(id) => { const el = document.getElementById(id); el.value = ''; el.focus(); }", box)
            await frame.type("01/31")
        self.assertEqual(await self.values("/frame", ["m", "y"]), ["01", "01"])

    async def test_single_masked_expiry_with_holder(self):
        self.pages["/frame"] = SINGLE_MASKED_FRAME
        self.pages["/"] = '<iframe src="http://localhost:8702/frame" width=500 height=300></iframe>'
        await self.open("/")
        filled, message = await self.fill()
        self.assertTrue(filled, message)
        self.assertEqual(await self.values("/frame", ["n", "e", "c", "h"]),
                         ["4276 5501 0132 4310", "01/31", "249", "SAVELY SOLOVYEV"])

    async def test_single_plain_expiry_needs_its_separator(self):
        self.pages["/"] = SINGLE_PLAIN_FRAME.replace('name="pan"', 'name="pan" id="n"').replace(
            'name="exp"', 'name="exp" id="e"').replace('name="code"', 'name="code" id="c"')
        await self.open("/")
        filled, message = await self.fill()
        self.assertTrue(filled, message)
        self.assertEqual(await self.values("/", ["n", "e", "c"]), ["4276550101324310", "01/31", "249"])

    async def test_stripe_one_frame_per_field(self):
        self.pages["/number"], self.pages["/expiry"], self.pages["/cvc"] = STRIPE_NUMBER, STRIPE_EXPIRY, STRIPE_CVC
        self.pages["/"] = "".join(f'<iframe src="http://localhost:8702/{name}" height=60></iframe>'
                                  for name in ("number", "expiry", "cvc"))
        await self.open("/")
        filled, message = await self.fill()
        self.assertTrue(filled, message)
        self.assertEqual((await self.values("/number", ["n"]))[0], "4276 5501 0132 4310")
        self.assertEqual((await self.values("/expiry", ["e"]))[0], "01 / 31")

    async def test_selects_and_a_delivery_form_beside_them(self):
        self.pages["/"] = SELECTS_PAGE
        await self.open("/")
        filled, message = await self.fill()
        self.assertTrue(filled, message)
        self.assertEqual(await self.values("/", ["number", "month", "year", "cvv", "name", "intercom"]),
                         ["4276550101324310", "01", "2031", "249", "", ""])

    async def test_unlabelled_fields_in_a_same_origin_frame(self):
        self.pages["/frame"] = UNLABELLED_FRAME.replace('name="cardNumber"', 'name="cardNumber" id="n"').replace(
            'name="expMonth"', 'name="expMonth" id="m"').replace('name="expYear"', 'name="expYear" id="y"').replace(
            'name="cvc"', 'name="cvc" id="c"')
        self.pages["/"] = '<iframe src="/frame"></iframe>'
        await self.open("/")
        filled, message = await self.fill()
        self.assertTrue(filled, message)
        self.assertEqual(await self.values("/frame", ["n", "m", "y", "c"]), ["4276550101324310", "01", "2031", "249"])

    async def test_a_page_without_a_card_form_is_left_alone(self):
        self.pages["/"] = DELIVERY_PAGE
        await self.open("/")
        filled, message = await self.fill()
        self.assertFalse(filled)
        self.assertIn("No card number field", message)
        self.assertEqual(await self.values("/", ["name", "intercom"]), ["", ""])


if __name__ == "__main__":
    unittest.main()
