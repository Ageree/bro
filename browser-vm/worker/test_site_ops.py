"""SiteTraffic, the operations it finds behind a report, and op() replaying them: python -m unittest test_site_ops.

The pages are small copies of what the sites answered on the stand (25.10): hh.ru's search document carries its
vacancies in <template id="HH-Lux-InitialState">, ostrovok.ru's results page asks its serp for the hotels."""

import asyncio
import html
import json
import sys
import time
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
        # A trailing slash on one side only is the same page.
        self.assertTrue(worker.site_template_matches("https://hh.ru/search/vacancy", "https://hh.ru/search/vacancy/"))
        self.assertTrue(worker.site_template_matches(template, "https://ostrovok.ru/hotel/russia/moscow"))

    def test_only_a_short_latin_word_of_a_path_stays_in_a_template(self):
        cases = {
            "https://site.ru/search/vacancy": "https://site.ru/search/vacancy",
            "https://site.ru/city/%D0%BA%D0%B0%D0%B7%D0%B0%D0%BD%D1%8C/": "https://site.ru/city/%word%/",
            "https://site.ru/call/916-123-45-67": "https://site.ru/call/%id%",
            "https://site.ru/u/ivan_petrov/": "https://site.ru/u/%id%/",
            "https://site.ru/u/ivan.petrov": "https://site.ru/u/%id%",
            "https://site.ru/u/Lenina": "https://site.ru/u/%word%",
            "https://site.ru/p/abc%25def": "https://site.ru/p/%id%",
            "https://site.ru/p/a@b": "https://site.ru/p/%id%",
            "https://site.ru/street/ulitsa-bolshaya-sadovaya-dom": "https://site.ru/street/%word%",
            "https://site.ru/v2/list": "https://site.ru/%id%/list",
        }
        for url, template in cases.items():
            self.assertEqual(worker.site_template(url), template, url)
        # A query's key that is a value itself is left out, as one named like a secret is.
        self.assertEqual(worker.site_template("https://site.ru/s?q=x&f12345=1&c0ffee12=2&k=1"),
                         "https://site.ru/s?q=%query%&k=%number%")
        # A request's own path keeps its API version.
        self.assertEqual(worker.site_path_part("v2", request=True), "v2")

    def test_a_key_that_is_a_value_is_no_field_of_an_operation(self):
        element = {"name": "x", "12345678": {"price": 1}, "deadbeef00": 2, "rating": 8}
        self.assertEqual([path for path, _ in worker.element_leaves(element)], [("name",), ("rating",)])
        nested = {"byId": {"55512345": [{"a": 1}, {"a": 2}, {"a": 3}]}, "list": [{"a": 1}, {"a": 2}, {"a": 3}]}
        self.assertEqual([path for path, _ in worker.object_arrays(nested)], [("list",)])

    def test_the_site_is_its_exact_host_but_www(self):
        self.assertTrue(worker.same_host("https://www.hh.ru/a", "https://hh.ru/b"))
        self.assertFalse(worker.same_host("https://api.hh.ru/a", "https://hh.ru/b"))
        self.assertFalse(worker.same_host("https://shop.msk.ru/a", "https://other.msk.ru/b"))
        self.assertFalse(worker.same_host("https://a.co.uk/x", "https://b.co.uk/x"))
        traffic = worker.SiteTraffic()
        self.assertIsNone(traffic.request("GET", "https://other.msk.ru/api", "https://shop.msk.ru/", "xhr"))
        self.assertIsNotNone(traffic.request("GET", "https://shop.msk.ru/api", "https://shop.msk.ru/", "xhr"))

    async def test_bodies_are_counted_in_bytes_and_one_over_the_cap_is_not_asked_for(self):
        traffic = worker.SiteTraffic()
        entry = traffic.request("GET", "https://hh.ru/api", "https://hh.ru/", "xhr")
        traffic.answered(entry, 200, "application/json")
        text = json.dumps({"a": "ж" * 1000}, ensure_ascii=False)
        traffic.hold(entry, text)
        self.assertEqual(traffic.held, len(text.encode()))
        # Chrome told a size over the cap: its body is never asked for.
        errors = worker.SiteErrors()
        errors.traffic = worker.SiteTraffic()
        await errors.handle({"method": "Network.requestWillBeSent", "params": {
            "requestId": "big", "type": "Fetch", "documentURL": "https://hh.ru/",
            "request": {"method": "GET", "url": "https://hh.ru/api"}}}, self.socket)
        await errors.handle({"method": "Network.responseReceived", "params": {
            "requestId": "big", "response": {"status": 200, "mimeType": "application/json"}}}, self.socket)
        await errors.handle({"method": "Network.loadingFinished", "params": {
            "requestId": "big", "encodedDataLength": worker.SITE_TRAFFIC_BODY + 1}}, self.socket)
        self.assertEqual(self.socket.ws.sent, [])
        self.assertFalse(errors.traffic.awaited())

    async def test_playwright_never_reads_a_body_of_unknown_or_too_large_a_size(self):
        class Answer:
            def __init__(self, headers, received=None):
                self.url, self.status, self.headers, self.read = "https://hh.ru/api", 200, headers, False
                frame = types.SimpleNamespace(url="https://hh.ru/", parent_frame=None)

                async def sizes():
                    if received is None:
                        raise RuntimeError("no sizes")
                    return {"responseBodySize": received}

                self.request = types.SimpleNamespace(resource_type="xhr", frame=frame, method="GET", post_data=None,
                                                     sizes=sizes)

            async def body(self):
                self.read = True
                return b'{"a": 1}'

        traffic = worker.SiteTraffic()
        json_type = {"content-type": "application/json"}
        for answer, read in [
            (Answer(json_type), False),  # no size at all
            (Answer(json_type, received=worker.SITE_TRAFFIC_BODY + 1), False),
            (Answer(json_type | {"content-encoding": "br"}, received=worker.SITE_TRAFFIC_PACKED + 1), False),
            (Answer(json_type | {"content-length": str(worker.SITE_TRAFFIC_BODY + 1)}), False),
            (Answer({"content-type": "image/png", "content-length": "10"}), False),
            (Answer(json_type | {"content-length": "8"}), True),
            (Answer(json_type | {"content-encoding": "gzip"}, received=100), True),
        ]:
            await traffic.response(answer)
            self.assertEqual(answer.read, read, answer.headers)

    async def test_looking_for_operations_never_holds_the_runs_outcome_long(self):
        class Slow:
            def operations(self, report, secrets, seconds):
                time.sleep(seconds + 0.8)
                return [{"name": "x"}]

        started = time.monotonic()
        self.assertEqual(await worker.site_operations_found(Slow(), HH_REPORT, None, seconds=0.2), [])
        self.assertLess(time.monotonic() - started, 0.9)
        # The search itself stops at its deadline and finds nothing.
        await feed(self.errors, self.socket, "d1", "Document", HH_PAGE, HH_PAGE, 200, "text/html", HH_DOCUMENT)
        self.assertEqual(self.traffic.operations(HH_REPORT, None, seconds=-1), [])
        self.assertEqual(len(await worker.site_operations_found(self.traffic, HH_REPORT)), 1)

    def test_a_run_record_has_the_traffic_only_when_it_was_asked_for(self):
        run = worker.Run("r1", "s1", "task")
        self.assertNotIn("siteTraffic", run.public())
        run.site_traffic = {"requests": [], "operations": []}
        self.assertEqual(worker.Run.load(run.public() | {"steps": []}).site_traffic, run.site_traffic)


