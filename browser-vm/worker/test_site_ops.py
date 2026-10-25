"""SiteTraffic, the operations it finds behind a report, and op() replaying them: python -m unittest test_site_ops.

The pages are small copies of what the sites answered on the stand (25.10): hh.ru's search document carries its
vacancies in <template id="HH-Lux-InitialState">, ostrovok.ru's results page asks its serp for the hotels."""

import asyncio
import html
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker  # noqa: E402

HH_PAGE = "https://hh.ru/search/vacancy?text=product+manager&area=1&salary=300000&only_with_salary=true"
VACANCIES = [
    {"vacancyId": 138625702, "name": "Продакт-менеджер", "company": {"visibleName": "Unagrande Company"},
     "compensation": {"from": 300000, "currencyCode": "RUR"}, "area": {"name": "Москва"},
     "links": {"desktop": "https://hh.ru/vacancy/138625702", "mobile": "https://m.hh.ru/vacancy/138625702"}},
    {"vacancyId": 138703565, "name": "Ведущий продакт-менеджер", "company": {"visibleName": "Авилон"},
     "compensation": {"from": 300000, "to": 350000}, "area": {"name": "Москва"},
     "links": {"desktop": "https://hh.ru/vacancy/138703565"}},
    {"vacancyId": 137660010, "name": "Product manager", "company": {"visibleName": "ООО Чатапп"},
     "compensation": {"from": 300000, "to": 400000}, "area": {"name": "Москва"},
     "links": {"desktop": "https://hh.ru/vacancy/137660010"}},
    {"vacancyId": 138000001, "name": "Менеджер продукта", "company": {"visibleName": "Lucky Hunter"},
     "compensation": {"from": 320000}, "area": {"name": "Москва"},
     "links": {"desktop": "https://hh.ru/vacancy/138000001"}},
]
STATE = {"account": {"email": "anna@example.com", "phone": "+79217818876"},
         "vacancySearchResult": {"vacancies": VACANCIES, "totalResults": 4}}
HH_DOCUMENT = ("<!doctype html><html><head><script>window.x = {a: 1}</script></head><body>"
               f'<template style="display:none" id="HH-Lux-InitialState">{html.escape(json.dumps(STATE, ensure_ascii=False))}'
               "</template></body></html>")
HH_REPORT = "RESULT: five vacancies\nITEMS: " + json.dumps([
    {"name": "Продакт-менеджер", "price": "300 000 ₽ за месяц, на руки", "url": "https://hh.ru/vacancy/138625702"},
    {"name": "Ведущий продакт-менеджер", "price": "от 300 000 до 350 000 ₽",
     "url": "https://hh.ru/vacancy/138703565"},
    {"name": "Product manager", "price": "300 000 – 400 000 ₽", "url": "https://hh.ru/vacancy/137660010"},
], ensure_ascii=False) + "\nNEEDS: none"

OSTROVOK_PAGE = "https://ostrovok.ru/hotel/russia/kazan/?dates=07.11.2026-09.11.2026&guests=1&sort=price.asc"
SERP = "https://ostrovok.ru/hotel/search/v2/site/serp?session=7082cb8b-d138-42b8-969c-26448d408401"
HOTELS = [{"ota_hotel_id": slug, "master_id": mid, "region_catalog_slug": "russia/kazan", "name": name,
           "rating": rating, "price": price}
          for slug, mid, name, rating, price in [
              ("bulgar", 7389083, "Отель Булгар", 8.0, 3936),
              ("gostinitsa_amsterdam_na_tukaya_hotel", 13127332, "Отель Амстердам на Тукая", 8.2, 4829),
              ("perekrestok_dzhaza_hotel", 10580707, "Отель Перекресток Джаза", 8.3, 4835),
              ("don_kikhot_hotel_", 6479652, "Отель Дон Кихот", 8.9, 7961)]]
SERP_ANSWER = {"hotels": [{"static_vm": {"name": h["name"]}, "rates": []} for h in HOTELS[:2]],
               "map_hotels": HOTELS, "total_hotels": 9219}


def hotel_link(hotel):
    return (f"https://ostrovok.ru/hotel/russia/kazan/mid{hotel['master_id']}/{hotel['ota_hotel_id']}/"
            "?dates=07.11.2026-09.11.2026&guests=1&sort=price.asc&room=s-2d44f313")


