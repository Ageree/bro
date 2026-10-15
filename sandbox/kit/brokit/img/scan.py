"""brokit img scan: phone photos of paper pages -> a flat, clean scan.

1. Page corners on a copy of at most DETECT_SIDE px: blur, Otsu, the largest
   bright component, its extremes along x+y and x-y (TL, BR, TR, BL). They must
   make a convex quadrilateral over MIN_PAGE_SHARE of the photo, else the photo
   is only deskewed and a warning asks for `--corners` read with `look --grid`.
2. Perspective: a homography from an 8x8 linear system into
   Image.transform(PERSPECTIVE); `--paper a4` gives the page 1:sqrt(2), `auto`
   snaps to A4 when the measured ratio is within A4_SNAP of it.
3. Clean-up: division by a blurred background (shadows go), a 2-98 % stretch,
   `bw` by Otsu.
4. A page upside down (or on its side) is turned when its text says so: the
   short last lines of paragraphs hang on the left margin of an upright page.
   The turn is reported; the model checks the result with look.

Several photos make one PDF in the given order at 300 dpi.
"""

import math

from brokit.img.raster import label_components, load_photo, otsu
from brokit.util import KitError, need_file, out_path, parser

DETECT_SIDE = 1000
MIN_PAGE_SHARE = 0.25
A4 = math.sqrt(2)
A4_SNAP = 0.06
A4_WIDTH_300DPI = 2480
DPI = 300
MAX_SIDE = 4200


def main(argv):
    p = parser("img scan")
    p.add_argument("photos", nargs="+")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--corners", action="append", help="x,y,x,y,x,y,x,y of TL TR BR BL in photo pixels, once per photo")
    p.add_argument("--mode", default="color", choices=("color", "gray", "bw"))
    p.add_argument("--paper", default="auto", choices=("auto", "a4"))
    p.add_argument("--no-turn", action="store_true", help="never turn the page by its text")
    args = p.parse_args(argv)
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
        first, rest = images[0], images[1:]
        first.save(
            args.output, "PDF", save_all=True, append_images=rest, resolution=pages[0]["dpi"], quality=80
        )
    else:
        images[0].save(args.output, dpi=(pages[0]["dpi"], pages[0]["dpi"]), quality=88)
    return {"output": args.output, "pages": pages, "warnings": warnings}


def parse_corners(text):
    try:
        values = [float(v) for v in text.replace(" ", "").split(",")]
    except ValueError:
        values = []
    if len(values) != 8:
        raise KitError("bad_args", "--corners needs 8 numbers: x,y of TL, TR, BR, BL in photo pixels")
    return [(values[i], values[i + 1]) for i in range(0, 8, 2)]


def find_corners(image):
    """(TL, TR, BR, BL) of the page in photo pixels, or None."""
    import numpy as np
    from PIL import ImageFilter

    scale = min(1.0, DETECT_SIDE / max(image.size))
    small = image.convert("L").resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))))
    small = small.filter(ImageFilter.GaussianBlur(3))
    gray = np.asarray(small, dtype=np.float32)
    bright = gray > otsu(gray)
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
    corners = [((x + 0.5) / scale, (y + 0.5) / scale) for x, y in points]
    if not convex(corners) or quad_area(corners) < MIN_PAGE_SHARE * image.width * image.height:
        return None
    return corners


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
    """0, 90, 180 or 270: how far to turn the page so that its text reads upright, or 0 when unsure."""
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
        # rot90 turned the page by 90° counter-clockwise; its text now reads
        # upright when short lines hang on the left.
        if left >= 3 * right:
            return 270
        if right >= 3 * left:
            return 90
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
        corners = find_corners(image)
    else:
        corners = [(x * scale, y * scale) for x, y in corners]
    if corners is None:
        angle = deskew_angle(np.asarray(image.convert("L")))
        flat = image.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=(255, 255, 255))
        warnings.append(
            "page edges not found: only straightened by %.1f°; pass --corners read with look --grid" % angle
        )
        width, height, name = flat.width, flat.height, "photo"
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
            warnings.append("turned by %d° to read upright: check with look" % turned)
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
