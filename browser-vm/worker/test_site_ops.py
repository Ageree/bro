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
import unittest.mock
import urllib.parse
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

    async def test_a_results_page_sorted_or_bounded_by_price_teaches_the_operation_the_sites_own_inputs(self):
        hotels = [{**HOTELS[0], "ota_hotel_id": f"hotel_{n}", "master_id": 7389083 + n, "name": f"Отель {n}",
                   "price": 3000 + 250 * n} for n in range(8)]
        report = "ITEMS: " + json.dumps([{"name": h["name"], "price": f"{h['price']} ₽", "url": hotel_link(h)}
                                         for h in hotels[:3]], ensure_ascii=False)

        async def found(page, listed):
            traffic = worker.SiteTraffic()
            self.errors.traffic = traffic
            await feed(self.errors, self.socket, f"q{len(self.socket.ws.sent)}", "Fetch", SERP, page, 200,
                       "application/json", json.dumps({**SERP_ANSWER, "map_hotels": listed}, ensure_ascii=False),
                       method="POST")
            [operation] = traffic.operations(report)
            return operation.get("inputs")

        self.assertEqual(await found(OSTROVOK_PAGE, hotels), {"sort": {"asc": "sort=price.asc"}})
        # A price as the site writes it (ozon.ru's «1 490 ₽») counts as its amount.
        written = [{**h, "price": f"{h['price']:,} ₽".replace(",", " ")} for h in hotels]
        self.assertEqual(await found(OSTROVOK_PAGE, written), {"sort": {"asc": "sort=price.asc"}})
        descending = OSTROVOK_PAGE.replace("price.asc", "price.desc")
        self.assertEqual(await found(descending, hotels[::-1]), {"sort": {"desc": "sort=price.desc"}})
        # Prices out of order say nothing of the key; nor does a page with no sort key, or one whose value the
        # site writes otherwise than a plain word.
        shuffled = [hotels[n] for n in (3, 0, 6, 1, 7, 2, 5, 4)]
        self.assertIsNone(await found(OSTROVOK_PAGE, shuffled))
        self.assertIsNone(await found(OSTROVOK_PAGE.replace("&sort=price.asc", ""), hotels))
        self.assertIsNone(await found(OSTROVOK_PAGE.replace("price.asc", "price%20asc%3B1"), hotels))
        self.assertIsNone(await found(OSTROVOK_PAGE, hotels[:5]))

        # The price's bounds the page was asked with, when every card is within them: keys of each end in roubles,
        # one key of both ends in roubles (ozon.ru) or kopecks (wildberries.ru), as the cards tell.
        unsorted = OSTROVOK_PAGE.replace("&sort=price.asc", "")
        self.assertEqual(await found(unsorted + "&price_min=3000&priceTo=5000", shuffled),
                         {"price": {"min": "price_min", "max": "priceTo"}})
        self.assertEqual(await found(OSTROVOK_PAGE + "&currency_price=2000.000;6000.000", hotels),
                         {"sort": {"asc": "sort=price.asc"},
                          "price": {"decimals": 3, "range": "currency_price", "unit": "rub"}})
        self.assertEqual(await found(unsorted + "&priceU=200000;600000", shuffled),
                         {"price": {"decimals": 0, "range": "priceU", "unit": "kop"}})
        # Bounds either unit holds, a card outside one, or a key of no end, teach nothing.
        self.assertIsNone(await found(unsorted + "&priceU=20;600000", shuffled))
        self.assertIsNone(await found(unsorted + "&price_max=4000", shuffled))
        self.assertIsNone(await found(unsorted + "&price_total=3000", shuffled))

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
            # A search's words in the path (labirint.ru, 26.10): a query, not one item's id.
            "https://www.labirint.ru/search/%D0%BC%D0%B0%D1%81%D1%82%D0%B5%D1%80%20%D0%B8%20%D0%BC%D0%B0%D1%80%D0%B3%D0%B0"
            "%D1%80%D0%B8%D1%82%D0%B0/?stype=0": "https://www.labirint.ru/search/%query%/?stype=%number%",
            "https://site.ru/search/harry+potter+3": "https://site.ru/search/%query%",
            "https://site.ru/p/12%2034": "https://site.ru/p/%id%",
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
        # The site's own API host under the page's (offers-api.tutu.ru for www.tutu.ru) is the site's, another site's
        # is not (search.wb.ru for wildberries.ru); a request's text/plain answer may be its JSON, a document's not.
        page = "https://www.tutu.ru/poezda/Moskva/Kazan/"
        self.assertIsNotNone(traffic.request("POST", "https://offers-api.tutu.ru/railway/offers", page, "xhr"))
        self.assertIsNone(traffic.request("GET", "https://search.wb.ru/v18/search", "https://www.wildberries.ru/",
                                          "fetch"))
        self.assertTrue(worker.SiteTraffic.wanted({"status": 200, "mime": "text/plain", "type": "fetch"}))
        self.assertFalse(worker.SiteTraffic.wanted({"status": 200, "mime": "text/plain", "type": "document"}))

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
        if event == "response":
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


OZON_PAGE = "https://www.ozon.ru/search/?text=%D1%87%D0%B0%D0%B9%D0%BD%D0%B8%D0%BA&deny_category_prediction=true"


def ozon_item(name, price, link, order):
    """An item of ozon.ru's grid as its SSR state has it: atoms in an order of their own, the name told by its id."""
    atoms = {"name": {"type": "textAtom", "id": "name", "textDS": {"text": name}},
             "price": {"type": "priceV2", "id": "atom", "priceV2": {"price": [{"text": price}]}},
             "label": {"type": "labelList", "id": "labels", "labelList": {"items": [{"title": "Бренд проверен"}]}},
             "rating": {"type": "labelList", "id": "rating", "labelList": {"items": [{"title": "4.9"}]}}}
    return {"mainState": [atoms[key] for key in order], "action": {"link": link}, "sku": len(name) * 1000003}


OZON_ITEMS = [
    ozon_item("Чайник электрический Weissgauff WK 1760", "1 494 ₽", "/product/chaynik-weissgauff-1760-1/",
              ["label", "rating", "name", "price"]),
    ozon_item("Чайник Polaris PWK 1755", "2 190 ₽", "/product/chaynik-polaris-1755-2/",
              ["label", "rating", "price", "name"]),
    ozon_item("Чайник Xiaomi Electric Kettle 2", "2 799 ₽", "/product/chaynik-xiaomi-kettle-3/",
              ["rating", "label", "name", "price"]),
    ozon_item("Чайник Kitfort KT-6150", "3 450 ₽", "/product/chaynik-kitfort-6150-4/",
              ["label", "rating", "name", "price"]),
]
OZON_DOCUMENT = ("<html><body><div class=a></div>"
                 '<div id="state-searchResultsHeader-3669721-default-1" data-state=\'{"title": "чайник"}\'></div>'
                 '<div id="state-tileGridDesktop-3669724-default-1" data-state=\''
                 + html.escape(json.dumps({"items": OZON_ITEMS}, ensure_ascii=False), quote=False).replace("'", "&#39;")
                 + "\'></div></body></html>")
OZON_REPORT = "ITEMS: " + json.dumps([{"name": i["mainState"][[a["id"] for a in i["mainState"]].index("name")]
                                       ["textDS"]["text"], "price": p, "url": "https://www.ozon.ru" + i["action"]["link"]}
                                      for i, p in zip(OZON_ITEMS, ["1 494 ₽", "2 190 ₽", "2 799 ₽"])], ensure_ascii=False)

TUTU_PAGE = "https://www.tutu.ru/poezda/Moskva/Sankt-Peterburg/?date=05.11.2026"
TUTU_ANSWER = [{
    "offers": {"actual": {
        f"{n:08x}cafe": {"routeIds": [f"r{n}"], "offerVariants": [{"price": {"value": {"amount": amount}}},
                                                                 {"price": {"value": {"amount": amount + 150000}}}]}
        for n, amount in [(1, 249165), (2, 604700), (3, 283500), (4, 590000)]}},
    "dictionary": {"common": {"routes": {f"r{n}": {"voyageNumber": f"V{n}20260"} for n in (1, 2, 3, 4)}},
                   "train": {"voyages": {f"V{n}20260": {"numberForPassengers": number, "departure": time_}
                                         for n, number, time_ in [(1, "030У", "00:01"), (2, "022А", "00:20"),
                                                                  (3, "050С", "00:23"), (4, "750А", "05:30")]}}}}]
TUTU_REPORT = "ITEMS: " + json.dumps([{"name": name, "price": price, "url": TUTU_PAGE} for name, price in [
    ("Поезд 030У, 00:01–09:32", "от 2 492 ₽"), ("Поезд 022А «Ночной экспресс», 00:20–09:00", "от 6 047 ₽"),
    ("Поезд 050С, 00:23–09:25", "от 2 835 ₽")]], ensure_ascii=False)


