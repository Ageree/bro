"""brokit img idphoto: a selfie -> a 35x45 mm document photo and a print sheet.

Geometry of a Russian passport photo (and Schengen visas): 35x45 mm, the head
from crown to chin 34 mm (32-36), 4 mm above the crown, eyes level. Steps:

1. Background: a smooth model of the border colours (a plane in Lab per
   channel, refitted without outliers such as shoulders at the bottom edge);
   pixels within BACKGROUND_DELTA_E of it and connected to the border are the
   background, the rest is the person.
2. Eyes: `--eyes x1,y1,x2,y2` (read with look --grid), else the two dark round
   blobs inside the face (a warning: verify with look).
3. Roll: the photo turns about the eye midpoint until the eyes are level;
   `roll_deg` is the eye line measured again on the result (None, with a
   warning, when the eyes are not found there).
4. Crown = top of the silhouette above the eyes; chin = `--chin y` or
   eyes + CHIN_RATIO x (eyes - crown).
5. Crop and scale so that the head is HEAD_MM, then the background is
   feathered to white (check by eye: hair edges).
6. `--sheet 10x15` lays out as many copies as fit with 2 mm gaps and cut lines.
"""

import math
import os

from brokit.img.raster import border_connected, label_components, load_photo, to_lab
from brokit.util import KitError, need_file, out_path, parser

DETECT_SIDE = 640
MAX_SIDE = 4200
DPI = 300
MM = DPI / 25.4
HEAD_MM = 34.0
TOP_MM = 4.0
CHIN_RATIO = 1.07
BACKGROUND_DELTA_E = 16.0
FEATHER_PX = 2
SHEET_GAP_MM = 2.0
CUT_LINE = (200, 200, 200)


def main(argv):
    p = parser("img idphoto")
    p.add_argument("photo")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--eyes", help="x1,y1,x2,y2: eye centres in photo pixels (as look shows them)")
    p.add_argument("--chin", type=float, help="y of the chin in photo pixels")
    p.add_argument("--size", default="35x45", help="photo size in mm, WxH")
    p.add_argument("--head-mm", type=float, help="crown to chin in mm (default 34 for 45 mm height)")
    p.add_argument("--sheet", help="print sheet in cm, like 10x15")
    p.add_argument("--keep-background", action="store_true")
    args = p.parse_args(argv)
    need_file(args.photo)
    out_path(args.output, args.photo)
    if not args.output.lower().endswith((".jpg", ".jpeg", ".png")):
        raise KitError("bad_output", "the output must be .jpg or .png")
    width_mm, height_mm = parse_size(args.size, "--size", 100)
    # In cm; A3 at most, so the sheet stays a printable raster at 300 dpi.
    sheet_w, sheet_h = parse_size(args.sheet, "--sheet", 45) if args.sheet else (None, None)
    head_mm = args.head_mm or HEAD_MM * height_mm / 45.0
    if not 0.3 * height_mm <= head_mm <= height_mm:
        raise KitError("bad_args", "--head-mm must fit the photo height")
    top_mm = TOP_MM * height_mm / 45.0
    image, scale = load_photo(args.photo, MAX_SIDE)
    eyes = [(x * scale, y * scale) for x, y in parse_eyes(args.eyes)] if args.eyes else None
    chin = args.chin * scale if args.chin is not None else None
    result = make_photo(image, eyes, chin, (width_mm, height_mm), head_mm, top_mm, not args.keep_background)
    result["eyes"]["points"] = [[round(x / scale, 1), round(y / scale, 1)] for x, y in result["eyes"]["points"]]
    for key in ("crown_y", "chin_y"):
        result[key] = round(result[key] / scale, 1)
    photo = result.pop("image")
    save(photo, args.output)
    result["photo"] = args.output
    result["sheet"] = None
    result["copies"] = 0
    if args.sheet:
        sheet, copies = make_sheet(photo, (sheet_w * 10, sheet_h * 10), (width_mm, height_mm))
        stem, ext = os.path.splitext(args.output)
        path = out_path("%s-sheet-%gx%g%s" % (stem, sheet_w, sheet_h, ext), args.photo)
        save(sheet, path)
        result["sheet"] = path
        result["copies"] = copies
    return result


def parse_size(text, flag, largest):
    try:
        width, height = (float(v) for v in text.lower().replace("х", "x").split("x"))
    except ValueError:
        raise KitError("bad_args", flag + " is WxH, like 35x45")
    if not (5 <= width <= largest and 5 <= height <= largest):
        raise KitError("bad_args", "%s is out of range (5-%g)" % (flag, largest))
    return width, height


