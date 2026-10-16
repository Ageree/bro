"""brokit qr: a QR code, including the payment QR of GOST R 56042-2014.

`--gost FIELDS.json` builds `ST00012|Name=…|PersonalAcc=…|…` (format 0001,
UTF-8) that Russian bank apps read to fill a payment; `--text T` encodes any
text. A ready GOST string (`--text 'ST00012|…'`, or a payload given to
qr_matrix and draw_qr) is split back into fields and goes through the same
checks and the same rebuilding as `--gost`: an organisation's or ИП's account
without PayeeINN is refused there too. The PDF is drawn with reportlab's QR widget through renderPDF and the PNG
with Pillow from the same module matrix (no renderPM, which needs a C extension
the sandbox does not have).

Python API for the task agent's own scripts: `gost_payload(fields)` and
`draw_qr(canvas, payload, x, y, size)` on a reportlab canvas.
"""

import re

from brokit import producer
from brokit.util import KitError, out_path, parser, read_json

GOST_HEADER = "ST00012"
# "ST0001", the encoding digit (1 windows-1251, 2 UTF-8, 3 KOI8-R) and the
# separator the string then uses; the kit always writes UTF-8 with "|".
GOST_TEXT = re.compile(r"ST0001(\d)")
REQUIRED = ("Name", "PersonalAcc", "BankName", "BIC", "CorrespAcc")
# GOST R 56042-2014 table 1: the bank fields' formats and the longest values
# bank apps accept.
FORMATS = {
    "PersonalAcc": (r"\d{20}", "20 digits"),
    "BIC": (r"\d{9}", "9 digits"),
    "CorrespAcc": (r"0|\d{20}", "20 digits or 0"),
    "PayeeINN": (r"\d{10}|\d{12}", "10 or 12 digits"),
    "PayerINN": (r"\d{10}|\d{12}", "10 or 12 digits"),
    "KPP": (r"\d{4}[\dA-Z]{2}\d{3}", "9 characters"),
    "Sum": (r"\d{1,18}", "kopecks as digits, 1500.00 rub = 150000"),
}
MAX_LENGTH = {"Name": 160, "BankName": 45, "Purpose": 210}
# Account prefixes of organisations (405-407), ИП (40802) and payment agents
# (40821): a payment there without the payee's INN is refused by bank apps.
BUSINESS_ACCOUNTS = ("405", "406", "407", "40802", "40821")
PAYEE_INN_HINT = (
    "add PayeeINN, the seller's INN from the invoice or contract (and KPP for an organisation); "
    "never make it up: without it ask for it"
)
QUIET_ZONE = 4
PNG_DPI = 300


def main(argv):
    p = parser("qr")
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument("--gost")
    source.add_argument("--text")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--size-mm", type=float, default=30.0)
    p.add_argument("--level", default="M", choices=("L", "M", "Q", "H"))
    args = p.parse_args(argv)
    if not 10 <= args.size_mm <= 200:
        raise KitError("bad_args", "--size-mm must be 10..200")
    warnings = []
    if args.gost:
        fields = read_json(args.gost)
        if not isinstance(fields, dict):
            raise KitError("bad_fields", "FIELDS.json must be an object of GOST keys")
    else:
        if not args.text:
            raise KitError("bad_args", "--text is empty")
        fields = gost_fields(args.text)
    if fields is None:
        payload = args.text
    else:
        payload = gost_payload(fields, ready=args.gost is None)
        warnings = gost_warnings(fields)
    out_path(args.output, args.gost)
    lower = args.output.lower()
    if lower.endswith(".pdf"):
        modules = write_pdf(payload, args.output, args.size_mm, args.level)
    elif lower.endswith(".png"):
        modules = write_png(payload, args.output, args.size_mm, args.level)
    else:
        raise KitError("bad_output", "the output must be .png or .pdf")
    return {"payload": payload, "modules": modules, "output": args.output, "warnings": warnings}


def gost_payload(fields, ready=False):
    """The ST00012 string for a dict of GOST keys; required keys first.

    The sum is given as SumRub, in rubles, and written as GOST's Sum in
    kopecks: a bare Sum was rubles as often as kopecks (24500 for 24 500 ₽ is
    245 ₽ in a bank app). A ready GOST string (`ready`) keeps its Sum.
    """
    fields = dict(fields)
    if not ready:
        if "Sum" in fields:
            raise KitError(
                "bad_fields",
                "Sum is kopecks and easy to get wrong",
                "pass SumRub, the sum in rubles (24500 or 24500.50); the kit writes Sum in kopecks",
            )
        if "SumRub" in fields:
            fields["Sum"] = kopecks(fields.pop("SumRub"))
    values = {}
    for key, value in fields.items():
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,39}", str(key)):
            raise KitError("bad_fields", "not a GOST key: " + str(key))
        text = str(value).strip()
        if "|" in text or "\n" in text or "\r" in text:
            raise KitError("bad_fields", key + " must not contain | or a line break")
        if text:
            values[key] = text
    missing = [key for key in REQUIRED if key not in values]
    if missing:
        raise KitError(
            "bad_fields", "missing required GOST keys: " + ", ".join(missing), "required: " + ", ".join(REQUIRED)
        )
    for key, (pattern, what) in FORMATS.items():
        if key in values and not re.fullmatch(pattern, values[key]):
            raise KitError("bad_fields", "%s must be %s: %s" % (key, what, values[key]))
    if "PayeeINN" not in values and values["PersonalAcc"].startswith(BUSINESS_ACCOUNTS):
        raise KitError(
            "bad_fields",
            "PayeeINN is missing: PersonalAcc %s… is an organisation's or ИП's account" % values["PersonalAcc"][:5],
            PAYEE_INN_HINT,
        )
    ordered = [key for key in REQUIRED] + [key for key in values if key not in REQUIRED]
    return "|".join([GOST_HEADER] + ["%s=%s" % (key, values[key]) for key in ordered])


