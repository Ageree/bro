"""Signature places: `pdf sign-spots`, `pdf sign-mark`, `pdf sign-places`, `pdf stamp-sign` (W2 spec §5.2, §5.3).

The task agent finds places (`sign-spots`) and marks the person's own places with fields
`bro_sign_<role>_<n>` (`sign-mark`; never a counterparty's). Bro's signer runs `sign-places`
(inventory only — Node decides the policy) and `stamp-sign` in its own sandbox with a fresh
copy of the kit. A mark carries /BroLabel — the printed text naming the place — and /BroMark,
the workspace's token bound to the mark's name, page and box (`seal`), without which the signer
does not trust the mark. `sign-places` reads every label from the page again, so a script that
rewrites /BroLabel cannot rename the place, and the token itself never lands in a file: a mark
copied out of a sent file vouches for nothing but its own place. Marks have no appearance (/AP):
a file printed without Bro's signature shows nothing extra.
"""

import datetime
import hashlib
import hmac
import os
import re
import unicodedata

from brokit import labels
from brokit.pdf import crypt, form, geom
from brokit.util import KitError, out_path, parse_pages, parser, read_json

# Matched with fullmatch and re.ASCII, so they mean what the same patterns mean in JavaScript
# (W3): Python's `$` also matches before a trailing newline and its `\d`/`\w` take any script.
MARK_RE = re.compile(r"^bro_sign_(signature|initials|date)_(\d+)$", re.ASCII)
SCAFFOLD_PREFIX = "bro_sign_"
SIGNING_ID_RE = re.compile(r"^[\w-]{1,64}$", re.ASCII)
TOKEN_RE = re.compile(r"^[0-9a-f]{8,64}$", re.ASCII)
DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$", re.ASCII)
MAX_PAGES = 500
MAX_PLACES = 200
ROLES = ("signature", "initials", "date")
HINTS = (
    ("name", re.compile(r"расшифр|ф\.?\s*и\.?\s*о\.?|printed name|print name")),
    ("stamp", re.compile(r"(^|\W)м\.?\s?п\.?(\W|$)")),
    ("initials", re.compile(r"инициал|параф|initial")),
    ("date", re.compile(r"дата|date")),
    ("signature", re.compile(r"подпис|signature|sign here")),
)
SIGNED_MARKER = "signed-by-bro"


def normalised(text):
    return unicodedata.normalize("NFKC", text or "").lower().replace("ё", "е")


def hint_for(text, is_text):
    """The first hint of HINTS matching NFKC-lower text (ё→е); `date` only for text fields."""
    text = normalised(text)
    for role, pattern in HINTS:
        if role == "date" and not is_text:
            continue
        if pattern.search(text):
            return role
    return None


def mark_token(explicit):
    """The workspace's mark token: --mark-token, else $BROKIT_HOME/mark-token (never printed)."""
    if explicit:
        token = explicit.strip().lower()
        if not TOKEN_RE.fullmatch(token):
            raise KitError("bad_args", "--mark-token must be hex")
        return token
    path = os.path.join(os.environ.get("BROKIT_HOME", "/workspace/.bro"), "mark-token")
    try:
        with open(path, encoding="ascii") as handle:
            token = handle.read().strip().lower()
    except (OSError, UnicodeDecodeError):
        return None
    return token if TOKEN_RE.fullmatch(token) else None


def mark_of(field):
    match = MARK_RE.fullmatch(form.raw_name(field))
    return {"role": match.group(1), "n": int(match.group(2))} if match else None


def is_scaffold(field):
    """Any field named `bro_sign_…` — marks and look-alikes: never filled, never left in a signed file."""
    return isinstance(field, dict) and form.raw_name(field).startswith(SCAFFOLD_PREFIX)


def stored(widget, key):
    """A key on the widget or, failing that, its field (marks carry /BroLabel and /BroMark)."""
    value = form.inherited(widget, key)
    return str(value) if value is not None else ""


