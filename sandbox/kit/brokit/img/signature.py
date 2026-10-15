"""brokit img signature: a photo of a handwritten signature -> a transparent PNG.

The one signature extractor (decision D2): Bro's signer runs it in its own
sandbox through a fresh kit (W3 `extractSignature`), the task agent may run it
too. Steps (W2 spec §6.9):

1. EXIF transpose, RGB, at most MAX_SIDE px.
2. Flat-field: gray divided by a blurred background, so a phone shadow does not
   become ink.
3. Threshold min(Otsu, 235).
4. Rows/columns that are ink over half their length (ruled paper, a frame) go.
5. Ink connected to the border goes (a table edge, a page edge) unless almost
   nothing would remain (a tight crop).
6. Specks: ink whose 17x17 neighbourhood is nearly empty goes.
7. 8-connected components; a typed page has hundreds -> `unclear`.
8. Reference colour = the largest components holding 60 % of the ink.
9. Colour filter: a red stamp next to blue ink, black print next to blue ink,
   red next to black are dropped.
10. Distance filter: components far from the main ink are dropped.
11. Crop, alpha ramp, one ink colour, scale to --height.

The preview is the sample as the person will see it: the signature on white and
a caption in the bottom CAPTION_STRIP_PX pixels (the suite skips that strip).
"""

import colorsys
import os

from brokit.img.raster import border_connected, label_components, otsu
from brokit.util import KitError, need_file, out_path, parser

MAX_SIDE = 1600
PREVIEW_MARGIN = 24
CAPTION_STRIP_PX = 52
CAPTION = "образец подписи · сохранён у Бро"
CAPTION_GRAY = (150, 150, 150)
CAPTION_SIZE = 14
FONT_PATHS = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
)

MIN_INK_PX = 150
MIN_COMPONENT_PX = 12
MAX_RAW_COMPONENTS = 400
MAX_KEPT_COMPONENTS = 40
MAX_INK_RATIO = 0.35
MAX_ASPECT = 12
HUE_GAP_DEG = 35
CHROMATIC = 25
CHROMA_FLOOR = 8
CORE_SHARE = 0.6
NEAR_SHARE_OF_DIAGONAL = 0.15
LOW_CONTRAST = 60


def main(argv):
    p = parser("img signature")
    p.add_argument("photo")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--preview")
    p.add_argument("--height", type=int, default=240)
    args = p.parse_args(argv)
    if not 24 <= args.height <= 400:
        raise KitError("bad_args", "--height must be 24..400")
    need_file(args.photo)
    out_path(args.output, args.photo)
    if args.preview:
        out_path(args.preview, args.photo, args.output)
    image = open_photo(args.photo)
    signature, info = extract(image, args.height)
    signature.save(args.output, optimize=True)
    preview = None
    if args.preview:
        render_preview(signature).save(args.preview, optimize=True)
        preview = args.preview
    return dict({"output": args.output, "preview": preview}, **info)


def open_photo(path):
    from PIL import Image, ImageOps, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = 120_000_000
    try:
        image = Image.open(path)
        image.draft("RGB", (MAX_SIDE, MAX_SIDE))
        image = ImageOps.exif_transpose(image).convert("RGB")
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as error:
        raise KitError(
            "unreadable",
            "cannot read the photo: " + type(error).__name__,
            "send the signature as a JPEG or PNG photo",
        )
    image.thumbnail((MAX_SIDE, MAX_SIDE))
    return image


def hue_chroma(rgb):
    r, g, b = (float(v) / 255 for v in rgb)
    hue = colorsys.rgb_to_hsv(r, g, b)[0] * 360
    return hue, (max(r, g, b) - min(r, g, b)) * 255