class StateAndShapeTest(unittest.IsolatedAsyncioTestCase):
    """A document's state where its scripts keep it, and data that is no plain list of results (25.10–26.10 on the
    stand: none of ozon.ru, tutu.ru, kassir.ru, litres.ru, 2gis.ru gave an operation before)."""

    async def asyncSetUp(self):
        self.traffic = worker.SiteTraffic()
        self.errors = worker.SiteErrors()
        self.errors.traffic = self.traffic
        self.socket = types.SimpleNamespace(ws=Socket(), next_id=1)

    def test_a_documents_state_is_found_where_its_scripts_and_elements_keep_it(self):
        state = {"list": [{"name": "a" * 80}, {"name": "b" * 80}, {"name": "c" * 80}]}
        literal = json.dumps(state)
        flat = [["Reactive", 1], {"list": 2}, [3, 5, 7], {"name": 4}, "a" * 80, {"name": 6}, "b" * 80, {"name": 8},
                "c" * 80]
        flight = ('1:I["chunk",[]]\n' + "2:" + json.dumps(["$", "div", None, {"state": state}]) + "\n")
        document = (
            "<script>var i = " + literal + "; window.initialState = JSON.parse(" + json.dumps(literal) + ");</script>"
            "<script>window.__initialData__ = " + json.dumps(urllib.parse.quote(literal)) + "</script>"
            '<div id="state-grid-123456-default" data-state=\'' + html.escape(literal, quote=False) + "\'></div>"
            '<script id="__NUXT_DATA__" type="application/json">' + json.dumps(flat) + "</script>"
            "<script>self.__next_f.push([1," + json.dumps(flight) + "])</script>")
        found = dict((json.dumps(selector, sort_keys=True), value) for selector, value in worker.embedded_states(document))
        for selector, value in [
            ({"assignment": "initialState"}, state), ({"assignment": "__initialData__"}, state),
            ({"attribute": "data-state", "idPrefix": "state-grid-"}, state),
            ({"tag": "script", "id": "__NUXT_DATA__", "decode": "devalue"}, state),
            ({"flight": "next"}, {"2": ["$", "div", None, {"state": state}]})]:
            self.assertEqual(found.get(json.dumps(selector, sort_keys=True)), value, selector)
            self.assertEqual(worker.embedded_state(document, selector), value, selector)
        # A minifier's local (`i`) is no state a page keeps from build to build.
        self.assertNotIn(json.dumps({"assignment": "i"}), found)

    def test_paths_decode_json_text_take_a_key_by_its_start_and_an_element_by_its_word(self):
        data = {"widgetStates": {"tileGrid-3669724-default-1": json.dumps({"items": OZON_ITEMS}, ensure_ascii=False)}}
        path = ["widgetStates", {"prefix": "tileGrid-"}, {"json": True}, "items", 1, "mainState",
                {"with": ["id", "name"]}, "textDS", "text"]
        self.assertEqual(worker.site_walk(data, path), "Чайник Polaris PWK 1755")
        self.assertEqual(worker.site_walk({"a": {"b": [{"rows": [1, 2]}]}}, [{"deep": "rows"}]), [1, 2])
        self.assertEqual(worker.site_items({"t": {"x1": {"a": 1}, "x2": {"a": 2}}}, ["t", "*"]), [{"a": 1}, {"a": 2}])
        self.assertEqual(worker.site_walk(TUTU_ANSWER[0]["offers"]["actual"]["00000001cafe"],
                                          ["routeIds", 0, {"at": [0, "dictionary", "common", "routes"]}, "voyageNumber"],
                                          TUTU_ANSWER), "V120260")

    async def test_an_elements_atoms_in_their_own_order_give_one_operation_that_reads_them_all(self):
        await feed(self.errors, self.socket, "d1", "Document", OZON_PAGE, OZON_PAGE, 200, "text/html", OZON_DOCUMENT)
        [operation] = self.traffic.operations(OZON_REPORT)
        self.assertEqual(operation["source"], {"kind": "document",
                                               "state": {"attribute": "data-state", "idPrefix": "state-tileGridDesktop-"}})
        self.assertEqual(operation["fields"]["name"], ["mainState", {"with": ["id", "name"]}, "textDS", "text"])
        cards = worker.site_cards(operation, worker.site_state(operation, OZON_DOCUMENT), OZON_PAGE)
        self.assertEqual([card["name"] for card in cards], [
            "Чайник электрический Weissgauff WK 1760", "Чайник Polaris PWK 1755", "Чайник Xiaomi Electric Kettle 2",
            "Чайник Kitfort KT-6150"])
        self.assertEqual(cards[3]["link"], "https://www.ozon.ru/product/chaynik-kitfort-6150-4/")
        self.assertNotIn("чайник", json.dumps(operation, ensure_ascii=False).lower())

    async def test_a_normalized_answer_on_the_sites_api_host_joins_its_tables(self):
        await feed(self.errors, self.socket, "x1", "XHR", "https://offers-api.tutu.ru/railway/offers", TUTU_PAGE, 200,
                   "application/json", json.dumps(TUTU_ANSWER), method="POST")
        [operation] = self.traffic.operations(TUTU_REPORT)
        self.assertEqual(operation["source"], {"kind": "xhr", "method": "POST",
                                               "url": "https://offers-api.tutu.ru/railway/offers"})
        self.assertEqual(operation["items"], [0, "offers", "actual", "*"])
        self.assertTrue(operation["fields"]["cents"])
        cards = worker.site_cards(operation, TUTU_ANSWER, TUTU_PAGE)
        # The train's number from its voyage two tables away; its «от» price the least of its classes, in roubles.
        self.assertEqual([(card["name"], card["price"]) for card in cards],
                         [("030У", 2491.65), ("022А", 6047.0), ("050С", 2835.0), ("750А", 5900.0)])
        self.assertEqual(cards[0]["link"], TUTU_PAGE)

    def test_a_step_named_after_the_errands_words_is_no_operation(self):
        page = "https://site.ru/search?text=%D0%BA%D0%B0%D0%BB%D1%8C%D1%8F%D0%BD&sort=price.asc"
        self.assertEqual(worker.errand_words(page), {"кальян"})
        self.assertEqual(worker.errand_words("https://2gis.ru/moscow/search/%D0%B0%D0%BF%D1%82%D0%B5%D0%BA%D0%B0"),
                         {"аптека"})

    def test_data_of_unusual_shapes_finds_no_operation_rather_than_failing(self):
        page = "https://shop.ru/search?text=galaxy"
        items = [{"title": f"Samsung Galaxy S{n}", "price": 50000 + n, "type": {"id": "product"},
                  "link": f"/p/{n}"} for n in range(5)]
        report = "ITEMS: " + json.dumps([{"name": f"Samsung Galaxy S{n}", "price": f"{50000 + n} ₽",
                                          "url": f"https://shop.ru/p/{n}"} for n in range(3)])
        traffic = worker.SiteTraffic()
        entry = traffic.request("GET", "https://shop.ru/api/search", page, "xhr")
        traffic.answered(entry, 200, "application/json")
        traffic.hold(entry, json.dumps({"products": items}))
        # A list's `type` that is an object, not a word: the operation is found all the same.
        [operation] = traffic.operations(report)
        self.assertEqual(operation["items"], ["products"])
        # A report's link that is no address finds what the rest of it does.
        broken = report.replace("https://shop.ru/p/0", "https://[shop.ru/p/0")
        self.assertEqual(len(traffic.operations(broken)), 1)
        # A key named after the errand's words (a Nuxt state's `search-<query>`) is its value: no operation.
        traffic = worker.SiteTraffic()
        entry = traffic.request("GET", "https://shop.ru/api/search", page, "xhr")
        traffic.answered(entry, 200, "application/json")
        traffic.hold(entry, json.dumps({"cache": {"search-galaxy": {"items": items}}}))
        self.assertEqual(traffic.operations(report), [])

    def test_an_assignment_inside_a_string_is_no_state_and_hides_none(self):
        state = {"list": [{"name": "a" * 80}, {"name": "b" * 80}, {"name": "c" * 80}]}
        for script in (f'fetch("/api?sort=");window.__INITIAL_STATE__={json.dumps(state)};',
                       f'var u="https://x.ru/?page=";\nwindow.__INITIAL_STATE__={json.dumps(state)}'):
            document = f"<script>{script}</script>"
            self.assertEqual(worker.embedded_state(document, {"assignment": "__INITIAL_STATE__"}), state, script)
            self.assertEqual([selector for selector, _ in worker.embedded_states(document)],
                             [{"assignment": "__INITIAL_STATE__"}], script)

    def test_a_cyrillic_word_of_the_path_is_asked_for_and_a_transliterated_one_is_not(self):
        twogis = {"page": "https://2gis.ru/moscow/search/%word%"}
        url = "https://2gis.ru/moscow/search/%D0%B0%D0%BF%D1%82%D0%B5%D0%BA%D0%B0"
        self.assertFalse(worker.site_op_answers(twogis, url, [{"name": "Додо Пицца", "more": {}}]))
        self.assertTrue(worker.site_op_answers(twogis, url, [{"name": "Горздрав, аптека №820", "more": {}}]))
        chitai = {"page": "https://www.chitai-gorod.ru/search/%word%"}
        self.assertTrue(worker.site_op_answers(chitai, "https://www.chitai-gorod.ru/search/dyuna",
                                               [{"name": "Дюна", "more": {}}]))

    def test_a_search_in_the_path_takes_its_words_with_spaces_and_is_asked_for(self):
        labirint = {"page": "https://www.labirint.ru/search/%query%/?stype=%number%"}
        fit = worker.site_template_fit
        for url in ("https://www.labirint.ru/search/%D0%B0%D0%BD%D0%BD%D0%B0%20%D0%BA%D0%B0%D1%80%D0%B5%D0%BD%D0%B8"
                    "%D0%BD%D0%B0/?stype=0", "https://www.labirint.ru/search/анна+каренина/"):
            self.assertEqual(fit(labirint["page"], url), "exact", url)
        for url in ("https://www.labirint.ru/search/анна/каренина/", "https://www.labirint.ru/search/a%3Cb/"):
            self.assertIsNone(fit(labirint["page"], url), url)
        # A word the template kept, or a `%word%`, takes no spaces still.
        self.assertIsNone(fit("https://2gis.ru/moscow/search/%word%", "https://2gis.ru/moscow/search/a%20b"))
        url = "https://www.labirint.ru/search/%D0%B0%D0%BD%D0%BD%D0%B0%20%D0%BA%D0%B0%D1%80%D0%B5%D0%BD%D0%B8%D0%BD%D0%B0/"
        self.assertTrue(worker.site_op_answers(labirint, url, [{"name": "Анна Каренина. Роман", "more": {}}]))
        self.assertFalse(worker.site_op_answers(labirint, url, [{"name": "Мастер и Маргарита", "more": {}}]))


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

    async def test_an_operation_whose_page_has_no_place_for_words_is_not_learned(self):
        # zoozavr.ru: the results page is /search/results/<id of this one search>/.
        url = "https://hh.ru/search/results/48151623/"
        page = Page({url: HH_DOCUMENT}, [Document(url, HH_DOCUMENT)])
        page.cards = [self.card(vacancy) for vacancy in VACANCIES]
        self.next_page = page
        status, answer = await self.look(url, "менеджер продукта")
        self.assertEqual((answer["ok"], answer["count"], answer["operations"]), (True, 4, []))
        for page, words, placed in (("https://hh.ru/search/vacancy?text=%query%", "менеджер", True),
                                    ("https://tutu.ru/poezda/%word%/%word%/", "москва", True),
                                    ("https://ostrovok.ru/hotel/russia/kazan/", "казань", True),
                                    ("https://superjob.ru/vakansii/voditel/", "водитель", True),
                                    ("https://zoozavr.ru/search/results/%id%/", "корм", False),
                                    ("https://hoff.ru/nsk/catalog/gostinaya/", "кровать", False)):
            self.assertEqual(worker.site_words_placed({"page": page}, words), placed, page)

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