OSTROVOK_REPORT = "ITEMS: " + json.dumps([
    {"name": h["name"], "price": f"{h['price']:,} ₽ за 2 ночи".replace(",", " "), "url": hotel_link(h)}
    for h in HOTELS[:3]], ensure_ascii=False)
SECRETS = {"https://*.hh.ru": {"login_phone": "+79217818876"}}


class Socket:
    """The tab's CDP socket: what was sent on it."""

    def __init__(self):
        self.sent, self.next_id = [], 1

    async def send_json(self, data):
        self.sent.append(data)


async def feed(errors, socket, request_id, kind, url, page, status, mime, body=None, sent=None, method="GET"):
    """One request of the page as Chrome tells it, and its body when one is asked for."""
    await errors.handle({"method": "Network.requestWillBeSent", "params": {
        "requestId": request_id, "type": kind, "documentURL": page,
        "request": {"method": method, "url": url, **({"postData": sent} if sent else {})}}}, socket)
    await errors.handle({"method": "Network.responseReceived", "params": {
        "requestId": request_id, "response": {"status": status, "mimeType": mime}}}, socket)
    await errors.handle({"method": "Network.loadingFinished",
                         "params": {"requestId": request_id, "encodedDataLength": len(body or "")}}, socket)
    asked = [m for m in socket.ws.sent if m["method"] == "Network.getResponseBody"
             and m["params"]["requestId"] == request_id]
    if asked and body is not None:
        await errors.handle({"id": asked[-1]["id"], "result": {"body": body}}, socket)
    return bool(asked)


class SiteTrafficTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.traffic = worker.SiteTraffic()
        self.errors = worker.SiteErrors()
        self.errors.traffic = self.traffic
        self.socket = types.SimpleNamespace(ws=Socket(), next_id=1)

    async def test_the_log_has_the_sites_own_requests_and_no_body_cookie_or_secret(self):
        asked = await feed(self.errors, self.socket, "q1", "Fetch", SERP, OSTROVOK_PAGE, 200, "application/json",
                           json.dumps(SERP_ANSWER, ensure_ascii=False),
                           sent=json.dumps({"session_params": {"arrival_date": "2026-11-07"}, "page": 1}),
                           method="POST")
        self.assertTrue(asked)
        # A tracker's request is not the site's: not written down, its body never asked for.
        self.assertFalse(await feed(self.errors, self.socket, "q2", "XHR",
                                    "https://mc.yandex.ru/watch/1?page-url=x", OSTROVOK_PAGE, 200, "application/json",
                                    "{}"))
        await feed(self.errors, self.socket, "q3", "XHR",
                   "https://hh.ru/api/user?phone=%2B79217818876&q=+79217818876", HH_PAGE, 401, "application/json")
        log = self.traffic.public(SECRETS)
        self.assertEqual([line["url"] for line in log], [
            "https://ostrovok.ru/hotel/search/v2/site/serp?session=%masked%",
            "https://hh.ru/api/user?phone=%masked%&q=<secret>"])
        self.assertEqual(log[0]["keys"], ["hotels", "map_hotels", "total_hotels"])
        self.assertEqual(log[0]["bodyKeys"], ["session_params", "page"])
        self.assertEqual(log[1]["status"], 401)
        written = json.dumps(log, ensure_ascii=False)
        for hidden in ("2026-11-07", "Отель", "7082cb8b", "79217818876", "mc.yandex"):
            self.assertNotIn(hidden, written)

    async def test_an_iframes_document_is_not_the_pages_and_a_redirect_keeps_its_status(self):
        socket = types.SimpleNamespace(ws=Socket(), next_id=1, frame="TAB")

        async def navigate(request_id, frame, url, redirect=None):
            await self.errors.handle({"method": "Network.requestWillBeSent", "params": {
                "requestId": request_id, "type": "Document", "frameId": frame, "documentURL": url,
                "request": {"method": "GET", "url": url},
                **({"redirectResponse": {"status": redirect, "mimeType": "text/html"}} if redirect else {})}}, socket)

        await navigate("n1", "TAB", "https://ostrovok.ru/hotel/russia/kazan/?dates=07.11.2026-09.11.2026")
        await navigate("n1", "TAB", OSTROVOK_PAGE, redirect=307)
        await navigate("n2", "AD", "https://ostrovok.ru/ads/frame.html")
        log = self.traffic.public()
        self.assertEqual([(line["url"].split("?")[0], line.get("status")) for line in log],
                         [("https://ostrovok.ru/hotel/russia/kazan/", 307), ("https://ostrovok.ru/hotel/russia/kazan/", None)])

    async def test_it_finds_the_operation_behind_the_reported_options_as_a_template(self):
        await feed(self.errors, self.socket, "d1", "Document", HH_PAGE, HH_PAGE, 200, "text/html", HH_DOCUMENT)
        operations = self.traffic.operations(HH_REPORT, SECRETS)
        self.assertEqual(operations, [{
            "name": "hh.ru/search/vacancy",
            "page": "https://hh.ru/search/vacancy?text=%query%&area=%number%&salary=%number%&only_with_salary=%flag%",
            "source": {"kind": "document", "state": {"tag": "template", "id": "HH-Lux-InitialState"}},
            "items": ["vacancySearchResult", "vacancies"],
            "fields": {"name": ["name"], "price": ["compensation", "from"], "link": {"path": ["links", "desktop"]}},
            "seen": {"items": 4, "matched": 3, "of": 3}}])

        traffic = worker.SiteTraffic()
        self.errors.traffic = traffic
        await feed(self.errors, self.socket, "q1", "Fetch", SERP, OSTROVOK_PAGE, 200, "application/json",
                   json.dumps(SERP_ANSWER, ensure_ascii=False), method="POST")
        [operation] = traffic.operations(OSTROVOK_REPORT)
        # The list with every hotel, not the page's first two; its link as a template of each hotel's fields.
        self.assertEqual(operation["items"], ["map_hotels"])
        self.assertEqual(operation["source"], {"kind": "xhr", "method": "POST",
                                               "url": "https://ostrovok.ru/hotel/search/v2/site/serp"})
        self.assertEqual(operation["fields"]["link"], {
            "template": "/hotel/{0}/mid{1}/{2}/", "parts": [["region_catalog_slug"], ["master_id"], ["ota_hotel_id"]],
            "query": ["dates", "guests", "sort"]})
        written = json.dumps(operation, ensure_ascii=False)
        for value in ("07.11.2026", "price.asc", "7082cb8b", "Булгар", "7389083", "3936"):
            self.assertNotIn(value, written)

    async def test_no_operation_without_enough_reported_options_or_with_a_secret_in_its_page(self):
        await feed(self.errors, self.socket, "d1", "Document", HH_PAGE, HH_PAGE, 200, "text/html", HH_DOCUMENT)
        one = "ITEMS: " + json.dumps([{"name": "Продакт-менеджер", "price": "300 000 ₽",
                                       "url": "https://hh.ru/vacancy/138625702"}], ensure_ascii=False)
        self.assertEqual(self.traffic.operations(one), [])
        self.assertEqual(self.traffic.operations("RESULT: nothing found\nITEMS: []"), [])
        traffic = worker.SiteTraffic()
        self.errors.traffic = traffic
        page = "https://hh.ru/search/annapetrova/vacancy?text=x"
        await feed(self.errors, self.socket, "d2", "Document", page, page, 200, "text/html", HH_DOCUMENT)
        self.assertEqual(len(traffic.operations(HH_REPORT)), 1)
        self.assertEqual(traffic.operations(HH_REPORT, {"https://*.hh.ru": {"login": "annapetrova"}}), [])

    def test_a_template_takes_the_pages_of_its_shape_only(self):
        self.assertEqual(worker.site_template("https://Ostrovok.ru/hotel/russia/kazan/mid7389083/?dates=07.11.2026"
                                              "&guests=2&sort=price.asc&phone=+7921&token=x#top"),
                         "https://ostrovok.ru/hotel/russia/kazan/%id%/?dates=%date%&guests=%number%&sort=%sort%")
        template = "https://ostrovok.ru/hotel/%word%/%word%/?dates=%date%"
        self.assertTrue(worker.site_template_matches(template, "https://ostrovok.ru/hotel/russia/moscow/?x=1"))
        self.assertFalse(worker.site_template_matches(template, "https://ostrovok.ru/hotel/russia/"))
        self.assertFalse(worker.site_template_matches(template, "https://evil.ru/hotel/russia/moscow/"))
        self.assertFalse(worker.site_template_matches(template, "http://ostrovok.ru/hotel/russia/moscow/"))

    def test_a_run_record_has_the_traffic_only_when_it_was_asked_for(self):
        run = worker.Run("r1", "s1", "task")
        self.assertNotIn("siteTraffic", run.public())
        run.site_traffic = {"requests": [], "operations": []}
        self.assertEqual(worker.Run.load(run.public() | {"steps": []}).site_traffic, run.site_traffic)


