"""Page geometry of the pdf commands and drawing onto pages.

"View pt" (every box the kit prints or takes): PDF points from the top-left corner of the
displayed CropBox after /Rotate — the frame of `look --grid`, and of pdftoppm and
`pdftotext -bbox-layout` only with `-cropbox` (by default poppler measures from the MediaBox). "User space": the page's own coordinates, before /Rotate.
"Visual frame": view pt with the y axis pointing up, the frame reportlab draws in.
"""

import io
import os

FONTS_DIR = "/usr/share/fonts/truetype/dejavu"
FONT_FILES = {
    "BroSans": "DejaVuSans.ttf",
    "BroSans-Bold": "DejaVuSans-Bold.ttf",
    "BroSerif": "DejaVuSerif.ttf",
    "BroSerif-Bold": "DejaVuSerif-Bold.ttf",
    "BroMono": "DejaVuSansMono.ttf",
}


def rect(values):
    """[x0, y0, x1, y1] floats with x0 <= x1 and y0 <= y1."""
    x0, y0, x1, y1 = (float(v) for v in values)
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def crop(page):
    return rect(page.cropbox)


def rotation(page):
    """/Rotate as 0, 90, 180 or 270 (clockwise, as displayed)."""
    try:
        angle = int(page.get("/Rotate", 0) or 0)
    except (TypeError, ValueError):
        angle = 0
    return (round(angle / 90) * 90) % 360


def view_size(page):
    x0, y0, x1, y1 = crop(page)
    width, height = x1 - x0, y1 - y0
    return (height, width) if rotation(page) in (90, 270) else (width, height)


def user_to_view(page, box):
    cx0, cy0, cx1, cy1 = crop(page)
    width, height = cx1 - cx0, cy1 - cy0
    x0, y0, x1, y1 = rect(box)
    x0, x1, y0, y1 = x0 - cx0, x1 - cx0, y0 - cy0, y1 - cy0
    angle = rotation(page)
    if angle == 0:
        return [x0, height - y1, x1, height - y0]
    if angle == 90:
        return [y0, x0, y1, x1]
    if angle == 180:
        return [width - x1, y0, width - x0, y1]
    return [height - y1, width - x1, height - y0, width - x0]


def view_to_user(page, box):
    cx0, cy0, cx1, cy1 = crop(page)
    width, height = cx1 - cx0, cy1 - cy0
    angle = rotation(page)

    def point(vx, vy):
        if angle == 0:
            return vx, height - vy
        if angle == 90:
            return vy, vx
        if angle == 180:
            return width - vx, vy
        return width - vy, height - vx

    (ax, ay), (bx, by) = point(box[0], box[1]), point(box[2], box[3])
    return [min(ax, bx) + cx0, min(ay, by) + cy0, max(ax, bx) + cx0, max(ay, by) + cy0]


def visual_matrix(page):
    """cm matrix (a, b, c, d, e, f) from the visual frame of the whole page to user space."""
    cx0, cy0, cx1, cy1 = crop(page)
    return frame([cx0, cy0, cx1, cy1], rotation(page))[0]


def frame(box, angle):
    """The visual frame of a user-space box on a page rotated by `angle`.

    Returns (cm matrix from that frame to user space, visual width, visual height): content
    drawn upright in a (width x height) frame lands in the box and reads upright on screen.
    """
    x0, y0, x1, y1 = rect(box)
    if angle == 90:
        return (0, 1, -1, 0, x1, y0), y1 - y0, x1 - x0
    if angle == 180:
        return (-1, 0, 0, -1, x1, y1), x1 - x0, y1 - y0
    if angle == 270:
        return (0, -1, 1, 0, x0, y1), y1 - y0, x1 - x0
    return (1, 0, 0, 1, x0, y0), x1 - x0, y1 - y0


def apply(matrix, x, y):
    a, b, c, d, e, f = matrix
    return a * x + c * y + e, b * x + d * y + f


def map_box(matrix, box):
    """Bounding box of `box` (x0, y0, x1, y1) after the matrix."""
    points = [apply(matrix, x, y) for x in (box[0], box[2]) for y in (box[1], box[3])]
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def area(box):
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def intersection(a, b):
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def iou(a, b):
    shared = intersection(a, b)
    union = area(a) + area(b) - shared
    return shared / union if union > 0 else 0.0


def rounded(box, digits=1):
    return [round(v, digits) for v in box]


