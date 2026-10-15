"""Image kinds: the signature preview and the signature's shape on a page, ID photos, sheets, regions."""

from __future__ import annotations

from . import CheckError, check, failed, passed
from .context import expand
from .signed import dilate, ink_crop, ncc, signature_aspect, signature_mask

PREVIEW_INK = 110
PREVIEW_PAPER = 238


def preview_metrics(img, *, strip: int, halo: int) -> dict:
    """W2's preview: RGBA composited on white, the caption strip skipped; ink = L < 110; paper = 110 ≤ L < 238 farther
    than `halo` px from ink."""
    import numpy as np
    from PIL import Image

    if img.mode in ("RGBA", "LA", "P"):
        rgba = img.convert("RGBA")
        canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        canvas.alpha_composite(rgba)
        img = canvas
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    if strip:
        rgb = rgb[: max(1, rgb.shape[0] - strip)]
    lum = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    ink = lum < PREVIEW_INK
    paper = (lum >= PREVIEW_INK) & (lum < PREVIEW_PAPER) & ~dilate(ink, halo)
    ys, xs = np.nonzero(ink)
    aspect = (xs.max() - xs.min() + 1) / (ys.max() - ys.min() + 1) if len(xs) else 0.0
    return {"paper": float(paper.mean()), "ink": float(ink.mean()), "aspect": float(aspect)}


@check("signature_preview", "image")
def signature_preview(ctx, params, item):
    from PIL import Image

    with Image.open(item.path) as im:
        m = preview_metrics(im.copy(), strip=int(params.get("caption_strip_px", 52)), halo=int(params.get("halo_px", 2)))
    want = signature_aspect(ctx)
    tol = float(params.get("tolerance", 0.15))
    problems = []
    if m["ink"] == 0:
        return failed("на образце нет чернил")
    if m["paper"] > float(params.get("paper_max", 0.005)):
        problems.append(f"бумага/клетка/штамп {m['paper']:.4f}")
    if abs(m["aspect"] - want) > tol * want:
        problems.append(f"аспект {m['aspect']:.2f} при {want:.2f}")
    note = f"бумага {m['paper']:.4f}, аспект {m['aspect']:.2f} (эталон {want:.2f})"
    if problems:
        return failed("; ".join(problems) + f" — {note}")
    return passed(note)


@check("signature_shape", "pdf")
def signature_shape(ctx, params, item):
    """Aspect of the blue ink in each signature rect of the 200 dpi render vs the truth sample (±tolerance), not
    mirrored (NCC with the truth beats NCC with its mirror)."""
    import numpy as np

    from .pdf import crop_rect, luma

    pdf = item.path
    want = signature_aspect(ctx)
    tol = float(params.get("tolerance", 0.15))
    truth = signature_mask(ctx)
    places = [(int(f.get("page", 1)), name, f["rect"]) for name, f in ctx.fields.items()
              if f.get("type") == "sig" and "rect" in f]
    if params.get("rect_from_truth"):
        names = params["rect_from_truth"]
        names = [names] if isinstance(names, str) else names
        places = [(int(ctx.fields[n].get("page", 1)), n, ctx.fields[n]["rect"]) for n in names]
    if not places:
        raise CheckError("в эталоне нет мест подписи")
    problems, seen = [], []
    for page, name, rect in places:
        if page > ctx.page_count(pdf):
            problems.append(f"{name}: нет стр. {page}")
            continue
        rgb, lum = luma(crop_rect(ctx, pdf, page, expand(rect, 12), 200))
        ink = ((lum < 110) & (rgb[..., 2] > rgb[..., 0] + 25)).astype(np.float32)
        crop = ink_crop(ink)
        if crop is None:
            problems.append(f"{name}: чернил нет")
            continue
        aspect = crop.shape[1] / crop.shape[0]
        direct, mirrored = ncc(crop, truth), ncc(np.fliplr(crop), truth)
        note = f"{name}: аспект {aspect:.2f} (эталон {want:.2f}), NCC {direct:.2f}/{mirrored:.2f}"
        if abs(aspect - want) > tol * want or mirrored > direct:
            problems.append(note)
        else:
            seen.append(note)
    if problems:
        return failed("; ".join(problems))
    return passed("; ".join(seen))


