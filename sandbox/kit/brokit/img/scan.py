"""brokit img scan: phone photos of paper pages -> a flat, clean scan.

1. Page corners on a copy of at most DETECT_SIDE px: blur, Otsu, the largest
   bright component, its extremes along x+y and x-y (TL, BR, TR, BL). They must
   make a convex quadrilateral over MIN_PAGE_SHARE of the photo, and the photo
   outside them must be clearly darker than the page (a table, not the same
   paper in a shadow: a page filling the frame would otherwise be cropped),
   else the photo is only deskewed and a warning asks for `--corners` read with
   `look --grid`. A sheet covers its corner quad whole; when the component
   leaves a wedge of background in it (a palm or a light table stuck to the
   sheet), what is far more saturated than the paper and comes in from the
   frame edge is dropped and the corners found again; if that does not give a
   clean quad either, the first corners stay with a warning to check them.
2. Perspective: a homography from an 8x8 linear system into
   Image.transform(PERSPECTIVE); `--paper a4` gives the page 1:sqrt(2), `auto`
   snaps to A4 when the measured ratio is within A4_SNAP of it.
3. Clean-up: division by a blurred background (shadows go), a 2-98 % stretch,
   `bw` by Otsu.
4. A page upside down (or on its side) is turned when its text says so: the
   short last lines of paragraphs hang on the left margin of an upright page.
   The turn is reported; the model checks the result with look.

Several photos make one PDF in the given order at 300 dpi.

5. `--max-mb N` (N million bytes, the stricter reading of a portal's «до N МБ»):
   while the file is bigger, it is written again at 200, then 150 dpi, then
   with JPEG quality 60 instead of 80; black and white pages are lossless, so
   only their dpi goes down. The result always gives `bytes` and the final
   `dpi` and `quality`; a file that does not fit even then is removed and
   refused (too_big).
"""

import os

import math

from brokit import producer
from brokit.img.raster import border_connected, label_components, load_photo, otsu
from brokit.util import KitError, need_file, out_path, parser

DETECT_SIDE = 1000
MIN_PAGE_SHARE = 0.25
# Gray levels between the page and what lies outside its corners: a table is
# 100+ darker, the shaded half of a page that fills the frame about 15.
MIN_EDGE_CONTRAST = 40
# Share of its corner quadrilateral a page (holes filled) covers. A sheet
# covers it whole; a hand or a wooden edge stuck to the sheet drags a corner
# out and leaves a wedge of background inside (a receipt on a palm: 0.89).
MIN_QUAD_FILL = 0.97
# Saturation above the paper's own that is skin or wood, not paper: paper is
# near neutral even under warm light (a receipt on a palm: paper 0.13, skin
# 0.44), and the floor keeps a tinted sheet's own shades on it.
PAPER_SATURATION_MARGIN = 0.15
MIN_SKIN_SATURATION = 0.3
A4 = math.sqrt(2)
A4_SNAP = 0.06
A4_WIDTH_300DPI = 2480
DPI = 300
MAX_SIDE = 4200
PDF_QUALITY = 80
JPEG_QUALITY = 88
# What --max-mb gives up, in order: pixels (text stays readable at 150 dpi),
# then JPEG quality.
SHRINK_DPI = (200, 150)
SHRINK_QUALITY = 60
MEGABYTE = 1000 * 1000


