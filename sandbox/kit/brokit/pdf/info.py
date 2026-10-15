"""`pdf info` (what a PDF is: pages, encryption, form fields, signature fields, scans) and `pdf text`.

Field boxes are view pt (brokit/pdf/geom.py). Field entries leave out empty keys (no
`options` on a text field, no `readonly: false`) to keep the line short.
"""

from brokit import labels
from brokit.pdf import crypt, form, geom
from brokit.util import KitError, limits, out_path, parse_pages, parser, run

TEXT_LIMIT = 20000
SCAN_CHARS = 20


def page_texts(path, password=None, first=None, last=None, layout=False):
    """The text layer per page (pdftotext), as a list for pages first..last."""
    command = ["pdftotext", "-cropbox", "-enc", "UTF-8"]
    if layout:
        command.append("-layout")
    if password:
        command += ["-upw", password]
    if first:
        command += ["-f", str(first), "-l", str(last or first)]
    result = run(command + [path, "-"], timeout=60)
    if result.returncode != 0:
        return []
    pages = result.stdout.decode("utf-8", "replace").split("\f")
    return pages[:-1] if pages and not pages[-1].strip() else pages


def has_images(page):
    """True when the page paints a raster image (directly or one form deep)."""
    resources = page.get("/Resources")
    stack = [(resources, 0)]
    while stack:
        current, depth = stack.pop()
        if current is None:
            continue
        xobjects = current.get_object().get("/XObject")
        if xobjects is None:
            continue
        for entry in xobjects.get_object().values():
            target = entry.get_object()
            subtype = target.get("/Subtype")
            if subtype == "/Image":
                return True
            if subtype == "/Form" and depth < 2:
                stack.append((target.get("/Resources"), depth + 1))
    return False


def scan_pages(reader, texts, numbers):
    def chars(number):
        return len("".join((texts[number - 1] if number - 1 < len(texts) else "").split()))

    return [n for n in numbers if chars(n) < SCAN_CHARS and has_images(reader.pages[n - 1])]


def compact_ranges(numbers):
    """[1, 2, 3, 5] → "1-3,5"."""
    parts, start, previous = [], None, None
    for number in numbers:
        if start is None:
            start = previous = number
        elif number == previous + 1:
            previous = number
        else:
            parts.append(str(start) if start == previous else "%d-%d" % (start, previous))
            start = previous = number
    if start is not None:
        parts.append(str(start) if start == previous else "%d-%d" % (start, previous))
    return ",".join(parts)


def page_sizes(reader):
    groups = []
    for number, page in enumerate(reader.pages, start=1):
        width, height = (round(v, 1) for v in geom.view_size(page))
        key = (width, height, geom.rotation(page))
        if groups and groups[-1][0] == key and groups[-1][2] == number - 1:
            groups[-1][2] = number
        else:
            groups.append([key, number, number])
    return [
        {"pages": str(first) if first == last else "%d-%d" % (first, last), "width": key[0], "height": key[1], "rotate": key[2]}
        for key, first, last in groups
    ]


def form_kind(reader):
    acro = form.acroform(reader)
    has_fields = bool(acro is not None and acro.get("/Fields") and len(acro["/Fields"].get_object()))
    has_xfa = acro is not None and "/XFA" in acro
    if has_xfa:
        return "hybrid" if has_fields else "xfa"
    return "acroform" if has_fields else "none"


def field_entries(reader, found, page_words):
    from brokit.pdf.sign import MARK_RE

    entries, signatures = [], []
    for name, record in found.items():
        field, field_kind = record["field"], record["kind"]
        index, page, _, widget = record["widgets"][0]
        box = geom.user_to_view(page, geom.rect(widget.get("/Rect", [0, 0, 0, 0])))
        if field_kind == "signature":
            signatures.append(
                {"name": name, "page": index + 1, "box": geom.rounded(box), "signed": form.inherited(field, "/V") is not None}
            )
        field_flags = form.flags(field)
        entry = {"name": name, "type": field_kind, "page": index + 1, "box": geom.rounded(box), "value": form.value_of(field)}
        optional = {
            "required": bool(field_flags & form.FF_REQUIRED),
            "readonly": bool(field_flags & form.FF_READONLY),
            "multiline": field_kind == "text" and bool(field_flags & form.FF_MULTILINE),
            "comb": field_kind == "text" and bool(field_flags & form.FF_COMB),
            "maxlen": int(form.inherited(field, "/MaxLen")) if form.inherited(field, "/MaxLen") is not None else None,
            "options": [display for _, display in form.options(field)] if field_kind == "choice" else None,
            "states": sorted({s for *_, w in record["widgets"] for s in form.on_states(w)}) if field_kind in ("checkbox", "radio") else None,
            "tooltip": str(field.get("/TU", "")) or None,
            "label": labels.label_for(page_words.get(index + 1, []), box) or None,
            "hidden": form.hidden(widget) or None,
            "bro_mark": bool(MARK_RE.match(form.raw_name(field))) or None,
        }
        entry.update({key: value for key, value in optional.items() if value})
        if field_kind == "radio" and len(record["widgets"]) > 1:
            entry["widgets"] = [
                {
                    "state": (form.on_states(w) or ["?"])[0],
                    "page": i + 1,
                    "box": geom.rounded(geom.user_to_view(p, geom.rect(w.get("/Rect", [0, 0, 0, 0])))),
                }
                for i, p, _, w in record["widgets"]
            ]
        entries.append(entry)
    return entries, signatures