def seal(token, raw_name, index, widget):
    """The /BroMark of a mark's widget: the token's HMAC over its name, page and box."""
    box = ",".join("%.1f" % value for value in geom.widget_rect(widget))
    message = "%s|%d|%s" % (raw_name, index + 1, box)
    return hmac.new(token.encode("ascii"), message.encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def sealed(token, raw_name, index, widget):
    """Whether the widget carries this token's seal for its own name, page and box."""
    if not token:
        return False
    return hmac.compare_digest(stored(widget, "/BroMark").encode("utf-8"), seal(token, raw_name, index, widget).encode("ascii"))


class Words:
    """labels.PageWords per page (pdftotext), read once per page."""

    def __init__(self, path):
        self.path = path
        self.pages = {}

    def prefetch(self, numbers, gap=3):
        """Reads runs of nearby pages with one pdftotext call each (a long form has fields on every page)."""
        runs = []
        for number in sorted(set(numbers) - set(self.pages)):
            if runs and number - runs[-1][1] <= gap:
                runs[-1][1] = number
            else:
                runs.append([number, number])
        for first, last in runs:
            layout = labels.page_layout(self.path, first, last)
            for number in range(first, last + 1):
                self.pages.setdefault(number, labels.PageWords(layout.get(number, [])))

    def __call__(self, number):
        if number not in self.pages:
            self.prefetch([number])
        return self.pages[number]


def signed_fields(found, doc):
    """Every /Sig field with a value: on the pages, and in /Fields without a widget (a rewrite breaks either)."""
    names = [name for name, record in found.items() if record["kind"] == "signature" and form.inherited(record["field"], "/V") is not None]
    for node in form.tree_nodes(doc):
        if "/T" in node and form.kind(node) == "signature" and form.inherited(node, "/V") is not None:
            name = form.full_name(node)
            if name not in names:
                names.append(name)
    return names


def is_signed_by_bro(reader):
    try:
        keywords = str((reader.metadata or {}).get("/Keywords") or "")
    except crypt.pdf_errors():
        keywords = ""
    return SIGNED_MARKER in keywords


def _xfa(doc):
    acro = form.acroform(doc)
    return acro is not None and "/XFA" in acro


# --- sign-places --------------------------------------------------------------------------


def places(argv):
    args = parser("pdf sign-places")
    args.add_argument("file")
    args.add_argument("--mark-token")
    options = args.parse_args(argv)
    token = mark_token(options.mark_token) if options.mark_token else None
    reader = crypt.open_pdf(options.file, decrypt=False)
    if reader.is_encrypted:
        try:
            count = len(reader.pages) if reader.decrypt("") else 0
        except crypt.pdf_errors():
            count = 0
        return {"status": "encrypted", "pages": count, "signed_by_bro": False, "signed_fields": [], "places": []}
    try:
        return inventory(options.file, reader, token)
    except crypt.pdf_errors() as error:
        raise crypt.unreadable(error)


def inventory(path, reader, token):
    count = len(reader.pages)
    base = {"pages": count, "signed_by_bro": is_signed_by_bro(reader), "signed_fields": [], "places": []}
    if _xfa(reader):
        return dict(base, status="xfa")
    if count > MAX_PAGES:
        base.pop("places")
        return dict(base, status="too_many")
    found = form.fields(reader)
    base["signed_fields"] = signed_fields(found, reader)
    words = Words(path)
    words.prefetch(index + 1 for record in found.values() if record["kind"] in ("signature", "text") for index, *_ in record["widgets"])
    listed = []
    for name, record in found.items():
        field, field_kind = record["field"], record["kind"]
        mark = mark_of(field)
        if field_kind not in ("signature", "text"):
            continue
        if field_kind == "signature" and form.inherited(field, "/V") is not None:
            continue
        for index, page, _, widget in record["widgets"]:
            box = geom.widget_rect(widget)
            view = geom.user_to_view(page, box)
            # From the page for marks too: /BroLabel is whatever the last script wrote there.
            label = words(index + 1).label(view)
            hint = mark["role"] if mark else hint_for(form.raw_name(field) + " " + label, field_kind == "text")
            if field_kind == "text" and mark is None and hint is None:
                continue
            value = form.value_of(field)
            listed.append(
                {
                    "field": name,
                    "raw_name": form.raw_name(field),
                    "type": field_kind,
                    "page": index + 1,
                    "rect": geom.rounded(box, 2),
                    "view_box": geom.rounded(view, 2),
                    "rotate": geom.rotation(page),
                    "hidden": form.hidden(widget),
                    "empty": value in (None, ""),
                    "bro": mark,
                    "marked": bool(mark) and sealed(token, form.raw_name(field), index, widget),
                    "label": label[:80],
                    "hint": hint,
                }
            )
            if len(listed) > MAX_PLACES:
                base.pop("places")
                return dict(base, status="too_many")
    base["places"] = listed
    return dict(base, status="ok")


# --- stamp-sign ---------------------------------------------------------------------------


def _plan(path):
    plan = read_json(path)
    if not isinstance(plan, dict):
        raise KitError("plan_mismatch", "PLAN.json must be an object")
    signing_id = str(plan.get("signing_id", ""))
    if not SIGNING_ID_RE.fullmatch(signing_id):
        raise KitError("plan_mismatch", "signing_id must match ^[\\w-]{1,64}$")
    chosen = plan.get("places")
    if not isinstance(chosen, list) or not chosen:
        raise KitError("plan_mismatch", "places must be a non-empty list")
    roles = {}
    for item in chosen:
        if not isinstance(item, dict) or item.get("role") not in ROLES or not isinstance(item.get("field"), str):
            raise KitError("plan_mismatch", "each place needs a field name and a role signature|initials|date")
        if item["field"] in roles:
            raise KitError("plan_mismatch", "field %s is planned twice" % item["field"])
        roles[item["field"]] = item["role"]
    date = str(plan.get("date", ""))
    if "date" in roles.values() and not DATE_RE.fullmatch(date):
        raise KitError("plan_mismatch", "date must be dd.mm.yyyy")
    signature = plan.get("signature")
    if not isinstance(signature, dict) or signature.get("kind") not in ("image", "typed"):
        raise KitError("plan_mismatch", "signature must be {kind: image, png} or {kind: typed, text, initials, font}")
    return signing_id, roles, date, signature


def _signature_image(signature):
    from PIL import Image

    png = str(signature.get("png", ""))
    if not os.path.isfile(png) or os.path.getsize(png) > 1024 * 1024:
        raise KitError("bad_signature", "the signature PNG is missing or larger than 1 MB")
    try:
        with Image.open(png) as image:
            mode, size, image_format = image.mode, image.size, image.format
    except (OSError, ValueError):
        raise KitError("bad_signature", "the signature is not a readable PNG")
    if image_format != "PNG" or mode not in ("RGBA", "LA") or size[0] > 4000 or size[1] > 400 or min(size) < 1:
        raise KitError("bad_signature", "the signature must be an RGBA or LA PNG within 4000×400")
    return png, size[0] / size[1]


def _typed_font(signature):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    font_path = str(signature.get("font", ""))
    text = str(signature.get("text", "")).strip()
    initials = str(signature.get("initials", "")).strip() or text
    if not text:
        raise KitError("plan_mismatch", "a typed signature needs text")
    if not os.path.isfile(font_path):
        raise KitError("font_missing", "the signature font is missing: " + os.path.basename(font_path))
    try:
        pdfmetrics.registerFont(TTFont("BroHand", font_path))
    except Exception:  # noqa: BLE001 — reportlab raises assorted errors on a bad TTF
        raise KitError("font_missing", "the signature font cannot be loaded")
    return text, initials


def _check_place(name, role, record):
    if record is None:
        return "field %s is not in the PDF" % name
    field, field_kind = record["field"], record["kind"]
    if all(form.hidden(widget) for *_, widget in record["widgets"]):
        return "field %s is hidden" % name
    empty = form.value_of(field) in (None, "")
    if role == "date" and not (field_kind == "text" and empty):
        return "a date goes into an empty text field, not %s" % name
    if role != "date" and not (field_kind == "signature" and form.inherited(field, "/V") is None) and not (field_kind == "text" and empty):
        return "a signature goes into an unsigned signature field or an empty text field, not %s" % name
    return None


def stamp(argv):
    args = parser("pdf stamp-sign")
    args.add_argument("file")
    args.add_argument("plan")
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    output = out_path(options.output, options.file, options.plan)
    signing_id, roles, date, signature = _plan(options.plan)
    reader = crypt.open_pdf(options.file, decrypt=False)
    if reader.is_encrypted:
        raise KitError("encrypted", "the PDF is encrypted", "ask for a copy without a password")
    with crypt.parsing():
        if _xfa(reader):
            raise KitError("xfa", "an XFA form cannot be signed here")
        found = form.fields(reader)
        if signed_fields(found, reader):
            raise KitError("already_signed", "the PDF already carries a digital signature: rewriting would break it")
        if is_signed_by_bro(reader):
            raise KitError("signed_by_bro", "Bro has already signed this PDF")
        for name, role in roles.items():
            problem = _check_place(name, role, found.get(name))
            if problem:
                raise KitError("plan_mismatch", problem)
        if signature["kind"] == "image":
            png, aspect = _signature_image(signature)
            typed = None
        else:
            png, aspect = None, None
            typed = _typed_font(signature)
        writer = crypt.writer_from(reader)
        result = _stamp(writer, roles, date, png, aspect, typed)
        _add_keywords(writer, signing_id)
    size = crypt.write_pdf(writer, output, producer="Бро")
    with open(output, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    return dict(result, output=output, pages=len(writer.pages), bytes=size, sha256=digest)


def _add_keywords(writer, signing_id):
    existing = str((writer.metadata or {}).get("/Keywords") or "").strip()
    now = datetime.datetime.now(datetime.timezone.utc).strftime("D:%Y%m%d%H%M%SZ")
    keywords = (existing + " " if existing else "") + SIGNED_MARKER + " " + signing_id
    writer.add_metadata({"/Keywords": keywords, "/ModDate": now})


def _stamp(writer, roles, date, png, aspect, typed):
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfbase import pdfmetrics

    date_font = geom.font("BroSans")
    found = form.fields(writer)
    jobs = []  # (name, role, page index, page, widget rect, frame matrix, visual w, visual h)
    for name, role in roles.items():
        for index, page, _, widget in found[name]["widgets"]:
            if form.hidden(widget):
                continue
            box = geom.widget_rect(widget)
            matrix, width, height = geom.frame(box, geom.rotation(page))
            jobs.append((name, role, index, page, box, matrix, width, height))
    image = ImageReader(png) if png else None
    painted = []  # visual-frame box of the ink, per job

    def draw(canvas, job_index, width, height):
        role = jobs[job_index][1]
        if role == "date":
            # clamp(0.7·h, 6, 11), and narrow enough for the box (a 40 pt box takes «15.10.2026» at 7 pt).
            fitting = (width - 3) / max(pdfmetrics.stringWidth(date, date_font, 1), 0.01)
            size = max(6.0, min(11.0, 0.7 * height, fitting))
            canvas.setFont(date_font, size)
            canvas.setFillColorRGB(0.05, 0.05, 0.25)
            canvas.drawString(2, (height - size * 0.72) / 2, date)
            painted.append(None)
            return
        if image is not None:
            cap = min(height, 22.0) if role == "initials" else max(height, 18.0)
            ink_height = min(cap, 0.92 * width / aspect)
            ink_width = ink_height * aspect
            x, y = (width - ink_width) / 2, 0.02 * height
            canvas.drawImage(image, x, y, ink_width, ink_height, mask="auto")
            painted.append([x, y, x + ink_width, y + ink_height])
            return
        text = typed[1] if role == "initials" else typed[0]
        unit = max(pdfmetrics.stringWidth(text, "BroHand", 1), 0.01)
        size = min(0.9 * height, 0.92 * width / unit)
        canvas.setFont("BroHand", size)
        canvas.setFillColorRGB(0.08, 0.12, 0.42)
        canvas.drawCentredString(width / 2, 0.22 * height, text)
        half = unit * size / 2
        painted.append([width / 2 - half, 0.22 * height - 0.3 * size, width / 2 + half, 0.22 * height + 0.8 * size])

    forms = geom.canvas_forms(writer, [(job[6], job[7]) for job in jobs], draw)
    stamper = geom.Stamper(writer, "BroSign")
    drawn, signed_boxes = [], []
    for job, reference, ink in zip(jobs, forms, painted):
        name, role, index, page, box, matrix = job[:6]
        stamper.add(page, reference, matrix)
        drawn.append({"field": name, "page": index + 1, "role": role, "view_box": geom.rounded(geom.user_to_view(page, box), 2)})
        if role != "date" and ink is not None:
            signed_boxes.append((index, box, geom.map_box(matrix, ink)))
    stamper.apply()

    removed = set(roles)
    for name, record in found.items():
        field = record["field"]
        if is_scaffold(field):
            removed.add(name)
        elif record["kind"] == "signature" and form.inherited(field, "/V") is None:
            for index, _, _, widget in record["widgets"]:
                box = geom.widget_rect(widget)
                for place_index, place_box, ink_box in signed_boxes:
                    covered = geom.intersection(box, ink_box) / geom.area(ink_box) if geom.area(ink_box) > 0 else 0
                    if place_index == index and (geom.iou(box, place_box) > 0.5 or covered > 0.5):
                        removed.add(name)
    dropped = set()
    for name in removed:
        record = found[name]
        dropped.add(id(record["field"]))
        dropped.update(id(widget) for *_, widget in record["widgets"])
    acro = form.acroform(writer)
    # `bro_sign_*` fields without a widget on any page (left by a script) go too: they may carry the token.
    form.drop_widgets(writer, acro, dropped, drop=is_scaffold)
    signatures_left = any(r["kind"] == "signature" for n, r in found.items() if n not in removed) or any(
        "/T" in node and form.kind(node) == "signature" for node in form.tree_nodes(writer)
    )
    if acro is not None and "/SigFlags" in acro and not signatures_left:
        del acro["/SigFlags"]
    writer.compress_identical_objects(remove_duplicates=True, remove_unreferenced=True)
    return {"drawn": drawn, "removed": sorted(removed)}


# --- sign-mark ----------------------------------------------------------------------------


def _mark_items(options):
    if options.adopt:
        return [{"adopt": options.adopt}]
    if options.spec:
        items = read_json(options.spec)
        if isinstance(items, dict):
            items = [items]
        if not isinstance(items, list) or not items:
            raise KitError("bad_json", "SPEC.json must be a list of places")
        return items
    if options.page is None or options.box is None or options.role is None:
        raise KitError("bad_args", "give SPEC.json, or --page N --box x0 y0 x1 y1 --role R, or --adopt NAME")
    return [{"page": options.page, "box": options.box, "role": options.role}]


def _role(value):
    if value in ("name", "stamp"):
        raise KitError("bad_role", "role %s is not marked" % value, "впиши расшифровку текстом (pdf write); М.П. не отмечается")
    if value not in ROLES:
        raise KitError("bad_role", "role must be signature, initials or date", "сам подпись не ставь: только отметь место")
    return value


def _box(page, value, number):
    try:
        box = [float(v) for v in value]
    except (TypeError, ValueError):
        raise KitError("bad_box", "box must be [x0, y0, x1, y1] in view pt")
    if len(box) != 4:
        raise KitError("bad_box", "box must be [x0, y0, x1, y1] in view pt")
    box = geom.rect(box)
    width, height = geom.view_size(page)
    if box[2] - box[0] < 2 or box[3] - box[1] < 2:
        raise KitError("bad_box", "the box on page %d is empty" % number)
    if box[0] < -2 or box[1] < -2 or box[2] > width + 2 or box[3] > height + 2:
        raise KitError("bad_box", "the box on page %d is outside the page (%.0f × %.0f pt)" % (number, width, height))
    return [max(0.0, box[0]), max(0.0, box[1]), min(width, box[2]), min(height, box[3])]


def mark(argv):
    args = parser("pdf sign-mark")
    args.add_argument("file")
    args.add_argument("spec", nargs="?")
    args.add_argument("--page", type=int)
    args.add_argument("--box", type=float, nargs=4)
    args.add_argument("--role")
    args.add_argument("--adopt")
    args.add_argument("--mark-token")
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    output = out_path(options.output, options.file, options.spec)
    items = _mark_items(options)
    token = mark_token(options.mark_token)
    warnings = []
    reader = crypt.open_pdf(options.file, warnings=warnings)
    with crypt.parsing():
        if _xfa(reader):
            raise KitError("xfa", "an XFA form cannot carry sign marks")
        writer = crypt.writer_from(reader)
        marks = _mark(options.file, writer, items, token, warnings)
    if not token:
        warnings.append("no_mark_token: Bro will ask the person to choose fields")
    crypt.write_pdf(writer, output)
    return {"output": output, "marks": marks, "token": bool(token), "warnings": warnings}


def _acroform(writer):
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject

    acro = form.acroform(writer)
    if acro is None:
        acro = DictionaryObject({NameObject("/Fields"): ArrayObject()})
        writer._root_object[NameObject("/AcroForm")] = writer._add_object(acro)
    if form.field_list(acro) is None:
        acro[NameObject("/Fields")] = ArrayObject()
    return acro


def _helvetica(writer, acro):
    from pypdf.generic import DictionaryObject, NameObject

    resources = acro.get("/DR")
    resources = resources.get_object() if resources is not None else DictionaryObject()
    fonts = resources.get("/Font")
    fonts = fonts.get_object() if fonts is not None else DictionaryObject()
    if "/Helv" not in fonts:
        fonts[NameObject("/Helv")] = writer._add_object(
            DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Font"),
                    NameObject("/Subtype"): NameObject("/Type1"),
                    NameObject("/BaseFont"): NameObject("/Helvetica"),
                    NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
                }
            )
        )
    resources[NameObject("/Font")] = fonts
    acro[NameObject("/DR")] = resources