# A labirint.ru search as an html operation finds it (26.10): its rows `div.product-card`, a fetched document.
LABIRINT_PAGE = "https://www.labirint.ru/search/%D0%B3%D0%B0%D1%80%D1%80%D0%B8/"
LABIRINT = {"name": "www.labirint.ru/search/%id%/", "page": "https://www.labirint.ru/search/%id%/",
            "source": {"kind": "html", "render": False, "rows": "div.product-card",
                       "cells": {"name": {"selector": "a.product-card__name"},
                                 "price": {"selector": ":scope", "attribute": "data-discount-price"},
                                 "link": {"selector": "a.product-card__img", "attribute": "href"}}},
            "items": [], "fields": {"name": ["name"], "price": ["price"], "link": {"path": ["link"]}},
            "seen": {"items": 60, "matched": 0, "of": 0}}
BOOKS = [{"name": "Мастер и Маргарита", "price": "761", "link": "https://www.labirint.ru/books/595815/",
          "text": "761 ₽ Мастер и Маргарита Булгаков Михаил АСТ"},
         {"name": "Мастер и Маргарита. Роман", "price": "399", "link": "https://www.labirint.ru/books/942043/",
          "text": "399 ₽ Мастер и Маргарита. Роман Булгаков"},
         {"name": "Мастер-класс", "price": "1072", "link": "https://www.labirint.ru/books/893994/",
          "text": "1 072 ₽ Мастер-класс"}]


def rows_answer(items, status=200, landed=None, nameless=0):
    """What SITE_ROWS_READ_JS (and the fetch around it) answers of a page's rows."""
    return {"status": status, "landed": landed, "rows": "div.product-card" if items else None, "count": len(items),
            "items": items, "nameless": nameless, "cells": LABIRINT["source"]["cells"] if items else {}}


class RowsPage(Page):
    """A page whose rows the reader reads (`fetched` for the fetch of a URL, `drawn` for the page as drawn)."""

    def __init__(self, documents=None, fetched=None, drawn=None, **options):
        super().__init__(documents or {}, **options)
        self.rows_fetched, self.rows_drawn, self.reads = fetched or {}, drawn, []

    async def evaluate(self, expression, argument=None):
        if expression == worker.SITE_ROWS_FETCH_JS:
            self.fetched.append(argument["url"])
            answer = self.rows_fetched.get(argument["url"])
            return answer | {"landed": answer.get("landed") or argument["url"]} if answer else \
                rows_answer([], status=404, landed=argument["url"])
        if expression == worker.SITE_ROWS_READ_JS:
            self.reads.append(argument)
            return self.rows_drawn or rows_answer([])
        return await super().evaluate(expression, argument)


class RowsGrammarTest(unittest.TestCase):
    """The selectors of an html operation: the site's own words, never a value of the errand's."""

    def test_a_selector_is_hooks_and_hand_written_classes_only(self):
        for selector in ("div.product-card", "article.j-card-item", "div[data-name=\"Offers\"] > div",
                         "span[data-mark=\"OfferTitle\"] span", "div:has(> div > div > a[href*=\"/firm/\"])",
                         ":scope > div > div > a > span > span", "a[href*=\"/firm/\"]", ":scope",
                         "div[data-ti=\"train-name-badge\"]", "meta[itemprop=\"name\"]", "div[data-product-id]",
                         "div[itemtype=\"http://schema.org/Product\"]", "ul.grid-cols-5 > li[data-index]"):
            self.assertTrue(worker.site_selector_ok(selector), selector)
        for selector in (
                "div.knfjIn a", "div.c0e_7", "span.tsBody500Medium", "div.x31de4314--8d758a--text",  # a build's hashes
                "div[title=\"Мастер\"]", "div[data-testid=\"iphone 15\"]", "div[data-x=\"abc\"]",  # a text value
                "a[href^=\"/\"]", "a[href*=\"/moscow1/\"]", "li:nth-child(2)", "div:not(.x)", "div  span", "div >",
                "a[href*=\"/firm/\"] :scope", "div > > a", 5, None):
            self.assertFalse(worker.site_selector_ok(selector), selector)

    def test_an_operation_that_names_the_errands_word_is_none(self):
        operation = json.loads(json.dumps(LABIRINT)) | {"page": "https://shop.ru/search/?q=%query%",
                                                        "name": "shop.ru/search/"}
        self.assertIsNotNone(worker.site_rows_clean(operation, "https://shop.ru/search/?q=bosch+drill"))
        operation["source"]["rows"] = "div.brand-bosch"
        self.assertIsNone(worker.site_rows_clean(operation, "https://shop.ru/search/?q=bosch+drill"))
        operation["source"]["rows"] = "div.product-card"
        self.assertIsNone(worker.site_rows_clean(operation, "https://shop.ru/search/?q=x", {"login": "product"}))

    def test_only_a_well_formed_html_operation_is_kept(self):
        self.assertEqual(list(worker.site_operations([LABIRINT])), [LABIRINT["name"]])
        for change in ({"items": ["rows"]}, {"fields": {"name": ["title"]}},
                       {"source": LABIRINT["source"] | {"rows": "div.c0e_7"}},
                       {"source": LABIRINT["source"] | {"render": "no"}},
                       {"source": LABIRINT["source"] | {"cells": {"price": {"selector": "span"}}}},
                       {"source": LABIRINT["source"] | {"cells": {"name": {"selector": "a", "attribute": "onclick"}}}}):
            self.assertEqual(worker.site_operations([LABIRINT | change]), {}, change)

    def test_rows_are_cards_and_rows_without_a_name_are_none(self):
        cards = worker.site_cards(LABIRINT, worker.site_rows_data(rows_answer(BOOKS)), LABIRINT_PAGE)
        self.assertEqual([(card["name"], card["price"], card["link"]) for card in cards],
                         [(book["name"], book["price"], book["link"]) for book in BOOKS])
        self.assertEqual(cards[0]["more"]["text"], BOOKS[0]["text"])
        self.assertEqual(worker.site_number(cards[2]["price"]), 1072)
        # A banner in the list is left out; more such rows than cards is a page the operation no longer reads.
        self.assertEqual(len(worker.site_cards(LABIRINT, worker.site_rows_data(rows_answer(BOOKS, nameless=1)), LABIRINT_PAGE)), 3)
        with self.assertRaises(worker.SiteOpFailure) as failure:
            worker.site_cards(LABIRINT, worker.site_rows_data(rows_answer(BOOKS[:1], nameless=2)), LABIRINT_PAGE)
        self.assertEqual(failure.exception.reason, "no_data")

    def test_a_report_s_items_are_read_as_written(self):
        report = "ITEMS: " + json.dumps([{"name": "A", "price": "1 000 ₽", "url": "https://x.ru/1"},
                                         {"name": "Fee", "price": "50", "fee": True}], ensure_ascii=False)
        self.assertEqual(worker.reported_items(report), [{"name": "A", "price": "1 000 ₽", "url": "https://x.ru/1"}])