class Response:
    def __init__(self, url, text, status=200, method="GET"):
        self.url, self.status, self.request = url, status, types.SimpleNamespace(method=method)
        self._text = text

    async def text(self):
        return self._text


class Page:
    """A Playwright page: goto answers with the document, and the page's own request with its data."""

    def __init__(self, documents, requests=()):
        self.documents, self.requests, self.url, self.closed = documents, list(requests), "about:blank", False

    def is_closed(self):
        return self.closed

    def on(self, *_):
        pass

    async def goto(self, url, **_):
        self.url = url
        return Response(url, self.documents.get(url, "<html></html>"))

    def expect_response(self, predicate, timeout):
        page = self

        class Waiting:
            async def __aenter__(self):
                future = asyncio.get_running_loop().create_future()
                self.value = future
                self.predicate, self.future = predicate, future
                return self

            async def __aexit__(self, *_):
                for response in page.requests:
                    if self.predicate(response) and not self.future.done():
                        self.future.set_result(response)
                if not self.future.done():
                    self.future.set_exception(TimeoutError("no such request"))

        return Waiting()


class OpTest(unittest.IsolatedAsyncioTestCase):
    def api(self, page, operations):
        context = types.SimpleNamespace(pages=[page])
        api = worker.CodeApi(context, [], operations=worker.site_operations(operations))
        api.register(page)
        api.last = page
        return api

    async def test_op_reads_a_documents_state_as_cards(self):
        [operation] = await self._hh_operation()
        url = "https://hh.ru/search/vacancy?text=analyst&area=2"
        page = Page({url: HH_DOCUMENT})
        answer = await self.api(page, [operation]).op("hh.ru/search/vacancy", url)
        self.assertEqual(answer["count"], 4)
        self.assertEqual(answer["cards"][0] | {"more": None}, {
            "name": "Продакт-менеджер", "price": 300000, "link": "https://hh.ru/vacancy/138625702", "more": None})
        self.assertEqual(answer["cards"][1]["more"]["compensation.to"], 350000)
        self.assertEqual(page.url, url)  # the results page is the one the model touched last
        # Not a page of the operation's, or no such operation: the model is told, nothing opens.
        api = self.api(Page({}), [operation])
        with self.assertRaisesRegex(ValueError, "takes a results page like"):
            await api.op("hh.ru/search/vacancy", "https://hh.ru/employer/1")
        with self.assertRaisesRegex(ValueError, "no known operation"):
            await api.op("ozon.ru/search", url)
        with self.assertRaisesRegex(ValueError, "no longer carries"):
            await self.api(Page({url: "<html>captcha</html>"}), [operation]).op("hh.ru/search/vacancy", url)

    async def test_op_reads_the_pages_own_request_and_writes_each_link(self):
        traffic = worker.SiteTraffic()
        errors = worker.SiteErrors()
        errors.traffic = traffic
        socket = types.SimpleNamespace(ws=Socket(), next_id=1)
        await feed(errors, socket, "q1", "Fetch", SERP, OSTROVOK_PAGE, 200, "application/json",
                   json.dumps(SERP_ANSWER, ensure_ascii=False), method="POST")
        [operation] = traffic.operations(OSTROVOK_REPORT)
        url = "https://ostrovok.ru/hotel/russia/kazan/?dates=10.12.2026-12.12.2026&guests=2"
        page = Page({}, [Response("https://ostrovok.ru/api/other", "{}"),
                         Response(SERP.replace("7082", "aaaa"), json.dumps(SERP_ANSWER), method="POST")])
        answer = await self.api(page, [operation]).op(operation["name"], url)
        self.assertEqual(answer["count"], 4)
        cheapest = min(answer["cards"], key=lambda card: card["price"])
        self.assertEqual(cheapest["link"],
                         "https://ostrovok.ru/hotel/russia/kazan/mid7389083/bulgar/?dates=10.12.2026-12.12.2026&guests=2")
        self.assertEqual(cheapest["more"]["rating"], 8.0)

    async def _hh_operation(self):
        traffic = worker.SiteTraffic()
        errors = worker.SiteErrors()
        errors.traffic = traffic
        socket = types.SimpleNamespace(ws=Socket(), next_id=1)
        await feed(errors, socket, "d1", "Document", HH_PAGE, HH_PAGE, 200, "text/html", HH_DOCUMENT)
        return traffic.operations(HH_REPORT)


if __name__ == "__main__":
    unittest.main()