# ------------------------------------------------------------------ ID photo and print sheet
def open_image(item):
    from PIL import Image, ImageOps

    with Image.open(item.path) as im:
        return ImageOps.exif_transpose(im).convert("RGB"), im.info.get("dpi")


def _aspect_ok(img, want, tol: float = 0.03) -> bool:
    return abs(img.width / img.height - want) <= tol * want


def classify(img, colors: dict, tol: float):
    """Label map: index of the nearest listed colour within `tol` (Euclidean RGB), else -1 (issues: hair and eye
    colours are 23.5 apart, so the nearest colour decides before the tolerance)."""
    import numpy as np

    names = list(colors)
    arr = np.asarray(img, dtype=np.float32)
    ref = np.array([colors[n] for n in names], dtype=np.float32)
    dist = np.sqrt(((arr[:, :, None, :] - ref[None, None, :, :]) ** 2).sum(-1))
    label = dist.argmin(-1)
    label[dist.min(-1) > tol] = -1
    return names, label


def head_geometry(img, colors: dict, tol: float) -> dict:
    import numpy as np

    from .signed import components

    names, label = classify(img, colors, tol)
    hair = label == names.index("hair") if "hair" in names else np.zeros(label.shape, bool)
    skin = label == names.index("skin")
    eye = label == names.index("eye") if "eye" in names else np.zeros(label.shape, bool)
    head = hair | skin
    rows = np.nonzero(head.sum(1) >= 3)[0]
    skin_rows = np.nonzero(skin.sum(1) >= 3)[0]
    if len(rows) == 0 or len(skin_rows) == 0:
        raise ValueError("голова не найдена")
    crown, chin = int(rows.min()), int(skin_rows.max())
    cols = np.nonzero(head[crown:chin + 1].sum(0) >= 3)[0]
    sy, sx = np.nonzero(skin)
    box = (sx.min(), sy.min(), sx.max() + 1, sy.max() + 1)
    sub = eye[box[1]:box[3], box[0]:box[2]]
    blobs = sorted(components(sub, min_pixels=8), key=lambda b: -(b[2] - b[0]) * (b[3] - b[1]))[:2]
    eyes = [((b[0] + b[2]) / 2 + box[0], (b[1] + b[3]) / 2 + box[1]) for b in blobs]
    return {"crown": crown, "chin": chin, "left": int(cols.min()) if len(cols) else 0,
            "right": int(cols.max()) + 1 if len(cols) else 0, "eyes": sorted(eyes)}


@check("photo_geometry", "image")
def photo_geometry(ctx, params, item):
    img, _ = open_image(item)
    if params.get("photo_aspect") and not _aspect_ok(img, float(params["photo_aspect"])):
        return failed(f"кадр {img.width}×{img.height} — не фото 35×45")
    ppm = img.width / 35.0
    try:
        g = head_geometry(img, params["colors"], float(params.get("color_tol", 40)))
    except ValueError as e:
        return failed(str(e))
    head = (g["chin"] - g["crown"]) / ppm
    width = (g["right"] - g["left"]) / ppm
    center = ((g["left"] + g["right"]) / 2 - img.width / 2) / ppm
    problems = []
    lo, hi = params["head_len_mm"]
    if not lo <= head <= hi:
        problems.append(f"голова {head:.1f} мм")
    lo, hi = params["head_width_mm"]
    if not lo <= width <= hi:
        problems.append(f"ширина {width:.1f} мм")
    if abs(center) > float(params.get("center_tol_mm", 1.5)):
        problems.append(f"центр смещён на {center:.1f} мм")
    if len(g["eyes"]) == 2:
        eyes = (img.height - (g["eyes"][0][1] + g["eyes"][1][1]) / 2) / ppm
        lo, hi = params["eyes_from_bottom_mm"]
        if not lo <= eyes <= hi:
            problems.append(f"глаза {eyes:.1f} мм от низа")
    else:
        problems.append("глаза не найдены")
    note = f"голова {head:.1f} мм, ширина {width:.1f} мм, центр {center:+.1f} мм"
    if problems:
        return failed("; ".join(problems) + f" ({note})")
    return passed(note)


