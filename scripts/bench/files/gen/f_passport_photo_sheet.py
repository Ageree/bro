"""Fixture for f-passport-photo-sheet.

selfie.jpg  synthetic portrait (not a real person). Displayed frame 3024×4032 (portrait), but the pixels are
            stored as 4032×3024 with EXIF Orientation=6 (rotate 90° clockwise to display) — orientation trap.
            Display coordinates: wall (200,196,186) with a vertical gradient ±10 and noise σ=4; skin ellipse
            centre (1512,1700), semi-axes 330×430, colour (224,182,150) → chin at y=2130; dark-brown hair
            (55,38,28) up to y=1180 (crown) → head length 950 px; eyes = discs r=34 (35,35,40) in eye whites at
            (1372,1640) and (1652,1640); nose and mouth strokes; shoulders (40,60,110) from y=2250. The whole head
            is rolled 4° (counter-clockwise on screen) around (1512,1700). A turtleneck collar (34,52,98) covers the
            neck, so «bottom of the skin» is the chin. JPEG q=90.
            «ОБРАЗЕЦ / SPECIMEN» is printed on the shirt (outside any passport crop).

truth/selfie_geometry.json          geometry in display px (before and after the roll), colours, derived
                                    passport-crop numbers, how the stored pixels relate to the display frame
truth/selfie_mask_{hair,skin,eyes}.png  1-bit masks in display px (after the roll)
"""

from __future__ import annotations

import math
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

W, H = 3024, 4032
WALL = (200, 196, 186)
SKIN = (224, 182, 150)
HAIR = (55, 38, 28)
EYE = (35, 35, 40)
SHIRT = (40, 60, 110)
COLLAR = (34, 52, 98)          # turtleneck under the chin: no bare neck below the face
CX, CY = 1512, 1700
SKIN_AX = (330, 430)
HAIR_AX = (330, 520)            # crown at CY - 520 = 1180; never wider than the skin ellipse
EYES = [(1372, 1640), (1652, 1640)]
EYE_R = 34
ROLL = 4.0                      # degrees, counter-clockwise on screen (PIL sense)
SHOULDER_Y = 2250
SEED = 3024


def _rot(x, y, deg=ROLL, cx=CX, cy=CY):
    """Where PIL's Image.rotate(deg, center=(cx, cy)) moves the point (x, y) (y down, + = CCW on screen)."""
    t = math.radians(deg)
    dx, dy = x - cx, y - cy
    return cx + dx * math.cos(t) + dy * math.sin(t), cy - dx * math.sin(t) + dy * math.cos(t)


def _ellipse_mask(cx, cy, ax, ay):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    return ((xx - cx) / ax) ** 2 + ((yy - cy) / ay) ** 2 <= 1.0