def _mark(path, writer, items, token, warnings):
    from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject

    found = form.fields(writer)
    used = set(found) | {form.raw_name(record["field"]) for record in found.values()}
    counters = {role: 0 for role in ROLES}
    words = Words(path)
    acro = _acroform(writer)
    marks = []

    def next_name(role):
        while True:
            counters[role] += 1
            name = "bro_sign_%s_%d" % (role, counters[role])
            if name not in used:
                used.add(name)
                return name

    native = [
        (index, geom.widget_rect(widget), name)
        for name, record in found.items()
        if record["kind"] == "signature" and not mark_of(record["field"]) and form.inherited(record["field"], "/V") is None
        for index, _, _, widget in record["widgets"]
    ]
    for item in items:
        if not isinstance(item, dict):
            raise KitError("bad_json", "each place is an object")
        if "adopt" in item:
            marks.append(_adopt(writer, found, str(item["adopt"]), token, words, next_name))
            acro[NameObject("/SigFlags")] = NumberObject(1)
            continue
        role = _role(item.get("role"))
        if "pages" in item:
            numbers = parse_pages(str(item["pages"]), len(writer.pages))
        elif item.get("page") is None and "at" in item:
            from brokit.pdf import layout

            numbers = [layout.blank_by_id(path, str(item["at"]))[0]]  # "p2b5" names its page
        else:
            try:
                numbers = [int(item.get("page"))]
            except (TypeError, ValueError):
                raise KitError("bad_box", "each place needs page (or pages) and box (or at)")
        for number in numbers:
            if not 1 <= number <= len(writer.pages):
                raise KitError("bad_box", "page %d is outside 1-%d" % (number, len(writer.pages)))
            page = writer.pages[number - 1]
            if "at" in item:
                from brokit.pdf import layout

                blank_page, blank_box, _ = layout.blank_by_id(path, str(item["at"]))
                if "pages" not in item and blank_page != number and item.get("page") is not None:
                    raise KitError("bad_box", "%s is a blank of page %d" % (item["at"], blank_page))
                view = _box(page, blank_box, number)
            else:
                view = _box(page, item.get("box"), number)
            user = geom.view_to_user(page, view)
            name = next_name(role)
            label = words(number).label(view)
            widget = DictionaryObject(
                {
                    NameObject("/Type"): NameObject("/Annot"),
                    NameObject("/Subtype"): NameObject("/Widget"),
                    NameObject("/FT"): NameObject("/Tx" if role == "date" else "/Sig"),
                    NameObject("/T"): TextStringObject(name),
                    NameObject("/Rect"): ArrayObject([FloatObject(round(v, 3)) for v in user]),
                    NameObject("/F"): NumberObject(4),
                    NameObject("/P"): page.indirect_reference,
                    NameObject("/BroLabel"): TextStringObject(label),
                }
            )
            if token:
                widget[NameObject("/BroMark")] = TextStringObject(seal(token, name, number - 1, widget))
            if role == "date":
                widget[NameObject("/DA")] = TextStringObject("/Helv 10 Tf 0 g")
                _helvetica(writer, acro)
            else:
                acro[NameObject("/SigFlags")] = NumberObject(1)
            reference = writer._add_object(widget)
            # A new array per page: pages may share one /Annots array, and the mark belongs to this page only.
            page[NameObject("/Annots")] = ArrayObject(list(form.annotations(page)) + [reference])
            form.field_list(acro).append(reference)
            width, height = view[2] - view[0], view[3] - view[1]
            if role != "date" and (width < 60 or height < 18):
                warnings.append("small_box: %s is %.0f×%.0f pt; a signature needs about 150×30" % (name, width, height))
            if role == "date" and (width < 40 or height < 10):
                warnings.append("small_box: %s is %.0f×%.0f pt; a date needs about 90×16" % (name, width, height))
            for index, native_box, native_name in native:
                if index == number - 1 and geom.intersection(user, native_box) > 0.5 * min(geom.area(user), geom.area(native_box)):
                    warnings.append("overlaps_field: %s covers the signature field %s — use --adopt %s" % (name, native_name, native_name))
            view_box = geom.rounded(geom.user_to_view(page, user), 2)
            marks.append({"field": name, "role": role, "page": number, "view_box": view_box, "label": label, "adopted": False})
    return marks