def test_tabs():
    """The keep-alive tabs of the worker as a direct read sees them, its own once it registered it."""
    return getattr(worker.worker, "visit_tabs", set())


class Response:
    def __init__(self, url, text, status=200, method="GET"):
        self.url, self.status, self.request = url, status, types.SimpleNamespace(method=method)
        self._text = text

    async def text(self):
        return self._text


class Page:
    """A Playwright page: goto answers with the document (its status and the address it landed on, when given),
    and tells its listeners each of the page's own requests; the page's fetch answers with the documents too."""

    def __init__(self, documents, requests=(), statuses=None, landed=None, walled=False):
        self.documents, self.requests, self.url, self.closed = documents, list(requests), "about:blank", False
        self.statuses, self.landed, self.walled = statuses or {}, landed or {}, walled
        self.listeners, self.visited, self.fetched = [], [], []
        self.target_seen = None
        self.cards = []

    def is_closed(self):
        return self.closed

    def on(self, event, handler):
        if event == "response":
            self.listeners.append(handler)

    def remove_listener(self, event, handler):
        self.listeners.remove(handler)

    @property
    def context(self):
        page = self

        class Cdp:
            async def send(self, method, params=None):
                page.visited.append(method)
                if method == "Target.getTargetInfo":
                    page.target_seen = page.target_seen or set(test_tabs())
                    return {"targetInfo": {"targetId": "T1"}}

        class Context:
            async def new_cdp_session(self, _page):
                return Cdp()

        return Context()

    async def goto(self, url, **_):
        self.url = self.landed.get(url, url)
        self.visited.append(url)
        for response in self.requests:
            for listener in list(self.listeners):
                listener(response)
        await asyncio.sleep(0)
        return Response(self.landed.get(url, url), self.documents.get(url, "<html></html>"),
                        status=self.statuses.get(url, 200))

    async def evaluate(self, expression, argument=None):
        if expression == worker.CODE_CARDS_JS:
            return self.cards
        if "fetch(u" in expression:
            self.fetched.append(argument)
            return {"status": self.statuses.get(argument, 200), "url": self.landed.get(argument, argument),
                    "text": self.documents.get(argument, "<html></html>")}
        if "document.title" in expression:  # code_wall's one look
            return ["Проверяем браузер", ""] if self.walled else ["Сайт", "x" * 2000]
        raise AssertionError(expression)

    async def close(self):
        self.closed = True


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
            await api.op("hh.ru/search/vacancy", "https://hh.ru/employer")
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

    async def test_op_takes_the_answer_that_holds_the_list_from_an_address_that_answers_many(self):
        # A GraphQL site asks one address for its menu first and its results after (citilink.ru, 25.10).
        operation = {"name": "www.citilink.ru/search/", "page": "https://www.citilink.ru/search/?text=%query%",
                     "source": {"kind": "xhr", "method": "POST", "url": "https://www.citilink.ru/graphql/"},
                     "items": ["data", "products"], "fields": {"name": ["shortName"], "price": ["price"]},
                     "seen": {"items": 3, "matched": 3, "of": 3}}
        products = [{"shortName": f"Чайник {n}", "price": 900 + n} for n in range(3)]
        page = Page({}, [Response("https://www.citilink.ru/graphql/", json.dumps({"data": {"menu": []}}), method="POST"),
                         Response("https://www.citilink.ru/graphql/", json.dumps({"data": {"products": products}}),
                                  method="POST")])
        recorder = worker.SiteTraffic()
        api = self.api(page, [operation])
        api.recorder = recorder
        answer = await api.op(operation["name"], "https://www.citilink.ru/search/?text=чайник")
        self.assertEqual([card["name"] for card in answer["cards"]], ["Чайник 0", "Чайник 1", "Чайник 2"])
        self.assertEqual(recorder.op_calls[0] | {"ms": 0},
                         {"name": operation["name"], "fit": "exact", "ok": True, "count": 3, "ms": 0})

    async def test_op_reads_a_page_whose_path_names_another_city_and_says_how_each_call_went(self):
        operation = await self._hh_operation()
        hotel = {"name": "drom.ru/toyota/camry/", "page": "https://auto.drom.ru/toyota/camry/",
                 "source": operation[0]["source"], "items": operation[0]["items"], "fields": operation[0]["fields"],
                 "seen": operation[0]["seen"]}
        url = "https://auto.drom.ru/kia/rio/"
        recorder = worker.SiteTraffic()
        api = self.api(Page({url: HH_DOCUMENT}), [hotel])
        api.recorder = recorder
        answer = await api.op(hotel["name"], url)
        self.assertEqual(answer["count"], 4)
        self.assertEqual(recorder.op_calls[-1]["fit"], "loose")
        # A site that no longer carries the state: a failure the model is told, written down with its reason.
        api = self.api(Page({url: "<html>nothing</html>"}), [hotel])
        api.recorder = recorder
        with self.assertRaisesRegex(ValueError, "no longer carries"):
            await api.op(hotel["name"], url)
        self.assertEqual({k: recorder.op_calls[-1][k] for k in ("ok", "reason", "fit")},
                         {"ok": False, "reason": "no_data", "fit": "loose"})

    async def _hh_operation(self):
        traffic = worker.SiteTraffic()
        errors = worker.SiteErrors()
        errors.traffic = traffic
        socket = types.SimpleNamespace(ws=Socket(), next_id=1)
        await feed(errors, socket, "d1", "Document", HH_PAGE, HH_PAGE, 200, "text/html", HH_DOCUMENT)
        return traffic.operations(HH_REPORT)


