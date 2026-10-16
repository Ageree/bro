"""`pdf write`: text, check marks and pictures onto a flat form, all pages of one file in one call (W2 spec §6.5).

SPEC.json is a list of items, each with "page" and "box" (view pt) or "at" (a blank id of
`pdf layout` of the same file — box, angle and rule come from its cache; the output keeps those
ids, its written blanks marked "filled"):
  {"at": "p1b3", "text": "…", "size": "auto" | 11, "align": "left|center|right", "comb": 12,
   "dashes": true, "font": "sans|serif|mono", "color": "#000", "angle": deg}
  {"page": 1, "box": [...], "check": true}
  {"page": 1, "box": [...], "image": "/workspace/x.png", "fit": "contain"}
Text on a rule sits 1.5 pt above it and follows the rule's angle (a skewed scan); in a box it
is centred vertically. Everything one page gets is drawn on one overlay, merged once.

Cells (a comb) take a character each from the first; "dashes" fills the cells left over with «-»
(the tax-form rule). A comb blank of `at` gets its cell count from the layout. A row the form
splits into cell groups at a printed «.» (roubles.kopecks, ДД.ММ.ГГГГ) is written whole at its
first group: "180000.00" puts 180000 into the roubles and 00 into the kopecks; a "comb" equal to
the whole row's cells spreads the text over its groups in turn. One item per cell group — two
would draw over each other. An item of such a row says what each group got ("groups").
"""

import math
import os
import re

from brokit.pdf import crypt, geom
from brokit.util import KitError, out_path, parser, read_json

FONTS = {"sans": "BroSans", "serif": "BroSerif", "mono": "BroMono"}
ALIGN = ("left", "center", "right")
SEPARATOR = re.compile(r"[.,]")
NUMERIC_PART = re.compile(r"[0-9\-   ]*")
SPACES = re.compile(r"[   ]")
ONE_PER_GROUP = 'one item per cell group: a value with kopecks or a date goes whole to its first group ("180000.00"); empty cells — "dashes": true'


def _number(value, name):
    try:
        return float(value)
    except (TypeError, ValueError):
        raise KitError("bad_spec", "%s must be a number" % name)


def _row_groups(path, number, blank):
    """The comb `blank` and the comb groups its row goes on in: same height, cells as wide, a cell apart at most."""
    from brokit.pdf import layout

    combs = [b for b in layout.page_blanks(path, number) if b.get("kind") == "comb" and b.get("cells") and not b.get("filled")]
    groups = [blank]
    while True:
        x0, y0, x1, y1 = groups[-1]["box"]
        cell = (x1 - x0) / groups[-1]["cells"]
        following = next(
            (
                b
                for b in combs
                if b["id"] not in {g["id"] for g in groups}
                and abs(b["box"][1] - y0) <= 2
                and abs(b["box"][3] - y1) <= 2
                and -1 <= b["box"][0] - x1 <= cell
                and abs((b["box"][2] - b["box"][0]) / b["cells"] - cell) <= 0.25 * cell
            ),
            None,
        )
        if following is None:
            return groups
        groups.append(following)


def _row_parts(item, groups, n):
    """The text of a comb item cut into its row's cell groups, or None when it stays in the first group."""
    text = str(item.get("text", ""))
    cells = [g["cells"] for g in groups]
    parts = SEPARATOR.split(text) if SEPARATOR.search(text) else None
    if parts and all(NUMERIC_PART.fullmatch(p) for p in parts) and len(groups) > 1:
        if len(parts) > len(groups):
            raise KitError(
                "bad_spec",
                "item %d: %r has %d parts, the row %s has %d cell groups" % (n, text, len(parts), groups[0]["id"], len(groups)),
                'digits without thousand separators, one «.» per printed dot: "180000.00", "16.10.2026"',
            )
        return [SPACES.sub("", p) for p in parts]
    if "comb" not in item:
        return None
    wanted = int(_number(item["comb"], "comb"))
    if wanted == cells[0]:
        return None
    totals = [sum(cells[: k + 1]) for k in range(len(cells))]
    if wanted not in totals[1:]:
        row = " + ".join("%s %d" % (g["id"], g["cells"]) for g in groups)
        raise KitError(
            "bad_spec",
            "item %d: comb %d, but %s has %d cells (the row: %s)" % (n, wanted, groups[0]["id"], cells[0], row),
            'leave "comb" out: "at" brings the cells; the picture shows other cells — "page", "box" and "comb" instead of "at"',
        )
    span = totals.index(wanted) + 1
    starts = [0] + totals[: span - 1]
    return [text[start : starts[k + 1]] if k + 1 < span else text[start:] for k, start in enumerate(starts)]