def _head_layers():
    """Upright head (before the roll): RGBA image + boolean masks (hair, skin, eye discs)."""
    rng = np.random.default_rng(SEED)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    skin_m = _ellipse_mask(CX, CY, *SKIN_AX)
    hair_outer = _ellipse_mask(CX, CY, *HAIR_AX)
    hairline = 1420 + 165 * np.clip(np.abs(xx - CX) / SKIN_AX[0], 0, 1.2) ** 2
    hair_m = hair_outer & (yy < hairline)
    # a few strands over the forehead
    strands = np.zeros((H, W), bool)
    for k, (x0, ln) in enumerate(((1430, 70), (1490, 95), (1560, 80), (1610, 60))):
        strands |= (np.abs(xx - (x0 + (yy - 1400) * 0.35)) < 14) & (yy >= 1400) & (yy < 1400 + ln) & skin_m
    hair_m |= strands
    skin_m = skin_m & ~hair_m
    rgb = np.zeros((H, W, 3), np.float32)
    # skin: soft left-right shading (±8) and fine texture — stays well inside the colour tolerance
    sk = np.array(SKIN, np.float32) + ((xx - CX) / SKIN_AX[0] * -6.0)[..., None]
    sk += (C.px_smooth_noise((H, W), 60, SEED + 1) * 2.5)[..., None]
    rgb[skin_m] = sk[skin_m]
    hr = np.array(HAIR, np.float32) + np.zeros((H, W, 1), np.float32)
    streak = (np.sin((xx - CX) / 9.0 + 3 * np.sin(yy / 80.0)) > 0.86)
    hr[streak] += (18, 13, 9)                                     # lighter strands only (never towards eye colour)
    hr += rng.normal(0, 2.5, (H, W, 1)).astype(np.float32)
    rgb[hair_m] = hr[hair_m]
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    alpha = np.zeros((H, W), np.uint8)
    alpha[skin_m | hair_m] = 255
    img.putalpha(Image.fromarray(alpha, "L"))
    d = ImageDraw.Draw(img)
    eye_m = np.zeros((H, W), bool)
    for ex, ey in EYES:
        d.ellipse([ex - 74, ey - 40, ex + 74, ey + 40], fill=(238, 236, 232, 255))           # eye white
        d.ellipse([ex - EYE_R, ey - EYE_R, ex + EYE_R, ey + EYE_R], fill=EYE + (255,))      # iris+pupil disc
        d.ellipse([ex + 8, ey - 18, ex + 18, ey - 8], fill=(236, 236, 236, 255))            # catch light
        d.arc([ex - 80, ey - 52, ex + 80, ey + 40], 200, 340, fill=(150, 108, 84, 255), width=8)  # upper lid
        d.arc([ex - 92, ey - 118, ex + 92, ey - 40], 200, 340, fill=(110, 78, 58, 255), width=18)  # eyebrow
        eye_m |= ((xx - ex) ** 2 + (yy - ey) ** 2) <= EYE_R ** 2
    # nose: bridge shadow and nostrils; mouth
    d.line([(CX - 18, 1680), (CX - 30, 1820), (CX - 6, 1860)], fill=(196, 150, 120, 255), width=9, joint="curve")
    d.ellipse([CX - 52, 1848, CX - 22, 1868], fill=(160, 112, 92, 255))
    d.ellipse([CX + 22, 1848, CX + 52, 1868], fill=(160, 112, 92, 255))
    d.chord([CX - 96, 1938, CX + 96, 1998], 0, 180, fill=(176, 96, 92, 255))
    d.chord([CX - 96, 1918, CX + 96, 1968], 180, 360, fill=(160, 84, 82, 255))
    d.line([(CX - 96, 1960), (CX + 96, 1960)], fill=(120, 60, 60, 255), width=4)
    # skin truth = drawn pixels of the face that still have the skin colour (features excluded)
    arr = np.asarray(img, np.float32)
    skin_m = skin_m & (np.abs(arr[..., :3] - np.array(SKIN, np.float32)).max(axis=2) <= 16)
    return img, hair_m, skin_m, eye_m


