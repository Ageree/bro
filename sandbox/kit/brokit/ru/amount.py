"""brokit ru amount: a sum in Russian words, as invoices and acts write it.

24500 -> «двадцать четыре тысячи пятьсот рублей 00 копеек». Thousands are
feminine («две тысячи»), millions and billions masculine; the noun after a
number takes the form 1 / 2-4 / 5-20 by the last two digits.
"""

import re

from brokit.util import KitError, parser

UNITS_M = ("", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять")
UNITS_F = ("", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять")
TEENS = (
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать",
)
TENS = ("", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто")
HUNDREDS = ("", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот")
# (one, few, many, feminine) per power of a thousand.
SCALES = (
    ("тысяча", "тысячи", "тысяч", True),
    ("миллион", "миллиона", "миллионов", False),
    ("миллиард", "миллиарда", "миллиардов", False),
)
RUBLE = ("рубль", "рубля", "рублей")
KOPECK = ("копейка", "копейки", "копеек")
MAX_AMOUNT = 10**12 - 1


def main(argv):
    p = parser("ru amount")
    p.add_argument("number")
    p.add_argument("--kop", type=int)
    p.add_argument("--currency", default="rub", choices=("rub", "none"))
    args = p.parse_args(argv)
    rubles, kopecks = parse_amount(args.number)
    if args.kop is not None:
        if not 0 <= args.kop <= 99:
            raise KitError("bad_args", "--kop must be 0..99")
        kopecks = args.kop
    if args.currency == "none":
        if kopecks:
            raise KitError("bad_args", "a number with kopecks needs --currency rub")
        words = number_words(rubles)
    else:
        words = rubles_words(rubles, kopecks)
    return {"words": words, "capitalized": words[:1].upper() + words[1:], "rubles": rubles, "kopecks": kopecks}


def parse_amount(text):
    """(rubles, kopecks) from «24500», «24 500,50», «24500.5»."""
    cleaned = re.sub(r"[\s  ']", "", text)
    match = re.fullmatch(r"(\d+)(?:[.,](\d{1,2}))?", cleaned)
    if not match:
        raise KitError("bad_number", "not an amount: " + text, "like 24500 or 24500,50")
    rubles = int(match.group(1))
    if rubles > MAX_AMOUNT:
        raise KitError("bad_number", "the amount is too large: " + text)
    kopecks = int((match.group(2) or "0").ljust(2, "0"))
    return rubles, kopecks


def plural(n, forms):
    tail = n % 100
    if 11 <= tail <= 19:
        return forms[2]
    if n % 10 == 1:
        return forms[0]
    if 2 <= n % 10 <= 4:
        return forms[1]
    return forms[2]


def triad(n, feminine):
    words = [HUNDREDS[n // 100]]
    tail = n % 100
    if 10 <= tail <= 19:
        words.append(TEENS[tail - 10])
    else:
        words.append(TENS[tail // 10])
        words.append((UNITS_F if feminine else UNITS_M)[tail % 10])
    return [word for word in words if word]


def number_words(n, feminine=False):
    if n == 0:
        return "ноль"
    words = []
    for power in range(len(SCALES), 0, -1):
        part = n // 1000**power % 1000
        if part:
            one, few, many, scale_feminine = SCALES[power - 1]
            words.extend(triad(part, scale_feminine))
            words.append(plural(part, (one, few, many)))
    words.extend(triad(n % 1000, feminine))
    return " ".join(words)


def rubles_words(rubles, kopecks):
    return "%s %s %02d %s" % (number_words(rubles), plural(rubles, RUBLE), kopecks, plural(kopecks, KOPECK))
