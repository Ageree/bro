"""The checkout fixture and harness: python -m unittest test_checkout_harness (in browser-vm/worker).

The shop's server rules run anywhere (aiohttp only). Its pages need a Chromium and browser-use 0.13.10, as
test_card_forms does: set BRO_CARD_FORMS_CHROME. The harness itself calls a paid model: set
BRO_CHECKOUT_MODELS (luna, deepseek or both, comma-separated) and ROUTERAI_API_KEY, and optionally
BRO_CHECKOUT_SCENARIOS (default: all), to run it as a regression check.
"""

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).parent))
import checkout_shop  # noqa: E402

CHROME = os.environ.get("BRO_CARD_FORMS_CHROME")
MODELS = [m for m in os.environ.get("BRO_CHECKOUT_MODELS", "").split(",") if m]

ORDER = {"customer": {"firstName": "Савелий", "lastName": "Соловьев", "email": checkout_shop.EMAIL,
                      "phone": checkout_shop.PHONE, "countryCode": "RU"},
         "city": "Москва", "deliveryMethod": "pickup", "storeId": "chistoprudny", "paymentMethod": "card"}


class ShopRules(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.shop = checkout_shop.Shop()
        self.client = TestClient(TestServer(self.shop.shop_app()))
        self.pay = TestClient(TestServer(self.shop.pay_app()))
        await self.client.start_server()
        await self.pay.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        await self.pay.close()

    async def add_cream(self):
        await self.client.get("/")
        response = await self.client.post("/api/cart", json={"slug": "vam-i-ne-snilos-30"})
        self.assertEqual(response.status, 200)

    async def sign_in(self, password=checkout_shop.PASSWORD):
        return await self.client.post("/api/auth/login", json={"email": checkout_shop.EMAIL, "password": password})

    async def test_a_guest_with_the_accounts_email_is_refused(self):
        await self.add_cream()
        response = await self.client.post("/api/orders", json=ORDER)
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["message"], "User already exist")
        self.assertEqual(self.shop.orders, {})

    async def test_signing_in_keeps_the_guests_basket_and_places_the_order(self):
        await self.add_cream()
        self.assertEqual((await self.sign_in("wrong")).status, 401)
        self.assertEqual((await self.sign_in()).status, 200)
        response = await self.client.post("/api/orders", json=ORDER)
        self.assertEqual(response.status, 200)
        order = (await response.json())["orderId"]
        self.assertEqual(self.shop.orders[order]["total"], 2100)
        self.assertEqual((await self.client.get("/api/cart")).status, 200)
        self.assertEqual((await (await self.client.get("/api/cart")).json())["items"], [])

    async def test_the_phone_flipped_to_kazakhstan_is_refused(self):
        await self.add_cream()
        await self.sign_in()
        for phone, country in (("+779217818876", "KZ"), ("+77921781887", "KZ"), ("+77921781887", "RU"),
                               ("+7921781887", "RU")):
            body = {**ORDER, "customer": {**ORDER["customer"], "phone": phone, "countryCode": country}}
            response = await self.client.post("/api/orders", json=body)
            self.assertEqual(response.status, 400, phone)
            self.assertIn("phone must be a valid phone number", (await response.json())["message"])

    async def test_pickup_without_a_store_has_no_delivery_method(self):
        await self.add_cream()
        await self.sign_in()
        body = {key: value for key, value in ORDER.items() if key not in ("deliveryMethod", "storeId")}
        response = await self.client.post("/api/orders", json=body)
        self.assertEqual(response.status, 400)
        self.assertEqual((await response.json())["message"], ["deliveryMethod must be a valid enum value"])

    async def test_the_legacy_order_form_always_fails(self):
        response = await self.client.post("/api/order", json={"name": "x", "phone": checkout_shop.PHONE})
        self.assertEqual(response.status, 400)
        self.assertEqual((await response.json())["message"], ["deliveryMethod must be a valid enum value",
                                                              "countryCode must be a string"])
        self.assertEqual(len(self.shop.requests("/api/order", "POST")), 1)

    async def test_signing_everyone_out_empties_the_guest_basket_but_not_the_accounts(self):
        await self.add_cream()
        await self.sign_in()
        self.shop.sign_out_everyone()
        self.assertIsNone((await (await self.client.get("/api/me")).json())["user"])
        self.assertEqual((await (await self.client.get("/api/cart")).json())["items"], [])
        await self.sign_in()
        self.assertEqual(len((await (await self.client.get("/api/cart")).json())["items"]), 1)

    async def test_the_processor_takes_only_the_test_card(self):
        order = self.shop.create_order()
        wrong = {"order": order["id"], "number": "4276 5501 0132 4310", "month": "01", "year": "01", "cvc": "249"}
        response = await self.pay.post("/api/pay", json=wrong)
        self.assertEqual(response.status, 402)
        self.assertEqual(self.shop.paid_orders(), [])
        response = await self.pay.post("/api/pay", json={**wrong, "year": "31"})
        self.assertTrue((await response.json())["paid"])
        self.assertEqual(self.shop.paid_orders(), [order])
        # The log keeps the card's last four digits only.
        self.assertEqual(self.shop.requests("/api/pay")[0]["body"]["number"], "…4310")