def _adopt(writer, found, wanted, token, words, next_name):
    from pypdf.generic import NameObject, TextStringObject

    record = found.get(wanted)
    if record is None:
        matches = [r for r in found.values() if form.raw_name(r["field"]) == wanted]
        record = matches[0] if len(matches) == 1 else None
    if record is None or record["kind"] != "signature" or mark_of(record["field"]):
        raise KitError("adopt_missing", "no unsigned signature field named %s" % wanted, "names from brokit pdf sign-spots (existing)")
    field = record["field"]
    if form.inherited(field, "/V") is not None:
        raise KitError("adopt_signed", "the field %s is already signed" % wanted)
    index, page, _, widget = record["widgets"][0]
    view = geom.user_to_view(page, geom.widget_rect(widget))
    label = words(index + 1).label(view)
    role = "initials" if re.search(r"инициал|параф|initial", normalised(label + " " + str(field.get("/TU", "")))) else "signature"
    name = next_name(role)
    field[NameObject("/T")] = TextStringObject(name)
    field[NameObject("/BroLabel")] = TextStringObject(label)
    for widget_index, _, _, target in record["widgets"]:
        target[NameObject("/BroLabel")] = TextStringObject(label)
        if token:
            target[NameObject("/BroMark")] = TextStringObject(seal(token, name, widget_index, target))
    return {"field": name, "role": role, "page": index + 1, "view_box": geom.rounded(view, 2), "label": label, "adopted": True, "was": wanted}