def _resolve(path, reader, item, n):
    """Pieces (page number, view box, angle, rule endpoints or None, item, blank id) of one spec item.

    One piece, except an item at a comb that the row's cell groups share (see the module docstring).
    """
    if "at" in item:
        from brokit.pdf import layout

        number, box, blank = layout.blank_by_id(path, str(item["at"]))
        line = blank.get("line") if blank.get("kind") in ("line", "underscores") else None
        angle = float(item["angle"]) if "angle" in item else float(blank.get("angle") or 0)
        if not blank.get("cells"):
            return [(number, geom.rect(box), angle, line, item, blank["id"])]
        groups = _row_groups(path, number, blank)
        parts = _row_parts(item, groups, n)
        if parts is None:
            return [(number, geom.rect(box), angle, line, dict(item, comb=blank["cells"]), blank["id"])]
        return [
            (number, geom.rect(group["box"]), angle, None, dict(item, text=part, comb=group["cells"]), group["id"])
            for group, part in zip(groups, parts)
        ]
    try:
        number = int(item.get("page"))
    except (TypeError, ValueError):
        raise KitError("bad_spec", "item %d needs page and box, or at" % n, "ids from brokit pdf layout")
    if not 1 <= number <= len(reader.pages):
        raise KitError("bad_spec", "item %d: page %d is outside 1-%d" % (n, number, len(reader.pages)))
    box = item.get("box")
    if not isinstance(box, list) or len(box) != 4:
        raise KitError("bad_spec", "item %d: box must be [x0, y0, x1, y1] in view pt" % n)
    box = geom.rect([_number(v, "box") for v in box])
    width, height = geom.view_size(reader.pages[number - 1])
    if box[2] - box[0] < 1 or box[3] - box[1] < 1 or box[0] < -2 or box[1] < -2 or box[2] > width + 2 or box[3] > height + 2:
        raise KitError("bad_spec", "item %d: box %s is empty or outside the page (%.0f × %.0f pt)" % (n, box, width, height))
    return [(number, box, _number(item.get("angle", 0), "angle"), None, item, None)]


def _lines(text, font_name, size, width, wrap):
    from reportlab.pdfbase import pdfmetrics

    out = []
    for paragraph in text.split("\n"):
        if not wrap:
            out.append(paragraph)
            continue
        line = ""
        for word in paragraph.split(" "):
            candidate = (line + " " + word) if line else word
            if not line or pdfmetrics.stringWidth(candidate, font_name, size) <= width:
                line = candidate
            else:
                out.append(line)
                line = word
        out.append(line)
    return out


def plan_text(item, box, font_name, on_rule):
    """Size, lines and status of a text item in its box."""
    from reportlab.pdfbase import pdfmetrics

    text = str(item.get("text", ""))
    width, height = box[2] - box[0], box[3] - box[1]
    wanted = item.get("size", "auto")
    if wanted not in (None, "auto"):
        wanted = _number(wanted, "size")
        if not 2 <= wanted <= 200:
            raise KitError("bad_spec", "size must be 2-200 pt or \"auto\"")
    if item.get("comb"):
        cells = int(_number(item["comb"], "comb"))
        if cells < 1:
            raise KitError("bad_spec", "comb must be ≥ 1")
        if item.get("dashes"):
            text += "-" * (cells - len(text))
        size = wanted if wanted not in (None, "auto") else min(12.0, (height - 3) / 1.2, width / cells * 1.3)
        status = "ok" if len(text) <= cells else "overflow"
        return {"size": size, "lines": [text[:cells]], "comb": cells, "status": status}
    base = wanted if wanted not in (None, "auto") else min(12.0, max(6.0, (min(height, 22.0) - 3) / 1.2))
    multiline = "\n" in text or (not on_rule and height >= 2.4 * base)
    size = base
    while True:
        lines = _lines(text, font_name, size, width, multiline)
        widest = max(pdfmetrics.stringWidth(line, font_name, size) for line in lines)
        tall = len(lines) * size * 1.15 if len(lines) > 1 else size
        if (widest <= width and tall <= max(height, size)) or size <= 6:
            break
        size -= 0.5
    fits = widest <= width + 0.01 and (len(lines) == 1 or len(lines) * size * 1.15 <= height + 0.01)
    status = "overflow" if not fits else ("shrunk" if size < base else "ok")
    return {"size": size, "lines": lines, "status": status}