@check("photo_roll", "image")
def photo_roll(ctx, params, item):
    import math

    img, _ = open_image(item)
    if params.get("photo_aspect") and not _aspect_ok(img, float(params["photo_aspect"])):
        return failed(f"кадр {img.width}×{img.height} — не фото 35×45")
    colors = params.get("colors") or {"hair": [55, 38, 28], "skin": [224, 182, 150], "eye": [35, 35, 40],
                                      "white": [255, 255, 255], "shirt": [34, 52, 98]}
    try:
        g = head_geometry(img, colors, float(params.get("color_tol", 40)))
    except ValueError as e:
        return failed(str(e))
    if len(g["eyes"]) != 2:
        return failed("глаза не найдены")
    (x0, y0), (x1, y1) = g["eyes"]
    angle = math.degrees(math.atan2(y1 - y0, x1 - x0))
    if abs(angle) > float(params.get("max_deg", 1.0)):
        return failed(f"линия глаз наклонена на {angle:.1f}°")
    return passed(f"линия глаз {angle:+.2f}°")


@check("image_aspect", "image")
def image_aspect(ctx, params, item):
    img, _ = open_image(item)
    want, tol = float(params["ratio"]), float(params.get("tol", 0.01))
    ratio = img.width / img.height
    if abs(ratio - want) > tol * want:
        return failed(f"{img.width}×{img.height}: аспект {ratio:.4f}")
    w, h = params.get("min_px", [0, 0])
    if img.width < w or img.height < h:
        return failed(f"{img.width}×{img.height} меньше {w}×{h}")
    return passed(f"{img.width}×{img.height}")


@check("image_dpi", "image", quantifier="all")
def image_dpi(ctx, params, item):
    img, dpi = open_image(item)
    want = float(params.get("dpi", 300))
    if dpi and abs(float(dpi[0]) - want) <= 1:
        return passed(f"DPI {dpi[0]:.0f}")
    for mm in ((35, 45), (100, 150), (45, 35), (150, 100)):
        px = (mm[0] / 25.4 * want, mm[1] / 25.4 * want)
        if abs(img.width - px[0]) <= 0.02 * px[0] and abs(img.height - px[1]) <= 0.02 * px[1]:
            return passed(f"{img.width}×{img.height} = {mm[0]}×{mm[1]} мм при {want:.0f} dpi")
    return failed(f"DPI {dpi}, {img.width}×{img.height} px")


def _pages_as_images(ctx, item, dpi: int) -> list:
    from .select import group_of

    if group_of(item) == "pdf":
        return [ctx.render(item.path, n, dpi) for n in range(1, ctx.page_count(item.path) + 1)]
    img, _ = open_image(item)
    return [img]