def main(argv):
    p = parser("img scan")
    p.add_argument("photos", nargs="+")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--corners", action="append", help="x,y,x,y,x,y,x,y of TL TR BR BL in photo pixels, once per photo")
    p.add_argument("--mode", default="color", choices=("color", "gray", "bw"))
    p.add_argument("--paper", default="auto", choices=("auto", "a4"))
    p.add_argument("--no-turn", action="store_true", help="never turn the page by its text")
    p.add_argument("--max-mb", type=float, help="the most the file may weigh, in millions of bytes")
    args = p.parse_args(argv)
    if args.max_mb is not None and not args.max_mb > 0:
        raise KitError("bad_args", "--max-mb must be above 0")
    for photo in args.photos:
        need_file(photo)
    out_path(args.output, *args.photos)
    pdf = args.output.lower().endswith(".pdf")
    if not pdf and not args.output.lower().endswith((".png", ".jpg", ".jpeg")):
        raise KitError("bad_output", "the output must be .pdf, .png or .jpg")
    if not pdf and len(args.photos) > 1:
        raise KitError("bad_output", "several photos make one PDF: -o OUT.pdf")
    if args.corners and len(args.corners) != len(args.photos):
        raise KitError("bad_args", "give --corners once per photo, in the order of the photos")
    if len(args.photos) > 100:
        raise KitError("too_many", "more than 100 photos in one call")
    pages, images, warnings = [], [], []
    for n, photo in enumerate(args.photos):
        corners = parse_corners(args.corners[n]) if args.corners else None
        image, info = scan_page(photo, corners, args.mode, args.paper, not args.no_turn)
        images.append(image)
        pages.append(info)
        warnings.extend("%s: %s" % (photo, w) for w in info.pop("warnings"))
    if pdf:
        images = same_a4_size(images, pages)
    # Pillow stores colour and gray PDF pages as JPEG (quality applies) and
    # black and white ones losslessly, where a quality setting is an error.
    lossy = not args.output.lower().endswith(".png") and not (pdf and args.mode == "bw")
    quality = (PDF_QUALITY if pdf else JPEG_QUALITY) if lossy else None
    native = [page["dpi"] for page in pages]
    steps = [(dpi, quality) for dpi in [native[0]] + [d for d in SHRINK_DPI if d < native[0]]]
    if lossy:
        steps.append((steps[-1][0], SHRINK_QUALITY))
    for dpi, quality in steps:
        size = save(images, pages, native, args.output, pdf, dpi, quality)
        if args.max_mb is None or size <= args.max_mb * MEGABYTE:
            break
    else:
        os.remove(args.output)
        raise KitError(
            "too_big",
            "%.2f MB even at %d dpi%s: more than --max-mb %g"
            % (size / MEGABYTE, dpi, ", JPEG quality %d" % quality if quality else "", args.max_mb),
            "split the photos into several files (one per document or a few pages each); text pages also fit as --mode gray or bw",
        )
    return {"output": args.output, "pages": pages, "bytes": size, "dpi": dpi, "quality": quality, "warnings": warnings}


def save(images, pages, native, output, pdf, dpi, quality):
    """Writes the pages at `dpi` (the first page's; `native` are their own dpi) and returns the file's size in bytes."""
    scale = min(1.0, dpi / native[0])
    if scale < 1:
        images = [shrunk(image, scale) for image in images]
    for image, page, own in zip(images, pages, native):
        page["size_px"] = [image.width, image.height]
        page["dpi"] = round(own * scale)
    options = {} if quality is None else {"quality": quality}
    if pdf:
        images[0].save(
            output,
            "PDF",
            save_all=True,
            append_images=images[1:],
            resolution=dpi,
            producer=producer(),
            **options,
        )
    else:
        images[0].save(output, dpi=(dpi, dpi), **options)
    return os.path.getsize(output)


def shrunk(image, scale):
    """The image scaled down; black and white through gray, so thin strokes stay whole."""
    from PIL import Image

    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    if image.mode == "1":
        gray = image.convert("L").resize(size, Image.LANCZOS)
        return gray.point(lambda value: 255 if value >= 128 else 0).convert("1")
    return image.resize(size, Image.LANCZOS)


def same_a4_size(images, pages):
    """A4 pages of one PDF share the first A4 page's pixel size, so they print alike."""
    from PIL import Image

    a4 = [image for image, page in zip(images, pages) if page["paper"] == "a4"]
    if not a4:
        return images
    short = min(a4[0].size)
    out = []
    for image, page in zip(images, pages):
        if page["paper"] == "a4":
            size = (short, round(short * A4)) if image.height >= image.width else (round(short * A4), short)
            if image.size != size:
                image = image.resize(size, Image.LANCZOS)
            page["size_px"] = list(size)
            page["dpi"] = round(short / (210 / 25.4))
        out.append(image)
    return out