def kopecks(rubles):
    """Rubles (24500, «24 500,50», 24500.5) as GOST's Sum: kopecks, digits only."""
    text = re.sub(r"[\s\u00a0]", "", str(rubles)).replace(",", ".")
    if not re.fullmatch(r"\d{1,16}(?:\.\d{1,2})?", text):
        raise KitError("bad_fields", "SumRub must be rubles, 24500 or 24500.50: " + str(rubles))
    whole, _, cents = text.partition(".")
    total = int(whole) * 100 + int((cents + "00")[:2])
    if total == 0:
        raise KitError("bad_fields", "SumRub must be more than 0")
    return str(total)


def gost_fields(text):
    """The fields of a ready GOST string (ST0001…), or None for any other text."""
    text = text.strip()
    found = GOST_TEXT.match(text)
    if found is None:
        return None
    separator = text[found.end() : found.end() + 1]
    if found.group(1) not in "123" or not separator:
        raise KitError("bad_fields", "not a GOST string: " + text[:20], "ST00012|Name=…|PersonalAcc=…|…, or --gost FIELDS.json")
    fields = {}
    for part in text[found.end() + 1 :].split(separator):
        if not part.strip():
            continue
        key, sign, value = part.partition("=")
        if not sign:
            raise KitError("bad_fields", "not a Key=Value part of the GOST string: " + part[:40])
        if key in fields:
            raise KitError("bad_fields", key + " is given twice in the GOST string")
        fields[key] = value
    return fields


def checked_payload(payload):
    """A ready GOST string rebuilt by gost_payload (refused like --gost); any other text as is."""
    fields = gost_fields(payload)
    return payload if fields is None else gost_payload(fields, ready=True)


def account_key_ok(prefix, account):
    """The control digit of a Russian bank account (Bank of Russia rules)."""
    digits = prefix + account
    weights = (7, 1, 3) * 8
    return sum(int(d) * w for d, w in zip(digits, weights)) % 10 == 0


def gost_warnings(fields):
    values = {key: str(value).strip() for key, value in fields.items()}
    warnings = []
    for key, limit in MAX_LENGTH.items():
        if len(values.get(key, "")) > limit:
            warnings.append("too_long: %s is longer than %d characters, some bank apps cut it" % (key, limit))
    if re.search(r"(?<![\w])[А-ЯЁ]\.\s*[А-ЯЁ]\.", values.get("Name", "")):
        # Live 16.10: «ИП Образцова Е. С.» from the card's short name; the bank matches the payee by the full one.
        warnings.append(
            "name_initials: Name has initials; write the payee's full name from the card "
            "(«ИП Фамилия Имя Отчество» or «Индивидуальный предприниматель …»)"
        )
    bic = values.get("BIC", "")
    if not account_key_ok(bic[-3:], values.get("PersonalAcc", "")):
        warnings.append("account_checksum: PersonalAcc does not match BIC, check both")
    corresp = values.get("CorrespAcc", "")
    if corresp != "0" and not account_key_ok("0" + bic[4:6], corresp):
        warnings.append("account_checksum: CorrespAcc does not match BIC, check both")
    return warnings


def qr_matrix(payload, level="M"):
    """(widget, rows of booleans) for the payload; a GOST string is checked first (checked_payload)."""
    from reportlab.graphics.barcode.qr import QrCodeWidget

    payload = checked_payload(payload)
    widget = QrCodeWidget(payload, barLevel=level, barBorder=QUIET_ZONE)
    try:
        widget.qr.make()
    except Exception as error:  # noqa: BLE001 — reportlab raises a bare Exception («code length overflow»)
        if "overflow" not in str(error):
            raise
        raise KitError(
            "too_long",
            "the text does not fit in one QR code (%d bytes)" % len(payload.encode("utf-8")),
            "shorten it (about 1200 Cyrillic letters at --level L) or use --level L",
        )
    count = widget.qr.getModuleCount()
    return widget, [[bool(widget.qr.isDark(r, c)) for c in range(count)] for r in range(count)]


def draw_qr(canvas, payload, x, y, size, level="M"):
    """Draws the QR (quiet zone included) with its lower-left corner at x, y."""
    from reportlab.graphics import renderPDF
    from reportlab.graphics.shapes import Drawing

    widget, matrix = qr_matrix(payload, level)
    widget.barWidth = widget.barHeight = size
    drawing = Drawing(size, size)
    drawing.add(widget)
    renderPDF.draw(drawing, canvas, x, y)
    return len(matrix)


def write_pdf(payload, output, size_mm, level):
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as pdf_canvas

    size = size_mm * mm
    canvas = pdf_canvas.Canvas(output, pagesize=(size, size))
    canvas.setTitle("QR")
    canvas.setProducer(producer())
    modules = draw_qr(canvas, payload, 0, 0, size, level)
    canvas.showPage()
    canvas.save()
    return modules


def write_png(payload, output, size_mm, level):
    from PIL import Image

    _, matrix = qr_matrix(payload, level)
    count = len(matrix) + 2 * QUIET_ZONE
    target = size_mm / 25.4 * PNG_DPI
    module = max(4, int(round(target / count)))
    image = Image.new("1", (count, count), 1)
    pixels = image.load()
    for r, row in enumerate(matrix):
        for c, dark in enumerate(row):
            if dark:
                pixels[c + QUIET_ZONE, r + QUIET_ZONE] = 0
    image = image.resize((count * module, count * module), Image.NEAREST)
    dpi = image.width / (size_mm / 25.4)
    image.save(output, dpi=(dpi, dpi))
    return len(matrix)