def hue_gap(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def same_ink(component, ref_hue, ref_chroma):
    chroma = component["chroma"]
    if ref_hue is not None and chroma >= CHROMATIC and hue_gap(component["hue"], ref_hue) > HUE_GAP_DEG:
        return False
    high = max(chroma, ref_chroma, CHROMA_FLOOR)
    low = max(min(chroma, ref_chroma), CHROMA_FLOOR)
    return high / low <= 2.0 or abs(chroma - ref_chroma) < 20


def largest_share(components, share):
    """The largest components (sorted by area) that hold `share` of their ink."""
    total = sum(c["area"] for c in components)
    taken, acc = [], 0
    for c in components:
        taken.append(c)
        acc += c["area"]
        if acc >= share * total:
            break
    return taken


def unclear(ink_ratio, aspect, why):
    return KitError(
        "unclear",
        "the photo does not look like one handwritten signature (" + why + ")",
        "photograph only the signature on a clean sheet, in good light",
        ink_ratio=round(float(ink_ratio), 3),
        aspect=round(float(aspect), 3),
    )


def extract(image, height=240):
    """(RGBA signature, info) for an RGB photo, or raises KitError."""
    import numpy as np
    from PIL import Image, ImageFilter

    gray_image = image.convert("L")
    width_px, height_px = gray_image.size
    blur = max(width_px, height_px) / 240
    small = gray_image.resize((max(1, width_px // 8), max(1, height_px // 8)), Image.BILINEAR)
    background = small.filter(ImageFilter.GaussianBlur(blur)).resize(gray_image.size, Image.BILINEAR)
    gray = np.asarray(gray_image, dtype=np.float32)
    flat = np.clip(gray / np.maximum(np.asarray(background, dtype=np.float32), 1) * 255, 0, 255)
    threshold = min(otsu(flat), 235)
    mask = flat < threshold
    warnings = []

    # Rows and columns that are ink over half their length: rules of lined or
    # squared paper, a frame, a table edge, or the underline of a tightly
    # cropped signature. They are cut out before the border flood (a rule must
    # not carry the signature it crosses to the border); those reaching the
    # border go, the rest (the underline of a tight crop) come back.
    long_lines = np.zeros_like(mask)
    long_lines[:, mask.mean(axis=0) > 0.5] = True
    long_lines[mask.mean(axis=1) > 0.5, :] = True
    lines = mask & long_lines
    cut = mask & ~long_lines
    rules = border_connected(lines)
    if rules.any():
        warnings.append("ruled_paper")
    rest = (cut & ~border_connected(cut)) | (lines & ~rules)
    if rest.sum() >= 300:
        mask = rest
    else:
        mask = cut | (lines & ~rules)
    density = np.asarray(
        Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.BoxBlur(8)), dtype=np.float32
    )
    mask &= density > 0.08 * 255
    if mask.sum() < MIN_INK_PX:
        raise KitError("no_ink", "no handwriting found on the photo", "photograph the signature closer, in good light")

    labels, count = label_components(mask, MAX_RAW_COMPONENTS)
    if labels is None:
        raise unclear(mask.mean(), 0, "%d separate marks" % count)

    rgb = np.asarray(image, dtype=np.float32).reshape(-1, 3)
    flat_labels = labels.ravel()
    on = flat_labels > 0
    n = count + 1
    area = np.bincount(flat_labels[on], minlength=n)
    flat_values = flat.ravel()
    mean_level = np.bincount(flat_labels[on], weights=flat_values[on], minlength=n) / np.maximum(area, 1)
    # Colour of the darker half of each component: anti-aliased edges are
    # paper-tinted and would pull every ink towards gray.
    dark = on & (flat_values <= mean_level[flat_labels])
    dark_n = np.bincount(flat_labels[dark], minlength=n)
    sums = [np.bincount(flat_labels[dark], weights=rgb[dark, k], minlength=n) for k in range(3)]
    ys, xs = np.divmod(np.flatnonzero(on), labels.shape[1])
    lab = flat_labels[on]
    box_x0 = np.full(n, 1 << 30)
    box_y0 = np.full(n, 1 << 30)
    box_x1 = np.zeros(n, np.int64)
    box_y1 = np.zeros(n, np.int64)
    np.minimum.at(box_x0, lab, xs)
    np.minimum.at(box_y0, lab, ys)
    np.maximum.at(box_x1, lab, xs + 1)
    np.maximum.at(box_y1, lab, ys + 1)

    components = []
    for i in np.flatnonzero(area >= MIN_COMPONENT_PX).tolist():
        if i == 0:
            continue
        colour = [sums[k][i] / max(dark_n[i], 1) for k in range(3)]
        hue, chroma = hue_chroma(colour)
        components.append(
            {
                "i": i,
                "area": int(area[i]),
                "box": [int(box_x0[i]), int(box_y0[i]), int(box_x1[i]), int(box_y1[i])],
                "hue": hue,
                "chroma": chroma,
            }
        )
    if sum(c["area"] for c in components) < MIN_INK_PX:
        raise KitError("no_ink", "no handwriting found on the photo", "photograph the signature closer, in good light")
    components.sort(key=lambda c: -c["area"])

    main_ink = largest_share(components, CORE_SHARE)
    ref_chroma = float(np.average([c["chroma"] for c in main_ink], weights=[c["area"] for c in main_ink]))
    chromatic = [c for c in main_ink if c["chroma"] >= CHROMATIC]
    ref_hue = chromatic[0]["hue"] if chromatic and ref_chroma >= CHROMATIC else None
    kept = [c for c in components if same_ink(c, ref_hue, ref_chroma)]
    dropped_colour = [c for c in components if c not in kept]
    if sum(c["area"] for c in dropped_colour) >= 300:
        warnings.append("stamp_removed")

    core = largest_share(kept, CORE_SHARE)
    x0 = min(c["box"][0] for c in core)
    y0 = min(c["box"][1] for c in core)
    x1 = max(c["box"][2] for c in core)
    y1 = max(c["box"][3] for c in core)
    final = list(core)
    rest_components = [c for c in kept if c not in core]
    grown = True
    while grown:
        grown = False
        diagonal = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        for c in list(rest_components):
            cx0, cy0, cx1, cy1 = c["box"]
            gap_x = max(0, x0 - cx1, cx0 - x1)
            gap_y = max(0, y0 - cy1, cy0 - y1)
            if (gap_x * gap_x + gap_y * gap_y) ** 0.5 <= NEAR_SHARE_OF_DIAGONAL * diagonal:
                final.append(c)
                rest_components.remove(c)
                x0, y0, x1, y1 = min(x0, cx0), min(y0, cy0), max(x1, cx1), max(y1, cy1)
                grown = True

    h, w = mask.shape
    if x0 <= 2 or y0 <= 2 or x1 >= w - 2 or y1 >= h - 2:
        warnings.append("touches_edge")
    pad = max(4, (y1 - y0) // 20)
    aspect = (x1 - x0) / max(1, y1 - y0)
    cx0, cy0 = max(0, x0 - pad), max(0, y0 - pad)
    cx1, cy1 = min(w, x1 + pad), min(h, y1 + pad)
    keep = np.isin(labels[cy0:cy1, cx0:cx1], [c["i"] for c in final])
    ink_ratio = float(keep.mean())
    crop_share = (cx1 - cx0) * (cy1 - cy0) / float(w * h)
    if ink_ratio > MAX_INK_RATIO:
        raise unclear(ink_ratio, aspect, "too much ink")
    if aspect > MAX_ASPECT:
        raise unclear(ink_ratio, aspect, "a long line, not a signature")
    if len(final) > MAX_KEPT_COMPONENTS:
        raise unclear(ink_ratio, aspect, "%d separate marks" % len(final))
    if crop_share > 0.9 and len(final) > 12:
        raise unclear(ink_ratio, aspect, "marks all over the photo")

    crop = flat.reshape(h, w)[cy0:cy1, cx0:cx1]
    ink_level = float(np.percentile(crop[keep], 20))
    contrast = threshold - ink_level
    if contrast < LOW_CONTRAST:
        warnings.append("low_contrast")
    alpha = np.clip((threshold - crop) / max(1.0, contrast), 0, 1)
    alpha[~keep] = 0
    colours = rgb.reshape(h, w, 3)[cy0:cy1, cx0:cx1]
    solid = alpha > 0.8
    ink = np.median(colours[solid], axis=0) if solid.any() else np.median(colours[keep], axis=0)
    ink = np.clip(ink * 0.85, 0, 255).astype(np.uint8)
    rgba = np.zeros(alpha.shape + (4,), np.uint8)
    rgba[..., :3] = ink
    rgba[..., 3] = np.round(alpha * 255).astype(np.uint8)
    signature = Image.fromarray(rgba, "RGBA")
    if signature.height > height:
        signature = signature.resize(
            (max(1, min(MAX_ASPECT * height, round(signature.width * height / signature.height))), height),
            Image.LANCZOS,
        )
    info = {
        "width": signature.width,
        "height": signature.height,
        "ink_ratio": round(ink_ratio, 3),
        "aspect": round(aspect, 3),
        "components": len(final),
        "dropped": {"colour": len(dropped_colour), "far": len(rest_components)},
        "ink_rgb": [int(v) for v in ink],
        "warnings": warnings,
    }
    return signature, info


def caption_font():
    from PIL import ImageFont

    for path in FONT_PATHS:
        if os.path.isfile(path):
            return ImageFont.truetype(path, CAPTION_SIZE)
    return ImageFont.load_default(size=CAPTION_SIZE)


def render_preview(signature):
    """The signature on white with the caption in the bottom CAPTION_STRIP_PX px."""
    from PIL import Image, ImageDraw

    font = caption_font()
    caption_width = int(font.getlength(CAPTION)) + 1
    width = max(signature.width, caption_width) + 2 * PREVIEW_MARGIN
    height = PREVIEW_MARGIN + signature.height + CAPTION_STRIP_PX
    canvas = Image.new("RGB", (width, height), "white")
    canvas.paste(signature, (PREVIEW_MARGIN, PREVIEW_MARGIN), signature)
    draw = ImageDraw.Draw(canvas)
    draw.text((PREVIEW_MARGIN, height - CAPTION_STRIP_PX + PREVIEW_MARGIN), CAPTION, font=font, fill=CAPTION_GRAY)
    return canvas