def _display_image():
    rng = np.random.default_rng(SEED + 7)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    wall = np.array(WALL, np.float32) + (10.0 - 20.0 * yy / H)[..., None]
    wall += rng.normal(0, 4.0, (H, W, 1)).astype(np.float32) + rng.normal(0, 1.0, (H, W, 3)).astype(np.float32)
    base = Image.fromarray(np.clip(wall, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    d = ImageDraw.Draw(base)
    # turtleneck collar (hidden behind the chin at its top), then shoulders
    d.rounded_rectangle([CX - 172, 2040, CX + 172, SHOULDER_Y + 140], radius=70, fill=COLLAR + (255,))
    for y in range(2080, SHOULDER_Y + 120, 34):
        d.line([(CX - 160, y), (CX + 160, y)], fill=(28, 44, 86, 255), width=5)
    sh = [(CX - 380, SHOULDER_Y), (CX + 380, SHOULDER_Y), (CX + 1300, 2650), (W, 2900), (W, H), (0, H), (0, 2900),
          (CX - 1300, 2650)]
    d.polygon(sh, fill=SHIRT + (255,))
    d.rounded_rectangle([CX - 172, SHOULDER_Y - 20, CX + 172, SHOULDER_Y + 140], radius=70, fill=COLLAR + (255,))
    for y in range(SHOULDER_Y, SHOULDER_Y + 120, 34):
        d.line([(CX - 160, y), (CX + 160, y)], fill=(28, 44, 86, 255), width=5)
    fnt = C.ff_pil_font("DejaVuSans-Bold", 90)
    d.text((W / 2, 3700), "ОБРАЗЕЦ / SPECIMEN", font=fnt, fill=(235, 235, 240, 255), anchor="mm")
    d.text((W / 2, 3830), "синтетическое изображение, не реальный человек", font=C.ff_pil_font("DejaVuSans", 54),
           fill=(220, 222, 232, 255), anchor="mm")
    head, hair_m, skin_m, eye_m = _head_layers()
    head_r = head.rotate(ROLL, resample=Image.BICUBIC, center=(CX, CY))
    base.alpha_composite(head_r)
    img = base.convert("RGB").filter(ImageFilter.GaussianBlur(1.0))           # camera softness

    def rot_mask(m):
        im = Image.fromarray(m.astype(np.uint8) * 255, "L").rotate(ROLL, resample=Image.BILINEAR, center=(CX, CY))
        return np.asarray(im) >= 128
    return img, rot_mask(hair_m), rot_mask(skin_m), rot_mask(eye_m)


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir, truth_dir = pathlib.Path(out_dir), pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    disp, hair_m, skin_m, eye_m = _display_image()
    stored = disp.transpose(Image.ROTATE_90)                  # 4032×3024; EXIF 6 rotates it back clockwise
    exif = C.ff_exif_bytes(6, when="2026:10:12 09:14:33")
    out = out_dir / "selfie.jpg"
    out.write_bytes(C.ff_jpeg_bytes(stored, 90, exif=exif))
    with Image.open(out) as chk:
        assert chk.size == (4032, 3024)
        shown = ImageOps.exif_transpose(chk)
        assert shown.size == (W, H)
        a = np.asarray(shown.convert("RGB"), np.float32)
        b = np.asarray(disp, np.float32)
        assert float(np.abs(a - b).mean()) < 3.0                   # JPEG round trip only

    masks = {}
    for name, m in (("hair", hair_m), ("skin", skin_m), ("eyes", eye_m)):
        p = truth_dir / f"selfie_mask_{name}.png"
        Image.fromarray(m.astype(np.uint8) * 255, "L").convert("1").save(p, optimize=False)
        masks[name] = p.name

    # measured geometry (display px, after the roll)
    hy, hx = np.nonzero(hair_m)
    sy, sx = np.nonzero(skin_m)
    crown = (float(hx[hy.argmin()]), float(hy.min()))
    chin = (float(sx[sy.argmax()]), float(sy.max()))
    eyes_r = [_rot(x, y) for x, y in EYES]
    eye_angle = math.degrees(math.atan2(eyes_r[1][1] - eyes_r[0][1], eyes_r[1][0] - eyes_r[0][0]))
    head_m = hair_m | skin_m
    # width across the head axis: rotate the mask back upright and take the widest row
    up = np.asarray(Image.fromarray(head_m.astype(np.uint8) * 255, "L").rotate(-ROLL, resample=Image.NEAREST,
                                                                                  center=(CX, CY))) > 0
    cols = up.any(axis=0)
    width_px = int(cols.sum())
    rows = np.nonzero(up.any(axis=1))[0]
    head_len_upright = int(rows.max() - rows.min() + 1)
    eye_from_crown = EYES[0][1] - (CY - HAIR_AX[1])
    chin_from_eye = (CY + SKIN_AX[1]) - EYES[0][1]

    def layout(head_mm=34.0, top_mm=4.0):
        ppm = 950.0 / head_mm
        eyes_from_bottom = 45.0 - top_mm - eye_from_crown / ppm
        return {"head_len_mm": head_mm, "crown_from_top_mm": top_mm, "px_per_mm_in_selfie": round(ppm, 3),
                "crop_size_px_in_selfie": [round(35 * ppm, 1), round(45 * ppm, 1)],
                "eyes_from_bottom_mm": round(eyes_from_bottom, 2),
                "head_width_mm": round(width_px / ppm, 2), "chin_from_bottom_mm": round(45.0 - top_mm - head_mm, 2)}
    truth = {
        "case": "f-passport-photo-sheet",
        "file": out.name,
        "stored_size_px": [4032, 3024],
        "exif_orientation": 6,
        "display_size_px": [W, H],
        "stored_to_display": "display = stored rotated 90° clockwise (PIL: stored.transpose(ROTATE_270)); "
                             "stored = display.transpose(ROTATE_90)",
        "colors": {"wall": list(WALL), "skin": list(SKIN), "hair": list(HAIR), "eye": list(EYE), "shirt": list(SHIRT),
                   "turtleneck_collar": list(COLLAR)},
        "wall_gradient": "+10 at the top → −10 at the bottom, noise σ=4",
        "head_upright": {"center": [CX, CY], "skin_semi_axes": list(SKIN_AX), "hair_outer_semi_axes": list(HAIR_AX),
                         "crown_y": CY - HAIR_AX[1], "chin_y": CY + SKIN_AX[1], "head_length_px": 950,
                         "eye_centers": [list(e) for e in EYES], "eye_radius": EYE_R,
                         "eye_line_from_crown_px": eye_from_crown, "chin_from_eye_line_px": chin_from_eye},
        "roll": {"deg_ccw_on_screen": ROLL, "center": [CX, CY],
                 "eye_centers_after": [[round(x, 1), round(y, 1)] for x, y in eyes_r],
                 "eye_line_angle_deg_image_coords": round(eye_angle, 3),
                 "fix": "rotate the image by −4° (PIL rotate(-4)) around the head centre to level the eyes"},
        "measured_after_roll": {"crown_point": [round(v, 1) for v in crown], "chin_point": [round(v, 1) for v in chin],
                                "head_length_upright_px": head_len_upright, "head_width_upright_px": width_px,
                                "skin_width_px": 2 * SKIN_AX[0]},
        "shoulders_top_y": SHOULDER_Y,
        "passport_layout_examples": [layout(34.0, 4.0), layout(33.0, 5.0), layout(35.0, 3.0)],
        "check_ranges": {"head_len_mm": [32, 36], "eyes_from_bottom_mm": [23, 31], "head_width_mm": [18, 25]},
        "masks": masks,
        "notes": "Masks are 1-bit PNGs in display px after the roll. A dark-blue turtleneck covers the neck, so the "
                 "lowest skin-coloured pixel is the chin (a bare or shadowed neck mixes with a white background into "
                 "skin-like colours and moves «the bottom of the skin» down). Hair colour and eye colour are only "
                 "23.5 apart (Euclidean): classify output pixels by the nearest of the listed colours, not by "
                 "tolerance alone.",
    }
    for ex in truth["passport_layout_examples"]:
        assert 23 <= ex["eyes_from_bottom_mm"] <= 31 and 18 <= ex["head_width_mm"] <= 25, ex
    tp = truth_dir / "selfie_geometry.json"
    C.ff_write_json(tp, truth)
    return [str(out), str(tp)] + [str(truth_dir / v) for v in masks.values()]


if __name__ == "__main__":
    root = HERE.parent
    for p in build(root / "out" / "f-passport-photo-sheet", root / "truth"):
        print(p)