class FitAndPickTest(unittest.TestCase):
    def test_a_page_fits_exactly_loosely_where_a_find_kept_a_value_as_a_word_or_not_at_all(self):
        fit = worker.site_template_fit
        self.assertEqual(fit("https://auto.drom.ru/toyota/camry/", "https://auto.drom.ru/toyota/camry"), "exact")
        self.assertEqual(fit("https://auto.drom.ru/toyota/camry/", "https://auto.drom.ru/kia/rio/"), "loose")
        self.assertEqual(fit("https://ostrovok.ru/hotel/russia/kazan/", "https://ostrovok.ru/hotel/russia/sochi/"),
                         "loose")
        self.assertEqual(fit("https://site.ru/city/%word%/", "https://site.ru/city/%D0%BA%D0%B0%D0%B7%D0%B0%D0%BD%D1%8C/"),
                         "exact")
        for url in ("https://auto.drom.ru/kia/rio/2020/", "https://auto.drom.ru/kia", "https://evil.ru/kia/rio/",
                    "http://auto.drom.ru/kia/rio/", "https://auto.drom.ru/kia/a%20b%3Cc/", "https://auto.drom.ru:444/kia/rio/"):
            self.assertIsNone(fit("https://auto.drom.ru/toyota/camry/", url), url)
        # A placeholder takes one part of a path: not a slash, not itself unfilled.
        for url in ("https://site.ru/city/%word%/", "https://site.ru/city/a%2Fb/"):
            self.assertIsNone(fit("https://site.ru/city/%word%/", url), url)

    def test_a_documents_state_is_read_whatever_its_status_but_never_from_another_address(self):
        operation = {"source": {"kind": "document", "state": {"tag": "template", "id": "HH-Lux-InitialState"}}}
        url = "https://hh.ru/search/vacancy?text=x"
        self.assertEqual(worker.site_document_state(operation, url, 429, url, HH_DOCUMENT), STATE)
        # A Russian exit lands on the city's own host of the site: the same place, the same results.
        regional = "https://blagoveschensk.hh.ru/search/vacancy?text=x"
        self.assertEqual(worker.site_document_state(operation, url, 200, regional, HH_DOCUMENT), STATE)
        self.assertEqual(worker.site_document_state(operation, regional, 200, url, HH_DOCUMENT), STATE)
        cases = [(404, url, HH_DOCUMENT, "moved"), (200, "https://hh.ru/", HH_DOCUMENT, "moved"),
                 (200, "https://evilhh.ru/search/vacancy?text=x", HH_DOCUMENT, "moved"),
                 (200, "https://spb.hh.ru/", HH_DOCUMENT, "moved"),
                 (403, url, "<html>Доступ ограничен</html>", "blocked"), (200, url, "<html></html>", "no_data"),
                 (500, url, "<html></html>", "failed")]
        for status, landed, text, reason in cases:
            with self.assertRaises(worker.SiteOpFailure) as raised:
                worker.site_document_state(operation, url, status, landed, text)
            self.assertEqual(raised.exception.reason, reason, (status, landed))

    def test_a_city_host_of_the_site_is_the_same_place_and_a_neighbour_is_not(self):
        same = worker.site_same_place
        self.assertTrue(same("https://hh.ru/a", "https://blagoveschensk.hh.ru/a"))
        self.assertTrue(same("https://www.hh.ru/a", "https://hh.ru/b"))
        self.assertTrue(same("https://spb.hh.ru/a", "https://hh.ru/a"))
        for landed in ("https://evilhh.ru/a", "https://other.msk.ru/a", "https://hh.ru.evil.com/a", "", None):
            self.assertFalse(same("https://hh.ru/a", landed), landed)
        self.assertFalse(same("https://shop.msk.ru/a", "https://other.msk.ru/a"))

    def test_cards_without_names_or_with_one_name_are_no_results(self):
        operation = {"fields": {"name": ["name"]}}
        self.assertEqual(len(worker.site_op_checked(operation, [{"name": "a"}, {"name": "b"}])), 2)
        for cards, reason in [([], "empty"), ([{"name": None}, {"name": ""}, {"name": "a"}], "no_data"),
                              ([{"name": "Меню"}] * 5, "no_data")]:
            with self.assertRaises(worker.SiteOpFailure) as raised:
                worker.site_op_checked(operation, cards)
            self.assertEqual(raised.exception.reason, reason)

    def test_results_that_name_none_of_the_words_asked_for_answer_nothing(self):
        operation = {"page": "https://www.letu.ru/search?q=%query%&page=%number%"}
        url = "https://www.letu.ru/search?q=солнцезащитный+крем&page=1"
        sponge = [{"name": None, "more": {"displayName": "Губка для душа", "brandName": "DOLCE MILK"}}] * 3
        self.assertFalse(worker.site_op_answers(operation, url, sponge))
        creams = sponge + [{"name": "Крем солнцезащитный SPF 50", "more": {}}]
        self.assertTrue(worker.site_op_answers(operation, url, creams))
        # «чайники» asked, «Чайник» named: the stem is enough. Nothing asked in words, nothing to check.
        kettles = [{"name": "Чайник электрический Supra", "more": {}}]
        self.assertTrue(worker.site_op_answers({"page": "https://c.ru/s/?text=%query%"},
                                               "https://c.ru/s/?text=электрические+чайники", kettles))
        self.assertTrue(worker.site_op_answers({"page": "https://auto.drom.ru/toyota/camry/"},
                                               "https://auto.drom.ru/kia/rio/", sponge))
        # A filter's value is no word the results must name: ostrovok.ru's hotels are «Отель …», not «hotel».
        hotels = {"page": "https://ostrovok.ru/hotel/russia/%word%/?type_group=%query%&q=%query%"}
        self.assertTrue(worker.site_op_answers(hotels, "https://ostrovok.ru/hotel/russia/sochi/?type_group=hotel",
                                               [{"name": "Отель Булгар", "more": {}}]))

    def test_a_direct_read_picks_by_price_and_keeps_the_telling_fields(self):
        cards = [{"name": f"Отель {n}", "price": price, "link": f"https://ostrovok.ru/h/{n}/",
                  "more": {"rating": 8.5, "ota_hotel_id": "x", "master_id": 7389083, "address.city": "Казань",
                           "images.0.url": "https://cdn/x.jpg", "uuid": "7082cb8b-d138-42b8", "stars": 30,
                           "description": "о" * 400}}
                 for n, price in enumerate([4829, None, 2959, "от 3 237 ₽", 12000])]
        picked = worker.site_op_pick(cards, "price_asc", None, 10000, 3)
        self.assertEqual([card["name"] for card in picked], ["Отель 2", "Отель 3", "Отель 0"])
        self.assertEqual(picked[0]["more"], {"rating": 8.5, "address.city": "Казань", "stars": 30})
        self.assertEqual([card["name"] for card in worker.site_op_pick(cards, "site", 3000, None, 10)],
                         ["Отель 0", "Отель 1", "Отель 3", "Отель 4"])