def parse_eyes(text):
    try:
        x1, y1, x2, y2 = (float(v) for v in text.split(","))
    except ValueError:
        raise KitError("bad_args", "--eyes is x1,y1,x2,y2")
    return sorted([(x1, y1), (x2, y2)])


def save(image, path):
    if path.lower().endswith(".png"):
        image.save(path, dpi=(DPI, DPI))
    else:
        image.save(path, quality=95, dpi=(DPI, DPI), subsampling=0)


# ---------------------------------------------------------------- analysis


def background_mask(image):
    """Float background mask (1 = background) at the photo's size, or None."""
    import numpy as np
    from PIL import Image, ImageFilter

    scale = min(1.0, DETECT_SIDE / max(image.size))
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    small = image.resize(size, Image.BILINEAR).filter(ImageFilter.GaussianBlur(1.5))
    lab = to_lab(np.asarray(small))
    h, w = lab.shape[:2]
    band = max(3, round(0.02 * max(h, w)))
    edge = np.zeros((h, w), bool)
    edge[:band, :] = edge[-band:, :] = True
    edge[:, :band] = edge[:, -band:] = True
    ys, xs = np.nonzero(edge)
    values = lab[ys, xs]
    # Start from the median border colour (shoulders on the bottom edge are a
    # minority), then fit a plane to the border pixels near it: walls have a
    # light gradient.
    keep = np.linalg.norm(values - np.median(values, axis=0), axis=1) < BACKGROUND_DELTA_E
    design = np.stack([np.ones(len(xs)), xs / w, ys / h], 1)
    coefficients = None
    for _ in range(3):
        if keep.sum() < 20:
            return None
        coefficients, *_ = np.linalg.lstsq(design[keep], values[keep], rcond=None)
        residual = np.linalg.norm(values - design @ coefficients, axis=1)
        keep = residual < BACKGROUND_DELTA_E * 0.75
    grid_y, grid_x = np.mgrid[0:h, 0:w]
    model = (
        coefficients[0]
        + np.multiply.outer(grid_x / w, coefficients[1])
        + np.multiply.outer(grid_y / h, coefficients[2])
    )
    candidate = np.linalg.norm(lab - model, axis=2) < BACKGROUND_DELTA_E
    background = border_connected(candidate, step=1)
    share = background.mean()
    if not 0.15 < share < 0.95:
        return None
    mask = Image.fromarray((background * 255).astype(np.uint8)).resize(image.size, Image.BILINEAR)
    return np.asarray(mask, dtype=np.float32) / 255


def skin_mask(lab):
    return (lab[..., 0] > 35) & (lab[..., 1] > 4) & (lab[..., 2] > 6) & (lab[..., 1] < 40)


def find_eyes(image, person):
    """((x1, y1), (x2, y2)) of the eyes in photo pixels, or None."""
    import numpy as np
    from PIL import Image

    scale = min(1.0, DETECT_SIDE / max(image.size))
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    lab = to_lab(np.asarray(image.resize(size, Image.BILINEAR)))
    inside = np.ones(lab.shape[:2], bool)
    if person is not None:
        inside = np.asarray(Image.fromarray((person * 255).astype(np.uint8)).resize(size, Image.BILINEAR)) > 127
    skin = skin_mask(lab) & inside
    labels, count = label_components(skin, 1 << 30)
    if not count:
        return None
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    sizes[0] = 0
    face = labels == int(np.argmax(sizes))
    ys, xs = np.nonzero(face)
    if len(xs) < 200:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    face_w = x1 - x0
    region = (slice(y0, y0 + int(0.7 * (y1 - y0))), slice(x0, x1))
    dark = (lab[..., 0] < 40) & inside
    dark_region = dark[region]
    labels, count = label_components(dark_region, 2000)
    if labels is None or not count:
        return None
    blobs = []
    for i in range(1, count + 1):
        by, bx = np.nonzero(labels == i)
        area = len(bx)
        if area < (0.03 * face_w) ** 2 or area > (0.25 * face_w) ** 2:
            continue
        if bx.min() == 0 or by.min() == 0 or bx.max() == dark_region.shape[1] - 1:
            continue
        bw, bh = bx.max() - bx.min() + 1, by.max() - by.min() + 1
        # An eye is a dark blob in light surroundings (sclera, skin); hair
        # strands and the hairline continue into more dark.
        around = (
            slice(y0 + max(0, by.min() - 3), y0 + by.max() + 4),
            slice(x0 + max(0, bx.min() - 3), x0 + bx.max() + 4),
        )
        ring_dark = dark[around].sum() - area
        ring_size = dark[around].size - area
        if ring_size <= 0 or ring_dark > 0.25 * ring_size or inside[around].mean() < 0.9:
            continue
        blobs.append(
            {
                "x": x0 + bx.mean(),
                "y": y0 + by.mean(),
                "area": area,
                "round": min(bw, bh) / max(bw, bh),
                "level": float(lab[..., 0][y0 + by, x0 + bx].mean()),
            }
        )
    best, best_score = None, None
    for i, a in enumerate(blobs):
        for b in blobs[i + 1 :]:
            dx, dy = abs(a["x"] - b["x"]), abs(a["y"] - b["y"])
            if not (0.2 * face_w <= dx <= 0.75 * face_w) or dy > 0.15 * face_w:
                continue
            if max(a["area"], b["area"]) > 3 * min(a["area"], b["area"]):
                continue
            score = a["level"] + b["level"] - 20 * (a["round"] + b["round"]) + dy
            if best_score is None or score < best_score:
                best, best_score = (a, b), score
    if best is None:
        return None
    return sorted(((p["x"] + 0.5) / scale, (p["y"] + 0.5) / scale) for p in best)