# --- sign-spots ---------------------------------------------------------------------------


def spots(argv):
    args = parser("pdf sign-spots")
    args.add_argument("file")
    args.add_argument("--pages")
    options = args.parse_args(argv)
    warnings = []
    reader = crypt.open_pdf(options.file, warnings=warnings)
    numbers = parse_pages(options.pages, len(reader.pages))
    token = mark_token(None)
    words = Words(options.file)
    words.prefetch(numbers)
    with crypt.parsing():
        found = form.fields(reader)
        found_spots, existing, covered = [], [], {}
        for name, record in found.items():
            field = record["field"]
            if mark_of(field):
                continue
            for index, page, _, widget in record["widgets"]:
                if index + 1 not in numbers:
                    continue
                view = geom.user_to_view(page, geom.widget_rect(widget))
                covered.setdefault(index + 1, []).append(view)
                label = words(index + 1).label(view)
                if record["kind"] == "signature":
                    signed = form.inherited(field, "/V") is not None
                    existing.append({"field": name, "page": index + 1, "box": geom.rounded(view), "label": label, "signed": signed})
                elif record["kind"] == "text" and form.value_of(field) in (None, ""):
                    # A filled text field is not a place to sign or date any more.
                    role = hint_for(form.raw_name(field) + " " + str(field.get("/TU", "")) + " " + label, True)
                    if role:
                        found_spots.append(
                            {"role": role, "page": index + 1, "box": geom.rounded(view), "label": label, "source": "field", "field": name, "confidence": 0.9}
                        )
        for number in numbers:
            found_spots.extend(_layout_spots(options.file, reader.pages[number - 1], number, words(number), covered.get(number, [])))
    anchors = [(s["page"], s["box"]) for s in found_spots if s["role"] in ("signature", "initials")]
    anchors += [(e["page"], e["box"]) for e in existing]
    # A date or a name (расшифровка) is a signing spot only next to a signature place.
    found_spots = [
        s for s in found_spots if s["role"] not in ("date", "name") or any(p == s["page"] and _near(s["box"], b) for p, b in anchors)
    ]
    for index, spot in enumerate(found_spots, start=1):
        spot["id"] = "s%d" % index
    return {"spots": found_spots, "existing": existing, "foreign_marks": foreign_marks(found, token), "warnings": warnings}