class DirectSetup(unittest.IsolatedAsyncioTestCase):
    """The worker's app on the stand's fake browser, for Bro's direct reads."""

    async def asyncSetUp(self):
        from unittest import mock
        from aiohttp.test_utils import TestClient, TestServer

        self.pages = []
        test = self

        class Browser:
            contexts = [types.SimpleNamespace(new_page=self.new_page)]

        class Chromium:
            async def connect_over_cdp(self, _url):
                return Browser()

        class Playwright:
            chromium = Chromium()

            async def start(self):
                return self

            async def stop(self):
                test.stopped = True

        key = bytes(32)
        self.worker = types.SimpleNamespace(config={"environment": "stand", "key": key}, generation=0,
                                            accept_generation=lambda _gen: None, current=None, sessions={},
                                            visit_tabs=set())
        self.enterContext(mock.patch.object(worker, "worker", self.worker))
        self.enterContext(mock.patch.object(worker, "chrome_ready", self.ready))
        self.enterContext(mock.patch.object(worker, "code_engine_available", lambda: True))
        self.enterContext(mock.patch.dict(sys.modules, {"playwright.async_api": types.SimpleNamespace(
            async_playwright=Playwright)}))
        payload = worker.b64url(json.dumps({"env": "stand", "exp": int(time.time()) + 300, "gen": 0}).encode())
        signature = worker.b64url(__import__("hmac").new(key, f"v1.{payload}".encode(), "sha256").digest())
        self.token = f"v1.{payload}.{signature}"
        self.client = TestClient(TestServer(worker.application()))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        self.next_page, self.stopped = None, False

    async def ready(self):
        return True

    async def new_page(self):
        page = self.next_page
        self.pages.append(page)
        return page



