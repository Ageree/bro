"""AcroForm model (widgets, field names, kinds) and `pdf fill` (W2 spec §6.2).

Appearances of every filled text or choice widget are drawn by reportlab in ONE document
(DejaVu, so Cyrillic shows; one embedded font) and become the widgets' /AP /N. Flattening
(the default) paints /N (or /N /<AS>) of each filled visible widget into the page as PDF
32000 §12.5.5 says, then drops those widgets and prunes /Fields. Signature fields and Bro's
sign marks (`bro_sign_*`, brokit/pdf/sign.py) are never filled or flattened: they are listed
under `kept`, and a value for one is refused as `reserved`.
"""

import re

from brokit.pdf import crypt, geom
from brokit.util import KitError, out_path, parser, read_json

FF_READONLY = 1
FF_REQUIRED = 1 << 1
FF_MULTILINE = 1 << 12
FF_RADIO = 1 << 15
FF_PUSH = 1 << 16
FF_COMBO = 1 << 17
FF_EDIT = 1 << 18
FF_COMB = 1 << 24
F_HIDDEN = 1 << 1
F_NOVIEW = 1 << 5

TRUE_WORDS = {"true", "yes", "on", "1", "x", "v", "✓", "✔", "да", "истина"}
FALSE_WORDS = {"false", "no", "off", "0", "", "нет", "ложь"}


def annotations(page):
    """The page's /Annots array, or [] when it is missing or not an array (a broken file)."""
    annots = page.get("/Annots")
    annots = annots.get_object() if annots is not None else None
    return annots if isinstance(annots, list) else []


def widgets(doc):
    """(page index, page, annotation entry, widget dict) for every widget in page /Annots."""
    for index, page in enumerate(doc.pages):
        for entry in annotations(page):
            widget = entry.get_object()
            if isinstance(widget, dict) and widget.get("/Subtype") == "/Widget":
                yield index, page, entry, widget


def parent(node):
    up = node.get("/Parent")
    return up.get_object() if up is not None else None


def inherited(node, key):
    for _ in range(32):
        if node is None:
            return None
        if key in node:
            return node[key]
        node = parent(node)
    return None


def terminal(widget):
    """The field a widget belongs to: itself when it carries /T, else its parent."""
    if "/T" in widget:
        return widget
    return parent(widget) or widget


def raw_name(field):
    return str(field.get("/T", ""))


def full_name(node):
    parts = []
    for _ in range(32):
        if node is None:
            break
        if "/T" in node:
            parts.append(str(node["/T"]))
        node = parent(node)
    return ".".join(reversed(parts))


def flags(field):
    try:
        return int(inherited(field, "/Ff") or 0)
    except (TypeError, ValueError):
        return 0


def kind(field):
    field_type, field_flags = inherited(field, "/FT"), flags(field)
    if field_type == "/Tx":
        return "text"
    if field_type == "/Btn":
        if field_flags & FF_PUSH:
            return "button"
        return "radio" if field_flags & FF_RADIO else "checkbox"
    if field_type == "/Ch":
        return "choice"
    if field_type == "/Sig":
        return "signature"
    return "unknown"


def on_states(widget):
    appearance = widget.get("/AP")
    normal = appearance.get_object().get("/N") if appearance is not None else None
    if normal is None or not hasattr(normal.get_object(), "keys") or "/BBox" in normal.get_object():
        return []
    return [str(key)[1:] for key in normal.get_object().keys() if key != "/Off"]


def hidden(widget):
    try:
        bits = int(widget.get("/F", 0) or 0)
    except (TypeError, ValueError):
        bits = 0
    box = geom.widget_rect(widget)
    return bool(bits & (F_HIDDEN | F_NOVIEW)) or geom.area(box) <= 0


def max_length(field):
    """/MaxLen as a positive int, or None (missing or broken)."""
    try:
        value = int(inherited(field, "/MaxLen"))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def options(field):
    """[(export value, display text)] of a choice field's /Opt."""
    listed = inherited(field, "/Opt")
    listed = listed.get_object() if listed is not None else None
    out = []
    for item in listed if isinstance(listed, list) else []:
        item = item.get_object()
        if isinstance(item, list) and len(item) >= 2:
            out.append((str(item[0].get_object()), str(item[1].get_object())))
        else:
            out.append((str(item), str(item)))
    return out