def main(argv):
    args = parser("pdf info")
    args.add_argument("file")
    args.add_argument("--password")
    options = args.parse_args(argv)
    limits()
    warnings = []
    reader = crypt.open_pdf(options.file, warnings=warnings, decrypt=False, max_pages=500)
    method = crypt.algorithm(reader)
    if reader.is_encrypted:
        opened = reader.decrypt(options.password) if options.password else 0
        if not opened and reader.decrypt(""):
            opened = 1
            warnings.append("encrypted_empty_password: opens without a password; outputs are not encrypted")
        if not opened:
            if options.password:
                raise KitError("bad_password", "the password does not open this PDF", "check it with the person")
            try:
                count = len(reader.pages)
            except Exception:  # noqa: BLE001 — an encrypted page tree may not be countable
                count = None
            return {
                "pages": count,
                "encrypted": True,
                "needs_password": True,
                "algorithm": method,
                "warnings": warnings + ["needs_password: ask the person for the password, then brokit pdf decrypt"],
            }
    return describe(options.file, reader, method, options.password, warnings)


def describe(path, reader, method, password, warnings):
    from brokit.pdf.sign import MARK_RE, mark_token

    try:
        count = len(reader.pages)
        found = form.fields(reader)
        metadata = reader.metadata or {}
        title = str(metadata.get("/Title") or "") or None
    except crypt.PDF_ERRORS as error:
        raise crypt.unreadable(error)
    texts = page_texts(path, password=password)
    numbers = list(range(1, count + 1))
    scans = scan_pages(reader, texts, numbers)
    text_pages = [n for n in numbers if n - 1 < len(texts) and len("".join(texts[n - 1].split())) >= SCAN_CHARS]
    widget_pages = sorted({record["widgets"][0][0] + 1 for record in found.values()})
    page_words = {}
    if widget_pages and not password:
        layout = labels.page_layout(path, widget_pages[0], widget_pages[-1])
        page_words = {number: labels.text_words(lines) for number, lines in layout.items()}
    entries, signatures = field_entries(reader, found, page_words)
    token = mark_token(None)
    foreign = [
        name
        for name, record in found.items()
        if MARK_RE.match(form.raw_name(record["field"]))
        and (token is None or str(record["widgets"][0][3].get("/BroMark", "")) != token)
    ]
    return {
        "pages": count,
        "sizes": page_sizes(reader),
        "encrypted": bool(method),
        "needs_password": False,
        "algorithm": method,
        "form": form_kind(reader),
        "fields": entries,
        "signature_fields": signatures,
        "foreign_marks": foreign,
        "text_pages": compact_ranges(text_pages),
        "scan_pages": compact_ranges(scans),
        "title": title,
        "warnings": warnings,
    }


def text(argv):
    args = parser("pdf text")
    args.add_argument("file")
    args.add_argument("--pages")
    args.add_argument("--layout", action="store_true")
    args.add_argument("-o", "--output")
    options = args.parse_args(argv)
    warnings = []
    reader = crypt.open_pdf(options.file, warnings=warnings)
    numbers = parse_pages(options.pages, len(reader.pages))
    first, last = min(numbers), max(numbers)
    texts = page_texts(options.file, first=first, last=last, layout=options.layout)
    chosen = [(n, texts[n - first] if n - first < len(texts) else "") for n in numbers]
    whole = "\f".join(page for _, page in chosen)
    result = {
        "pages": compact_ranges(numbers),
        "chars_per_page": [len(page.strip()) for _, page in chosen],
        "scan_pages": compact_ranges(
            [n for n, page in chosen if len("".join(page.split())) < SCAN_CHARS and has_images(reader.pages[n - 1])]
        ),
        "warnings": warnings,
    }
    if options.output:
        output = out_path(options.output, options.file)
        with open(output, "w", encoding="utf-8") as handle:
            handle.write(whole)
        result["output"] = output
    result["text"] = whole[:TEXT_LIMIT]
    result["truncated"] = len(whole) > TEXT_LIMIT
    if result["truncated"] and not options.output:
        result["hint"] = "the text is longer than %d chars: add -o FILE.txt and read it in parts" % TEXT_LIMIT
    return result
