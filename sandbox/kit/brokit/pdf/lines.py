"""`pdf lines` and `pdf retext`: translate a PDF in place, keeping its look (W2 spec §6.6).

`lines` lists every printed line (pdftotext -bbox-layout) with an id "p<N>l<k>", its box in
view pt, an approximate size, bold/serif (from the fonts pypdf sees on that baseline, best
effort) and its alignment in the page's text column. `retext` removes all text from the PDF
(images, rules, stamps and signatures stay), then draws every line again — the mapped ones
with their translation, the rest with their own text — in DejaVu Sans/Serif, fitted to the
old box with the old alignment, and reports ids that still hold Cyrillic.
"""

import re

from brokit import labels
from brokit.pdf import crypt, geom
from brokit.util import KitError, out_path, parse_pages, parser, read_json

CYRILLIC = re.compile(r"[А-Яа-яЁё]")


def _font_runs(page):
    """[(view y of the baseline, view x, font name)] of text pieces pypdf sees on the page."""
    runs = []

    def visitor(text, cm, tm, font, _size):
        if not text.strip() or font is None:
            return
        x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
        y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
        view = geom.user_to_view(page, [x, y, x, y])
        runs.append((view[1], view[0], str(font.get("/BaseFont", ""))))

    try:
        page.extract_text(visitor_text=visitor)
    except crypt.PDF_ERRORS:
        return []
    return runs


def _style(line, runs):
    x0, y0, x1, y1 = line["box"]
    baseline = y1 - 0.21 * (y1 - y0)
    names = [name for y, x, name in runs if abs(y - baseline) <= 2.5 and x0 - 2 <= x <= x1 + 2]
    bold = sum(1 for n in names if re.search(r"Bold|Black|Heavy|Semibold|Demi", n)) > len(names) / 2 if names else False
    serifs = sum(1 for n in names if re.search(r"Times|Serif|Georgia|Cambria|Garamond|Roman", n) and "Sans" not in n)
    serif = serifs > len(names) / 2 if names else False
    return bold, serif


def page_lines(path, reader, numbers):
    """{page: [line]} with id, text, box, size, bold, serif, align."""
    layout = labels.page_layout(path, min(numbers), max(numbers)) if numbers else {}
    out = {}
    for number in numbers:
        page = reader.pages[number - 1]
        lines = layout.get(number, [])
        runs = _font_runs(page) if lines else []
        if lines:
            left = min(l["box"][0] for l in lines)
            right = max(l["box"][2] for l in lines)
        middles = ((left + right) / 2, geom.view_size(page)[0] / 2) if lines else ()
        result = []
        for index, line in enumerate(lines, start=1):
            x0, y0, x1, y1 = line["box"]
            text = " ".join(w["t"] for w in line["words"])
            centre = (x0 + x1) / 2
            if any(abs(centre - middle) <= 3 for middle in middles) and x0 > left + 3 and x1 < right - 3:
                align = "center"
            elif abs(x1 - right) <= 3 and x0 > left + 20:
                align = "right"
            else:
                align = "left"
            bold, serif = _style(line, runs)
            result.append(
                {
                    "id": "p%dl%d" % (number, index),
                    "text": text,
                    "box": geom.rounded(line["box"]),
                    "size": round(0.78 * (y1 - y0), 1),
                    "bold": bold,
                    "serif": serif,
                    "align": align,
                }
            )
        out[number] = result
    return out


def lines(argv):
    args = parser("pdf lines")
    args.add_argument("file")
    args.add_argument("--pages")
    options = args.parse_args(argv)
    warnings = []
    reader = crypt.open_pdf(options.file, warnings=warnings)
    numbers = parse_pages(options.pages, len(reader.pages))
    found = page_lines(options.file, reader, numbers)
    pages = [{"page": n, "lines": found[n]} for n in numbers]
    empty = [n for n in numbers if not found[n]]
    if empty:
        warnings.append("no_text_layer: pages %s are scans — read them with look" % ",".join(str(n) for n in empty))
    return {"pages": pages, "warnings": warnings}


