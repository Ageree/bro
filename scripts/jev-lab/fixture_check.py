"""Validate the PASS logic of every fixture by driving it with jev-like raw CDP input.

    <venv with playwright>/bin/python fixture_check.py [--port 9251] [fixture ...]

Clicks are Input.dispatchMouseEvent mousePressed/mouseReleased at the element centre (no mouse move, like jev);
text is Input.insertText after a select-all key; Enter and wheel are raw CDP events too. Each scenario loads the
fixture fresh and asserts whether the title starts with "PASS". A correct interaction must PASS; every wrong or
partial one must not. Run it only when no jev run is using the same Chrome.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
BASE = os.environ.get("FIXTURE_BASE", "http://127.0.0.1:8765/")
# The original jev snapshot, to assert each trap really hides its controls from it: JEV_DIR, else .jev-base here.
SNAPSHOT = (Path(os.environ.get("JEV_DIR", HERE / ".jev-base")) / "jev_ultrafast" / "snapshot.js").read_text()


class Driver:
    def __init__(self, page):
        self.page = page
        self.cdp = page.context.new_cdp_session(page)

    def load(self, path):
        self.page.goto(BASE + path, wait_until="load")
        self.page.wait_for_timeout(150)

    def center(self, locator):
        locator.wait_for(state="visible", timeout=3000)
        box = locator.bounding_box()
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    def click_xy(self, x, y):
        for kind in ("mousePressed", "mouseReleased"):
            self.cdp.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})
        self.page.wait_for_timeout(80)

    def click(self, locator):
        self.click_xy(*self.center(locator))

    def fill(self, locator, text):
        self.click(locator)
        self.cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "a", "code": "KeyA", "modifiers": 2, "commands": ["selectAll"]})
        self.cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "a", "code": "KeyA", "modifiers": 2})
        self.cdp.send("Input.insertText", {"text": text})
        self.page.wait_for_timeout(80)

    def enter(self):
        base = {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13}
        self.cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", "text": "\r", **base})
        self.cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", **base})
        self.page.wait_for_timeout(80)

    def wheel(self, x, y, dy, times=1):
        for _ in range(times):
            self.cdp.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": dy})
            self.page.wait_for_timeout(120)

    def title(self, settle=600):
        self.page.wait_for_timeout(settle)
        return self.page.title()

    def hit(self, locator):
        """True when a jev-style hit test at the element centre lands on the element itself."""
        x, y = self.center(locator)
        return locator.evaluate("(e, p) => { const h = document.elementFromPoint(p[0], p[1]); return !!h && e.contains(h); }", [x, y])

    def jev_view(self):
        state = self.page.evaluate(SNAPSHOT)
        return [(a["kind"], a.get("role"), a["label"][:60]) for a in state["actions"] if a["kind"] not in ("scroll", "wait")]


def opt(page, name):
    return page.get_by_role("option", name=name, exact=True)


# ---- scenarios: (name, expect_pass, function(driver)) per fixture -------------------------------------------------

def combobox_portal(d):
    p = d.page

    def pick(kind, value):
        d.click(p.locator("#" + kind))
        d.click(opt(p, value))

    def correct():
        d.load("combobox_portal.html")
        d.click(p.locator("#trip"))
        listbox = p.locator("#trip-listbox")
        assert listbox.evaluate("e => e.closest('.popover-root').parentElement === document.body && !e.closest('#app')"), "listbox not in a body portal"
        assert p.locator("#app").get_attribute("aria-hidden") == "true", "app not hidden while open"
        assert not any("Search" in a[2] for a in d.jev_view()), "page controls visible to jev while listbox is open"
        d.click(opt(p, "One way"))
        pick("cabin", "Business")
        assert p.locator("#return-field").is_hidden()
        d.click(p.get_by_role("button", name="Search"))

    def only_trip():
        d.load("combobox_portal.html")
        pick("trip", "One way")
        d.click(p.get_by_role("button", name="Search"))

    def multi_city():
        d.load("combobox_portal.html")
        pick("trip", "Multi-city")
        pick("cabin", "Business")
        d.click(p.get_by_role("button", name="Search"))

    def changed_after():
        correct()
        assert d.title().startswith("PASS")
        pick("cabin", "Economy")

    def backdrop_close():
        d.load("combobox_portal.html")
        d.click(p.locator("#trip"))
        d.click_xy(900, 600)  # outside the paper: closes without choosing
        pick("cabin", "Business")
        d.click(p.get_by_role("button", name="Search"))
        assert p.locator("#trip-value").inner_text() == "Round trip"

    return [("correct: one way + business + Search", True, correct), ("partial: one way, cabin unchanged", False, only_trip),
            ("wrong: multi-city + business", False, multi_city), ("edited after a correct search", False, changed_after),
            ("listbox dismissed via backdrop", False, backdrop_close)]


def airport_autocomplete(d):
    p = d.page

    def choose(field, text, option_text):
        d.fill(p.locator("#" + field), text)
        item = p.locator(f"#{field}-listbox li[role=option]", has_text=option_text).first
        d.click(item)

    def search():
        d.click(p.get_by_role("button", name="Search"))

    def correct():
        d.load("airport_autocomplete.html")
        d.fill(p.locator("#from"), "Moscow")
        assert p.locator("#from-listbox li[role=option]").count() == 0, "suggestions should be debounced"
        p.locator("#from-listbox li[role=option]").first.wait_for(timeout=2000)
        d.click(p.locator("#from-listbox li[role=option]", has_text="City in Russia").first)
        choose("to", "Kazan", "City in Russia")
        search()

    def airport():
        d.load("airport_autocomplete.html")
        choose("from", "Sheremetyevo", "SVO")
        choose("to", "Kaz", "Kazan International Airport")
        search()

    def typed_only():
        d.load("airport_autocomplete.html")
        d.fill(p.locator("#from"), "Moscow")
        d.fill(p.locator("#to"), "Kazan")
        p.wait_for_timeout(700)
        d.click_xy(80, 600)  # blur: the open suggestion list covers the Search button
        p.wait_for_timeout(300)
        search()
        assert "from the list" in p.locator("#error").inner_text()

    def idaho():
        d.load("airport_autocomplete.html")
        choose("from", "Moscow", "Idaho")
        choose("to", "Kazan", "City in Russia")
        search()

    def kept_washington():
        d.load("airport_autocomplete.html")
        choose("to", "Kazan", "City in Russia")
        search()

    def retyped_after_choice():
        d.load("airport_autocomplete.html")
        choose("from", "Moscow", "City in Russia")
        choose("to", "Kazan", "City in Russia")
        d.fill(p.locator("#to"), "Kazan")  # typing again drops the chosen suggestion
        p.wait_for_timeout(700)
        d.click_xy(80, 600)
        search()

    return [("correct: Moscow city + Kazan city", True, correct), ("correct: SVO airport + KZN airport", True, airport),
            ("typed text, no suggestion chosen", False, typed_only), ("wrong suggestion: Moscow, Idaho", False, idaho),
            ("prefilled origin Washington kept", False, kept_washington), ("retyped after choosing", False, retyped_after_choice)]


def aria_datepicker(d):
    p = d.page
    day = lambda label: p.get_by_role("button", name=label, exact=True)

    def open_pick(label, nexts=1, done=True):
        d.load("aria_datepicker.html")
        d.click(p.locator("#depart"))
        assert day("Friday, December 18, 2026").count() == 0, "target month must need navigation"
        for _ in range(nexts):
            d.click(p.get_by_role("button", name="Next month"))
        d.click(day(label))
        if done:
            d.click(p.get_by_role("button", name="Done"))

    def correct():
        open_pick("Friday, December 18, 2026")
        assert p.locator("#depart").input_value() == "Fri, Dec 18"
        d.click(p.get_by_role("button", name="Search"))

    def no_done():
        open_pick("Friday, December 18, 2026", done=False)
        d.click_xy(30, 700)  # scrim: dismiss without applying
        d.click(p.get_by_role("button", name="Search"))

    def november():
        open_pick("Wednesday, November 18, 2026", nexts=0)
        d.click(p.get_by_role("button", name="Search"))

    def off_by_one():
        open_pick("Thursday, December 17, 2026")
        d.click(p.get_by_role("button", name="Search"))

    def no_search():
        open_pick("Friday, December 18, 2026")

    return [("correct: next month, Dec 18, Done, Search", True, correct), ("picked Dec 18 but dismissed without Done", False, no_done),
            ("wrong month: Nov 18", False, november), ("wrong day: Dec 17", False, off_by_one), ("not submitted", False, no_search)]


def div_calendar(d):
    p = d.page

    def pick(month_name, n):
        d.click(p.locator("#when"))
        month = p.locator(".popup .twomonths > div", has=p.locator(".mname", has_text=month_name))
        d.click(month.locator(".day").nth(n - 1))

    def find():
        d.click(p.get_by_role("button", name="Найти"))

    def correct():
        d.load("div_calendar.html")
        d.click(p.locator("#when"))
        assert not any(a[2].strip() == "20" for a in d.jev_view()), "day cells must not be observable as controls"
        label = [a[2] for a in d.jev_view() if a[0] == "click" and "Когда" in a[2]]
        assert label and "ноябрь" in label[0], "date input name should absorb the popup text"
        month = p.locator(".popup .twomonths > div", has=p.locator(".mname", has_text="ноябрь"))
        d.click(month.locator(".day").nth(19))
        assert p.locator("#when").input_value() == "20 ноября, пт"
        find()

    def october():
        d.load("div_calendar.html")
        pick("октябрь", 20)
        find()

    def all_days():
        d.load("div_calendar.html")
        d.click(p.locator("#when"))
        d.click(p.locator(".quick span", has_text="на все дни"))
        find()

    def no_date():
        d.load("div_calendar.html")
        find()
        assert "дату" in p.locator("#err").inner_text()

    def swapped():
        d.load("div_calendar.html")
        pick("ноябрь", 20)
        d.click(p.get_by_role("button", name="Поменять местами"))
        find()

    return [("correct: 20 ноября + Найти", True, correct), ("wrong month: 20 октября", False, october),
            ("на все дни", False, all_days), ("no date", False, no_date), ("route swapped", False, swapped)]


def animated_search(d):
    p = d.page

    def correct():
        d.load("animated_search.html")
        first = p.locator("#q").get_attribute("placeholder")
        p.wait_for_timeout(450)
        assert p.locator("#q").get_attribute("placeholder") != first, "placeholder must animate"
        d.fill(p.locator("#q"), "молоко 3,2%")
        d.enter()
        assert p.get_by_text("Молоко 3,2% пастеризованное").count() == 1

    def no_enter():
        d.load("animated_search.html")
        d.fill(p.locator("#q"), "молоко 3,2%")

    def plain_milk():
        d.load("animated_search.html")
        d.fill(p.locator("#q"), "молоко")
        d.enter()

    def retyped():
        correct()
        assert d.title().startswith("PASS")
        d.fill(p.locator("#q"), "кефир")

    return [("correct: type + Enter", True, correct), ("typed, no Enter", False, no_enter), ("only 'молоко' + Enter", False, plain_milk),
            ("retyped after the search", False, retyped)]


def iframe_form(d):
    p = d.page
    f = p.frame_locator("#widget")

    def fill_widget(city, cin, cout, guests):
        d.load("iframe_form.html")
        assert not any("Город" in a[2] or "Найти отели" in a[2] for a in d.jev_view()), "widget controls must be inside the iframe"
        d.fill(f.locator("#city"), city)
        d.fill(f.locator("#checkin"), cin)
        d.fill(f.locator("#checkout"), cout)
        f.locator("#guests").select_option(guests)
        d.click(f.get_by_role("button", name="Найти отели"))

    def blog_search():
        d.load("iframe_form.html")
        d.fill(p.locator("#site-q"), "Казань отели 12-15 ноября")
        d.click(p.get_by_role("button", name="Искать"))

    return [("correct: Казань 12.11–15.11.2026, 2 guests", True, lambda: fill_widget("Казань", "12.11.2026", "15.11.2026", "2")),
            ("correct: ISO dates", True, lambda: fill_widget("Казань", "2026-11-12", "2026-11-15", "2")),
            ("wrong guests: 1", False, lambda: fill_widget("Казань", "12.11.2026", "15.11.2026", "1")),
            ("wrong check-out", False, lambda: fill_widget("Казань", "12.11.2026", "16.11.2026", "2")),
            ("blog search outside the widget", False, blog_search)]


def shadow_form(d):
    p = d.page

    def run(a, b, date):
        d.load("shadow_form.html")
        assert not any("Откуда" in x[2] or "Найти билеты" in x[2] for x in d.jev_view()), "form must be inside shadow roots"
        d.fill(p.locator("city-field#from input"), a)
        d.fill(p.locator("city-field#to input"), b)
        d.fill(p.locator("city-field#date input"), date)
        d.click(p.get_by_role("button", name="Найти билеты"))

    return [("correct: Москва → Тверь 20.11.2026", True, lambda: run("Москва", "Тверь", "20.11.2026")),
            ("reversed route", False, lambda: run("Тверь", "Москва", "20.11.2026")),
            ("wrong date", False, lambda: run("Москва", "Тверь", "21.11.2026")),
            ("missing date", False, lambda: run("Москва", "Тверь", ""))]


def scroll_container(d):
    p = d.page
    target = p.get_by_role("button", name="Шаляпин Палас")

    def visible_center():
        box = target.bounding_box()
        return 0 < box["y"] + box["height"] / 2 < 780

    def correct():
        d.load("scroll_container.html")
        assert not visible_center(), "target must start outside the list viewport"
        assert not any("Шаляпин" in a[2] for a in d.jev_view())
        assert not any(a["kind"] == "scroll" for a in d.page.evaluate(SNAPSHOT)["actions"]), "page itself must not scroll"
        for _ in range(12):
            if visible_center():
                break
            d.wheel(200, 400, 400)
        assert visible_center(), "wheel over the list must reach the target"
        d.click(target)

    def page_wheel():
        d.load("scroll_container.html")
        d.wheel(550, 650, 560, times=4)  # where jev's own scroll lands: over the map
        assert not visible_center(), "wheel over the map must not move the list"
        d.click(p.get_by_role("button", name="Казань Сити"))

    def wrong_hotel():
        d.load("scroll_container.html")
        d.wheel(200, 400, 400, times=5)
        d.click(p.get_by_role("button", name="Давыдов"))

    return [("correct: scroll the list, open Шаляпин Палас", True, correct), ("page wheel over map, open first hotel", False, page_wheel),
            ("opened a neighbouring hotel", False, wrong_hotel)]


def consent_overlay(d):
    p = d.page

    def wait_cmp():
        p.get_by_role("button", name="Принять все").wait_for(timeout=3000)

    def blocked():
        d.load("consent_overlay.html")
        wait_cmp()
        assert not d.hit(p.locator("#q")), "overlay must cover the search field"
        d.click_xy(*d.center(p.locator("#q")))
        d.cdp.send("Input.insertText", {"text": "наушники"})
        d.click_xy(*d.center(p.get_by_role("button", name="Найти")))
        assert p.locator("#q").input_value() == ""

    def correct(button="Принять все", query="беспроводные наушники"):
        d.load("consent_overlay.html")
        wait_cmp()
        d.click(p.get_by_role("button", name=button))
        d.fill(p.locator("#q"), query)
        d.click(p.get_by_role("button", name="Найти"))

    def via_settings():
        d.load("consent_overlay.html")
        wait_cmp()
        d.click(p.get_by_role("button", name="Настроить"))
        d.click(p.get_by_role("button", name="Сохранить выбор"))
        d.fill(p.locator("#q"), "наушники")
        d.click(p.get_by_role("button", name="Найти"))

    return [("correct: accept, search наушники", True, correct), ("correct: only necessary", True, lambda: correct("Только необходимые")),
            ("correct: settings, save", True, via_settings), ("clicks while the overlay blocks", False, blocked),
            ("wrong query after dismissal", False, lambda: correct(query="колонка"))]


def filters_sort(d):
    p = d.page
    brand = lambda name: p.locator("label.cb", has_text=name).locator(".box")

    def setup(brands, stock, sort):
        d.load("filters_sort.html")
        for b in brands:
            d.click(brand(b))
        if stock:
            d.click(p.get_by_role("switch", name="Только в наличии"))
        if sort:
            d.click(p.locator("#sort"))
            d.click(p.get_by_role("option", name=sort))

    def correct():
        setup(["Lenovo"], True, "Сначала дешёвые")
        cb = p.locator("label.cb", has_text="Lenovo").locator("input")
        assert not d.hit(cb), "the sr-only checkbox itself must not be hit-testable"
        assert [a for a in d.jev_view() if a[0] == "click" and a[1] == "checkbox" and a[2].startswith("Lenovo")], "checkbox observable"
        d.page.wait_for_timeout(500)
        prices = [int("".join(c for c in t if c.isdigit())) for t in p.locator(".item .price").all_inner_texts()]
        assert prices == sorted(prices) and len(prices) == 4, prices

    return [("correct: Lenovo + in stock + cheapest first", True, correct),
            ("extra brand HP", False, lambda: setup(["Lenovo", "HP"], True, "Сначала дешёвые")),
            ("wrong sort: most expensive first", False, lambda: setup(["Lenovo"], True, "Сначала дорогие")),
            ("in-stock toggle missing", False, lambda: setup(["Lenovo"], False, "Сначала дешёвые")),
            ("sort not set", False, lambda: setup(["Lenovo"], True, None))]


def route_chips(d):
    p = d.page
    chip = lambda text: p.get_by_role("button", name=text, exact=True)
    find = lambda: d.click(p.get_by_role("button", name="Найти"))

    def correct():
        d.load("route_chips.html")
        d.click(chip("Москва — Санкт-Петербург"))
        assert p.locator("#from").input_value() == "Москва"
        assert not d.page.title().startswith("PASS")
        find()

    def chip_only():
        d.load("route_chips.html")
        d.click(chip("Москва — Санкт-Петербург"))

    def reverse():
        d.load("route_chips.html")
        d.click(chip("Санкт-Петербург — Москва"))
        find()

    def typed():
        d.load("route_chips.html")
        d.fill(p.locator("#from"), "Москва")
        d.fill(p.locator("#to"), "Санкт-Петербург")
        find()

    return [("correct: chip + Найти", True, correct), ("chip only, no Найти", False, chip_only), ("reverse chip", False, reverse),
            ("typed instead of the chip", False, typed)]


def guests_stepper(d):
    p = d.page

    def run(adults_plus, children_plus, age, done=True):
        d.load("guests_stepper.html")
        d.click(p.locator("#guests"))
        assert sum(1 for a in d.jev_view() if a[2] == "button") >= 2, "stepper buttons must be unlabeled"
        for _ in range(adults_plus):
            d.click(p.locator("#a-plus"))
        for _ in range(children_plus):
            d.click(p.locator("#c-plus"))
        if age is not None:
            p.locator("#ages select").first.select_option(age)
        if done:
            d.click(p.get_by_role("button", name="Готово"))
        d.click(p.get_by_role("button", name="Найти"))

    return [("correct: 2 adults + child 5", True, lambda: run(1, 1, "5")), ("wrong age 6", False, lambda: run(1, 1, "6")),
            ("child added to adults instead", False, lambda: run(2, 0, None)), ("no Готово", False, lambda: run(1, 1, "5", done=False)),
            ("age not chosen", False, lambda: run(1, 1, None))]


def plain_suggest(d):
    p = d.page

    def choose(field, text, title, sub):
        d.fill(p.locator("#" + field), text)
        item = p.locator(f"#{field}-s .item", has=p.locator("div", has_text=title)).filter(has_text=sub).first
        d.click(item)

    def correct():
        d.load("plain_suggest.html")
        d.fill(p.locator("#from"), "Моск")
        p.locator("#from-s .item").first.wait_for(timeout=2000)
        assert not any("все вокзалы" in a[2] for a in d.jev_view()), "suggestions must not be observable as controls"
        d.click(p.locator("#from-s .item", has_text="все вокзалы").first)
        choose("to", "Нижн", "Нижний Новгород", "Московский вокзал")
        d.click(p.get_by_role("button", name="Найти"))

    def typed():
        d.load("plain_suggest.html")
        d.fill(p.locator("#from"), "Москва")
        d.fill(p.locator("#to"), "Нижний Новгород")
        p.wait_for_timeout(500)
        d.click(p.get_by_role("button", name="Найти"))
        assert "из списка" in p.locator("#err").inner_text()

    def tagil():
        d.load("plain_suggest.html")
        choose("from", "Моск", "Москва", "Курский")
        choose("to", "Нижн", "Нижний Тагил", "Свердловская")
        d.click(p.get_by_role("button", name="Найти"))

    return [("correct: chosen suggestions", True, correct), ("typed text only", False, typed), ("wrong suggestion: Нижний Тагил", False, tagil)]


def label_chips(d):
    p = d.page
    lab = lambda text: p.locator("label", has_text=text)

    def run(*labels):
        d.load("label_chips.html")
        assert not any(a[1] in ("radio", "checkbox") for a in d.jev_view()), "native inputs must be display:none"
        for text in labels:
            d.click(lab(text))

    return [("correct: Купе + Вечер", True, lambda: run("Купе", "Вечер")), ("extra time slot", False, lambda: run("Купе", "Вечер", "Ночь")),
            ("wrong car type", False, lambda: run("Плацкарт", "Вечер")), ("only Купе", False, lambda: run("Купе"))]


FIXTURES = {f.__name__: f for f in [combobox_portal, airport_autocomplete, aria_datepicker, div_calendar, animated_search,
                                    iframe_form, shadow_form, scroll_container, consent_overlay, filters_sort, route_chips,
                                    guests_stepper, plain_suggest, label_chips]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9251)
    parser.add_argument("names", nargs="*")
    args = parser.parse_args()
    failures = 0
    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{args.port}")
        context = browser.contexts[0]
        page = context.new_page()
        page.set_viewport_size({"width": 1120, "height": 780})
        d = Driver(page)
        for name in args.names or FIXTURES:
            for label, expect, fn in FIXTURES[name](d):
                try:
                    d.load(name + ".html")
                    assert not page.title().startswith("PASS"), "PASS before any interaction"
                    fn()
                    title = d.title()
                    ok = title.startswith("PASS") == expect
                    detail = title
                except Exception as error:
                    import traceback
                    where = traceback.extract_tb(error.__traceback__)[-1]
                    ok, detail = False, f"{type(error).__name__}: {error} (line {where.lineno}: {where.line})"[:300]
                failures += not ok
                print(f"{'ok  ' if ok else 'FAIL'} {name:22s} {'PASS' if expect else 'no  '} {label:45s} | {detail}", flush=True)
        page.close()
    print(json.dumps({"failures": failures}))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