def parse_corners(text):
    try:
        values = [float(v) for v in text.replace(" ", "").split(",")]
    except ValueError:
        values = []
    if len(values) != 8:
        raise KitError("bad_args", "--corners needs 8 numbers: x,y of TL, TR, BR, BL in photo pixels")
    return [(values[i], values[i + 1]) for i in range(0, 8, 2)]


def find_corners(image):
    """(TL, TR, BR, BL) of the page in photo pixels or None, and False when that outline is doubtful."""
    import numpy as np
    from PIL import ImageFilter

    scale = min(1.0, DETECT_SIDE / max(image.size))
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    small = image.convert("L").resize(size).filter(ImageFilter.GaussianBlur(3))
    gray = np.asarray(small, dtype=np.float32)
    bright = gray > otsu(gray)
    found = page_quad(bright, gray)
    if found is None:
        return None, True
    points, fill, page = found
    if fill >= MIN_QUAD_FILL:
        return corners_in_photo(points, scale), True
    # Something as bright as paper sticks to the sheet. A hand or a light table
    # is far more colourful than the brightest part of the page: drop it and
    # look again. Only what comes in from the frame edge goes, so a coloured
    # header printed on the sheet is not cut off with it.
    color = image.convert("RGB").resize(size).filter(ImageFilter.GaussianBlur(3))
    saturation = np.asarray(color.convert("HSV"), dtype=np.float32)[..., 1] / 255
    paper = float(np.median(saturation[page & (gray >= np.percentile(gray[page], 90))]))
    colourful = bright & (saturation >= max(MIN_SKIN_SATURATION, paper + PAPER_SATURATION_MARGIN))
    retry = page_quad(bright & ~border_connected(colourful, step=2), gray)
    # The page without the hand is the better outline, but a thumb over the
    # corner itself still hides it: the corners come with a request to check.
    if retry is not None and retry[1] > fill:
        return corners_in_photo(retry[0], scale), False
    return corners_in_photo(points, scale), False


def page_quad(bright, gray):
    """(extreme points, filled share of their quad, page mask) of the largest bright component, or None."""
    import numpy as np
    from PIL import Image, ImageDraw

    labels, count = label_components(bright, 1 << 30)
    if not count:
        return None
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    sizes[0] = 0
    page = labels == int(np.argmax(sizes))
    if page.mean() < MIN_PAGE_SHARE:
        return None
    ys, xs = np.nonzero(page)
    total, diff = xs + ys, xs - ys
    points = [
        (xs[np.argmin(total)], ys[np.argmin(total)]),
        (xs[np.argmax(diff)], ys[np.argmax(diff)]),
        (xs[np.argmax(total)], ys[np.argmax(total)]),
        (xs[np.argmin(diff)], ys[np.argmin(diff)]),
    ]
    h, w = page.shape
    if not convex(points) or quad_area(points) < MIN_PAGE_SHARE * w * h:
        return None
    quad = Image.new("L", (w, h), 0)
    ImageDraw.Draw(quad).polygon([(float(x) + 0.5, float(y) + 0.5) for x, y in points], fill=255)
    inside = np.asarray(quad) > 0
    if (~inside).mean() > 0.02 and gray[inside].mean() - gray[~inside].mean() < MIN_EDGE_CONTRAST:
        return None
    solid = ~border_connected(~page, step=2)
    return points, float((solid & inside).sum() / max(1, inside.sum())), page


def corners_in_photo(points, scale):
    return [((x + 0.5) / scale, (y + 0.5) / scale) for x, y in points]


def convex(points):
    signs = []
    for i in range(4):
        (x0, y0), (x1, y1), (x2, y2) = points[i], points[(i + 1) % 4], points[(i + 2) % 4]
        signs.append((x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1) > 0)
    return all(signs) or not any(signs)


