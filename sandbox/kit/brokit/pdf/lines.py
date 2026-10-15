"""`pdf lines` and `pdf retext`: translate a PDF in place, keeping its look (W2 spec §6.6).

`lines` lists every printed line (pdftotext -bbox-layout) with an id "p<N>l<k>", its box in
view pt, its size, bold/serif (from the text pypdf sees on that baseline, best effort) and its
alignment in the page's text column. `retext` removes all text from the PDF (images, rules,
stamps and signatures stay), then draws every line again — the mapped ones with their
translation, the rest with their own text — in DejaVu Sans/Serif at the old size and colour,
fitted to the old box with the old alignment, and reports ids that still hold Cyrillic.
"""

import collections
import math
import re

from brokit import labels
from brokit.pdf import crypt, geom
from brokit.util import KitError, out_path, parse_pages, parser, read_json

CYRILLIC = re.compile(r"[А-Яа-яЁё]")


BLACK = (0.0, 0.0, 0.0)
SQUEEZE = 0.8


def _fill_colour(operator, args):
    """RGB of a non-stroking colour operator (g, rg, k; sc/scn by their count of numbers), else None."""
    values = [min(1.0, max(0.0, float(a))) for a in args if isinstance(a, (int, float))]
    if operator == b"g" or (operator in (b"sc", b"scn") and len(values) == 1):
        return (values[0],) * 3 if values else None
    if operator == b"rg" or (operator in (b"sc", b"scn") and len(values) == 3):
        return tuple(values) if len(values) == 3 else None
    if operator == b"k" or (operator in (b"sc", b"scn") and len(values) == 4):
        if len(values) != 4:
            return None
        c, m, y, k = values
        return ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    return None


def _font_runs(page):
    """[(view y of the baseline, view x, font name, size in pt, fill RGB)] of text pieces pypdf sees on the page."""
    runs = []
    colour, saved = [BLACK], []

    def before(operator, args, _cm, _tm):
        if operator == b"q":
            saved.append(colour[0])
        elif operator == b"Q" and saved:
            colour[0] = saved.pop()
        elif operator in (b"g", b"rg", b"k", b"sc", b"scn"):
            colour[0] = _fill_colour(operator, args) or colour[0]

    def visitor(text, cm, tm, font, size):
        if not text.strip() or font is None:
            return
        x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
        y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
        view = geom.user_to_view(page, [x, y, x, y])
        # The size as printed: Tf scaled by the text and the graphics matrices (a «1 Tf» run of Word).
        printed = float(size or 0) * math.hypot(tm[0], tm[1]) * math.hypot(cm[0], cm[1])
        runs.append((view[1], view[0], str(font.get("/BaseFont", "")), printed, colour[0]))

    try:
        page.extract_text(visitor_text=visitor, visitor_operand_before=before)
    except crypt.pdf_errors():
        return []
    return runs


def _style(line, runs):
    """(bold, serif, size, colour) of a line from the runs on its baseline; size ≈ the box's height without them."""
    x0, y0, x1, y1 = line["box"]
    baseline = y1 - 0.21 * (y1 - y0)
    found = [run for run in runs if abs(run[0] - baseline) <= 2.5 and x0 - 2 <= run[1] <= x1 + 2]
    names = [run[2] for run in found]
    bold = sum(1 for n in names if re.search(r"Bold|Black|Heavy|Semibold|Demi", n)) > len(names) / 2 if names else False
    serifs = sum(1 for n in names if re.search(r"Times|Serif|Georgia|Cambria|Garamond|Roman", n) and "Sans" not in n)
    serif = serifs > len(names) / 2 if names else False
    sizes = sorted(run[3] for run in found if run[3] > 0)
    size = sizes[len(sizes) // 2] if sizes else y1 - y0
    colour = collections.Counter(run[4] for run in found).most_common(1)[0][0] if found else BLACK
    return bold, serif, size, colour


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
            bold, serif, size, colour = _style(line, runs)
            result.append(
                {
                    "id": "p%dl%d" % (number, index),
                    "text": text,
                    "box": geom.rounded(line["box"]),
                    "size": round(size, 1),
                    "bold": bold,
                    "serif": serif,
                    "align": align,
                    "colour": colour,
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
    # The colour is retext's to keep, not the translator's to read.
    pages = [{"page": n, "lines": [{k: v for k, v in line.items() if k != "colour"} for line in found[n]]} for n in numbers]
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
            current = current.get_object() if current is not None else None
            xobjects = current.get("/XObject") if isinstance(current, dict) else None
            xobjects = xobjects.get_object() if xobjects is not None else None
            if not isinstance(xobjects, dict):
                continue
            for entry in xobjects.values():
                target = entry.get_object()
                if not isinstance(target, dict):
                    continue
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
    with crypt.parsing():
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
            # DejaVu runs wider than most document fonts: first narrower letters (down to 80 %), then smaller ones.
            squeeze = max(SQUEEZE, min(1.0, room / max(pdfmetrics.stringWidth(text, font_name, size), 0.01)))
            while size > 4 and pdfmetrics.stringWidth(text, font_name, size) * squeeze > room:
                size -= 0.25
            wide = pdfmetrics.stringWidth(text, font_name, size) * squeeze
            if wide > room + 0.5:
                overflow.append(line["id"])
            canvas.setFillColorRGB(*line["colour"])
            baseline = height - (y1 - 0.21 * (y1 - y0))
            start = {"center": (x0 + x1 - wide) / 2, "right": x1 - wide}.get(line["align"], x0)
            writing = canvas.beginText(start, baseline)
            writing.setFont(font_name, size)
            writing.setHorizScale(squeeze * 100)
            writing.textOut(text)
            canvas.drawText(writing)
            drawn += 1
        canvas.showPage()
    canvas.save()
    if numbers:
        overlay = PdfReader(io.BytesIO(buffer.getvalue()))
        for index, number in enumerate(numbers):
            page = writer.pages[number - 1]
            page.merge_transformed_page(overlay.pages[index], Transformation(geom.visual_matrix(page)))
    return drawn, kept, untranslated, overflow