class DirectOpTest(DirectSetup):
    """POST /v1/op, Bro's direct read: a tab of its own."""

    async def read(self, operation, url, **options):
        response = await self.client.post("/v1/op", json={"operation": operation, "url": url, **options},
                                          headers={"Authorization": f"Bearer {self.token}"})
        return response.status, await response.json() if response.status == 200 else await response.text()

    async def test_a_document_is_fetched_by_the_page_from_the_sites_robots_and_its_cards_picked(self):
        [operation] = await OpTest._hh_operation(None)
        url = "https://hh.ru/search/vacancy?text=менеджер&area=2"
        self.next_page = Page({url: HH_DOCUMENT})
        status, answer = await self.read(operation, url, limit=2)
        self.assertEqual(status, 200)
        self.assertEqual((answer["ok"], answer["via"], answer["fit"], answer["count"]), (True, "fetch", "exact", 4))
        self.assertEqual([card["name"] for card in answer["cards"]], ["Продакт-менеджер", "Ведущий продакт-менеджер"])
        self.assertEqual(answer["cards"][0]["more"]["company.visibleName"], "Unagrande Company")
        page = self.pages[0]
        self.assertEqual((page.visited[1:], page.fetched, page.closed), (["https://hh.ru/robots.txt"], [url], True))
        self.assertTrue(self.stopped)
        # Its tab was a keep-alive visit's while it read, and is no more.
        self.assertEqual(self.worker.visit_tabs, set())
        # Results that name none of the words asked are no answer.
        self.next_page = Page({url.replace("менеджер", "сварщик"): HH_DOCUMENT})
        status, answer = await self.read(operation, url.replace("менеджер", "сварщик"))
        self.assertEqual((answer["ok"], answer["reason"]), (False, "unanswered"))

    async def test_a_site_that_sends_the_tab_to_its_city_host_is_asked_there(self):
        [operation] = await OpTest._hh_operation(None)
        url = "https://hh.ru/search/vacancy?text=менеджер&area=2"
        regional = "https://spb.hh.ru/search/vacancy?text=менеджер&area=2"
        self.next_page = Page({regional: HH_DOCUMENT},
                              landed={"https://hh.ru/robots.txt": "https://spb.hh.ru/robots.txt"})
        status, answer = await self.read(operation, url)
        self.assertEqual((answer["ok"], answer["via"], answer["fit"]), (True, "fetch", "exact"))
        self.assertEqual(self.pages[0].fetched, [regional])

    async def test_a_document_the_fetch_cannot_read_is_opened_and_a_site_that_moved_says_so(self):
        [operation] = await OpTest._hh_operation(None)
        url = "https://hh.ru/search/vacancy?text=менеджер&area=2"

        class Drawn(Page):
            async def evaluate(self, expression, argument=None):
                if "fetch(u" in expression:
                    return {"status": 403, "url": argument, "text": "<html>check</html>"}
                return await super().evaluate(expression, argument)

        self.next_page = Drawn({url: HH_DOCUMENT})
        status, answer = await self.read(operation, url)
        self.assertEqual((answer["ok"], answer["via"]), (True, "page"))
        self.next_page = Page({url: HH_DOCUMENT}, landed={url: "https://hh.ru/"})
        status, answer = await self.read(operation, url)
        self.assertEqual((answer["ok"], answer["reason"]), (False, "moved"))
        self.next_page = Page({url: "<html></html>"}, walled=True)
        status, answer = await self.read(operation, url)
        self.assertEqual((answer["ok"], answer["reason"]), (False, "blocked"))

    async def test_an_xhr_page_is_opened_without_its_pictures_and_a_page_of_another_site_is_refused(self):
        traffic = worker.SiteTraffic()
        errors = worker.SiteErrors()
        errors.traffic = traffic
        socket = types.SimpleNamespace(ws=Socket(), next_id=1)
        await feed(errors, socket, "q1", "Fetch", SERP, OSTROVOK_PAGE, 200, "application/json",
                   json.dumps(SERP_ANSWER, ensure_ascii=False), method="POST")
        [operation] = traffic.operations(OSTROVOK_REPORT)
        url = "https://ostrovok.ru/hotel/russia/sochi/?dates=10.12.2026-12.12.2026&guests=2&sort=price.asc"
        self.next_page = Page({}, [Response(SERP, json.dumps(SERP_ANSWER), method="POST")])
        status, answer = await self.read(operation, url, sort="price_asc", priceMax=4900)
        self.assertEqual((answer["ok"], answer["fit"]), (True, "loose"))
        self.assertEqual([card["price"] for card in answer["cards"]], [3936, 4829, 4835])
        self.assertIn("Network.setBlockedURLs", self.pages[0].visited)
        for bad in ("https://evil.ru/hotel/russia/sochi/", "https://ostrovok.ru/hotel/russia/", 5,
                    "https://ostrovok.ru:8443/hotel/russia/sochi/", "https://ostrovok.ru/hotel/russia/sochi/?dates=%date%"):
            status, _ = await self.read(operation, bad)
            self.assertEqual(status, 400, bad)
        status, _ = await self.read({"name": "x"}, url)
        self.assertEqual(status, 400)