def _count_images(writer):
    seen = set()
    for page in writer.pages:
        resources = page.get("/Resources")
        stack = [resources]
        while stack:
            current = stack.pop()
            if current is None:
                continue
            xobjects = current.get_object().get("/XObject")
            if xobjects is None:
                continue
            for entry in xobjects.get_object().values():
                target = entry.get_object()
                key = entry.idnum if hasattr(entry, "idnum") else id(target)
                if target.get("/Subtype") == "/Image":
                    seen.add(key)
                elif target.get("/Subtype") == "/Form" and key not in seen:
                    seen.add(("form", key))
                    stack.append(target.get("/Resources"))
    return sum(1 for key in seen if not isinstance(key, tuple))


def retext(argv):
    args = parser("pdf retext")
    args.add_argument("file")
    args.add_argument("map")
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    output = out_path(options.output, options.file, options.map)
    mapping = read_json(options.map)
    if not isinstance(mapping, dict) or not all(isinstance(v, str) for v in mapping.values()):
        raise KitError("bad_json", "MAP.json must be {\"p1l3\": \"translation\"}", "ids from brokit pdf lines")
    warnings = []
    reader = crypt.open_pdf(options.file, warnings=warnings)
    numbers = list(range(1, len(reader.pages) + 1))
    found = page_lines(options.file, reader, numbers)
    known = {line["id"] for page in found.values() for line in page}
    unknown = sorted(set(mapping) - known)
    if not known:
        raise KitError("no_text", "the PDF has no text layer", "scans: read with look, then write a new document")
    writer = crypt.writer_from(reader)
    before = _count_images(writer)
    writer.remove_text()
    drawn, kept, untranslated, overflow = _redraw(writer, found, mapping)
    crypt.write_pdf(writer, output)
    return {
        "output": output,
        "drawn": drawn,
        "kept_original": kept,
        "untranslated": untranslated,
        "overflow": overflow,
        "unknown": unknown,
        "images_before": before,
        "images_after": _count_images(writer),
        "warnings": warnings,
    }


def _redraw(writer, found, mapping):
    import io

    from pypdf import PdfReader, Transformation
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfgen import canvas as rl_canvas

    buffer = io.BytesIO()
    canvas = rl_canvas.Canvas(buffer, invariant=1)
    numbers = [n for n in sorted(found) if found[n]]
    drawn, kept, untranslated, overflow = 0, [], [], []
    for number in numbers:
        page = writer.pages[number - 1]
        width, height = geom.view_size(page)
        canvas.setPageSize((width, height))
        for line in found[number]:
            text = mapping.get(line["id"], line["text"])
            if line["id"] not in mapping:
                kept.append(line["id"])
            if CYRILLIC.search(text):
                untranslated.append(line["id"])
            if not text.strip():
                continue
            family = "BroSerif" if line["serif"] else "BroSans"
            font_name = geom.font(family + ("-Bold" if line["bold"] else ""))
            x0, y0, x1, y1 = line["box"]
            size = max(line["size"], 4.0)
            room = x1 - x0 if line["align"] != "left" or text == line["text"] else max(x1 - x0, width - x0 - 36)
            while size > 4 and pdfmetrics.stringWidth(text, font_name, size) > room:
                size -= 0.25
            if pdfmetrics.stringWidth(text, font_name, size) > room + 0.5:
                overflow.append(line["id"])
            canvas.setFont(font_name, size)
            canvas.setFillColorRGB(0, 0, 0)
            baseline = height - (y1 - 0.21 * (y1 - y0))
            if line["align"] == "center":
                canvas.drawCentredString((x0 + x1) / 2, baseline, text)
            elif line["align"] == "right":
                canvas.drawRightString(x1, baseline, text)
            else:
                canvas.drawString(x0, baseline, text)
            drawn += 1
        canvas.showPage()
    canvas.save()
    if numbers:
        overlay = PdfReader(io.BytesIO(buffer.getvalue()))
        for index, number in enumerate(numbers):
            page = writer.pages[number - 1]
            page.merge_transformed_page(overlay.pages[index], Transformation(geom.visual_matrix(page)))
    return drawn, kept, untranslated, overflow
