"""`pdf layout`: where text goes on a flat form — rules, boxes, checkboxes, comb cells, «____» (W2 spec §6.4).

Pages are rasterised in the displayed frame (pdftoppm): 100 dpi for pages with a text layer,
200 dpi for scans (at 100 dpi the rules of a noisy scan wash out). A scan's skew is found by
maximising the variance of the row projection over −3…+3°; the raster is straightened, rules
are found there (dark runs ≥ 8 pt with paper above or below — letter strokes do not count),
and their ends are mapped back, so a blank on a skewed scan carries its `angle` and its `line`
(the rule's ends) for `pdf write`. Every page result is cached by the file's sha1, which is
how `pdf write` and `pdf sign-mark` resolve ids like "p1b3". A file `pdf write` made keeps the
ids of the file it wrote on (`carry`): the blanks its text filled stay, marked "filled", instead
of dropping out and renumbering the rest — an id from the source's layout names the same place.
"""

import hashlib
import json
import math
import os
import re
import tempfile

from brokit import labels
from brokit.pdf import crypt, geom
from brokit.util import KitError, need_file, parse_pages, parser, run

LAYOUT_VERSION = 1
DARK = 150
TEXT_DPI = 100
SCAN_DPI = 200
MAX_PIXELS_SIDE = 4000
WORDS_CAP = 400
BLANK_KEYS = ("id", "kind", "box", "angle", "label", "label_box", "cells", "line", "filled")
CACHE_NAME = re.compile(r"([0-9a-f]{40})-(\d+)\.json")
FILLED_SHARE = 0.3


def cache_dir():
    """BROKIT_CACHE or /workspace/.bro/cache, + /layout; a temp dir outside a task sandbox."""
    for base in (os.environ.get("BROKIT_CACHE") or "/workspace/.bro/cache", os.path.join(tempfile.gettempdir(), "brokit-cache")):
        path = os.path.join(base, "layout")
        try:
            os.makedirs(path, exist_ok=True)
            if os.access(path, os.W_OK):
                return path
        except OSError:
            continue
    return None


def file_sha1(path):
    digest = hashlib.sha1()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _raster(path, number, dpi):
    """The displayed page as a gray numpy array."""
    import numpy
    from PIL import Image

    with tempfile.TemporaryDirectory(prefix="brokit-layout-") as directory:
        stem = os.path.join(directory, "page")
        result = run(["pdftoppm", "-cropbox", "-gray", "-r", "%.2f" % dpi, "-f", str(number), "-l", str(number), "-singlefile", path, stem], timeout=60)
        if result.returncode != 0 or not os.path.exists(stem + ".pgm"):
            raise KitError("unreadable", "poppler could not render page %d" % number)
        with Image.open(stem + ".pgm") as image:
            return numpy.asarray(image.convert("L")).copy()


def skew_angle(gray):
    """Degrees (counter-clockwise, as PIL rotates) that make rows of ink most peaked."""
    import numpy
    from PIL import Image

    dark = (gray < DARK).astype(numpy.uint8) * 255
    small = Image.fromarray(dark).reduce(2)
    if numpy.count_nonzero(numpy.asarray(small)) < 200:
        return 0.0
    best, best_angle = -1.0, 0.0
    for tenth in range(-30, 31):
        angle = tenth / 10
        rows = (numpy.asarray(small.rotate(angle, resample=Image.NEAREST, fillcolor=0)) > 0).sum(axis=1).astype(numpy.float64)
        variance = rows.var()
        if variance > best + 1e-9:
            best, best_angle = variance, angle
    return best_angle


def _row_runs(dark, minimum):
    """(row, start, end) of dark runs ≥ minimum px along every row."""
    import numpy

    padded = numpy.zeros((dark.shape[0], dark.shape[1] + 2), dtype=numpy.int8)
    padded[:, 1:-1] = dark
    steps = numpy.diff(padded, axis=1)
    starts = numpy.argwhere(steps == 1)
    ends = numpy.argwhere(steps == -1)
    lengths = ends[:, 1] - starts[:, 1]
    keep = lengths >= minimum
    return starts[keep, 0], starts[keep, 1], ends[keep, 1]