def value_of(field):
    value = inherited(field, "/V")
    if value is None:
        return None
    value = value.get_object()
    if isinstance(value, list):
        return [str(v) for v in value]
    text = str(value)
    return text[1:] if text.startswith("/") else text


def is_reserved(field):
    """Signature fields and Bro's sign scaffolding (`bro_sign_*`): never filled, flattened or removed by fill."""
    from brokit.pdf.sign import is_scaffold

    return kind(field) == "signature" or is_scaffold(field)


def fields(doc):
    """{full name: {"field", "kind", "widgets": [(page index, page, entry, widget)]}} in page order."""
    found = {}
    for index, page, entry, widget in widgets(doc):
        field = terminal(widget)
        name = full_name(field)
        record = found.setdefault(name, {"field": field, "kind": kind(field), "widgets": []})
        record["widgets"].append((index, page, entry, widget))
    return found


def acroform(writer_or_reader):
    root = writer_or_reader._root_object if hasattr(writer_or_reader, "_root_object") else writer_or_reader.trailer["/Root"]
    form = root.get_object().get("/AcroForm")
    form = form.get_object() if form is not None else None
    return form if isinstance(form, dict) else None


def field_list(form):
    """The AcroForm's /Fields array, or None when it is missing or not an array."""
    fields = form.get("/Fields") if form is not None else None
    fields = fields.get_object() if fields is not None else None
    return fields if isinstance(fields, list) else None


def tree_nodes(doc):
    """Every field dict reachable from the AcroForm's /Fields (also those with no widget on a page)."""
    stack = list(field_list(acroform(doc)) or [])
    seen = set()
    while stack:
        node = stack.pop().get_object()
        if not isinstance(node, dict) or id(node) in seen:
            continue
        seen.add(id(node))
        yield node
        kids = node.get("/Kids")
        kids = kids.get_object() if kids is not None else None
        if isinstance(kids, list):
            stack.extend(kids)


def prune_fields(array, dropped, drop=None, seen=None):
    """/Fields (or /Kids) without the nodes whose id() is in `dropped` or for which `drop(node)`
    is true (each with its subtree); a parent whose kids all went goes too. Cycles end."""
    from pypdf.generic import ArrayObject, NameObject

    seen = set() if seen is None else seen
    keep = ArrayObject()
    for entry in array:
        node = entry.get_object()
        if not isinstance(node, dict) or id(node) in dropped or id(node) in seen or (drop is not None and drop(node)):
            continue
        seen.add(id(node))
        kids = node.get("/Kids")
        kids = kids.get_object() if kids is not None else None
        if isinstance(kids, list) and len(kids):
            remaining = prune_fields(kids, dropped, drop, seen)
            if not remaining:
                continue
            node[NameObject("/Kids")] = remaining
        keep.append(entry)
    return keep