@check("image_region", "any")
def image_region(ctx, params, item):
    import numpy as np

    if "min_median" in params:
        for n, img in enumerate(_pages_as_images(ctx, item, 100), start=1):
            arr = np.asarray(img.convert("RGB"), dtype=np.float32)
            lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
            h, w = lum.shape
            s = max(1, int(round(8 * w / 210)))
            for name, strip in (("сверху", lum[:s]), ("снизу", lum[-s:]), ("слева", lum[:, :s]), ("справа", lum[:, -s:])):
                med = float(np.median(strip))
                if med < float(params["min_median"]):
                    return failed(f"стр. {n}: поле {name} медиана {med:.0f}")
            hsv = np.asarray(img.convert("HSV"), dtype=np.float32)
            hue, sat, val = hsv[..., 0] * 360 / 255, hsv[..., 1] / 255, hsv[..., 2] / 255
            brown = (hue >= 15) & (hue <= 45) & (sat >= 0.25) & (val >= 0.15) & (val <= 0.85)
            if float(brown.mean()) > float(params.get("max_brown", 0.005)):
                return failed(f"стр. {n}: стола {brown.mean():.2%}")
        return passed("поля белые, стола нет")
    from .select import group_of

    if group_of(item) != "image":
        return failed("не картинка")
    img, _ = open_image(item)
    if params.get("photo_aspect") and not _aspect_ok(img, float(params["photo_aspect"])):
        return failed(f"кадр {img.width}×{img.height} — не фото 35×45")
    arr = np.asarray(img, dtype=np.float32)
    lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    ppm = img.width / 35.0
    h = lum.shape[0]
    cw, ch, side = int(10 * ppm), int(4 * ppm), max(1, int(2 * ppm))
    eye_y = int(h - 27 * ppm)
    strips = {"угол слева": lum[:ch, :cw], "угол справа": lum[:ch, -cw:],
              "бок слева": lum[eye_y - int(2.5 * ppm):eye_y + int(2.5 * ppm), :side],
              "бок справа": lum[eye_y - int(2.5 * ppm):eye_y + int(2.5 * ppm), -side:]}
    for name, strip in strips.items():
        if strip.size == 0:
            continue
        if strip.mean() < float(params["min_mean"]) or strip.std() > float(params["max_std"]):
            return failed(f"{name}: яркость {strip.mean():.0f}, σ {strip.std():.1f}")
    return passed("фон белый")


@check("print_sheet", "any")
def print_sheet(ctx, params, item):
    import numpy as np

    from .select import group_of
    from .signed import components, dilate

    want_w, want_h = params["size_mm"]
    tol = float(params.get("size_tol_mm", 1))
    if group_of(item) == "pdf":
        w_pt, h_pt = ctx.geometry(item.path, 1).view_size
        size = (w_pt / 72 * 25.4, h_pt / 72 * 25.4)
        img = ctx.render(item.path, 1, 300)
        ppm = 300 / 25.4
    else:
        img, dpi = open_image(item)
        d = float(dpi[0]) if dpi else 300.0
        ppm = d / 25.4
        size = (img.width / ppm, img.height / ppm)
    if size[0] > size[1]:
        size = (size[1], size[0])
    if abs(size[0] - want_w) > tol or abs(size[1] - want_h) > tol:
        return failed(f"лист {size[0]:.1f}×{size[1]:.1f} мм")
    colors = params.get("colors") or {"hair": [55, 38, 28], "skin": [224, 182, 150], "white": [255, 255, 255]}
    small = img.copy()
    scale = min(1.0, 900 / max(img.size))
    if scale < 1:
        small = small.resize((int(img.width * scale), int(img.height * scale)))
    names, label = classify(small, colors, 40)
    head = (label == names.index("skin")) | (label == names.index("hair"))
    blobs = [b for b in components(dilate(head, 2), min_pixels=200)]
    min_area = (20 * ppm * scale) ** 2 * 0.3
    heads = [b for b in blobs if (b[2] - b[0]) * (b[3] - b[1]) >= min_area]
    if len(heads) != int(params.get("heads", 6)):
        return failed(f"голов {len(heads)}")
    lo, hi = params["head_len_mm"]
    lengths = []
    skin = label == names.index("skin")
    for x0, y0, x1, y1 in heads:
        rows_head = np.nonzero(head[y0:y1, x0:x1].sum(1) >= 2)[0]
        rows_skin = np.nonzero(skin[y0:y1, x0:x1].sum(1) >= 2)[0]
        if len(rows_head) == 0 or len(rows_skin) == 0:
            return failed("голова без лица")
        lengths.append((rows_skin.max() - rows_head.min()) / (ppm * scale))
    bad = [round(v, 1) for v in lengths if not lo - 0.5 <= v <= hi + 0.5]
    if bad:
        return failed(f"длина головы {bad} мм")
    return passed(f"{len(heads)} голов по {min(lengths):.1f}–{max(lengths):.1f} мм, лист {size[0]:.0f}×{size[1]:.0f} мм")