def find_segments(dark, minimum, clearance):
    """Horizontal ink segments [y0, y1, x0, x1) (px) with paper `clearance` px above or below."""
    import numpy

    height = dark.shape[0]
    rows, starts, ends = _row_runs(dark, minimum)
    inside = (rows >= clearance) & (rows < height - clearance)
    rows, starts, ends = rows[inside], starts[inside], ends[inside]
    if not len(rows):
        return []
    paper = ~dark
    clear = numpy.zeros_like(dark, dtype=numpy.int32)
    clear[clearance : height - clearance] = paper[: height - 2 * clearance] | paper[2 * clearance :]
    sums = numpy.zeros((height, dark.shape[1] + 1), dtype=numpy.int32)
    numpy.cumsum(clear, axis=1, out=sums[:, 1:])
    share = (sums[rows, ends] - sums[rows, starts]) / (ends - starts)
    keep = share >= 0.8
    pieces = sorted(zip(rows[keep].tolist(), starts[keep].tolist(), ends[keep].tolist()))
    merged = []
    for y, x0, x1 in pieces:
        for segment in reversed(merged[-60:]):
            if 0 <= y - segment[1] <= clearance and x0 <= segment[3] + 2 * clearance and x1 >= segment[2] - 2 * clearance:
                segment[1] = y
                segment[2] = min(segment[2], x0)
                segment[3] = max(segment[3], x1)
                break
        else:
            merged.append([y, y, x0, x1])
    changed = True
    while changed:
        changed = False
        merged.sort(key=lambda s: (s[2], s[0]))
        for i, first in enumerate(merged):
            for second in merged[i + 1 :]:
                if abs(second[0] - first[0]) <= clearance and 0 <= second[2] - first[3] <= 2 * clearance:
                    first[0], first[1] = min(first[0], second[0]), max(first[1], second[1])
                    first[3] = max(first[3], second[3])
                    merged.remove(second)
                    changed = True
                    break
            if changed:
                break
    return [s for s in merged if s[1] - s[0] <= 2 * clearance]


def _vertical_share(dark, column, top, bottom, reach):
    """Share of rows top..bottom with ink within `reach` px of `column`."""
    left, right = max(0, column - reach), min(dark.shape[1], column + reach + 1)
    if bottom <= top or right <= left:
        return 0.0
    return float(dark[top:bottom, left:right].any(axis=1).mean())


def _attached(dark, y0, y1, x0, x1, length):
    """True when a vertical stroke ≥ length px leaves the segment up or down: a letter's bar, not a rule."""
    above = dark[max(0, y0 - length) : y0, x0:x1]
    below = dark[y1 + 1 : y1 + 1 + length, x0:x1]
    return bool((above.shape[0] == length and above.all(axis=0).any()) or (below.shape[0] == length and below.all(axis=0).any()))


def _dividers(dark, top, bottom, x0, x1, reach):
    """x of vertical lines inside a box spanning ≥ 80 % of its height."""
    if bottom - top < 3:
        return []
    columns = dark[top + 1 : bottom, x0 + reach + 1 : x1 - reach].mean(axis=0)
    xs = [x0 + reach + 1 + i for i, v in enumerate(columns.tolist()) if v >= 0.8]
    groups = []
    for x in xs:
        if groups and x - groups[-1][-1] <= reach + 1:
            groups[-1].append(x)
        else:
            groups.append([x])
    return [sum(g) / len(g) for g in groups]


