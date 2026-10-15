"""Printed words of PDF pages and the label that names a place on a page (W2 spec §6.3).

Shared by `pdf layout`, `pdf sign-spots`, `pdf sign-mark` and `pdf sign-places`. Words come
from `pdftotext -cropbox -bbox-layout` in view pt (the displayed frame: without -cropbox
poppler measures from the MediaBox, which differs from what viewers show when a PDF is
cropped; the <page> size attributes of that output are unrotated and are not used). A word with a run of underscores or dots
(«Дата:____») is split into a text piece and a blank piece, boxes shared by characters.
"""

import re
import xml.etree.ElementTree as ElementTree

from brokit.util import run

_BLANK_RUN = re.compile(r"[_.…]+")
_NAMESPACE = "{http://www.w3.org/1999/xhtml}"


def _is_blank_run(text):
    return "__" in text or len(text) + 2 * text.count("…") >= 3


def pieces(text, box):
    """Splits one word into [(kind, text, box)], kind "text" or "blank"."""
    runs = [m for m in _BLANK_RUN.finditer(text) if _is_blank_run(m.group())]
    if not runs:
        return [("text", text, box)]
    x0, y0, x1, y1 = box
    step = (x1 - x0) / max(len(text), 1)
    out = []
    cursor = 0
    for match in runs:
        if match.start() > cursor:
            out.append(("text", text[cursor : match.start()], [x0 + step * cursor, y0, x0 + step * match.start(), y1]))
        out.append(("blank", match.group(), [x0 + step * match.start(), y0, x0 + step * match.end(), y1]))
        cursor = match.end()
    if cursor < len(text):
        out.append(("text", text[cursor:], [x0 + step * cursor, y0, x1, y1]))
    return out


def page_layout(path, first, last=None):
    """{page: [line]} for pages first..last; line = {"box", "words": [{"t", "box", "kind"}]}.

    Pages without a text layer (scans) give no lines. A pdftotext failure gives {}.
    """
    last = last or first
    result = run(["pdftotext", "-cropbox", "-bbox-layout", "-f", str(first), "-l", str(last), path, "-"], timeout=60)
    if result.returncode != 0:
        return {}
    try:
        # Control characters from a hostile text layer are not valid XML.
        root = ElementTree.fromstring(re.sub(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]", b"", result.stdout))
    except ElementTree.ParseError:
        return {}
    pages = {}
    for offset, page in enumerate(root.iter(_NAMESPACE + "page")):
        lines = []
        for line in page.iter(_NAMESPACE + "line"):
            words = []
            for word in line.iter(_NAMESPACE + "word"):
                text = (word.text or "").strip()
                if not text:
                    continue
                box = [float(word.get(key, 0)) for key in ("xMin", "yMin", "xMax", "yMax")]
                for kind, piece, piece_box in pieces(text, box):
                    words.append({"t": piece, "box": piece_box, "kind": kind})
            if words:
                lines.append({"box": [float(line.get(key, 0)) for key in ("xMin", "yMin", "xMax", "yMax")], "words": words})
        pages[first + offset] = lines
    return pages


def text_words(lines):
    """The text pieces of a page's lines, without blanks and bare punctuation (/, |, «»)."""
    return [word for line in lines for word in line["words"] if word["kind"] == "text" and re.search(r"[\w№]", word["t"])]


def _centre(box):
    return (box[0] + box[2]) / 2, (box[1] + box[3]) / 2


def label_for(words, box):
    """The printed text naming the place `box` (view pt), ≤ 80 chars; "" on a scan.

    Left: the contiguous run of words just left of the box on its line (never the
    neighbouring column). Else above: the nearest row of words over the box within 90 pt (a
    column header like «НАНИМАТЕЛЬ:»). Plus below: the caption right under the box
    («(подпись)»).
    """
    return label_parts(words, box)[0]


def right_label(words, box):
    """(text, box) of the words right after a checkbox on its line («☐ Согласен»), or ("", None)."""
    x0, y0, x1, y1 = box
    height = max(y1 - y0, 6.0)
    row = sorted(
        (w for w in words if y0 - 0.5 * height <= _centre(w["box"])[1] <= y1 + 0.5 * height and w["box"][0] >= x1 - 1),
        key=lambda w: w["box"][0],
    )
    chosen, edge = [], x1
    for word in row:
        if word["box"][0] - edge > 12:
            break
        chosen.append(word)
        edge = word["box"][2]
    return " ".join(w["t"] for w in chosen)[:40].strip(), _bounds(chosen)


def _bounds(chosen):
    if not chosen:
        return None
    return [min(w["box"][0] for w in chosen), min(w["box"][1] for w in chosen), max(w["box"][2] for w in chosen), max(w["box"][3] for w in chosen)]


def label_parts(words, box):
    """(label text, bounding box of the words it came from or None); see label_for."""
    x0, y0, x1, y1 = box
    height = max(y1 - y0, 8.0)
    same_row = sorted(
        (w for w in words if y0 - 0.5 * height <= _centre(w["box"])[1] <= y1 + 0.25 * height and w["box"][2] <= x0 + 2),
        key=lambda w: -w["box"][2],
    )
    left, edge = [], x0
    for word in same_row:
        if edge - word["box"][2] > (60 if not left else 12):
            break
        left.append(word)
        edge = word["box"][0]
    head = " ".join(w["t"] for w in reversed(left))[-40:].strip()
    used = list(left)
    if not head:
        candidates = [w for w in words if w["box"][3] <= y0 + 1 and y0 - w["box"][3] <= 90 and x0 - 20 <= _centre(w["box"])[0] <= x1]
        if candidates:
            nearest = max(w["box"][3] for w in candidates)
            row = sorted((w for w in candidates if nearest - w["box"][3] <= 3), key=lambda w: w["box"][0])
            text = " ".join(w["t"] for w in row)
            if sum(ch.isalpha() for ch in text) >= 3:
                head = text[:40].strip()
                used = row
    under = [
        w
        for w in sorted(words, key=lambda w: w["box"][0])
        if x0 <= _centre(w["box"])[0] <= x1 and -2 <= w["box"][1] - y1 <= max(14.0, 0.8 * height)
    ]
    below = " ".join(w["t"] for w in under)[:30].strip()
    if below:
        used = used + under
    return " · ".join(part for part in (head, below) if part)[:80], _bounds(used)