def crown_y(person, center_x, half_width):
    """Top row of the person's silhouette over the eyes, in photo pixels."""
    import numpy as np

    x0 = max(0, int(center_x - half_width))
    x1 = min(person.shape[1], int(center_x + half_width) + 1)
    rows = np.flatnonzero((person[:, x0:x1] > 0.5).any(axis=1))
    return float(rows[0]) if len(rows) else None


def face_width_px(image, person, y0, y1):
    import numpy as np

    lab = to_lab(np.asarray(image)[int(y0) : int(y1)])
    skin = skin_mask(lab)
    if person is not None:
        skin &= person[int(y0) : int(y1)] > 0.5
    widest = 0
    for row in skin:
        columns = np.flatnonzero(row)
        if len(columns) > 1:
            widest = max(widest, columns[-1] - columns[0] + 1)
    return widest


# ---------------------------------------------------------------- photo


def make_photo(image, eyes, chin, size_mm, head_mm, top_mm, whiten):
    import numpy as np
    from PIL import Image, ImageFilter

    warnings = []
    background = background_mask(image)
    if background is None:
        warnings.append("background not separated: the photo keeps its own background")
    person = None if background is None else 1.0 - background
    auto = eyes is None
    if auto:
        eyes = find_eyes(image, person)
        if eyes is None:
            raise KitError(
                "no_face",
                "eyes not found on the photo",
                "look at the photo with grid and pass --eyes x1,y1,x2,y2 (and --chin y)",
            )
        warnings.append("eyes found automatically: check the result with look, else pass --eyes")
    (lx, ly), (rx, ry) = eyes
    roll = math.degrees(math.atan2(ry - ly, rx - lx))
    middle = ((lx + rx) / 2, (ly + ry) / 2)
    eye_distance = math.hypot(rx - lx, ry - ly)
    if eye_distance < 10:
        raise KitError("bad_args", "the eyes are too close together")
    if abs(roll) > 0.05:
        image = image.rotate(roll, resample=Image.BICUBIC, center=middle, fillcolor=(255, 255, 255))
        if background is not None:
            mask = Image.fromarray(np.clip(background * 255, 0, 255).astype(np.uint8))
            background = np.asarray(mask.rotate(roll, resample=Image.BILINEAR, center=middle, fillcolor=255)) / 255.0
            person = 1.0 - background
    eyes_y = middle[1]
    # A chin read on the photo before the roll lies on the face's axis, tilted
    # by the roll: levelled, it is 1/cos(roll) farther below the eye midpoint.
    chin_y = None if chin is None else middle[1] + (chin - middle[1]) / math.cos(math.radians(roll))
    crown = crown_y(person, middle[0], 0.6 * eye_distance) if person is not None else None
    if crown is None and chin_y is not None:
        crown = eyes_y - (chin_y - eyes_y) / CHIN_RATIO
        warnings.append("top of the head estimated from the eyes and the chin")
    if crown is None or crown >= eyes_y:
        raise KitError("no_face", "the top of the head was not found", "pass --chin y (and --eyes) read with look --grid")
    if chin_y is None:
        chin_y = eyes_y + CHIN_RATIO * (eyes_y - crown)
    head_px = chin_y - crown
    if head_px <= 0:
        raise KitError("bad_args", "the chin is above the top of the head")
    width_mm, height_mm = size_mm
    k = head_mm * MM / head_px
    out_w, out_h = round(width_mm * MM), round(height_mm * MM)
    left = middle[0] - out_w / 2 / k
    top = crown - top_mm * MM / k
    box = (left, top, left + out_w / k, top + out_h / k)
    photo = image.transform((out_w, out_h), Image.EXTENT, box, Image.BICUBIC, fillcolor=(255, 255, 255))
    if box[0] < 0 or box[1] < 0 or box[2] > image.width or box[3] > image.height:
        warnings.append("the photo is too tight around the head: white was added at the edges")
    if whiten and background is not None:
        mask = Image.fromarray(np.clip(background * 255, 0, 255).astype(np.uint8))
        mask = mask.transform((out_w, out_h), Image.EXTENT, box, Image.BILINEAR, fillcolor=255)
        mask = mask.filter(ImageFilter.GaussianBlur(FEATHER_PX))
        photo = Image.composite(Image.new("RGB", photo.size, (255, 255, 255)), photo, mask)
        warnings.append("background replaced with white: check the hair edges with look")
    eyes_out = (eyes_y - top) * k
    face_px = 0
    if person is not None:
        person_out = 1.0 - np.asarray(
            Image.fromarray(np.clip(background * 255, 0, 255).astype(np.uint8)).transform(
                (out_w, out_h), Image.EXTENT, box, Image.BILINEAR, fillcolor=255
            ),
            dtype=np.float32,
        ) / 255
        face_px = face_width_px(photo, person_out, eyes_out - 0.1 * head_px * k, (chin_y - top) * k)
    # Measured on the result whoever placed the eyes: a mistyped --eyes leaves the head tilted.
    residual = None
    again = find_eyes(photo, None)
    if again:
        (ax, ay), (bx, by) = again
        residual = round(math.degrees(math.atan2(by - ay, bx - ax)), 2)
        if abs(residual) > 1:
            # Live 16.10: level --eyes on a tilted head left it at −3.9°, and the photo went out as is.
            warnings.append(
                "the eye line on the result is tilted %.1f°: the --eyes points are wrong; run again without --eyes or fix them" % residual
            )
    else:
        warnings.append("eye line not re-measured: check it with look")
    head_out_mm = head_px * k / MM
    eyes_from_bottom = (out_h - eyes_out) / MM
    if not 23 <= eyes_from_bottom <= 31:
        warnings.append("eyes are %.1f mm from the bottom (23-31 expected)" % eyes_from_bottom)
    return {
        "image": photo,
        "size_mm": [width_mm, height_mm],
        "size_px": [out_w, out_h],
        "roll_deg": residual,
        "roll_fixed_deg": round(-roll, 2),
        "head_mm": round(head_out_mm, 2),
        "eyes_from_bottom_mm": round(eyes_from_bottom, 2),
        "head_width_mm": round(face_px / MM, 2) if face_px else None,
        "eyes": {"auto": auto, "points": [[round(x, 1), round(y, 1)] for x, y in eyes]},
        "crown_y": round(crown, 1),
        "chin_y": round(chin_y, 1),
        "warnings": warnings,
    }