def find_boxes(dark, segments, scale, reach):
    """Boxes (two rules joined by sides), checkboxes (6–20 pt squares) and comb cells."""
    boxes = []
    used = set()
    ordered = sorted(segments, key=lambda s: s[0])
    for i, top in enumerate(ordered):
        for j in range(i + 1, len(ordered)):
            bottom = ordered[j]
            gap = (bottom[0] - top[1]) * scale
            if gap > 60:
                break
            if gap < 4 or abs(top[2] - bottom[2]) > 2 * reach or abs(top[3] - bottom[3]) > 2 * reach:
                continue
            x0, x1 = (top[2] + bottom[2]) // 2, (top[3] + bottom[3]) // 2 - 1
            if _vertical_share(dark, x0, top[1], bottom[0], reach) < 0.8 or _vertical_share(dark, x1, top[1], bottom[0], reach) < 0.8:
                continue
            width, height = (x1 - x0) * scale, (bottom[1] - top[0]) * scale
            box = {"px": [x0, top[0], x1 + 1, bottom[1] + 1]}
            if 6 <= width <= 20 and 6 <= height <= 20 and 0.7 <= width / height <= 1.4:
                box["kind"] = "checkbox"
            else:
                dividers = _dividers(dark, top[1], bottom[0], x0, x1, reach)
                edges = [x0] + dividers + [x1]
                widths = sorted(b - a for a, b in zip(edges, edges[1:]))
                middle = widths[len(widths) // 2] if widths else 0
                # Cells drawn apart leave narrow gaps between double sides: those are not cells.
                cells = [w for w in widths if w > 0.5 * middle]
                gaps_only = all(w <= 0.4 * middle for w in widths if w <= 0.5 * middle)
                if len(cells) >= 5 and gaps_only and max(cells) <= 1.25 * min(cells):
                    box.update(kind="comb", cells=len(cells))
                elif width >= 12 and height >= 8:
                    box["kind"] = "box"
                else:
                    continue
            boxes.append(box)
            used.update((id(top), id(bottom)))
            break
    return boxes, used


def _join_cells(boxes, reach):
    """≥ 5 equal boxes side by side on one baseline (drawn apart, not sharing sides) → one comb."""
    rows, out = {}, []
    for box in boxes:
        if box["kind"] in ("box", "checkbox"):
            rows.setdefault((box["px"][1] // (2 * reach), box["px"][3] // (2 * reach)), []).append(box)
        else:
            out.append(box)
    for row in rows.values():
        row.sort(key=lambda b: b["px"][0])
        run = [row[0]]
        for box in row[1:] + [None]:
            previous = run[-1]
            width = previous["px"][2] - previous["px"][0]
            if (
                box is not None
                and 0 <= box["px"][0] - previous["px"][2] <= max(3 * reach, 0.8 * width)
                and abs((box["px"][2] - box["px"][0]) - width) <= 0.15 * width
            ):
                run.append(box)
                continue
            if len(run) >= 5:
                out.append({"kind": "comb", "cells": len(run), "px": [run[0]["px"][0], min(b["px"][1] for b in run), run[-1]["px"][2], max(b["px"][3] for b in run)]})
            else:
                out.extend(run)
            run = [box]
    return out


def _ink_above(dark, y, x0, x1, limit):
    """Rows from `y` up to the nearest ink within x0..x1 (≤ limit)."""
    import numpy

    top = max(0, y - limit)
    band = dark[top:y, x0:x1]
    if not band.size:
        return limit
    rows = numpy.flatnonzero(band.mean(axis=1) > 0.01)
    return y - (top + rows[-1]) - 1 if len(rows) else limit


class Unrotate:
    """Maps straightened-raster pixels back to view pt of the displayed page."""

    def __init__(self, angle, width, height, scale):
        self.radians = math.radians(-angle)
        self.cx, self.cy = width / 2, height / 2
        self.scale = scale

    def __call__(self, x, y):
        dx, dy = x - self.cx, y - self.cy
        cos, sin = math.cos(self.radians), math.sin(self.radians)
        return ((self.cx + dx * cos + dy * sin) * self.scale, (self.cy - dx * sin + dy * cos) * self.scale)


BOX_GLYPHS = set("☐□▢❏❐❑❒◻⬜☑☒✓✔✗✘")


def _in_text(rule, words):
    """True when a rule found in the raster is a stroke of printed text (a letter, an underline)."""
    x0, y0, x1, y1 = rule
    middle = (y0 + y1) / 2
    shared = sum(
        max(0.0, min(x1, w["box"][2]) - max(x0, w["box"][0]))
        for w in words
        if w["box"][1] - 0.5 <= middle <= w["box"][3] + 1.0
    )
    return shared >= 0.5 * (x1 - x0)


def _covered(box, words):
    total = geom.area(box)
    if total <= 0:
        return 1.0
    return sum(geom.intersection(box, w["box"]) for w in words) / total


def analyse(path, number, page, lines):
    """The layout of one page (see the module docstring)."""
    import numpy
    from PIL import Image

    from brokit.pdf.info import has_images

    words = labels.text_words(lines)
    printed = [w for line in lines for w in line["words"] if w["kind"] == "text" and not set(w["t"]) <= BOX_GLYPHS]
    width, height = geom.view_size(page)
    chars = sum(len(w["t"]) for w in words)
    scan = chars < 20 or (has_images(page) and _big_image(page))
    dpi = min(SCAN_DPI if scan else TEXT_DPI, MAX_PIXELS_SIDE * 72 / max(width, height, 1))
    scale = 72.0 / dpi
    gray = _raster(path, number, dpi)
    angle = skew_angle(gray) if scan else 0.0
    skew = 0.0 if abs(angle) < 0.05 else -angle
    if abs(angle) >= 0.05:
        gray = numpy.asarray(Image.fromarray(gray).rotate(angle, resample=Image.BILINEAR, fillcolor=255))
    dark = gray < DARK
    reach = max(2, round(1.0 / scale))
    segments = find_segments(dark, max(3, int(round(5 / scale))), reach)
    boxes, in_boxes = find_boxes(dark, segments, scale, reach)
    boxes = _join_cells(boxes, reach)
    back = Unrotate(angle, gray.shape[1], gray.shape[0], scale)
    blanks = []

    def to_view(px_box):
        x0, y0, x1, y1 = px_box
        points = [back(x, y) for x in (x0, x1) for y in (y0, y1)]
        return [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]

    for box in boxes:
        blank = {"kind": box["kind"], "box": to_view(box["px"]), "angle": round(skew, 2)}
        if "cells" in box:
            blank["cells"] = box["cells"]
        blanks.append(blank)
    limit = int(round(22 / scale))
    for segment in segments:
        y0, y1, x0, x1 = segment
        if id(segment) in in_boxes or (x1 - x0) * scale < 8:
            continue
        if any(b["px"][0] - reach <= x0 and x1 <= b["px"][2] + reach and b["px"][1] - reach <= y0 <= b["px"][3] + reach for b in boxes):
            continue
        if _in_text(to_view([x0, y0, x1, y1 + 1]), printed):
            continue
        if (x1 - x0) * scale < 40 and _attached(dark, y0, y1, x0, x1, int(round(2.5 / scale))):
            continue
        rise = min(max(_ink_above(dark, y0, x0, x1, limit), int(round(10 / scale))), limit)
        start, end = back(x0, y0), back(x1, y0)
        blanks.append(
            {
                "kind": "line",
                "box": to_view([x0, y0 - rise, x1, y0]),
                "angle": round(math.degrees(math.atan2(start[1] - end[1], end[0] - start[0])), 2),
                "line": [round(start[0], 2), round(start[1], 2), round(end[0], 2), round(end[1], 2)],
            }
        )
    for word in (w for line in lines for w in line["words"] if w["kind"] == "blank"):
        x0, y0, x1, y1 = word["box"]
        rule_y = y1 - 0.2 * (y1 - y0)
        candidate = [x0, rule_y - min(22.0, max(10.0, y1 - y0)), x1, rule_y]
        twin = next(
            (
                b
                for b in blanks
                if b["kind"] in ("line", "underscores")
                and min(b["box"][2], x1) - max(b["box"][0], x0) > 0.5 * min(x1 - x0, b["box"][2] - b["box"][0])
                and abs(b["box"][3] - rule_y) <= 6
            ),
            None,
        )
        if twin is not None:
            twin["kind"] = "underscores"  # typed «____»: the raster rule gives the exact geometry
        else:
            blanks.append({"kind": "underscores", "box": candidate, "angle": 0.0, "line": [x0, rule_y, x1, rule_y]})
    kept = [b for b in blanks if _covered(b["box"], printed) <= FILLED_SHARE]
    kept.sort(key=lambda b: (round(b["box"][3] / 6), b["box"][0]))
    for index, blank in enumerate(kept, start=1):
        blank["id"] = "p%db%d" % (number, index)
        blank["box"] = geom.rounded(blank["box"])
        x0, y0, x1, y1 = blank["box"]
        near = [x0, max(y0, y1 - 14), x1, y1] if blank["kind"] in ("line", "underscores") else blank["box"]
        text, box = labels.right_label(words, blank["box"]) if blank["kind"] == "checkbox" else ("", None)
        if not text:
            text, box = labels.label_parts(words, near)
        blank["label"] = text
        if box:
            blank["label_box"] = geom.rounded(box)
    return {
        "page": number,
        "size": [round(width, 1), round(height, 1)],
        "rotate": geom.rotation(page),
        "scan": scan,
        "skew_deg": round(skew, 1),
        "words": [{"t": w["t"], "box": geom.rounded(w["box"])} for w in words[:WORDS_CAP]],
        "blanks": [{key: blank[key] for key in BLANK_KEYS if key in blank} for blank in kept],
    }


def _big_image(page):
    """True when the page holds a raster of at least 1000 px on a side (a scan with an OCR layer)."""
    resources = page.get("/Resources")
    resources = resources.get_object() if resources is not None else None
    xobjects = resources.get("/XObject") if isinstance(resources, dict) else None
    xobjects = xobjects.get_object() if xobjects is not None else None
    if not isinstance(xobjects, dict):
        return False
    for entry in xobjects.values():
        target = entry.get_object()
        if not isinstance(target, dict):
            continue
        try:
            if target.get("/Subtype") == "/Image" and max(int(target.get("/Width", 0)), int(target.get("/Height", 0))) >= 1000:
                return True
        except (TypeError, ValueError):
            continue
    return False


def page_results(path, numbers, reader=None):
    """{page: result} for the pages, from the cache when the file is unchanged."""
    need_file(path)
    digest = file_sha1(path)
    directory = cache_dir()
    out, missing = {}, []
    for number in numbers:
        cached = os.path.join(directory, "%s-%d.json" % (digest, number)) if directory else None
        if cached and os.path.exists(cached):
            try:
                with open(cached, encoding="utf-8") as handle:
                    data = json.load(handle)
                if data.get("v") == LAYOUT_VERSION and data.get("kit") == crypt.kit_version():
                    out[number] = data["page"]
                    continue
            except (OSError, ValueError, KeyError):
                pass
        missing.append(number)
    if missing:
        reader = reader or crypt.open_pdf(path)
        text = labels.page_layout(path, min(missing), max(missing))
        for number in missing:
            result = analyse(path, number, reader.pages[number - 1], text.get(number, []))
            out[number] = result
            _store(directory, digest, number, result)
    _prune_cache(directory)
    return out


def _store(directory, digest, number, result):
    if not directory:
        return
    temporary = os.path.join(directory, "%s-%d.json.%d" % (digest, number, os.getpid()))
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump({"v": LAYOUT_VERSION, "kit": crypt.kit_version(), "page": result}, handle, ensure_ascii=False)
    os.replace(temporary, os.path.join(directory, "%s-%d.json" % (digest, number)))


def carry(source, output, written):
    """Caches the source's laid-out pages for the file `pdf write` made from it, with the ids.

    A fresh layout of the written file would drop the blanks its text now covers and number the
    rest anew, so "p1b16" of the source would name another blank there. The output's words are
    read again; a blank under its text or a written box (`written`: (page, view box) pairs) is
    marked "filled".
    """
    directory = cache_dir()
    if not directory:
        return
    source_digest, output_digest = file_sha1(source), file_sha1(output)
    pages = {}
    for name in os.listdir(directory):
        match = CACHE_NAME.fullmatch(name)
        if not match or match.group(1) != source_digest:
            continue
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as handle:
                data = json.load(handle)
            if data.get("v") == LAYOUT_VERSION and data.get("kit") == crypt.kit_version():
                pages[int(match.group(2))] = data["page"]
        except (OSError, ValueError, KeyError):
            continue
    if not pages:
        return
    text = labels.page_layout(output, min(pages), max(pages))
    for number, page in pages.items():
        lines = text.get(number, [])
        printed = [w for line in lines for w in line["words"] if w["kind"] == "text" and not set(w["t"]) <= BOX_GLYPHS]
        boxes = [box for page_number, box in written if page_number == number]
        for blank in page["blanks"]:
            area = geom.area(blank["box"])
            if _covered(blank["box"], printed) > FILLED_SHARE or any(geom.intersection(blank["box"], box) > FILLED_SHARE * area for box in boxes):
                blank["filled"] = True
        page["words"] = [{"t": w["t"], "box": geom.rounded(w["box"])} for w in labels.text_words(lines)[:WORDS_CAP]]
        _store(directory, output_digest, number, page)


def _prune_cache(directory, budget=50 * 1024 * 1024):
    if not directory:
        return
    try:
        root = os.path.dirname(directory)
        files = []
        for base, _, names in os.walk(root):
            for name in names:
                full = os.path.join(base, name)
                stat = os.stat(full)
                files.append((stat.st_mtime, stat.st_size, full))
        total = sum(size for _, size, _ in files)
        for _, size, full in sorted(files):
            if total <= budget:
                break
            os.remove(full)
            total -= size
    except OSError:
        pass


def page_blanks(path, number):
    return page_results(path, [number])[number]["blanks"]


def blank_by_id(path, blank_id):
    """(page, view box, blank) of an id like "p2b5" from the layout of this exact file."""
    import re

    match = re.match(r"^p(\d+)b(\d+)$", blank_id or "")
    if not match:
        raise KitError("bad_id", "a blank id looks like p2b5", "ids come from brokit pdf layout of the same file")
    number = int(match.group(1))
    reader = crypt.open_pdf(path)
    if not 1 <= number <= len(reader.pages):
        raise KitError("bad_id", "no page %d in this file" % number)
    for blank in page_results(path, [number], reader)[number]["blanks"]:
        if blank["id"] == blank_id and blank.get("filled"):
            raise KitError("filled_blank", "%s is already filled in this file" % blank_id, "write every blank in one pdf write on the source file")
        if blank["id"] == blank_id:
            return number, blank["box"], blank
    raise KitError("bad_id", "no blank %s on page %d" % (blank_id, number), "run brokit pdf layout on this file again")


def draw_marks(path, number, result, directory):
    """A 1280 px picture of the page with every blank boxed and numbered (Set-of-Mark)."""
    from PIL import Image, ImageDraw, ImageFont

    width, height = result["size"]
    scale = 1280 / max(width, height)
    with tempfile.TemporaryDirectory(prefix="brokit-marks-") as temporary:
        stem = os.path.join(temporary, "page")
        rendered = run(["pdftoppm", "-cropbox", "-png", "-scale-to", "1280", "-f", str(number), "-l", str(number), "-singlefile", path, stem], timeout=60)
        if rendered.returncode != 0:
            raise KitError("unreadable", "poppler could not render page %d" % number)
        with Image.open(stem + ".png") as image:
            canvas = image.convert("RGB")
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype(os.path.join(geom.FONTS_DIR, geom.FONT_FILES["BroSans-Bold"]), 13)
    except OSError:
        font = ImageFont.load_default()
    for blank in result["blanks"]:
        x0, y0, x1, y1 = (v * scale for v in blank["box"])
        draw.rectangle([x0, y0, x1, y1], outline=(0, 90, 255), width=2)
        tag = blank["id"].split("b", 1)[1]
        text_box = draw.textbbox((x0, y0 - 15), tag, font=font)
        draw.rectangle(text_box, fill=(0, 90, 255))
        draw.text((x0, y0 - 15), tag, fill=(255, 255, 255), font=font)
    os.makedirs(directory, exist_ok=True)
    output = os.path.join(directory, "layout-p%d.png" % number)
    canvas.save(output)
    return output


def main(argv):
    args = parser("pdf layout")
    args.add_argument("file")
    args.add_argument("--pages")
    args.add_argument("--marks")
    options = args.parse_args(argv)
    warnings = []
    reader = crypt.open_pdf(options.file, warnings=warnings)
    numbers = parse_pages(options.pages, len(reader.pages))
    if len(numbers) > 12:
        raise KitError("too_many_pages", "layout reads up to 12 pages per call", "pass --pages, e.g. 1-6")
    results = page_results(options.file, numbers, reader)
    pages = [results[n] for n in numbers]
    out = {"pages": pages, "warnings": warnings}
    if options.marks:
        out["marks"] = [draw_marks(options.file, n, results[n], options.marks) for n in numbers]
    if any(p["scan"] for p in pages):
        out["hint"] = "scan pages have no text layer: labels are empty — look at --marks pictures to tell the blanks apart"
    return out