class ShopPages(unittest.IsolatedAsyncioTestCase):
    """The pages in Chromium, driven the way browser-use's own actions drive them."""

    async def asyncSetUp(self):
        if not CHROME:
            self.skipTest("set BRO_CARD_FORMS_CHROME to a Chromium binary")
        from browser_use import BrowserSession, Tools

        self.shop = checkout_shop.Shop(saved_city=False)
        await self.shop.start()
        self.browser = BrowserSession(executable_path=CHROME, headless=True, keep_alive=True,
                                      chromium_sandbox=os.geteuid() != 0, args=["--site-per-process"])
        await self.browser.start()
        self.tools = Tools()
        sid = self.shop.new_session(checkout_shop.EMAIL)
        self.shop.fill_cart()
        cdp = await self.browser.get_or_create_cdp_session()
        await cdp.cdp_client.send.Network.setCookie(
            params={"name": "sid", "value": sid, "domain": "127.0.0.1", "path": "/"}, session_id=cdp.session_id)

    async def asyncTearDown(self):
        await self.browser.kill()
        await self.shop.stop()

    async def open(self, path):
        await self.browser.navigate_to(checkout_shop.SHOP + path)
        await asyncio.sleep(1.5)

    async def index_of(self, **attributes):
        state = await self.browser.get_browser_state_summary(include_screenshot=False)
        for index, node in state.dom_state.selector_map.items():
            if all(node.attributes.get(k) == v for k, v in attributes.items()):
                return index
        raise AssertionError(f"no element {attributes}")

    async def act(self, action, **params):
        result = await self.tools.registry.execute_action(action, params, browser_session=self.browser)
        self.assertIsNone(result.error, result.error)

    async def evaluate(self, expression):
        cdp = await self.browser.get_or_create_cdp_session()
        answer = await cdp.cdp_client.send.Runtime.evaluate(
            params={"expression": expression, "returnByValue": True, "awaitPromise": True}, session_id=cdp.session_id)
        return answer["result"].get("value")

    async def test_the_phone_typed_whole_after_its_fixed_prefix_turns_kazakh(self):
        await self.open("/checkout")
        await self.act("input", index=await self.index_of(name="phone"), text="+7 921 781-88-76")
        self.assertEqual(await self.evaluate("[document.querySelector('[name=phone]').value, "
                                             "document.querySelector('[name=phoneCountry]').value]"),
                         ["+7 79217818876", "KZ"])
        await self.act("input", index=await self.index_of(name="phone"), text="9217818876")
        self.assertEqual(await self.evaluate("[document.querySelector('[name=phone]').value, "
                                             "document.querySelector('[name=phoneCountry]').value]"),
                         ["+7 921 781-88-76", "RU"])

    async def test_the_city_comes_from_its_late_suggestions_and_typing_again_drops_it(self):
        await self.open("/checkout")
        await self.act("input", index=await self.index_of(name="city"), text="Моск")
        await asyncio.sleep(0.5)
        self.assertTrue(await self.evaluate("document.getElementById('suggest').classList.contains('hidden')"))
        await asyncio.sleep(1.2)
        await self.evaluate("[...document.querySelectorAll('#suggest li')].find(li => li.textContent === 'Москва').click()")
        await self.evaluate("document.querySelector('[value=pickup]').click()")
        await self.evaluate("document.querySelector('[data-store=chistoprudny]').click()")
        self.assertEqual(await self.evaluate("document.querySelector('.store.chosen b').textContent"),
                         "PREDUBEZHDAI Чистые пруды")
        await self.act("input", index=await self.index_of(name="city"), text="Москва")
        self.assertTrue(await self.evaluate("document.getElementById('methods').classList.contains('hidden')"))

    async def test_a_scripted_checkout_pays_by_card_in_the_processors_frame(self):
        import worker

        await self.open("/checkout")
        await self.act("input", index=await self.index_of(name="phone"), text="9217818876")
        await self.act("input", index=await self.index_of(name="city"), text="Моск")
        await asyncio.sleep(1.5)
        await self.evaluate("document.querySelector('#suggest li').click()")
        await self.evaluate("document.querySelector('[value=pickup]').click()")
        await self.evaluate("document.querySelector('[data-store=chistoprudny]').click()")
        await self.evaluate("document.getElementById('to-pay').click()")
        await self.evaluate("document.querySelector('[name=payment][value=card]').click()")
        await self.evaluate("document.getElementById('pay').click()")
        await asyncio.sleep(2)
        self.assertRegex(await self.browser.get_current_page_url(), r"/payment/43846$")
        card = {**checkout_shop.CARD, "sites": [checkout_shop.SHOP, checkout_shop.PAY]}
        filled, message = await worker.fill_card_form(await worker.card_frames(self.browser), card)
        self.assertTrue(filled, message)
        frame = next(f for f in await worker.card_frames(self.browser) if "/frame" in f.url)
        await frame.call("document.getElementById('pay').click()")
        await asyncio.sleep(2)
        self.assertRegex(await self.browser.get_current_page_url(), r"/order/success/43846$")
        self.assertEqual(len(self.shop.paid_orders()), 1)


@unittest.skipUnless(MODELS and os.environ.get("ROUTERAI_API_KEY"), "set BRO_CHECKOUT_MODELS and ROUTERAI_API_KEY")
class Harness(unittest.IsolatedAsyncioTestCase):
    """The real agent through the scenarios: each one is a paid run of a model."""

    async def test_scenarios(self):
        import checkout_harness

        os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
        fixture = json.loads(checkout_harness.TASKS.read_text())
        names = [n for n in os.environ.get("BRO_CHECKOUT_SCENARIOS", "").split(",") if n] or list(
            checkout_harness.SCENARIOS)
        out = tempfile.mkdtemp(prefix="bro-checkout-")
        for name in names:
            for model in MODELS:
                with self.subTest(scenario=name, model=model):
                    report = await checkout_harness.run_scenario(name, model, out, fixture)
                    self.assertTrue(report["verdict"]["pass"], report["verdict"])


if __name__ == "__main__":
    unittest.main()