def make_sheet(photo, sheet_mm, photo_mm):
    """A print sheet (portrait) with as many copies as fit, 2 mm apart."""
    from PIL import Image, ImageDraw

    sheet_w, sheet_h = sorted(sheet_mm)
    width_mm, height_mm = photo_mm
    columns = int((sheet_w + SHEET_GAP_MM) // (width_mm + SHEET_GAP_MM))
    rows = int((sheet_h + SHEET_GAP_MM) // (height_mm + SHEET_GAP_MM))
    if columns < 1 or rows < 1:
        raise KitError("bad_args", "the sheet is smaller than one photo")
    canvas = Image.new("RGB", (round(sheet_w * MM), round(sheet_h * MM)), (255, 255, 255))
    draw = ImageDraw.Draw(canvas)
    used_w = columns * width_mm + (columns - 1) * SHEET_GAP_MM
    used_h = rows * height_mm + (rows - 1) * SHEET_GAP_MM
    x0 = (sheet_w - used_w) / 2
    y0 = (sheet_h - used_h) / 2
    for r in range(rows):
        for c in range(columns):
            x = round((x0 + c * (width_mm + SHEET_GAP_MM)) * MM)
            y = round((y0 + r * (height_mm + SHEET_GAP_MM)) * MM)
            canvas.paste(photo, (x, y))
            draw.rectangle([x - 1, y - 1, x + photo.width, y + photo.height], outline=CUT_LINE)
    return canvas, rows * columns