class RowsDirectTest(DirectSetup):
    """POST /v1/op of an html operation: the rows of a fetched document, or of the page drawn."""

    async def read(self, operation, url, **options):
        response = await self.client.post("/v1/op", json={"operation": operation, "url": url, **options},
                                          headers={"Authorization": f"Bearer {self.token}"})
        return await response.json()

    async def test_a_fetched_documents_rows_are_the_cards(self):
        url = "https://www.labirint.ru/search/%D0%BC%D0%B0%D1%81%D1%82%D0%B5%D1%80/"
        self.next_page = RowsPage(fetched={url: rows_answer(BOOKS)})
        answer = await self.read(LABIRINT, url, sort="price_asc")
        self.assertEqual((answer["ok"], answer["via"], answer["count"]), (True, "fetch", 3))
        self.assertEqual([card["price"] for card in answer["cards"]], ["399", "761", "1072"])
        self.assertEqual(self.pages[0].visited[1:], ["https://www.labirint.ru/robots.txt"])
        self.assertEqual(self.pages[0].reads, [])  # never drawn

    async def test_a_fetch_the_site_refuses_is_read_from_the_page_drawn_without_its_pictures(self):
        url = "https://www.labirint.ru/search/%D0%BC%D0%B0%D1%81%D1%82%D0%B5%D1%80/"
        self.next_page = RowsPage(fetched={url: rows_answer([], status=401)}, drawn=rows_answer(BOOKS))
        answer = await self.read(LABIRINT, url)
        self.assertEqual((answer["ok"], answer["via"], answer["count"]), (True, "page", 3))
        self.assertIn("Network.setBlockedURLs", self.pages[0].visited)
        # A page that went home is no read of this one; a drawn page with no rows has none.
        self.next_page = RowsPage(fetched={url: rows_answer(BOOKS, landed="https://www.labirint.ru/")})
        self.assertEqual((await self.read(LABIRINT, url))["reason"], "moved")
        # One that went to a page of the site that shows the same rows (a category) is read there when half of
        # its first rows name what was searched; rows of «similar items» on one book's own page are not the search.
        searched = {**LABIRINT, "name": "www.labirint.ru/search/%query%/",
                    "page": "https://www.labirint.ru/search/%query%/"}
        self.next_page = RowsPage(fetched={url: rows_answer(BOOKS, landed="https://www.labirint.ru/genres/2304/")})
        self.assertEqual((await self.read(searched, url))["count"], 3)
        similar = [{**book, "name": name} for book, name in zip(BOOKS, ("Белая гвардия", "Собачье сердце",
                                                                       "Мастер и Маргарита"))]
        self.next_page = RowsPage(fetched={url: rows_answer(similar, landed="https://www.labirint.ru/books/1/")})
        self.assertEqual((await self.read(searched, url))["reason"], "moved")
        # Words it cannot check against (an %id% part) leave such a page unread.
        self.next_page = RowsPage(fetched={url: rows_answer(BOOKS, landed="https://www.labirint.ru/genres/2304/")})
        self.assertEqual((await self.read(LABIRINT, url))["reason"], "moved")
        # A drawn page with no rows: a search with no results when it shows no list (no count against the
        # operation), a changed site when it shows a list the selectors miss.
        self.next_page = RowsPage(fetched={url: rows_answer([], status=200)}, drawn=rows_answer([]))
        with unittest.mock.patch.object(worker, "SITE_ROWS_DRAWN_S", 0.3):
            self.assertEqual((await self.read(LABIRINT, url))["reason"], "empty")
        self.next_page = RowsPage(fetched={url: rows_answer([], status=200)}, drawn=rows_answer([]))
        self.next_page.cards = [{"title": f"Книга {n}", "text": "", "links": []} for n in range(5)]
        with unittest.mock.patch.object(worker, "SITE_ROWS_DRAWN_S", 0.3):
            self.assertEqual((await self.read(LABIRINT, url))["reason"], "no_data")
        # One result of a narrow search is the search's answer.
        self.next_page = RowsPage(fetched={url: rows_answer(BOOKS[:1])})
        self.assertEqual((await self.read(LABIRINT, url))["count"], 1)

    async def test_a_drawn_operation_is_never_fetched(self):
        drawn = json.loads(json.dumps(LABIRINT))
        drawn["source"]["render"] = True
        url = "https://www.labirint.ru/search/%D0%BC%D0%B0%D1%81%D1%82%D0%B5%D1%80/"
        self.next_page = RowsPage(drawn=rows_answer(BOOKS))
        answer = await self.read(drawn, url)
        self.assertEqual((answer["ok"], answer["via"], answer["count"]), (True, "page", 3))
        self.assertEqual(self.pages[0].fetched, [])


class RowsLearnTest(DirectSetup):
    """Learning an html operation: in a look when no data of the site's holds its cards, at a run's end on its tab."""

    LEARNED = {"rows": [{"sel": "div.product-card", "rank": 0.8, "n": 3}], "matched": 0, "of": 0,
               "fields": {"name": [{"selector": "a.product-card__name"}],
                          "price": [{"selector": ":scope", "attribute": "data-discount-price"}],
                          "link": [{"selector": "a.product-card__img", "attribute": "href"}]}}

    async def asyncSetUp(self):
        from unittest import mock

        await super().asyncSetUp()
        self.enterContext(mock.patch.object(worker, "SITE_LOOK_CARDS_S", 0.05))

    def page(self, url, document):
        test = self

        class Learning(RowsPage):
            async def evaluate(self, expression, argument=None):
                if expression == worker.SITE_ROWS_LEARN_JS:
                    test.learned_with = argument
                    return test.LEARNED
                if expression == worker.SITE_ROWS_READ_JS and argument.get("html") is not None:
                    test.parsed = argument["html"]
                return await super().evaluate(expression, argument)

        page = Learning({url: document}, drawn=rows_answer(BOOKS), requests=[Document(url, document)])
        page.cards = [{"title": book["name"], "text": book["text"], "links": [book["link"]], "image": None}
                      for book in BOOKS]
        return page

    async def test_a_look_learns_the_rows_of_a_page_whose_data_holds_no_cards(self):
        url = "https://www.labirint.ru/search/%D0%BC%D0%B0%D1%81%D1%82%D0%B5%D1%80/"
        document = "<html><body>" + "<div class=product-card></div>" * 3 + "</body></html>"
        self.next_page = self.page(url, document)
        response = await self.client.post("/v1/look", json={"url": url, "words": "мастер"},
                                          headers={"Authorization": f"Bearer {self.token}"})
        answer = await response.json()
        self.assertTrue(answer["ok"])
        [operation] = answer["operations"]
        self.assertEqual(operation["source"], {"kind": "html", "render": False, "rows": "div.product-card",
                                               "cells": LABIRINT["source"]["cells"]})
        self.assertEqual((operation["items"], operation["fields"]), ([], LABIRINT["fields"]))
        self.assertEqual(self.learned_with["options"], [])  # the look's own cards' titles are no report
        self.assertEqual(self.parsed, document)  # settled against the document the page came with

    async def test_a_look_whose_data_holds_the_cards_learns_no_rows(self):
        url = "https://hh.ru/search/vacancy?text=менеджер&area=1"
        self.learned_with = None
        page = self.page(url, HH_DOCUMENT)
        page.cards = [LookTest.card(None, vacancy) for vacancy in VACANCIES]
        self.next_page = page
        response = await self.client.post("/v1/look", json={"url": url, "words": "менеджер"},
                                          headers={"Authorization": f"Bearer {self.token}"})
        [operation] = (await response.json())["operations"]
        self.assertEqual(operation["source"]["kind"], "document")
        self.assertIsNone(self.learned_with)

    async def test_a_runs_end_learns_from_its_report_on_its_last_tab_and_never_raises(self):
        from unittest import mock

        url = "https://www.labirint.ru/search/%D0%BC%D0%B0%D1%81%D1%82%D0%B5%D1%80/"
        recorder = worker.SiteTraffic()
        recorder.entries.append({"url": url, "type": "document"})
        recorder.bodies.append(({"url": url, "type": "document", "page": url}, "<html>doc</html>"))
        session = types.SimpleNamespace(tab="T1", sensitive_data=None)
        report = "ITEMS: " + json.dumps([{"name": b["name"], "price": b["price"] + " ₽", "url": b["link"]}
                                         for b in BOOKS], ensure_ascii=False)
        calls = []

        async def targets():
            return [{"id": "T1", "url": url, "webSocketDebuggerUrl": "ws://tab"}]

        async def learn(evaluate, page_url, items, document, secrets, seconds):
            calls.append((page_url, items, document, seconds))
            return [LABIRINT]

        self.enterContext(mock.patch.object(worker, "page_targets", targets))
        self.enterContext(mock.patch.object(worker, "site_rows_operations", learn))
        self.assertEqual(await worker.run_rows_operations(session, recorder, report, 4), [LABIRINT])
        self.assertEqual(calls[0][:3], (url, [{"name": b["name"], "price": b["price"] + " ₽", "url": b["link"]}
                                              for b in BOOKS], "<html>doc</html>"))
        # One item, no tab, no time left, or a page whose requests the run never wrote down: nothing learned.
        one = "ITEMS: " + json.dumps([{"name": "A", "price": "1", "url": url}])
        self.assertEqual(await worker.run_rows_operations(session, recorder, one, 4), [])
        self.assertEqual(await worker.run_rows_operations(types.SimpleNamespace(tab=None), recorder, report, 4), [])
        self.assertEqual(await worker.run_rows_operations(session, recorder, report, 0.2), [])
        self.assertEqual(await worker.run_rows_operations(session, worker.SiteTraffic(), report, 4), [])
        self.assertEqual(len(calls), 1)
        # Another site's options never go into the page (its scripts can read them); a page past the results — a
        # cart a follow-up went on to — is learned nothing from.
        mixed = "ITEMS: " + json.dumps([{"name": "Дрель", "price": "5 000 ₽", "url": "https://other.ru/p/1"}]
                                       + [{"name": b["name"], "price": b["price"], "url": b["link"]} for b in BOOKS])
        await worker.run_rows_operations(session, recorder, mixed, 4)
        self.assertNotIn("Дрель", json.dumps(calls[-1][1], ensure_ascii=False))

        async def cart():
            return [{"id": "T1", "url": "https://www.labirint.ru/cart/", "webSocketDebuggerUrl": "ws://tab"}]

        with mock.patch.object(worker, "page_targets", cart):
            recorder.entries.append({"url": "https://www.labirint.ru/cart/", "type": "document"})
            self.assertEqual(await worker.run_rows_operations(session, recorder, report, 4), [])
        self.assertEqual(len(calls), 2)

        async def broken():
            raise RuntimeError("Chrome is gone")

        self.enterContext(mock.patch.object(worker, "page_targets", broken))
        self.assertEqual(await worker.run_rows_operations(session, recorder, report, 4), [])

    async def test_learning_that_fails_in_the_page_gives_none(self):
        async def failing(expression, argument=None):
            raise RuntimeError("Execution context was destroyed")

        self.assertEqual(await worker.site_rows_operations(failing, LABIRINT_PAGE, None, None, None, 2), [])

        async def nothing(expression, argument=None):
            return {"error": "no group of cards"}

        self.assertEqual(await worker.site_rows_operations(nothing, LABIRINT_PAGE, None, None, None, 2), [])