def quad_area(points):
    return abs(sum(points[i][0] * points[(i + 1) % 4][1] - points[(i + 1) % 4][0] * points[i][1] for i in range(4))) / 2


def distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def page_size(corners, paper):
    """(width, height, paper name) of the flat page in pixels at about 300 dpi."""
    tl, tr, br, bl = corners
    width = (distance(tl, tr) + distance(bl, br)) / 2
    height = (distance(tl, bl) + distance(tr, br)) / 2
    portrait = height >= width
    long_side, short_side = max(width, height), min(width, height)
    ratio = long_side / max(short_side, 1)
    if paper == "a4" or abs(ratio / A4 - 1) < A4_SNAP:
        short_side = min(A4_WIDTH_300DPI, short_side)
        long_side = short_side * A4
        name = "a4"
    else:
        name = "auto"
    size = (round(short_side), round(long_side)) if portrait else (round(long_side), round(short_side))
    return size[0], size[1], name


def homography(source, target):
    """Coefficients mapping target (output) points to source (photo) points for PERSPECTIVE."""
    import numpy as np

    rows, rhs = [], []
    for (x, y), (u, v) in zip(target, source):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        rhs.extend([u, v])
    return np.linalg.solve(np.array(rows, dtype=np.float64), np.array(rhs, dtype=np.float64)).tolist()