def main(argv):
    args = parser("pdf write")
    args.add_argument("file")
    args.add_argument("spec")
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    output = out_path(options.output, options.file, options.spec)
    spec = read_json(options.spec)
    if isinstance(spec, dict):
        spec = [spec]
    if not isinstance(spec, list) or not spec:
        raise KitError("bad_spec", "SPEC.json must be a list of items")
    warnings = []
    reader = crypt.open_pdf(options.file, warnings=warnings)
    placed, combs = [], {}
    for n, item in enumerate(spec, start=1):
        if not isinstance(item, dict):
            raise KitError("bad_spec", "item %d is not an object" % n)
        for number, box, angle, rule, piece, blank_id in _resolve(options.file, reader, item, n):
            if piece.get("comb") and blank_id:
                if blank_id in combs:
                    raise KitError("bad_spec", "items %d and %d both write the cells of %s" % (combs[blank_id], n, blank_id), ONE_PER_GROUP)
                combs[blank_id] = n
            if "image" in piece:
                image = str(piece["image"])
                if not os.path.isfile(image):
                    raise KitError("not_found", "item %d: no image %s" % (n, image))
            font_name = geom.font(FONTS.get(str(piece.get("font", "sans")), "BroSans"))
            align = str(piece.get("align", "left"))
            if align not in ALIGN:
                raise KitError("bad_spec", "align must be left, center or right")
            plan = None
            if not piece.get("check") and "image" not in piece:
                plan = plan_text(piece, box, font_name, rule is not None)
            placed.append(
                {"n": n, "at": blank_id, "page": number, "box": box, "angle": angle, "rule": rule, "item": piece, "font": font_name, "align": align, "plan": plan}
            )
    writer = crypt.writer_from(reader)
    with crypt.parsing():
        _draw(writer, placed)
    crypt.write_pdf(writer, output)
    from brokit.pdf import layout

    layout.carry(options.file, output, [(p["page"], p["box"]) for p in placed])
    items = []
    for n in range(1, len(spec) + 1):
        pieces = [p for p in placed if p["n"] == n]
        first, statuses = pieces[0], [p["plan"]["status"] if p["plan"] else "ok" for p in pieces]
        entry = {
            "n": n,
            "page": first["page"],
            "box": geom.rounded(first["box"]),
            "size": round(first["plan"]["size"], 1) if first["plan"] else None,
            "angle": round(first["angle"], 2),
            "status": next((s for s in ("overflow", "shrunk") if s in statuses), "ok"),
        }
        if len(pieces) > 1:
            entry["groups"] = {p["at"]: p["plan"]["lines"][0] for p in pieces}
        items.append(entry)
    problems = [i["n"] for i in items if i["status"] == "overflow"]
    result = {"output": output, "items": items, "warnings": warnings}
    if problems:
        result["hint"] = "items %s do not fit: shorten the text or give a bigger box" % ",".join(str(n) for n in problems)
    return result


def _draw(writer, placed):
    import io

    from pypdf import PdfReader, Transformation
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas as rl_canvas

    numbers = sorted({p["page"] for p in placed})
    buffer = io.BytesIO()
    canvas = rl_canvas.Canvas(buffer, invariant=1)
    for number in numbers:
        page = writer.pages[number - 1]
        width, height = geom.view_size(page)
        canvas.setPageSize((width, height))
        for item in (p for p in placed if p["page"] == number):
            x0, y0, x1, y1 = item["box"]
            spec = item["item"]
            canvas.saveState()
            canvas.setFillColorRGB(*geom.colour(spec.get("color")))
            canvas.setStrokeColorRGB(*geom.colour(spec.get("color")))
            bottom, box_w, box_h = height - y1, x1 - x0, y1 - y0
            if spec.get("check"):
                side = min(box_w, box_h)
                cx, cy = x0 + box_w / 2, bottom + box_h / 2
                canvas.setLineWidth(max(0.8, side * 0.12))
                path = canvas.beginPath()
                path.moveTo(cx - side * 0.32, cy)
                path.lineTo(cx - side * 0.08, cy - side * 0.28)
                path.lineTo(cx + side * 0.34, cy + side * 0.3)
                canvas.drawPath(path, stroke=1, fill=0)
            elif "image" in spec:
                image = ImageReader(str(spec["image"]))
                iw, ih = image.getSize()
                scale = min(box_w / iw, box_h / ih)
                w, h = iw * scale, ih * scale
                canvas.drawImage(image, x0 + (box_w - w) / 2, bottom + (box_h - h) / 2, w, h, mask="auto")
            else:
                plan = item["plan"]
                size = plan["size"]
                canvas.setFont(item["font"], size)
                if item["rule"]:
                    sx, sy = item["rule"][0], item["rule"][1]
                    canvas.translate(sx, height - sy)
                    canvas.rotate(item["angle"])
                    origin_y, inner_w = 1.5, math.hypot(item["rule"][2] - sx, item["rule"][3] - sy)
                    origin_x = 0.0
                else:
                    canvas.translate(x0, bottom)
                    if item["angle"]:
                        canvas.rotate(item["angle"])
                    inner_w = box_w
                    origin_x = 0.0
                    lines = len(plan["lines"])
                    block = size * 1.15 * (lines - 1) + size * 0.72
                    origin_y = (box_h + block) / 2 - size * 0.72
                if plan.get("comb"):
                    cell = inner_w / plan["comb"]
                    for index, char in enumerate(plan["lines"][0]):
                        canvas.drawCentredString(cell * (index + 0.5), origin_y, char)
                else:
                    for index, line in enumerate(plan["lines"]):
                        y = origin_y - index * size * 1.15
                        if item["align"] == "center":
                            canvas.drawCentredString(origin_x + inner_w / 2, y, line)
                        elif item["align"] == "right":
                            canvas.drawRightString(origin_x + inner_w - 1, y, line)
                        else:
                            canvas.drawString(origin_x + 1, y, line)
            canvas.restoreState()
        canvas.showPage()
    canvas.save()
    overlay = PdfReader(io.BytesIO(buffer.getvalue()))
    for index, number in enumerate(numbers):
        page = writer.pages[number - 1]
        page.merge_transformed_page(overlay.pages[index], Transformation(geom.visual_matrix(page)))