def foreign_marks(found, token):
    """Names of sign marks that do not carry this workspace's seal (another workspace's, moved, or forged)."""
    return [
        name
        for name, record in found.items()
        if mark_of(record["field"])
        and not all(sealed(token, form.raw_name(record["field"]), index, widget) for index, _, _, widget in record["widgets"])
    ]


def _layout_spots(path, page, number, text_layer, covered):
    """Spots named by printed words («Подпись ____», «(подпись)», «М.П.») and the blank they point at."""
    from brokit.pdf import layout

    words = text_layer.view
    blanks = None
    out = []
    for phrase in _phrases(words):
        text = phrase["t"]
        role = hint_for(text, True)
        if role is None:
            continue
        box = phrase["box"]
        if any(geom.intersection(box, c) > 0.5 * geom.area(box) for c in covered):
            continue
        if blanks is None:
            blanks = layout.page_blanks(path, number)
        caption = text.lstrip().startswith("(")
        line_words = sorted(
            (w for w in words if abs((w["box"][1] + w["box"][3]) / 2 - (box[1] + box[3]) / 2) < 4), key=lambda w: w["box"][0]
        )
        following = [w for w in line_words if w["box"][0] >= box[2] - 1]
        labelled = caption or text.rstrip().endswith(":") or len(line_words) <= 4 or (following and following[0]["box"][0] - box[2] > 30)
        if not labelled:
            continue  # a word of running text («подписания договора»), not a label
        blank = _blank_for(box, blanks, caption)
        if role == "stamp":
            out.append({"role": role, "page": number, "box": geom.rounded(box), "label": text, "source": "layout", "confidence": 0.6})
            continue
        if blank is not None:
            spot_box, confidence = blank["box"], 0.7
        elif role == "date":
            continue
        else:
            width, height = {"signature": (150, 30), "initials": (150, 30), "date": (90, 16)}.get(role, (110, 16))
            if caption:
                centre = (box[0] + box[2]) / 2
                spot_box = [centre - width / 2, box[1] - 2 - height, centre + width / 2, box[1] - 2]
            else:
                spot_box = [box[2] + 4, box[3] - height, box[2] + 4 + width, box[3]]
            confidence = 0.4
        page_width, page_height = geom.view_size(page)
        spot_box = [max(0.0, spot_box[0]), max(0.0, spot_box[1]), min(page_width, spot_box[2]), min(page_height, spot_box[3])]
        if any(geom.intersection(spot_box, c) > 0.3 * geom.area(spot_box) for c in covered):
            continue  # a form field is there: it is listed from the field
        if sum(geom.intersection(spot_box, w["box"]) for w in words) > 0.3 * geom.area(spot_box):
            continue  # already filled in
        label = text_layer.label(spot_box) or text
        out.append({"role": role, "page": number, "box": geom.rounded(spot_box), "label": label, "source": "layout", "confidence": confidence})
    kept = []
    for spot in out:
        if not any(geom.iou(spot["box"], other["box"]) > 0.8 for other in kept):
            kept.append(spot)
    return kept


