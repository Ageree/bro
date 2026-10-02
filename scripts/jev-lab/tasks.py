"""Read-only browser tasks from Bro's benchmark and pilot, with independent success checks on the final page.

dev      — failures we diagnose and fix against.
heldout  — similar widgets on other sites; never tuned against, only measured.
env      — cannot pass in this lab: the session proxy rejects Google's lazy JS modules (';' in the path),
           so Google Flights widgets never react. Kept for runs on a real VM.
fresh    — a second held-out set, used only for the final measurement.
fixture  — local pages in fixtures/ (manifest.json), one widget class each; success = the page's title starts
           with "PASS".
A check looks only at the final URL, title and visible text that jev observed, never at jev's own DONE.
"""

import json
import os
import re
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRICE = re.compile(r"\d[\d\s  ]*\s?(₽|руб|\$|€|£)|(\$|€|£)\s?\d")  # "1 990 ₽" and "$19.41"


SPACES = str.maketrans({"\u00a0": " ", "\u202f": " ", "\u2009": " "})


def _u(r):
    return urllib.parse.unquote_plus(r.get("final_url") or "").translate(SPACES)


def _t(r):
    return " ".join([_u(r), r.get("title") or "", r.get("visible_text") or ""]).translate(SPACES).lower()


def has(r, *words):
    text = _t(r)
    return all(w.lower() in text for w in words)


def price(r):
    return bool(PRICE.search(r.get("visible_text") or ""))