SHOP = """<!doctype html><html><head><meta charset=utf-8><title>Поиск</title></head><body>
<header><nav class="menu"><a href="/catalog/">Каталог</a><a href="/help/">Помощь</a><a href="/cart/">Корзина</a></nav></header>
<main><div class="search-results x9k2_7">%s<div class="product-card promo-banner" data-product-id>
<a class="product-card__img" href="/promo/"><img alt=""></a><div class="banner-text">Скидки недели на всё, успейте купить</div>
</div></div></main></body></html>"""


def shop_card(number, name, price, old=None):
    old_price = f'<del class="product-card__old">{old:,} ₽</del>'.replace(",", " ") if old else ""
    return (f'<div class="product-card c0e_7" data-product-id="{number}"><a class="product-card__img" href="/product/{number}/">'
            f'<img alt="{name}"></a><div class="product-card__price">{old_price}'
            f'<span class="product-card__price-current">{price:,} ₽</span></div>'.replace(",", " ")
            + f'<a class="product-card__name" href="/product/{number}/">{name}</a>'
              f'<span class="product-card__rating">4,8 · 120 оценок</span><a class="product-card__brand" href="/brand/x/">Бренд</a></div>')


SHOP_DRILLS = SHOP % "".join(shop_card(*card) for card in [
    (101, "Дрель ударная Makita HP1630", 7390, 8200), (102, "Дрель Интерскол Д-16/1050Р2", 6990, None),
    (103, "Дрель Bosch GSB 13 RE", 5490, 6100), (104, "Дрель-шуруповёрт Зубр", 3190, None)])
SHOP_SAWS = SHOP % "".join(shop_card(*card) for card in [
    (201, "Пила циркулярная Makita HS7601", 9990, None), (202, "Пила торцовочная Зубр", 12490, 13900),
    (203, "Электролобзик Bosch PST 650", 4890, None)])
# 2gis.ru: no class a person wrote, the firm's link is the card's only hook.
MAP = """<!doctype html><html><head><meta charset=utf-8></head><body><div class="_awwm2v">%s</div></body></html>"""
MAP_CARDS = "".join(
    f'<div><div class="_1kf6gff"><div class="_zjunba"><a class="_1rehek" href="/moscow/firm/7000000{n}"><span>{name}</span></a></div>'
    f'<div class="_1idnaau">Кофейня · {street}</div></div></div>'
    for n, name, street in [(1, "Здрасте", "Крымская набережная, 10"), (2, "Comme à Paris", "Ленинградский проспект, 36"),
                            (3, "Миндальное настроение", "Дубравная улица, 34"), (4, "Humbl cookies", "Тверской бульвар, 27")])
# tutu.ru: the document has an empty list, the page's script draws the trains into it.
TRAINS = """<!doctype html><html><head><meta charset=utf-8></head><body><div data-ti="offersList"></div><script>
const list = document.querySelector('[data-ti="offersList"]');
for (const [name, time, price] of [['022А Ночной экспресс', '00:20', '6 047'], ['016А Арктика', '00:28', '2 664'],
                                   ['057М', '01:00', '2 835'], ['060Г Волга', '01:28', '3 425']]) {
  const row = document.createElement('div');
  row.innerHTML = '<div data-ti="train-name-badge"><span class="mhcs">' + name + '</span></div><p data-ti="departure-time">'
    + time + '</p><span data-ti="first-price">от ' + price + ' ₽</span><span class="dmcs1">924 отзыва</span>';
  list.append(row);
}
</script></body></html>"""


class RowsChromeTest(unittest.IsolatedAsyncioTestCase):
    """The rows' learner and reader in a real Chromium, on small pages like the sites' (no network): set
    BRO_SITE_ROWS_CHROME to a Chromium binary (a cloud session's /opt/pw-browsers/chromium) with Playwright
    installed; CI skips it."""

    PAGES = {"https://shop.example/search/?q=drel": SHOP_DRILLS, "https://shop.example/search/?q=pila": SHOP_SAWS,
             "https://maps.example/moscow/search/kofe": MAP % MAP_CARDS,
             "https://maps.example/moscow/search/pizza": MAP % MAP_CARDS.replace("Здрасте", "Додо Пицца"),
             "https://trains.example/poezda/Moskva/Kazan/": TRAINS}

    async def asyncSetUp(self):
        import os

        chrome = os.environ.get("BRO_SITE_ROWS_CHROME")
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            async_playwright = None
        if not chrome or async_playwright is None:
            self.skipTest("set BRO_SITE_ROWS_CHROME to a Chromium binary, with Playwright installed")
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(executable_path=chrome, args=["--no-sandbox"])
        self.context = await self.browser.new_context()

        async def serve(route):
            url = route.request.url
            if url.endswith("/robots.txt"):
                return await route.fulfill(status=200, content_type="text/plain", body="User-agent: *")
            body = self.PAGES.get(url)
            await route.fulfill(status=200 if body else 404, content_type="text/html; charset=utf-8",
                                body=body or "<html>404</html>")

        await self.context.route("**/*", serve)

    async def asyncTearDown(self):
        await self.browser.close()
        await self.playwright.stop()

    async def learn(self, url, items=None):
        page = await self.context.new_page()
        await page.goto(url)
        operations = await worker.site_rows_operations(worker.page_evaluator(page), page.url, items, self.PAGES[url],
                                                       None, 5)
        await page.close()
        return operations

    async def read(self, operation, url):
        page = await self.context.new_page()
        try:
            data = await worker.site_op_rows(page, operation, url)
            return worker.site_cards(operation, data, url)
        finally:
            await page.close()

    async def test_a_shop_page_learns_its_cards_by_their_hooks_and_reads_another_search_fetched(self):
        [operation] = await self.learn("https://shop.example/search/?q=drel")
        self.assertEqual(operation["page"], "https://shop.example/search/?q=%query%")
        source = operation["source"]
        self.assertFalse(source["render"])
        self.assertIn(source["rows"], ("div.product-card", "div[data-product-id]"))
        self.assertEqual(source["cells"]["name"], {"selector": "a.product-card__name"})
        self.assertEqual(source["cells"]["price"], {"selector": "span.product-card__price-current"})
        self.assertNotIn("c0e_7", json.dumps(source))
        cards = await self.read(operation, "https://shop.example/search/?q=pila")
        self.assertEqual([(card["name"], card["price"], card["link"]) for card in cards], [
            ("Пила циркулярная Makita HS7601", "9 990 ₽", "https://shop.example/product/201/"),
            ("Пила торцовочная Зубр", "12 490 ₽", "https://shop.example/product/202/"),
            ("Электролобзик Bosch PST 650", "4 890 ₽", "https://shop.example/product/203/")])

    async def test_a_runs_report_names_the_fields_it_reported(self):
        items = [{"name": "Дрель Интерскол Д-16/1050Р2", "price": "6 990 ₽", "url": "https://shop.example/product/102/"},
                 {"name": "Дрель Bosch GSB 13 RE", "price": "5 490 ₽", "url": "https://shop.example/product/103/"}]
        [operation] = await self.learn("https://shop.example/search/?q=drel", items)
        self.assertEqual(operation["seen"]["matched"], 2)
        self.assertEqual(operation["source"]["cells"]["price"], {"selector": "span.product-card__price-current"})
        # A report that names nothing on the page learns nothing.
        self.assertEqual(await self.learn("https://shop.example/search/?q=drel",
                                          [{"name": "Ноутбук", "price": "50 000 ₽", "url": "https://x.example/1"},
                                           {"name": "Планшет", "price": "30 000 ₽", "url": "https://x.example/2"}]), [])

    async def test_a_page_without_a_hand_written_class_is_read_by_its_cards_links(self):
        [operation] = await self.learn("https://maps.example/moscow/search/kofe")
        self.assertEqual(operation["source"]["rows"], 'div:has(> div > div > a[href*="/firm/"])')
        self.assertNotIn("moscow", json.dumps(operation["source"]))
        cards = await self.read(operation, "https://maps.example/moscow/search/pizza")
        self.assertEqual([card["name"] for card in cards][:2], ["Додо Пицца", "Comme à Paris"])
        self.assertEqual(cards[0]["link"], "https://maps.example/moscow/firm/70000001")

    async def test_rows_only_the_page_draws_are_read_drawn(self):
        [operation] = await self.learn("https://trains.example/poezda/Moskva/Kazan/")
        self.assertTrue(operation["source"]["render"])
        self.assertEqual(operation["source"]["cells"]["name"], {"selector": 'div[data-ti="train-name-badge"]'})
        self.assertEqual(operation["fields"]["link"], "page")
        cards = await self.read(operation, "https://trains.example/poezda/Moskva/Kazan/")
        self.assertEqual([(card["name"], card["price"]) for card in cards][:2],
                         [("022А Ночной экспресс", "от 6 047 ₽"), ("016А Арктика", "от 2 664 ₽")])


