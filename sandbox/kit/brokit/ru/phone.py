"""brokit ru phone: phone numbers in one form, +7… and a tel a phone dials.

Each number gives {n, in, tel, e164, ext, kind, problem}; `n` is the input it
came from (an argument or a line of --file, blank ones counted), `in` its text.

- 8XXXXXXXXXX, 7XXXXXXXXXX, +7XXXXXXXXXX and ten digits of a code and a
  number (3XX, 4XX, 80X-87X, 9XX) become +7XXXXXXXXXX. kind: mobile (9XX),
  city (3XX, 4XX, 8XX) or foreign (+7 6XX and 7XX are Kazakhstan; another +
  or 00 code keeps its own).
- An extension after «доб.», «добавочный», «вн.», «внутр.», «ext», «x» or «#»
  goes to ext, and tel is +74950000001,123: after the comma (a pause) iPhone
  and Android dial the extension themselves.
- A number that cannot be brought to that form for sure keeps its text
  (tel = in, e164 = null) with a problem: no_area_code (5-7 digits: the city
  is unknown), plus_eight (+8 9XX…: a Russian 8 or a foreign code?),
  unknown_code, bad_length, unreadable, not_a_number. They are listed in
  `unsure` with a hint: the code is never guessed.
- One cell may hold several numbers split by ; / or a line break, or by
  commas when every part has five digits or more: each gets a row of its own
  with the cell's `n`.

--country is the code of numbers written without one (7: the rules above);
for another code a leading trunk 0 is dropped and the code is put in front.

Python API for the agent's own scripts: `phones(text, country="7")` gives the
rows of one cell (a spreadsheet column longer than the 200 rows of the JSON).
"""

import re

from brokit.util import KitError, need_file, parser

UNSURE_HINT = "Код города не дописывай: оставь номер как есть и назови его в отчёте"
MAX_INPUTS = 5000
# The extension: a marker not glued to a word, digits, the end of the text.
EXTENSION = re.compile(
    r"(?<![^\W\d_])(?:добавочный|доб\.?|внутр\.?|вн\.?|ext\.?|x|#)\s*[:.]?\s*([0-9]{1,6})\s*\)?\s*$",
    re.IGNORECASE,
)
CELL_SPLIT = re.compile(r"[;/\r\n]+")
NUMBER_CHARS = re.compile(r"[0-9\s+().\-‐-―]*")
START = re.compile(r"[0-9+]")


def main(argv):
    p = parser("ru phone")
    p.add_argument("numbers", nargs="*")
    p.add_argument("--file")
    p.add_argument("--country", default="7")
    args = p.parse_args(argv)
    if not re.fullmatch(r"[1-9][0-9]{0,2}", args.country):
        raise KitError("bad_args", "--country is a calling code of 1-3 digits, like 7 or 375")
    cells = list(args.numbers)
    if args.file:
        need_file(args.file)
        with open(args.file, encoding="utf-8-sig") as handle:
            cells.extend(line.rstrip("\r\n") for line in handle)
    if not any(cell.strip() for cell in cells):
        raise KitError("bad_args", "give numbers or --file NUMBERS.txt (one cell per line)")
    if len(cells) > MAX_INPUTS:
        raise KitError("too_many", "more than %d numbers in one call" % MAX_INPUTS, "use phones() from brokit.ru.phone")
    rows = []
    for n, cell in enumerate(cells, 1):
        rows.extend(dict({"n": n}, **row) for row in phones(cell, args.country))
    unsure = [{"n": row["n"], "in": row["in"], "problem": row["problem"]} for row in rows if row["problem"]]
    result = {"count": len(rows), "numbers": rows, "unsure": unsure}
    if unsure:
        result["hint"] = UNSURE_HINT
    return result


def phones(text, country="7"):
    """Rows {in, tel, e164, ext, kind, problem} for the numbers of one cell."""
    pieces = [piece.strip() for piece in CELL_SPLIT.split(str(text))]
    pieces = [piece for piece in pieces if piece]
    split = []
    for piece in pieces:
        parts = [part.strip() for part in piece.split(",")]
        if len(parts) > 1 and all(len(digits_of(part)) >= 5 for part in parts):
            split.extend(parts)
        else:
            split.append(piece)
    # A label alone between separators («тел./факс») is no number of its own.
    numbered = [piece for piece in split if digits_of(piece)]
    if not numbered:
        numbered = split[:1]
    return [phone(piece, country) for piece in numbered]


def digits_of(text):
    return re.sub(r"[^0-9]", "", text)


def phone(text, country="7"):
    """The row of one number."""
    row = {"in": text, "tel": text, "e164": None, "ext": None, "kind": None, "problem": None}
    main_part = text
    found = EXTENSION.search(text)
    if found:
        row["ext"] = found.group(1)
        main_part = text[: found.start()].rstrip(" \t,;(-")
    start = START.search(main_part)
    if start is None:
        row["problem"] = "not_a_number"
        return row
    # Words before the number («тел.», «моб.:») are a label; after it — not a number.
    number = main_part[start.start() :]
    if not NUMBER_CHARS.fullmatch(number) or "+" in number[1:]:
        row["problem"] = "unreadable"
        return row
    e164, kind, problem = normalize(digits_of(number), number.startswith("+"), country)
    if problem:
        row["problem"] = problem
        return row
    row.update(e164=e164, kind=kind, tel=e164 + ("," + row["ext"] if row["ext"] else ""))
    return row


def normalize(digits, plus, country):
    """(e164, kind, None) or (None, None, problem) for the digits of one number."""
    if plus or digits.startswith("00"):
        return international(digits if plus else digits[2:], plus)
    if digits.startswith("810") and len(digits) > 11:
        return international(digits[3:], False)  # the old Russian way out: 8, tone, 10
    if country != "7":
        if digits.startswith(country) and len(digits) >= 11:
            return international(digits, False)
        if digits.startswith("0") and 8 <= len(country) + len(digits) - 1 <= 15:
            return international(country + digits[1:], False)
        return None, None, "unknown_code"
    if len(digits) == 11 and digits[0] in "78":
        return russian(digits[1:])
    if len(digits) == 10:
        # 6XX and 7XX without a prefix may be Kazakhstan or a digit short: unsure.
        return russian(digits) if digits[0] not in "67" else (None, None, "unknown_code")
    if 5 <= len(digits) <= 7:
        return None, None, "no_area_code"
    return None, None, "bad_length"


def international(digits, plus):
    if digits.startswith("7"):
        return russian(digits[1:]) if len(digits) == 11 else (None, None, "bad_length")
    if plus and digits.startswith("8") and len(digits) == 11:
        return None, None, "plus_eight"
    if not 8 <= len(digits) <= 15:
        return None, None, "bad_length"
    return "+" + digits, "foreign", None


def russian(national):
    """+7 and the kind of a ten-digit number (code and number)."""
    if len(national) != 10:
        return None, None, "bad_length"
    first, second = national[0], national[1]
    if first == "9":
        return "+7" + national, "mobile", None
    if first in "34" or (first == "8" and second in "01234567"):
        return "+7" + national, "city", None
    if first in "67":
        return "+7" + national, "foreign", None
    return None, None, "unknown_code"
