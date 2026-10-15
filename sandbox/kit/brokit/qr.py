"""brokit qr: a QR code, including the payment QR of GOST R 56042-2014.

`--gost FIELDS.json` builds `ST00012|Name=…|PersonalAcc=…|…` (format 0001,
UTF-8) that Russian bank apps read to fill a payment; `--text T` encodes any
text. The PDF is drawn with reportlab's QR widget through renderPDF and the PNG
with Pillow from the same module matrix (no renderPM, which needs a C extension
the sandbox does not have).

Python API for the task agent's own scripts: `gost_payload(fields)` and
`draw_qr(canvas, payload, x, y, size)` on a reportlab canvas.
"""

import re

from brokit.util import KitError, out_path, parser, read_json

GOST_HEADER = "ST00012"
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
        payload = gost_payload(fields)
        warnings = gost_warnings(fields)
    else:
        payload = args.text
        if not payload:
            raise KitError("bad_args", "--text is empty")
    out_path(args.output, args.gost)
    lower = args.output.lower()
    if lower.endswith(".pdf"):
        modules = write_pdf(payload, args.output, args.size_mm, args.level)
    elif lower.endswith(".png"):
        modules = write_png(payload, args.output, args.size_mm, args.level)
    else:
        raise KitError("bad_output", "the output must be .png or .pdf")
    return {"payload": payload, "modules": modules, "output": args.output, "warnings": warnings}


def gost_payload(fields):
    """The ST00012 string for a dict of GOST keys; required keys first."""
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
    ordered = [key for key in REQUIRED] + [key for key in values if key not in REQUIRED]
    return "|".join([GOST_HEADER] + ["%s=%s" % (key, values[key]) for key in ordered])


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
    bic = values.get("BIC", "")
    if not account_key_ok(bic[-3:], values.get("PersonalAcc", "")):
        warnings.append("account_checksum: PersonalAcc does not match BIC, check both")
    corresp = values.get("CorrespAcc", "")
    if corresp != "0" and not account_key_ok("0" + bic[4:6], corresp):
        warnings.append("account_checksum: CorrespAcc does not match BIC, check both")
    return warnings


def qr_matrix(payload, level="M"):
    """(widget, rows of booleans) for the payload."""
    from reportlab.graphics.barcode.qr import QrCodeWidget

    widget = QrCodeWidget(payload, barLevel=level, barBorder=QUIET_ZONE)
    widget.qr.make()
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