def deskew_angle(gray):
    """Degrees to rotate by so that text rows are level (-5..5)."""
    import numpy as np
    from PIL import Image

    small = Image.fromarray(gray).resize((max(1, gray.shape[1] // 4), max(1, gray.shape[0] // 4)))
    dark = (np.asarray(small) < otsu(np.asarray(small))).astype(np.uint8) * 255
    mask = Image.fromarray(dark)
    best, best_score = 0.0, -1.0
    for step in range(-50, 51, 2):
        angle = step / 10
        rows = np.asarray(mask.rotate(angle, resample=Image.NEAREST), dtype=np.float32).sum(axis=1)
        score = float(np.var(rows))
        if score > best_score:
            best, best_score = angle, score
    return best


def clean(image, mode):
    """Background division and a 2-98 % stretch; gray or black and white on request."""
    import numpy as np
    from PIL import Image, ImageFilter

    width, height = image.size
    blur = max(width, height) / 40
    small = image.resize((max(1, width // 8), max(1, height // 8)), Image.BILINEAR)
    background = small.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(blur / 8))
    background = np.asarray(background.resize(image.size, Image.BILINEAR), dtype=np.float32)
    pixels = np.asarray(image, dtype=np.float32)
    flat = np.clip(pixels / np.maximum(background, 1) * 255, 0, 255)
    if mode != "color":
        flat = flat @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    low, high = np.percentile(flat[::4, ::4], (2, 98))
    if high - low < 30:
        high = low + 30
    stretched = np.clip((flat - low) / (high - low) * 255, 0, 255).astype(np.uint8)
    if mode == "bw":
        threshold = min(otsu(stretched), 200)
        return Image.fromarray(((stretched > threshold) * 255).astype(np.uint8), "L").convert("1")
    return Image.fromarray(stretched, "RGB" if mode == "color" else "L")


def text_turn(gray):
    """0, 90, 180 or 270 degrees counter-clockwise (Image.rotate) that make the text read upright, or 0 when unsure."""
    import numpy as np

    dark = gray < min(otsu(gray), 170)
    if dark.mean() < 0.005:
        return 0
    rows_strength = float(np.var(dark.mean(axis=1)))
    cols_strength = float(np.var(dark.mean(axis=0)))
    sideways = cols_strength > 2.5 * rows_strength
    sample = np.rot90(dark, 1) if sideways else dark
    left, right = ragged_edges(sample)
    if left + right < 6:
        return 0
    if sideways:
        # np.rot90 turned the sample by 90° counter-clockwise, as Image.rotate(90)
        # turns the page: short lines on the left mean that turn makes it
        # upright, on the right that it lands upside down (90 + 180).
        if left >= 3 * right:
            return 90
        if right >= 3 * left:
            return 270
        return 0
    return 180 if right >= 3 * left else 0


def ragged_edges(dark):
    """Counts of short text lines aligned to the left and to the right margin."""
    import numpy as np

    profile = dark.mean(axis=1)
    on = profile > 0.01
    lines = []
    start = None
    for y, value in enumerate(on.tolist() + [False]):
        if value and start is None:
            start = y
        elif not value and start is not None:
            if y - start >= 4:
                lines.append((start, y))
            start = None
    spans = []
    for y0, y1 in lines:
        columns = np.flatnonzero(dark[y0:y1].any(axis=0))
        if len(columns) > 10:
            spans.append((int(columns[0]), int(columns[-1])))
    if len(spans) < 6:
        return 0, 0
    margin_left = float(np.percentile([s[0] for s in spans], 10))
    margin_right = float(np.percentile([s[1] for s in spans], 90))
    column = margin_right - margin_left
    tolerance = 0.03 * column
    left = right = 0
    for x0, x1 in spans:
        if x1 - x0 > 0.8 * column or x1 - x0 < 0.1 * column:
            continue
        at_left = x0 - margin_left < tolerance * 3
        at_right = margin_right - x1 < tolerance
        if at_left and not at_right:
            left += 1
        elif at_right and not at_left:
            right += 1
    return left, right


def scan_page(path, corners, mode, paper, turn):
    import numpy as np
    from PIL import Image

    image, scale = load_photo(path, MAX_SIDE)
    warnings = []
    auto = corners is None
    if auto:
        corners, clean_outline = find_corners(image)
        if corners is not None and not clean_outline:
            warnings.append(
                "the page outline is not a clean quadrilateral (a hand or an object on its edge?): "
                "check the result with look; if an edge is off, pass --corners read with look --grid"
            )
    else:
        corners = [(x * scale, y * scale) for x, y in corners]
        # A corner far off the photo would only stretch the page into a huge,
        # empty raster: the points come from look, in the photo's pixels.
        slack_x, slack_y = 0.05 * image.width, 0.05 * image.height
        inside = [
            -slack_x <= x <= image.width + slack_x and -slack_y <= y <= image.height + slack_y for x, y in corners
        ]
        if not all(inside):
            size = (round(image.width / scale), round(image.height / scale))
            raise KitError(
                "bad_args",
                "--corners lie outside the photo (%dx%d px)" % size,
                "read them with look --grid: pixels of the photo itself",
            )
    if corners is None:
        angle = deskew_angle(np.asarray(image.convert("L")))
        flat = image.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))
        warnings.append(
            "page edges not found: only straightened by %.1f°; pass --corners read with look --grid" % angle
        )
        name = "photo"
        used = None
    else:
        if not convex(corners):
            raise KitError("bad_args", "the corners do not make a convex page: order TL, TR, BR, BL")
        width, height, name = page_size(corners, paper)
        target = [(0, 0), (width, 0), (width, height), (0, height)]
        flat = image.transform((width, height), Image.PERSPECTIVE, homography(corners, target), Image.BICUBIC)
        used = [[round(x / scale, 1), round(y / scale, 1)] for x, y in corners]
    result = clean(flat, mode)
    turned = 0
    if turn:
        turned = text_turn(np.asarray(result.convert("L")))
        if turned:
            result = result.rotate(turned, expand=True)
            warnings.append("turned by %d° counter-clockwise to read upright: check with look" % turned)
    dpi = round(min(result.size) / (210 / 25.4)) if name == "a4" else DPI
    return result, {
        "source": path,
        "corners": used,
        "auto": bool(auto and used),
        "size_px": [result.width, result.height],
        "paper": name,
        "turned": turned,
        "dpi": dpi,
        "warnings": warnings,
    }