def _phrases(words):
    """Runs of up to 4 adjacent words of one line («(Ф. И. О.)», «М. П.», «Подпись заявителя:»)."""
    rows = []
    for word in sorted(words, key=lambda w: ((w["box"][1] + w["box"][3]) / 2, w["box"][0])):
        middle = (word["box"][1] + word["box"][3]) / 2
        if rows and abs(rows[-1][0] - middle) < 3:
            rows[-1][1].append(word)
        else:
            rows.append([middle, [word]])
    phrases = []
    for _, row in rows:
        row.sort(key=lambda w: w["box"][0])
        run = []
        for word in row:
            if run and (word["box"][0] - run[-1]["box"][2] > 6 or len(run) == 4):
                phrases.append(run)
                run = []
            run.append(word)
        if run:
            phrases.append(run)
    return [
        {
            "t": " ".join(w["t"] for w in run),
            "box": [min(w["box"][0] for w in run), min(w["box"][1] for w in run), max(w["box"][2] for w in run), max(w["box"][3] for w in run)],
        }
        for run in phrases
    ]


def _near(box, other):
    """Same line, or within 40 pt above or below."""
    same_line = abs((box[1] + box[3]) / 2 - (other[1] + other[3]) / 2) < 8
    return same_line or 0 <= box[1] - other[3] <= 40 or 0 <= other[1] - box[3] <= 40


def _blank_for(box, blanks, caption):
    x0, y0, x1, y1 = box
    best, best_distance = None, None
    for blank in blanks:
        bx0, by0, bx1, by1 = blank["box"]
        if blank["kind"] == "checkbox" or blank.get("filled"):
            continue
        if caption:
            # «(подпись)» sits under its line: the blank right above it, across its centre.
            centre = (x0 + x1) / 2
            if not (bx0 - 4 <= centre <= bx1 + 4 and 0 <= y0 - by1 <= 20):
                continue
            distance = y0 - by1
        else:
            same_line = abs((by0 + by1) / 2 - (y0 + y1) / 2) <= max(8.0, (y1 - y0)) and bx0 >= x1 - 2 and bx0 - x1 <= 120
            below = 0 <= by0 - y1 <= 40 and bx0 <= x1 and bx1 >= x0
            if not (same_line or below):
                continue
            distance = (bx0 - x1) if same_line else 50 + by0 - y1
        if best_distance is None or distance < best_distance:
            best, best_distance = blank, distance
    return best