class Document:
    """The page's own document as Playwright's response listener sees it, for SiteTraffic."""

    def __init__(self, url, text):
        self.url, self.status, self._text = url, 200, text
        self.headers = {"content-type": "text/html; charset=utf-8", "content-length": str(len(text.encode()))}
        frame = types.SimpleNamespace(url=url, parent_frame=None)

        async def sizes():
            return {"responseBodySize": len(text.encode())}

        self.request = types.SimpleNamespace(resource_type="document", frame=frame, method="GET", post_data=None,
                                             sizes=sizes)

    async def body(self):
        return self._text.encode()


class LookTest(DirectSetup):
    """POST /v1/look, Bro's first search on a site it has no operation for."""

    async def asyncSetUp(self):
        from unittest import mock

        await super().asyncSetUp()
        self.enterContext(mock.patch.object(worker, "SITE_LOOK_CARDS_S", 0.05))

    async def look(self, url, words):
        response = await self.client.post("/v1/look", json={"url": url, "words": words},
                                          headers={"Authorization": f"Bearer {self.token}"})
        return response.status, await response.json() if response.status == 200 else await response.text()

    def card(self, vacancy):
        salary = f"{vacancy['compensation']['from']:,} ₽".replace(",", " ")
        return {"title": vacancy["name"], "text": f"{vacancy['name']} {vacancy['company']['visibleName']} от {salary}",
                "links": [vacancy["links"]["desktop"]], "image": None}

    async def test_a_first_look_gives_the_pages_cards_and_learns_the_operation_behind_them(self):
        url = "https://hh.ru/search/vacancy?text=менеджер&area=1"
        page = Page({url: HH_DOCUMENT}, [Document(url, HH_DOCUMENT)])
        page.cards = [self.card(vacancy) for vacancy in VACANCIES]
        self.next_page = page
        status, answer = await self.look(url, "менеджер продукта")
        self.assertEqual((status, answer["ok"], answer["count"]), (200, True, 4))
        self.assertEqual(answer["cards"][0]["title"], "Продакт-менеджер")
        self.assertEqual(answer["cards"][0]["link"], "https://hh.ru/vacancy/138625702")
        [operation] = answer["operations"]
        self.assertEqual(operation["name"], "hh.ru/search/vacancy")
        self.assertEqual(operation["source"], {"kind": "document",
                                               "state": {"tag": "template", "id": "HH-Lux-InitialState"}})
        self.assertNotIn("менеджер", json.dumps(operation, ensure_ascii=False))
        self.assertEqual((page.closed, self.worker.visit_tabs), (True, set()))

    async def test_a_page_that_is_not_the_sites_results_for_the_words_gives_nothing(self):
        url = "https://hh.ru/search/vacancy?text=сварщик"
        self.next_page = Page({url: HH_DOCUMENT}, [Document(url, HH_DOCUMENT)])
        self.next_page.cards = [self.card(vacancy) for vacancy in VACANCIES]
        status, answer = await self.look(url, "сварщик")
        self.assertEqual((answer["ok"], answer["reason"]), (False, "unanswered"))
        self.next_page = Page({url: HH_DOCUMENT}, statuses={url: 404})
        self.next_page.cards = [self.card(vacancy) for vacancy in VACANCIES]
        status, answer = await self.look(url, "сварщик")
        self.assertEqual((answer["ok"], answer["reason"]), (False, "moved"))
        self.next_page = Page({url: "<html></html>"})
        status, answer = await self.look(url, None)
        self.assertEqual((answer["ok"], answer["reason"]), (False, "empty"))
        # Cards and no words to check them against, or a match or two by chance: not the results asked for.
        for words in (None, "продакт", "Unagrande"):
            self.next_page = Page({url: HH_DOCUMENT}, [Document(url, HH_DOCUMENT)])
            self.next_page.cards = [self.card(vacancy) for vacancy in VACANCIES]
            status, answer = await self.look(url, words)
            self.assertEqual((answer["ok"], answer.get("reason")), (False, "unanswered") if words != "продакт"
                             else (True, None), words)
        for bad in ("http://hh.ru/search", "https://hh.ru:8443/search", "https://web.archive.org/hh.ru", 5):
            status, _ = await self.look(bad, None)
            self.assertEqual(status, 400, bad)

    async def test_a_tab_that_does_not_close_holds_no_slot(self):
        from unittest import mock

        url = "https://hh.ru/search/vacancy?text=менеджер&area=1"
        self.enterContext(mock.patch.object(worker, "SITE_OP_CLOSE_S", 0.05))
        closed = []
        self.enterContext(mock.patch.object(worker, "close_tab", lambda target: closed.append(target) or asyncio.sleep(0)))
        for _ in range(worker.SITE_OP_DIRECT_AT_ONCE + 1):
            page = Page({url: HH_DOCUMENT}, [Document(url, HH_DOCUMENT)])
            page.cards = [self.card(vacancy) for vacancy in VACANCIES]
            page.close = lambda: asyncio.sleep(3600)
            self.next_page = page
            status, answer = await asyncio.wait_for(self.look(url, "менеджер"), 5)
            self.assertEqual((status, answer["ok"]), (200, True))
        self.assertEqual(len(closed), worker.SITE_OP_DIRECT_AT_ONCE + 1)
        self.assertEqual(self.worker.visit_tabs, set())

    async def test_a_look_waits_for_a_slot_only_briefly(self):
        from unittest import mock

        self.enterContext(mock.patch.object(worker, "SITE_LOOK_GATE_S", 0.05))
        worker.site_op_gate = asyncio.Semaphore(1)
        await worker.site_op_gate.acquire()
        try:
            status, answer = await asyncio.wait_for(self.look("https://hh.ru/search/vacancy?text=x", "x"), 5)
        finally:
            worker.site_op_gate = None
        self.assertEqual((status, answer["ok"], answer["reason"]), (200, False, "failed"))


if __name__ == "__main__":
    unittest.main()