class SiteCheckChromeTest(unittest.IsolatedAsyncioTestCase):
    """A site behind a check of its own, in a real Chromium (no network): a browser without its cookie gets 403 and
    a script that sets the cookie and reloads the page, as ozon.ru answered the owner's browser (26.10) until an
    errand had drawn its page. Set BRO_SITE_ROWS_CHROME as for RowsChromeTest; CI skips it."""

    URL = "https://hh.example/search/vacancy?text=x"
    OPERATION = {"name": "hh.example/search/vacancy", "page": "https://hh.example/search/vacancy?text=%query%",
                 "source": {"kind": "document", "state": {"tag": "template", "id": "HH-Lux-InitialState"}},
                 "items": ["vacancySearchResult", "vacancies"]}
    CHECK = ("<html><body>Проверяем браузер<script>setTimeout(() => {document.cookie = 'passed=1; path=/';"
             " location.reload()}, 300)</script></body></html>")

    async def asyncSetUp(self):
        import os

        chrome = os.environ.get("BRO_SITE_ROWS_CHROME")
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            async_playwright = None
        if not chrome or async_playwright is None:
            self.skipTest("set BRO_SITE_ROWS_CHROME to a Chromium binary, with Playwright installed")
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(executable_path=chrome, args=["--no-sandbox"])
        self.context = await self.browser.new_context()
        self.passes = True  # whether the check page's script passes it (a captcha does not)
        self.asked = []

        async def serve(route):
            url, cookie = route.request.url, route.request.headers.get("cookie") or ""
            self.asked.append((url.removeprefix("https://hh.example"), "passed=1" in cookie))
            if "passed=1" not in cookie:
                body = self.CHECK if self.passes else "<html><body>Решите капчу</body></html>"
                return await route.fulfill(status=403, content_type="text/html; charset=utf-8", body=body)
            if url.endswith("/robots.txt"):
                return await route.fulfill(status=200, content_type="text/plain", body="User-agent: *")
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=HH_DOCUMENT)

        await self.context.route("**/*", serve)
        self.page = await self.context.new_page()

    async def asyncTearDown(self):
        await self.browser.close()
        await self.playwright.stop()

    async def test_a_fetch_waits_for_the_sites_check_on_its_robots_page_and_reads_with_its_cookie(self):
        self.assertEqual(await worker.site_op_fetched(self.page, self.OPERATION, self.URL), STATE)
        self.assertEqual(self.asked, [("/robots.txt", False), ("/robots.txt", True),
                                      ("/search/vacancy?text=x", True)])

    async def test_a_results_page_opened_waits_for_the_sites_check_to_reload_it(self):
        self.assertEqual(await worker.site_op_document(self.page, self.OPERATION, self.URL, 10), STATE)
        self.assertEqual(self.asked, [("/search/vacancy?text=x", False), ("/search/vacancy?text=x", True)])

    async def test_a_check_that_never_passes_is_blocked_after_its_wait(self):
        self.passes = False
        began = time.monotonic()
        with unittest.mock.patch.object(worker, "SITE_CHECK_S", 1):
            with self.assertRaises(worker.SiteOpFailure) as raised:
                await worker.site_op_document(self.page, self.OPERATION, self.URL, 10)
        self.assertEqual(raised.exception.reason, "blocked")
        self.assertLess(time.monotonic() - began, 5)


class ItemPageTest(unittest.TestCase):
    def test_an_html_operation_reads_a_page_of_the_site_it_was_sent_to_only_when_its_rows_are_there(self):
        url = "https://moscow.petrovich.ru/search/?q=x"
        landed = worker.site_rows_landed
        self.assertTrue(landed(url, url, False))
        # A search sent to the category of its word (petrovich.ru, 26.10): the same rows answer it.
        self.assertTrue(landed(url, "https://moscow.petrovich.ru/catalog/1234/", True))
        self.assertFalse(landed(url, "https://moscow.petrovich.ru/catalog/1234/", False))
        self.assertFalse(landed(url, "https://evil.ru/search/?q=x", True))
        # A front page shows its own picks in the same rows.
        self.assertFalse(landed(url, "https://moscow.petrovich.ru/", True))

    def test_a_check_page_and_a_list_are_told_from_an_item(self):
        walled = worker.site_item_walled
        self.assertTrue(walled({"text": "Just a moment... Verify you are human"}, 200))
        self.assertTrue(walled({"text": "Термос " * 100}, 429))
        self.assertFalse(walled({"text": "Термос. " * 400 + " access denied for minors"}, 200))
        with self.assertRaises(worker.SiteOpFailure):
            worker.site_item_one({"ld": [], "lists": 1, "text": "Чайник " * 100})
        product = {"ld": [{"@type": "Product"}], "lists": 1, "text": "Термос"}
        self.assertIs(worker.site_item_one(product), product)

    def test_a_sort_the_site_splits_into_a_key_and_a_direction_is_not_learned(self):
        prices = [100.0, 200, 300, 400, 500, 600]
        self.assertEqual(worker.site_learned_sort([("sort", "price")], prices), {"asc": "sort=price"})
        self.assertIsNone(worker.site_learned_sort([("sort", "price"), ("direction", "desc")], prices[::-1]))
        self.assertIsNone(worker.site_learned_sort([("order", "price"), ("way", "forward")], prices))

    def test_a_moved_failure_says_where_it_went(self):
        failure = worker.SiteOpFailure("moved", "went", "https://moscow.petrovich.ru/catalog/1234/")
        self.assertEqual(worker.site_template(failure.landed), "https://moscow.petrovich.ru/catalog/%id%/")


