"""Bench tasks: a start page, a goal in plain words (the same text for every arm), and an independent check of the
final page. The check is the success; the agent's own DONE or `success` is not."""

import re
from urllib.parse import parse_qs, unquote, urlparse


def wiki(p):
    return unquote(urlparse(p["url"]).path) == "/wiki/Сергиев_Посад" and p["title"].startswith("Сергиев Посад")


def form(p):
    u = urlparse(p["url"])
    q = parse_qs(u.query)
    return (u.path.endswith("submitted-form.html") and q.get("my-text") == ["Bro Browser"]
            and q.get("my-textarea") == ["Testing Jev"] and q.get("my-select") == ["2"])


def books(p):
    return "its-only-the-himalayas" in p["url"] and "It's Only the Himalayas" in p["text"]


def shop(p):
    return urlparse(p["url"]).path.endswith("/cart.html") and "Sauce Labs Backpack" in p["text"]


def rasp(p):
    u = urlparse(p["url"])
    return (u.hostname == "rasp.yandex.ru" and u.path.startswith(("/search", "/suburban", "/routes", "/thread"))
            and "Сергиев" in p["text"] and "Москва" in p["text"] and len(re.findall(r"\b\d{1,2}:\d{2}\b", p["text"])) >= 3
            and "captcha" not in p["url"].lower())


def flights(p):
    u = urlparse(p["url"])
    return (u.hostname == "www.google.com" and u.path.startswith("/travel/flights/search") and "Zürich" in p["text"]
            and "London" in p["text"] and re.search(r"Fri, Nov 20", p["text"]) is not None and "One way" in p["text"])


def market(p):
    u = urlparse(p["url"])
    return (u.hostname == "market.yandex.ru" and u.path.startswith("/search") and "captcha" not in p["url"].lower()
            and "JBL" in p["text"] and "Tune 520" in p["text"])


STOP = " Stop once the result is visibly on screen; do not buy, order or submit anything beyond what is asked."
TASKS = {
    "wiki": ("https://ru.wikipedia.org/", "Find the Russian Wikipedia article about the city Sergiev Posad (Сергиев Посад) and open it." , wiki),
    "form": ("https://www.selenium.dev/selenium/web/web-form.html",
             "Fill in the web form: Text input = Bro Browser; Textarea = Testing Jev; in the dropdown select the option Two. Then press Submit.",
             form),
    "books": ("https://books.toscrape.com/",
              "Open the category Travel, then open the book called It's Only the Himalayas.", books),
    "shop": ("https://www.saucedemo.com/",
             "Log in with username standard_user and password secret_sauce. Then add the product Sauce Labs Backpack to the cart and open the cart.",
             shop),
    "rasp": ("https://rasp.yandex.ru/",
             "Find suburban trains (электрички) from Moscow to Sergiev Posad (Сергиев Посад) for today." + STOP, rasp),
    "flights": ("https://www.google.com/travel/flights?hl=en",
                "Find one-way flights from Zurich to London on November 20, 2026, for one adult in economy." + STOP, flights),
    "market": ("https://market.yandex.ru/",
               "Search for the wireless headphones JBL Tune 520BT." + STOP, market),
}