def font(name="BroSans"):
    """Registers a DejaVu face with reportlab under `name` (BroSans, BroSerif, BroMono, …-Bold)."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    if name not in pdfmetrics.getRegisteredFontNames():
        path = os.path.join(FONTS_DIR, FONT_FILES[name])
        if not os.path.isfile(path):
            from brokit.util import KitError

            raise KitError("unavailable", "font missing in this sandbox: " + path)
        pdfmetrics.registerFont(TTFont(name, path))
    return name


def fit_size(text, font_name, width, height, size=None, minimum=6.0):
    """The largest size ≤ the wanted one at which one line of text fits; (size, fits, shrunk)."""
    from reportlab.pdfbase import pdfmetrics

    wanted = float(size) if size else min(12.0, max(minimum, (height - 3) / 1.2))
    current = wanted
    while current > minimum and pdfmetrics.stringWidth(text, font_name, current) > width:
        current -= 0.5
    fits = pdfmetrics.stringWidth(text, font_name, current) <= width
    return current, fits, current < wanted


def colour(value):
    """'#rrggbb' → (r, g, b) floats; anything else → black."""
    text = str(value or "").strip().lstrip("#")
    if len(text) == 6:
        try:
            return tuple(int(text[i : i + 2], 16) / 255 for i in (0, 2, 4))
        except ValueError:
            pass
    return (0.0, 0.0, 0.0)


def canvas_forms(writer, sizes, draw):
    """Form XObjects drawn by reportlab, one per (width, height) in `sizes`, all from ONE document.

    `draw(canvas, index, width, height)` paints form `index`. One document means one embedded
    subset per font for every form. Returns the indirect references of the forms, in order.
    """
    from pypdf import PdfReader
    from pypdf.generic import ArrayObject, DecodedStreamObject, FloatObject, NameObject
    from reportlab.pdfgen import canvas as rl_canvas

    if not sizes:
        return []
    buffer = io.BytesIO()
    canvas = rl_canvas.Canvas(buffer, pagesize=sizes[0], pageCompression=1, invariant=1)
    for index, (width, height) in enumerate(sizes):
        canvas.setPageSize((max(width, 0.01), max(height, 0.01)))
        draw(canvas, index, width, height)
        canvas.showPage()
    canvas.save()
    source = PdfReader(io.BytesIO(buffer.getvalue()))
    forms = []
    for index, (width, height) in enumerate(sizes):
        page = source.pages[index]
        contents = page.get_contents()
        stream = DecodedStreamObject()
        stream.set_data(contents.get_data() if contents is not None else b"")
        stream.update(
            {
                NameObject("/Type"): NameObject("/XObject"),
                NameObject("/Subtype"): NameObject("/Form"),
                NameObject("/BBox"): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(width), FloatObject(height)]),
            }
        )
        if "/Resources" in page:
            stream[NameObject("/Resources")] = page["/Resources"].clone(writer)
        forms.append(writer._add_object(stream.flate_encode()))
    return forms


class Stamper:
    """Paints Form XObjects onto pages: `add(page, form, matrix)` per placement, then `apply()` once.

    The old content of each touched page is wrapped in q…Q first, so an unbalanced `cm` in it
    cannot move what we paint; page resources are copied before they gain names, so pages that
    share one resource dictionary do not see each other's forms.
    """

    def __init__(self, writer, prefix):
        self.writer = writer
        self.prefix = prefix
        self.placements = {}

    def add(self, page, form, matrix):
        self.placements.setdefault(id(page), (page, []))[1].append((form, matrix))

    def apply(self):
        from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, IndirectObject, NameObject

        for page, items in self.placements.values():
            resources = page.get("/Resources")
            resources = DictionaryObject(dict(resources.get_object().items())) if resources is not None else DictionaryObject()
            xobjects = resources.get("/XObject")
            xobjects = DictionaryObject(dict(xobjects.get_object().items())) if xobjects is not None else DictionaryObject()
            operations = []
            counter = 0
            for form, matrix in items:
                counter += 1
                while NameObject("/%s%d" % (self.prefix, counter)) in xobjects:
                    counter += 1
                name = "/%s%d" % (self.prefix, counter)
                xobjects[NameObject(name)] = form
                operations.append("q %s cm %s Do Q" % (" ".join("%.5f" % v for v in matrix), name))
            resources[NameObject("/XObject")] = xobjects
            page[NameObject("/Resources")] = resources
            add = self.writer._add_object
            old = page.get("/Contents")
            parts = []
            if old is not None:
                target = old.get_object()
                if isinstance(target, ArrayObject):
                    parts = list(target)
                else:
                    parts = [old if isinstance(old, IndirectObject) else add(target)]
            before, after, painted = DecodedStreamObject(), DecodedStreamObject(), DecodedStreamObject()
            before.set_data(b"q\n")
            after.set_data(b"\nQ\n")
            painted.set_data(("\n".join(operations) + "\n").encode("ascii"))
            page[NameObject("/Contents")] = ArrayObject([add(before), *parts, add(after), add(painted)])
        self.placements = {}