class ItemChromeTest(unittest.IsolatedAsyncioTestCase):
    """One result's page read as `/v1/item` reads it, in a real Chromium (no network): set BRO_SITE_ROWS_CHROME as for
    RowsChromeTest; CI skips it."""

    PRODUCT = ("<html><head><title>Термос</title><script type=\"application/ld+json\">"
               + json.dumps({"@context": "https://schema.org", "@type": "Product", "name": "Термос Hitt 1 л",
                             "image": "https://shop.example/1.jpg",
                             "offers": {"@type": "Offer", "price": "914", "priceCurrency": "RUB"}})
               + "</script><script type=\"application/ld+json\">"
               + json.dumps({"@type": "BreadcrumbList", "itemListElement": []})
               + "</script><meta property=\"og:title\" content=\"Термос Hitt\"></head><body><header>Меню сайта</header>"
               "<main><h1>Термос Hitt 1 л</h1><p>Характеристики</p><p>Объём: 1 л</p><button>Купить</button></main>"
               "<footer>Подвал</footer></body></html>")
    LIST = ("<html><head><title>Чайники</title><script type=\"application/ld+json\">"
            + json.dumps({"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "position": 1}]})
            + "</script></head><body><main><h1>Чайники</h1>" + "<p>Чайник Polaris 1 590 ₽</p>" * 20
            + "</main></body></html>")
    WALL = "<html><head><title>Just a moment...</title></head><body><main>Checking your browser before you go on " \
           "to the site. Verify you are human.</main></body></html>"
    SHELL = ("<html><head><title>Магазин</title></head><body><div id=\"app\"></div><script>setTimeout(() => {"
             "document.getElementById('app').innerHTML = '<main><h1>Термостат SASIC</h1><p>' + 'описание '.repeat(40)"
             " + '11 034 ₽</p></main>'}, 300)</script></body></html>")

    async def asyncSetUp(self):
        import os

        chrome = os.environ.get("BRO_SITE_ROWS_CHROME")
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            async_playwright = None
        if not chrome or async_playwright is None:
            self.skipTest("set BRO_SITE_ROWS_CHROME to a Chromium binary, with Playwright installed")
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(executable_path=chrome, args=["--no-sandbox"])
        self.context = await self.browser.new_context()

        async def serve(route):
            url = route.request.url
            if url.endswith("/robots.txt"):
                return await route.fulfill(status=200, content_type="text/plain", body="User-agent: *")
            pages = {"https://shop.example/product/1": self.PRODUCT, "https://app.example/item/2": self.SHELL,
                     "https://shop.example/category/7": self.LIST, "https://walled.example/item/3": self.WALL}
            status = 403 if "walled" in url else 200 if url in pages else 404
            await route.fulfill(status=status, content_type="text/html; charset=utf-8",
                                body=pages.get(url, "<html><main>404</main></html>"))

        await self.context.route("**/*", serve)
        self.page = await self.context.new_page()

    async def asyncTearDown(self):
        await self.browser.close()
        await self.playwright.stop()

    async def test_a_page_with_its_own_data_is_read_from_its_document_and_the_site_furniture_is_left_out(self):
        holder = {}
        item = await worker.site_item_on(self.page, "https://shop.example/product/1", holder)
        self.assertEqual(holder["via"], "fetch")
        self.assertEqual(item["title"], "Термос Hitt 1 л")
        self.assertEqual(item["ld"], [{"@type": "Product", "name": "Термос Hitt 1 л", "offers.@type": "Offer",
                                       "offers.price": "914", "offers.priceCurrency": "RUB"}])
        self.assertEqual(item["meta"], {"og:title": "Термос Hitt"})
        self.assertIn("Объём: 1 л", item["text"])
        self.assertNotIn("Меню сайта", item["text"])
        self.assertNotIn("Купить", item["text"])

    async def test_an_apps_shell_is_drawn_and_read_once_its_text_is_there(self):
        holder = {}
        item = await worker.site_item_on(self.page, "https://app.example/item/2", holder)
        self.assertEqual(holder["via"], "page")
        self.assertEqual(item["title"], "Термостат SASIC")
        self.assertIn("11 034 ₽", item["text"])

    async def test_a_list_of_results_or_an_anti_bot_check_is_no_item(self):
        with unittest.mock.patch.object(worker, "SITE_ITEM_DRAWN_S", 1):
            for url, reason in (("https://shop.example/category/7", "unanswered"),
                                ("https://walled.example/item/3", "blocked")):
                with self.assertRaises(worker.SiteOpFailure) as raised:
                    await worker.site_item_on(self.page, url, {})
                self.assertEqual(raised.exception.reason, reason, url)

    async def test_a_page_that_is_gone_is_no_item(self):
        with self.assertRaises(worker.SiteOpFailure) as raised:
            await worker.site_item_on(self.page, "https://shop.example/product/404", {})
        self.assertEqual(raised.exception.reason, "moved")


class SiteSearchTest(unittest.TestCase):
    """The home pages a search through a site's own box does not search (`site_search_checked`)."""

    def test_a_home_page_that_went_to_the_sites_check_is_not_searched(self):
        home = "https://shop.example/"
        self.assertFalse(worker.site_search_checked(home, "https://shop.example/"))
        self.assertFalse(worker.site_search_checked(home, "https://shop.example/moscow/"))
        self.assertTrue(worker.site_search_checked(home, "https://shop.example/xpvnsulc/?back_location=https%3A%2F%2Fshop.example%2F"))
        self.assertTrue(worker.site_search_checked(home, "https://shop.example/showcaptcha?retpath=x"))

    def test_only_the_results_bodies_teach_the_operation(self):
        recorder = types.SimpleNamespace(bodies=[
            ({"page": "https://www.shop.example/"}, "home"),
            ({"page": "https://shop.example/?utm=x"}, "home with a query"),
            ({"page": "https://shop.example/search/?q=x"}, "results"),
        ])
        worker.site_search_results_only(recorder, "https://shop.example/")
        self.assertEqual([text for _, text in recorder.bodies], ["home with a query", "results"])


class SearchChromeTest(unittest.IsolatedAsyncioTestCase):
    """A search through a site's own box as `/v1/look` makes it, in a real Chromium (no network): set
    BRO_SITE_ROWS_CHROME as for RowsChromeTest; CI skips it."""

    # Each field reports a key typed into it: only the search box may.
    TYPED = " oninput=\"fetch('/typed?f=' + this.name)\""
    # A home page with a sign-in form and a city's field beside the search: neither is ever typed into.
    HOME = ("<html><head><title>Магазин</title></head><body><header>"
            f"<form class=\"login\" action=\"/login\"><input type=\"text\" name=\"email\" placeholder=\"Почта\"{TYPED}>"
            f"<input type=\"password\" name=\"password\"{TYPED}></form>"
            f"<input type=\"text\" name=\"city\" placeholder=\"Ваш город\"{TYPED}>"
            f"<form action=\"/search/\" role=\"search\"><input name=\"q\" placeholder=\"Поиск по магазину\"{TYPED}>"
            "<button type=\"submit\">Найти</button></form></header><main>" + "<p>Магазин бытовой техники</p>" * 20
            + "</main></body></html>")
    # A home page whose box only a search button shows.
    HIDDEN = ("<html><body><header><button class=\"header-search-toggle\" aria-label=\"Поиск\" onclick=\""
              "document.getElementById('f').style.display='block'\">🔍</button>"
              "<form id=\"f\" action=\"/search/\" style=\"display:none\"><input type=\"search\" name=\"text\"></form>"
              "</header><main>" + "<p>Каталог товаров</p>" * 20 + "</main></body></html>")
    # A realty site's form: a city and a price, no search box.
    FORM = ("<html><body><form action=\"/flats/\"><input name=\"city\" placeholder=\"Город\">"
            "<input name=\"price_to\" placeholder=\"до\" inputmode=\"numeric\"><button>Показать</button></form>"
            "<main>" + "<p>Квартиры</p>" * 20 + "</main></body></html>")
    # A travel site's route the site filled in, its button «Найти билеты», no search box: never sent.
    ROUTE = ("<html><body><form action=\"/tickets/\"><input name=\"from\" value=\"Москва\">"
             "<input name=\"to\" value=\"Сочи\"><button type=\"submit\">Найти билеты</button></form>"
             "<main>" + "<p>Билеты на поезда</p>" * 20 + "</main></body></html>")
    # An old site's one form around the whole page: its box takes no Enter, and the form holds a sign-in link and a
    # cart's button before anything that searches. Neither is clicked, the form not sent.
    PAGE_FORM = ("<html><body><form action=\"/default.aspx\" method=\"post\"><a href=\"/login\">Войти</a>"
                 "<button type=\"button\" onclick=\"fetch('/cart')\">В корзину</button>"
                 "<input name=\"q\" placeholder=\"Поиск\" onkeydown=\"if (event.key === 'Enter') event.preventDefault()\">"
                 + "".join(f"<input name=\"f{n}\">" for n in range(7))
                 + "<main>" + "<p>Каталог</p>" * 20 + "</main></form></body></html>")

    @staticmethod
    def results(words):
        cards = "".join(f"<li class=\"card\"><a href=\"/item/{n}\">{words} модель {n}</a><span>{1000 + n} ₽</span></li>"
                        for n in range(12))
        return f"<html><body><main><h1>Результаты</h1><ul>{cards}</ul></main></body></html>"

    async def asyncSetUp(self):
        import os

        chrome = os.environ.get("BRO_SITE_ROWS_CHROME")
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            async_playwright = None
        if not chrome or async_playwright is None:
            self.skipTest("set BRO_SITE_ROWS_CHROME to a Chromium binary, with Playwright installed")
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(executable_path=chrome, args=["--no-sandbox"])
        self.context = await self.browser.new_context()
        self.logins, self.typed, self.sent = [], [], []
        self.delays = {}

        async def serve(route):
            parts = urllib.parse.urlsplit(route.request.url)
            if parts.path.startswith("/login"):
                self.logins.append(route.request.url)
            if parts.path == "/typed":
                self.typed.append(parts.query)
            if parts.path in ("/tickets/", "/cart", "/default.aspx"):
                self.sent.append(parts.path)
            query = dict(urllib.parse.parse_qsl(parts.query))
            if parts.path == "/search/":
                body = self.results(query.get("q") or query.get("text") or "")
            else:
                body = {"shop.example": self.HOME, "hidden.example": self.HIDDEN, "flats.example": self.FORM,
                        "route.example": self.ROUTE, "aspx.example": self.PAGE_FORM,
                        }.get(parts.hostname, "<html><main>404</main></html>")
            if parts.path == "/" and parts.hostname in self.delays:
                await asyncio.sleep(self.delays[parts.hostname])
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=body)

        await self.context.route("**/*", serve)
        self.page = await self.context.new_page()

    async def asyncTearDown(self):
        await self.browser.close()
        await self.playwright.stop()

    async def search(self, host, words):
        holder = {}
        until = time.monotonic() + worker.SITE_SEARCH_S
        cards = await worker.site_search_on(self.page, f"https://{host}/", words, holder, until)
        return cards, holder

    async def test_the_words_go_into_the_sites_search_box_and_never_into_another_field(self):
        cards, holder = await self.search("shop.example", "чайник")
        self.assertIn("name", holder["box"]["signs"])
        self.assertEqual(urllib.parse.urlsplit(self.page.url).path, "/search/")
        self.assertTrue(worker.site_look_answers("чайник", cards))
        self.assertTrue(self.typed and all(typed == "f=q" for typed in self.typed), self.typed)
        self.assertEqual(self.logins, [])

    async def test_a_box_a_search_button_shows_is_opened_first(self):
        cards, holder = await self.search("hidden.example", "утюг")
        self.assertEqual(holder["box"]["toggles"], 1)
        self.assertTrue(worker.site_look_answers("утюг", cards))

    async def test_a_site_with_only_its_own_form_is_not_typed_into(self):
        with unittest.mock.patch.object(worker, "SITE_SEARCH_WAIT_S", 1):
            with self.assertRaises(worker.SiteOpFailure) as raised:
                await self.search("flats.example", "двушка")
        self.assertEqual(raised.exception.reason, "no_box")
        self.assertEqual(await self.page.evaluate("[...document.querySelectorAll('input')].map((e) => e.value)"),
                         ["", ""])

    async def test_another_forms_search_button_is_never_a_toggle(self):
        with unittest.mock.patch.object(worker, "SITE_SEARCH_WAIT_S", 1):
            with self.assertRaises(worker.SiteOpFailure) as raised:
                await self.search("route.example", "сапсан")
        self.assertEqual(raised.exception.reason, "no_box")
        self.assertEqual(self.sent, [])

    async def test_a_home_page_slow_over_a_slow_exit_still_gives_results(self):
        # hoff.ru, pleer.ru, 366.ru on the prod exit (26.10): a home that took longer than the old nine seconds cut
        # the whole search at 19 s. The home's wait is a deadline of the phase now, and the rest follows.
        self.delays["shop.example"] = 11
        cards, holder = await self.search("shop.example", "чайник")
        self.assertTrue(worker.site_look_answers("чайник", cards))
        self.assertGreaterEqual(holder["ms"]["home"], 10000)

    async def test_a_search_cut_at_its_deadline_names_the_phase_it_was_in(self):
        self.delays["shop.example"] = 30
        holder = {}
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(
                worker.site_search_on(self.page, "https://shop.example/", "чайник", holder, time.monotonic() + 60), 3)
        self.assertEqual(holder["phase"], "home")

    async def test_a_whole_pages_form_gets_no_click_but_a_search_button(self):
        cards, holder = await self.search("aspx.example", "чайник")
        self.assertEqual(holder["sent"], "none:none")
        self.assertEqual((self.sent, self.logins), ([], []))
        self.assertEqual(cards, [])


if __name__ == "__main__":
    unittest.main()


class CategoryLandingTest(unittest.TestCase):
    def test_a_page_below_the_front_page_of_the_same_site_is_a_category_landing(self):
        url = "https://shop.example/search/?q=ноутбук"
        self.assertTrue(worker.site_category_landing(url, "https://shop.example/catalog/noutbuki/"))
        self.assertTrue(worker.site_category_landing(url, "https://www.shop.example/catalog/noutbuki/"))
        self.assertFalse(worker.site_category_landing(url, "https://shop.example/"))
        self.assertFalse(worker.site_category_landing(url, "https://other.example/catalog/noutbuki/"))
        self.assertFalse(worker.site_category_landing(url, "https://shop.example/search/?q=ноутбук"))

    def test_a_search_that_ended_on_a_page_without_its_words_is_a_category(self):
        self.assertTrue(worker.site_search_category("ноутбук", "https://shop.example/catalog/noutbuki/"))
        self.assertFalse(worker.site_search_category("ноутбук", "https://shop.example/search/?q=ноутбук"))
        self.assertFalse(worker.site_search_category("дюна", "https://shop.example/search/dyuna"))
        self.assertFalse(worker.site_search_category("ноутбук", "https://shop.example/catalog/ноутбуки/"))
        self.assertFalse(worker.site_search_category("ноутбук", "https://shop.example/"))


class CategoryLandingChromeTest(unittest.IsolatedAsyncioTestCase):
    """A search the site sends to a category of its own, in a real Chromium (no network): set BRO_SITE_ROWS_CHROME as
    for RowsChromeTest; CI skips it."""

    OPERATION = {"name": "shop.example/search/", "page": "https://shop.example/search/?q=%query%",
                 "source": {"kind": "document", "state": {"tag": "template", "id": "state"}}, "items": ["items"]}
    HOME = ("<html><body><form action=\"/search/\" role=\"search\"><input name=\"q\" placeholder=\"Поиск\">"
            "<button type=\"submit\">Найти</button></form><main>" + "<p>Магазин</p>" * 20 + "</main></body></html>")

    @staticmethod
    def cards(title, head=""):
        items = "".join(f"<li class=\"card\"><a href=\"/item/{n}\">{title} модель {n}</a><span>{1000 + n} ₽</span></li>"
                        for n in range(12))
        return f"<html><head>{head}</head><body><main><ul>{items}</ul></main></body></html>"

    async def asyncSetUp(self):
        import os

        chrome = os.environ.get("BRO_SITE_ROWS_CHROME")
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            async_playwright = None
        if not chrome or async_playwright is None:
            self.skipTest("set BRO_SITE_ROWS_CHROME to a Chromium binary, with Playwright installed")
        import ssl
        import subprocess
        import tempfile

        from aiohttp import web

        # The site is a local TLS server the browser reaches under the site's name: a redirect (the search's way to its
        # category) is the network's, which a fulfilled route does not follow.
        self.certs = tempfile.TemporaryDirectory()
        key, cert = f"{self.certs.name}/key.pem", f"{self.certs.name}/cert.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
                        "-days", "1", "-subj", "/CN=shop.example"], check=True, capture_output=True)
        context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        context.load_cert_chain(cert, key)

        async def serve(request):
            query = request.query.get("q")
            if request.path == "/search/":
                # «ноутбук» is a category's word, an exact title a product's; the site has no search page of its own.
                target = {"ноутбук": "/catalog/noutbuki/", "ноутбук x1": "/item/x1/",
                          "ничего": "/"}.get(query, "/catalog/other/")
                raise web.HTTPFound(target)
            if request.path == "/catalog/noutbuki/":
                body = self.cards("Ноутбук")
            elif request.path == "/item/x1/":
                body = self.cards("Ноутбук", "<meta property=\"og:type\" content=\"product\">")
            elif request.path == "/catalog/other/":
                body = self.cards("Чайник")
            elif request.path == "/robots.txt":
                return web.Response(text="User-agent: *")
            else:
                body = self.HOME
            return web.Response(text=body, content_type="text/html")

        app = web.Application()
        app.router.add_get("/{tail:.*}", serve)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0, ssl_context=context)
        await site.start()
        port = self.runner.addresses[0][1]
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(executable_path=chrome, args=[
            "--no-sandbox", "--no-proxy-server", f"--host-resolver-rules=MAP shop.example 127.0.0.1:{port}",
            "--ignore-certificate-errors"])
        self.context = await self.browser.new_context()
        self.page = await self.context.new_page()

    async def asyncTearDown(self):
        await self.browser.close()
        await self.playwright.stop()
        await self.runner.cleanup()
        self.certs.cleanup()

    async def moved(self, words):
        url = "https://shop.example/search/?q=" + urllib.parse.quote(words)
        with self.assertRaises(worker.SiteOpFailure) as raised:
            await worker.site_op_fetched(self.page, self.OPERATION, url)
        self.assertEqual(raised.exception.reason, "moved")
        return url, raised.exception.landed

    async def test_a_direct_read_sent_to_a_category_gets_its_cards(self):
        url, landed = await self.moved("ноутбук")
        cards = await worker.site_op_landed({"page": self.page}, self.OPERATION, url, landed, time.monotonic() + 30)
        self.assertEqual(len(cards), 12)
        rows = worker.site_page_cards(cards, landed)
        self.assertEqual(rows[0]["link"], "https://shop.example/item/0")
        self.assertTrue(rows[0]["price"].endswith("1000 ₽"))

    async def test_a_read_with_too_little_of_its_time_left_does_not_open_the_category(self):
        # Bro waits 45 s for /v1/op: the category's cards come within the read's own SITE_OP_DIRECT_S.
        url, landed = await self.moved("ноутбук")
        self.assertIsNone(await worker.site_op_landed({"page": self.page}, self.OPERATION, url, landed,
                                                      time.monotonic() + 1))
        self.assertNotEqual(urllib.parse.urlsplit(self.page.url).path, urllib.parse.urlsplit(landed).path)

    async def test_a_category_that_names_nothing_of_the_search_is_not_its_answer(self):
        url, landed = await self.moved("кастрюля")
        self.assertIsNone(await worker.site_op_landed({"page": self.page}, self.OPERATION, url, landed, time.monotonic() + 30))

    async def test_a_search_sent_to_one_items_page_is_not_a_list(self):
        url, landed = await self.moved("ноутбук x1")
        self.assertIsNone(await worker.site_op_landed({"page": self.page}, self.OPERATION, url, landed, time.monotonic() + 30))

    async def test_a_search_sent_to_the_front_page_is_not_a_list(self):
        url, landed = await self.moved("ничего")
        self.assertIsNone(await worker.site_op_landed({"page": self.page}, self.OPERATION, url, landed, time.monotonic() + 30))

    async def test_a_search_through_the_box_that_ends_on_a_category_gives_its_cards(self):
        holder = {}
        cards = await worker.site_search_on(self.page, "https://shop.example/", "ноутбук", holder,
                                            time.monotonic() + worker.SITE_SEARCH_S)
        self.assertTrue(worker.site_look_answers("ноутбук", cards))
        self.assertTrue(worker.site_search_category("ноутбук", self.page.url))