def _da(field):
    """(font size or 0, (r, g, b)) from /DA."""
    text = str(inherited(field, "/DA") or "")
    size = re.search(r"([\d.]+)\s+Tf", text)
    rgb = re.search(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg", text)
    gray = re.search(r"([\d.]+)\s+g(?:\s|$)", text)
    colour = (0.0, 0.0, 0.0)
    if rgb:
        colour = tuple(min(1.0, float(v)) for v in rgb.groups())
    elif gray:
        colour = (min(1.0, float(gray.group(1))),) * 3
    try:
        return (float(size.group(1)) if size else 0.0), colour
    except ValueError:
        return 0.0, colour


def _mk_colour(values):
    try:
        numbers = [float(v) for v in values.get_object()] if values is not None else []
    except (TypeError, ValueError):
        return None
    if len(numbers) == 1:
        return (numbers[0],) * 3
    if len(numbers) == 3:
        return tuple(numbers)
    if len(numbers) == 4:
        c, m, y, k = numbers
        return ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    return None


def _rotation(widget):
    characteristics = widget.get("/MK")
    try:
        angle = int(characteristics.get_object().get("/R", 0)) if characteristics is not None else 0
    except (TypeError, ValueError):
        angle = 0
    return (round(angle / 90) * 90) % 360


def _wrap(text, font_name, size, width):
    from reportlab.pdfbase import pdfmetrics

    lines = []
    for paragraph in text.split("\n"):
        line = ""
        for word in paragraph.split(" "):
            candidate = (line + " " + word).strip() if line else word
            if not line or pdfmetrics.stringWidth(candidate, font_name, size) <= width:
                line = candidate
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def layout_text(field, text, width, height):
    """How a text/choice value is drawn in a (width × height) box: a plan dict and a problem or None."""
    from reportlab.pdfbase import pdfmetrics

    font_name = geom.font("BroSans")
    da_size, colour = _da(field)
    field_flags = flags(field)
    try:
        alignment = int(inherited(field, "/Q") or 0)
    except (TypeError, ValueError):
        alignment = 0
    plan = {"font": font_name, "colour": colour, "align": alignment, "lines": [text], "size": da_size or 10.0}
    cells = max_length(field)
    if kind(field) == "text" and field_flags & FF_COMB and cells:
        if len(text) > cells and len(re.sub(r"\s+", "", text)) <= cells:
            text = re.sub(r"\s+", "", text)
        if len(text) > cells:
            return None, "overflow"
        plan.update(comb=cells, lines=[text], size=da_size or min(12.0, (height - 3) / 1.2, width / cells * 1.3))
        return plan, None
    if kind(field) == "text" and field_flags & FF_MULTILINE:
        size = da_size or min(11.0, max(6.0, height - 4))
        while True:
            lines = _wrap(text, font_name, size, width - 4)
            if len(lines) * size * 1.15 <= height - 2 or size <= 6:
                break
            size -= 0.5
        plan.update(lines=lines, size=size, multiline=True)
        widest = max(pdfmetrics.stringWidth(line, font_name, size) for line in lines)
        fits = len(lines) * size * 1.15 <= height - 2 + 0.01 and widest <= width - 4
        return plan, None if fits else "overflow"
    size, fits, _ = geom.fit_size(text, font_name, width - 4, height, size=da_size or None)
    plan.update(size=size)
    return plan, None if fits else "overflow"


def draw_appearance(canvas, plan, width, height, background, border, border_width):
    """Paints one widget appearance at (0, 0, width, height)."""
    if background:
        canvas.setFillColorRGB(*background)
        canvas.rect(0, 0, width, height, stroke=0, fill=1)
    if border and border_width > 0:
        canvas.setStrokeColorRGB(*border)
        canvas.setLineWidth(border_width)
        canvas.rect(border_width / 2, border_width / 2, width - border_width, height - border_width, stroke=1, fill=0)
    if plan is None:
        return
    canvas.setFillColorRGB(*plan["colour"])
    size = plan["size"]
    canvas.setFont(plan["font"], size)
    if plan.get("comb"):
        cell = width / plan["comb"]
        for index, char in enumerate(plan["lines"][0]):
            canvas.drawCentredString(cell * (index + 0.5), (height - size * 0.7) / 2, char)
        return
    if plan.get("multiline"):
        y = height - 2 - size * 0.9
        for line in plan["lines"]:
            canvas.drawString(2, y, line)
            y -= size * 1.15
        return
    text = plan["lines"][0]
    baseline = (height - size * 0.7) / 2
    if plan["align"] == 1:
        canvas.drawCentredString(width / 2, baseline, text)
    elif plan["align"] == 2:
        canvas.drawRightString(width - 2, baseline, text)
    else:
        canvas.drawString(2, baseline, text)


def _truthy(value):
    if value is True or value is False:
        return value
    text = str(value).strip().lower()
    if text in TRUE_WORDS:
        return True
    if text in FALSE_WORDS:
        return False
    return None


def _state_for(states, value):
    text = str(value).strip().lstrip("/")
    for state in states:
        if state == text:
            return state
    for state in states:
        if state.lower() == text.lower():
            return state
    return None


def _flatten_matrix(form, box):
    """cm placing an appearance form into the widget rect (PDF 32000 §12.5.5, algorithm 8.1)."""
    bbox = geom.rect(form.get("/BBox", [0, 0, 1, 1]))
    matrix = tuple(float(v) for v in form.get("/Matrix", [1, 0, 0, 1, 0, 0]))
    tx0, ty0, tx1, ty1 = geom.map_box(matrix, bbox)
    x0, y0, x1, y1 = box
    sx = (x1 - x0) / (tx1 - tx0) if tx1 > tx0 else 1.0
    sy = (y1 - y0) / (ty1 - ty0) if ty1 > ty0 else 1.0
    return (sx, 0, 0, sy, x0 - tx0 * sx, y0 - ty0 * sy)


def _normal_appearance(widget):
    appearance = widget.get("/AP")
    if appearance is None:
        return None
    normal = appearance.get_object().get("/N")
    if normal is None:
        return None
    target = normal.get_object()
    if "/BBox" not in target and hasattr(target, "keys"):
        state = widget.get("/AS")
        normal = target.get(state) if state is not None else None
        if normal is None:
            return None
        target = normal.get_object()
    return normal, target


def main(argv):
    args = parser("pdf fill")
    args.add_argument("file")
    args.add_argument("values")
    args.add_argument("-o", "--output", required=True)
    args.add_argument("--keep-fields", action="store_true")
    options_ = args.parse_args(argv)
    output = out_path(options_.output, options_.file, options_.values)
    values = read_json(options_.values)
    if not isinstance(values, dict):
        raise KitError("bad_json", "VALUES.json must be an object {\"field name\": value}", "names from brokit pdf info")
    warnings = []
    reader = crypt.open_pdf(options_.file, warnings=warnings)
    writer = crypt.writer_from(reader)
    with crypt.parsing():
        form = acroform(writer)
        found = fields(writer)
        if form is not None and "/XFA" in form:
            if not found:
                raise KitError("xfa", "an XFA-only form: no AcroForm fields to fill", "use brokit pdf layout, then brokit pdf write")
            del form["/XFA"]
            warnings.append("xfa_dropped: the form also had XFA; filled the AcroForm fields, viewers will show those")
        if form is None or not found:
            raise KitError("no_fields", "the PDF has no form fields", "use brokit pdf layout, then brokit pdf write")
        return fill(writer, form, found, values, output, options_.keep_fields, warnings)


def fill(writer, form, found, values, output, keep_fields, warnings):
    from pypdf.generic import ArrayObject, BooleanObject, DictionaryObject, NameObject, NumberObject, TextStringObject

    filled, problems, drawn = [], [], []
    unknown = sorted(name for name in values if name not in found)
    for name, value in values.items():
        record = found.get(name)
        if record is None or value is None:
            continue
        field, field_kind = record["field"], record["kind"]
        if is_reserved(field):
            problems.append({"field": name, "problem": "reserved"})
            continue
        if field_kind in ("button", "unknown") or flags(field) & FF_READONLY:
            problems.append({"field": name, "problem": "not_fillable"})
            continue
        if field_kind in ("checkbox", "radio"):
            states = sorted({s for *_, widget in record["widgets"] for s in on_states(widget)}) or ["Yes"]
            truth = _truthy(value)
            chosen = _state_for(states, value)
            # A bare «true» ticks a field of one on-state; buttons that share a name with
            # several (male/female) are told apart by the state's name.
            if chosen is None and truth is True and len(states) == 1:
                chosen = states[0]
            if chosen is None and truth is not False:
                problems.append({"field": name, "problem": "no_option", "options": states})
                continue
            field[NameObject("/V")] = NameObject("/" + (chosen or "Off"))
            for *_, widget in record["widgets"]:
                here = chosen if chosen in on_states(widget) or (chosen and not on_states(widget)) else "Off"
                widget[NameObject("/AS")] = NameObject("/" + here)
                if here != "Off" and not on_states(widget):
                    drawn.append((widget, field, None, "mark:" + field_kind, here))
        else:
            text = value if isinstance(value, str) else str(value)
            if field_kind == "choice":
                choices = options(field)
                match = next((c for c in choices if text in c), None) or next(
                    (c for c in choices if text.lower() in (c[0].lower(), c[1].lower())), None
                )
                if match is None and not (flags(field) & FF_EDIT):
                    problems.append({"field": name, "problem": "no_option", "options": [c[1] for c in choices]})
                    continue
                export, text = match if match else (text, text)
                field[NameObject("/V")] = TextStringObject(export)
            else:
                limit = max_length(field)
                if flags(field) & FF_COMB and limit and len(text) > limit:
                    text = re.sub(r"\s+", "", text)  # «0015 246813» into 10 cells; the value and the cells agree
                if limit is not None and len(text) > limit:
                    problems.append({"field": name, "problem": "overflow", "max_length": limit})
                    continue
                field[NameObject("/V")] = TextStringObject(text)
            for *_, widget in record["widgets"]:
                drawn.append((widget, field, text, "text", None))
        filled.append(name)

    # One reportlab document for every appearance.
    jobs, sizes = [], []
    for widget, field, text, job_kind, state in drawn:
        x0, y0, x1, y1 = geom.widget_rect(widget)
        angle = _rotation(widget)
        width, height = (y1 - y0, x1 - x0) if angle in (90, 270) else (x1 - x0, y1 - y0)
        plan, problem = (layout_text(field, text, width, height) if job_kind == "text" else (None, None))
        if problem:
            name = full_name(field)
            if not any(p["field"] == name for p in problems):
                problems.append({"field": name, "problem": problem})
            if plan is None:
                continue
        jobs.append((widget, plan, angle, job_kind, state))
        sizes.append((width, height))

    def draw(canvas, index, width, height):
        widget, plan, _, job_kind, _ = jobs[index]
        characteristics = widget.get("/MK")
        characteristics = characteristics.get_object() if characteristics is not None else {}
        border_style = widget.get("/BS")
        try:
            border_width = float(border_style.get_object().get("/W", 1)) if border_style is not None else 1.0
        except (TypeError, ValueError):
            border_width = 1.0
        if job_kind.startswith("mark:"):
            canvas.setFillColorRGB(0, 0, 0)
            side = min(width, height)
            if job_kind == "mark:radio":
                canvas.circle(width / 2, height / 2, side * 0.25, stroke=0, fill=1)
            else:
                canvas.setLineWidth(max(1.0, side * 0.12))
                path = canvas.beginPath()
                path.moveTo(width / 2 - side * 0.3, height / 2)
                path.lineTo(width / 2 - side * 0.08, height / 2 - side * 0.25)
                path.lineTo(width / 2 + side * 0.32, height / 2 + side * 0.3)
                canvas.drawPath(path, stroke=1, fill=0)
            return
        draw_appearance(
            canvas, plan, width, height, _mk_colour(characteristics.get("/BG")), _mk_colour(characteristics.get("/BC")), border_width
        )

    forms = geom.canvas_forms(writer, sizes, draw)
    for (widget, _, angle, job_kind, state), reference in zip(jobs, forms):
        if angle:
            radians = {90: (0, 1, -1, 0), 180: (-1, 0, 0, -1), 270: (0, -1, 1, 0)}[angle]
            reference.get_object()[NameObject("/Matrix")] = ArrayObject([NumberObject(v) for v in radians] + [NumberObject(0)] * 2)
        if job_kind.startswith("mark:"):
            widget[NameObject("/AP")] = DictionaryObject({NameObject("/N"): DictionaryObject({NameObject("/" + state): reference})})
        else:
            widget[NameObject("/AP")] = DictionaryObject({NameObject("/N"): reference})

    if keep_fields:
        form[NameObject("/NeedAppearances")] = BooleanObject(False)
    else:
        _flatten(writer, form, set(filled), found)

    crypt.write_pdf(writer, output)
    left_empty = [
        name
        for name, record in found.items()
        if name not in values
        and record["kind"] in ("text", "choice", "checkbox", "radio")
        and not is_reserved(record["field"])
        and not flags(record["field"]) & FF_READONLY
        and value_of(record["field"]) in (None, "", "Off", [])
    ]
    kept = [name for name, record in found.items() if is_reserved(record["field"])]
    return {
        "output": output,
        "filled": filled,
        "problems": problems,
        "unknown": unknown,
        "left_empty": left_empty,
        "kept": kept,
        "flattened": not keep_fields,
        "warnings": warnings,
    }


def _flatten(writer, form, names, found):
    stamper = geom.Stamper(writer, "BroFlat")
    dropped = set()
    for name in names:
        for _, page, _, widget in found[name]["widgets"]:
            dropped.add(id(widget))
            if hidden(widget):
                continue
            appearance = _normal_appearance(widget)
            if appearance is None:
                continue
            reference, target = appearance
            stamper.add(page, reference, _flatten_matrix(target, geom.widget_rect(widget)))
    stamper.apply()
    drop_widgets(writer, form, dropped)


def drop_widgets(writer, form, dropped, drop=None):
    """Takes the annotations whose id() is in `dropped` off every page, and those nodes (and the
    ones `drop(node)` names) out of the AcroForm's /Fields."""
    from pypdf.generic import ArrayObject, NameObject

    for page in writer.pages:
        annots = annotations(page)
        kept = ArrayObject(entry for entry in annots if id(entry.get_object()) not in dropped)
        if len(kept) != len(annots):
            page[NameObject("/Annots")] = kept
    listed = field_list(form)
    if listed is not None:
        form[NameObject("/Fields")] = prune_fields(listed, dropped, drop)