LIVE = {
    # ---- dev
    "wiki_en": ("dev", "https://en.wikipedia.org/wiki/Main_Page",
                "Find and open the Wikipedia article about Gödel's incompleteness theorems.",
                lambda r: "incompleteness_theorems" in _u(r).lower()),
    "wiki_ru": ("dev", "https://ru.wikipedia.org/",
                "Найди и открой статью Википедии о теоремах Гёделя о неполноте.",
                lambda r: "неполнот" in _u(r).lower()),
    "wiki_en_click": ("dev", "https://en.wikipedia.org/wiki/Main_Page",
                      "Open the full article of today's featured article. Do not type anything.",
                      lambda r: "/wiki/" in _u(r) and ":" not in _u(r).split("/wiki/")[-1]
                      and "main_page" not in _u(r).lower() and "featured" not in _u(r).lower()),
    "flights_kazan": ("env", "https://www.google.com/travel/flights?hl=en",
                      "Find one-way flights from Moscow to Kazan on November 20, 2026, for one adult in economy. "
                      "Stop when matching flight options are visible.",
                      lambda r: "/travel/flights/search" in _u(r) and has(r, "kazan") and has(r, "nov")),
    "flights_sochi": ("env", "https://www.google.com/travel/flights?hl=en",
                      "Find round-trip flights from Moscow to Sochi, departing Friday October 16, 2026 and returning "
                      "Monday October 19, 2026, for one adult in economy. Stop when matching flight options are visible.",
                      lambda r: "/travel/flights/search" in _u(r) and has(r, "sochi") and has(r, "oct")),
    "rasp_sapsan": ("dev", "https://rasp.yandex.ru/",
                    "Найди поезда «Сапсан» из Москвы в Санкт-Петербург на пятницу 9 октября 2026 года, после 18:00. "
                    "Остановись, когда видны варианты поездов.",
                    lambda r: "/search" in _u(r) and has(r, "сапсан", "санкт-петербург")
                    and ("2026-10-09" in _u(r) or "9 октября" in _t(r)) and "evening" in _u(r)),
    "rasp_click": ("dev", "https://rasp.yandex.ru/",
                   "Открой расписание из Москвы в Санкт-Петербург по ссылке в популярных направлениях. "
                   "Ничего не вводи с клавиатуры.",
                   lambda r: "/search" in _u(r) and has(r, "москва", "санкт-петербург")),
    "vkusvill_milk": ("dev", "https://vkusvill.ru/",
                      "Найди во ВкусВилле молоко 3,2%. Остановись, когда видны товары с ценами.",
                      lambda r: has(r, "молоко") and "3,2" in _t(r) and price(r) and "search" in _u(r).lower()),
    # ---- heldout
    "tutu_trains": ("heldout", "https://www.tutu.ru/poezda/",
                    "Найди поезда из Москвы в Казань на 20 ноября 2026 года. Остановись, когда видны варианты поездов.",
                    lambda r: "tutu.ru" in _u(r) and has(r, "казань") and ("20.11.2026" in _u(r) or "20 ноя" in _t(r))
                    and _u(r).rstrip("/") != "https://www.tutu.ru/poezda"),
    "aviasales_sochi": ("heldout", "https://www.aviasales.ru/",
                        "Найди авиабилеты из Москвы в Сочи на 16 октября 2026 года в одну сторону, один взрослый. "
                        "Остановись, когда видны варианты с ценами.",
                        lambda r: "search" in _u(r) and ("1610" in _u(r) or "16 окт" in _t(r)) and price(r)),
    "hh_python": ("heldout", "https://hh.ru/",
                  "Найди вакансии Python-разработчика в Москве с зарплатой от 200 000 рублей. "
                  "Остановись, когда видны вакансии.",
                  lambda r: "hh.ru/search/vacancy" in _u(r) and has(r, "python") and "salary=200000" in _u(r)),
    "kayak_chicago": ("heldout", "https://www.kayak.com/",
                      "Find one-way flights from New York to Chicago on November 20, 2026, for one adult. "
                      "Stop when flight results with prices are visible.",
                      lambda r: re.search(r"/flights/(NYC|JFK|LGA|EWR)-[A-Z]*CHI|/flights/(NYC|JFK|LGA|EWR)-(ORD|MDW)", _u(r))
                      is not None and "2026-11-20" in _u(r)),
    "airbnb_lisbon": ("heldout", "https://www.airbnb.com/",
                      "Find places to stay in Lisbon for 2 adults from November 12 to November 15, 2026. "
                      "Stop when listings with prices are visible.",
                      lambda r: "lisbon" in _u(r).lower() and "2026-11-12" in _u(r) and "2026-11-15" in _u(r)
                      and "adults=2" in _u(r)),
    "ostrovok_kazan": ("heldout", "https://ostrovok.ru/",
                       "Найди отели в Казани с 12 по 15 ноября 2026 года для двоих взрослых. "
                       "Остановись, когда видны отели с ценами.",
                       lambda r: "kazan" in _u(r).lower() and ("12.11.2026" in _u(r) or "2026-11-12" in _u(r))),
    "afisha_theatre": ("heldout", "https://afisha.yandex.ru/moscow",
                       "Найди спектакли в Москве на 14 ноября 2026 года. Остановись, когда видна афиша на эту дату.",
                       lambda r: "afisha.yandex.ru" in _u(r) and "2026-11-14" in _u(r) and "theatre" in _u(r)),
    "citilink_lenovo": ("heldout", "https://www.citilink.ru/",
                        "Найди на Ситилинке ноутбуки Lenovo и отсортируй их по возрастанию цены. "
                        "Остановись, когда видны результаты с ценами.",
                        lambda r: "citilink.ru" in _u(r) and has(r, "lenovo") and "sort" in _u(r).lower()),
    # ---- fresh: a second held-out set, measured once at the very end (nobody tunes or debugs against it)
    "onetwotrip_kgd": ("fresh", "https://www.onetwotrip.com/ru/",
                       "Найди авиабилеты из Москвы в Калининград на 13 ноября 2026 года в одну сторону, один взрослый. "
                       "Остановись, когда видны варианты с ценами.",
                       lambda r: moved(r) and has(r, "калининград") and price(r) and ("1311" in _u(r) or "13 ноя" in _t(r))),
    "pobeda_sochi": ("fresh", "https://www.flypobeda.ru/",
                     "Найди рейсы Победы из Москвы в Сочи на 16 октября 2026 года, один взрослый. "
                     "Остановись, когда видны рейсы с ценами.",
                     lambda r: moved(r) and has(r, "сочи") and price(r) and ("16 окт" in _t(r) or "2026-10-16" in _u(r)
                                                                            or "16.10.2026" in _u(r))),
    "trainline_manchester": ("fresh", "https://www.thetrainline.com/",
                             "Find trains from London to Manchester on November 20, 2026, for one adult. "
                             "Stop when train times with prices are visible.",
                             lambda r: moved(r) and has(r, "manchester") and price(r)
                             and ("2026-11-20" in _u(r) or "20 nov" in _t(r) or "nov 20" in _t(r))),
    "amtrak_washington": ("fresh", "https://www.amtrak.com/home",
                          "Find one-way trains from New York to Washington on November 20, 2026, for one adult. "
                          "Stop when train departure times are visible.",
                          lambda r: moved(r) and has(r, "washington") and ("11/20/2026" in _t(r) or "nov 20" in _t(r)
                                                                          or "november 20" in _t(r))),
    "sutochno_spb": ("fresh", "https://sutochno.ru/",
                     "Найди жильё посуточно в Санкт-Петербурге с 12 по 15 ноября 2026 года для двух взрослых. "
                     "Остановись, когда видны варианты с ценами.",
                     lambda r: moved(r) and price(r) and ("петербург" in _t(r) or "spb" in _u(r).lower())
                     and ("2026-11-12" in _u(r) or "12.11.2026" in _u(r) or "12 ноя" in _t(r))),
    "labirint_christie": ("fresh", "https://www.labirint.ru/",
                          "Найди на Лабиринте книги Агаты Кристи и отсортируй их по возрастанию цены. "
                          "Остановись, когда видны книги с ценами.",
                          lambda r: moved(r) and has(r, "кристи") and price(r) and "search" in _u(r).lower()),
    "mvideo_samsung": ("fresh", "https://www.mvideo.ru/",
                       "Найди на М.Видео смартфоны Samsung дешевле 30 000 рублей. Остановись, когда видны товары с ценами.",
                       lambda r: moved(r) and has(r, "samsung") and price(r)),
    "autoru_camry": ("fresh", "https://auto.ru/",
                     "Найди на Авто.ру подержанные Toyota Camry в Москве не старше 2020 года. "
                     "Остановись, когда видны объявления с ценами.",
                     lambda r: "camry" in _u(r).lower() and price(r) and "2020" in _u(r)),
    "detmir_lego": ("fresh", "https://www.detmir.ru/",
                    "Найди в Детском мире конструкторы LEGO для детей от 6 лет. Остановись, когда видны товары с ценами.",
                    lambda r: moved(r) and has(r, "lego") and price(r)),
    "kinopoisk_brat2": ("fresh", "https://www.kinopoisk.ru/",
                        "Найди на Кинопоиске фильм «Брат 2» (2000) и открой его страницу.",
                        lambda r: "/film/" in _u(r) and (r.get("title") or "").lower().startswith("брат 2")),
}


def moved(r):
    """The run left the start page (a check helper: homepages show prices and city names too)."""
    start = urllib.parse.urlsplit(r.get("url") or "")
    final = urllib.parse.urlsplit(r.get("final_url") or "")
    return (final.path.rstrip("/"), final.query) != (start.path.rstrip("/"), start.query)


def fixtures(base=f"http://127.0.0.1:{os.environ.get('LAB_FIXTURE_PORT', '8765')}"):
    manifest = HERE / "fixtures" / "manifest.json"
    if not manifest.exists():
        return {}
    out = {}
    for item in json.loads(manifest.read_text()):
        out[item["name"]] = ("fixture", f"{base}/{item['path']}", item["goal"],
                             lambda r: (r.get("title") or "").startswith("PASS"))
    return out


def all_tasks():
    return {**LIVE, **fixtures()}
