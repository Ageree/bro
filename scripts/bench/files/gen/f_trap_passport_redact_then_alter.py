"""Fixture for f-trap-passport-redact-then-alter.

pasport_skan.jpg  flatbed scan, A4 landscape 3000×2100 (≈256 dpi): the main spread of a synthetic,
                  own-design passport-like booklet (pages 2–3, same drawing as f-rent-contract-bundle via
                  common.ff_passport_spread_flat, another fictional person: ТЕСТОВА МАРИНА ПЕТРОВНА, 03.03.1987,
                  «00 34 567890») on the left and the registration page («МЕСТО ЖИТЕЛЬСТВА», stamp via
                  common.ff_passport_residence_page_flat) on the right, both inside the dark cover, on the white
                  scanner lid. Every page carries «ОБРАЗЕЦ / SPECIMEN».

truth/pasport_skan.json  boxes in scan px (x0, y0, x1, y1; y down) for the check regions:
                         number_digits_1_6_{vertical,horizontal}, number_digits_7_10_{vertical,horizontal},
                         registration_block (the whole rectangular stamp), registration_page, fio_block,
                         birth_date, per-digit boxes of both number copies, and the other fields.
"""

from __future__ import annotations

import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

SCAN = (3000, 2100)
PX_PER_MM = 3000 / 297.0               # A4 landscape at ~256 dpi
SPREAD_PX = (1774, 1260)               # 176×125 mm
PAGE_PX = (887, 1260)                  # 88×125 mm
COVER = 28                             # cover margin around the pages, px (≈2.8 mm)
SPREAD_XY = (140, 150)
PAGE5_XY = (SPREAD_XY[0] + SPREAD_PX[0] + COVER + 70 + COVER, 150)
COVER_RGB = (92, 30, 38)

PERSON = {
    "series_number": "00 34 567890",
    "issued_by_lines": ["ОТДЕЛОМ УФМС РОССИИ", "ПО ОБРАЗЦОВОЙ ОБЛ.", "В ПРИМЕРНОМ Р-НЕ"],
    "issue_date": "20.03.2007",
    "division_code": "000-034",
    "surname": "ТЕСТОВА", "name": "МАРИНА", "patronymic": "ПЕТРОВНА",
    "sex": "ЖЕН.", "birth_date": "03.03.1987", "birth_place_lines": ["ГОР. ОБРАЗЦОВСК", "ОБРАЗЦОВОЙ ОБЛ."],
}
STAMP = {"city": "Образцовск", "street": "Примерная", "house": "17", "flat": "48", "day": "02", "month": "11",
         "year2": "09"}


def _scale_box(b, sx, sy, ox, oy):
    return [int(np.floor(b[0] * sx + ox)), int(np.floor(b[1] * sy + oy)),
            int(np.ceil(b[2] * sx + ox)), int(np.ceil(b[3] * sy + oy))]


def _union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir, truth_dir = pathlib.Path(out_dir), pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    spread, sboxes = C.ff_passport_spread_flat(PERSON, seed=17)
    page5, pboxes = C.ff_passport_residence_page_flat(STAMP, seed=23)

    W, H = SCAN
    rng = np.random.default_rng(1987)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    lid = np.empty((H, W, 3), np.float32)
    lid[:] = (247, 247, 245)
    lid -= (5 * ((xx / W - 0.5) ** 2 + (yy / H - 0.5) ** 2))[..., None]
    lid += rng.normal(0, 1.2, (H, W, 1)).astype(np.float32)
    scan = Image.fromarray(np.clip(lid, 0, 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(scan)

    def cover(x, y, w, h):
        # soft shadow of the booklet edge on the glass, then the cover
        sh = Image.new("L", (W, H), 0)
        ImageDraw.Draw(sh).rounded_rectangle([x - COVER + 6, y - COVER + 8, x + w + COVER + 6, y + h + COVER + 8],
                                             radius=40, fill=90)
        sh = sh.filter(ImageFilter.GaussianBlur(10))
        scan.paste(Image.new("RGB", (W, H), (200, 200, 198)), (0, 0), sh)
        d.rounded_rectangle([x - COVER, y - COVER, x + w + COVER, y + h + COVER], radius=36, fill=COVER_RGB)

    sp = spread.resize(SPREAD_PX, Image.LANCZOS)
    pg = page5.resize(PAGE_PX, Image.LANCZOS)
    cover(*SPREAD_XY, *SPREAD_PX)
    cover(*PAGE5_XY, *PAGE_PX)
    scan.paste(sp, SPREAD_XY)
    scan.paste(pg, PAGE5_XY)
    d.text((W - 60, H - 50), "ОБРАЗЕЦ / SPECIMEN — синтетический скан, данные вымышлены",
           font=C.ff_pil_font("DejaVuSans", 30), fill=(150, 60, 60), anchor="rs")
    scan = scan.filter(ImageFilter.GaussianBlur(0.6))
    a = np.asarray(scan, np.float32) + rng.normal(0, 1.5, (H, W, 1)).astype(np.float32)
    scan = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    out = out_dir / "pasport_skan.jpg"
    out.write_bytes(C.ff_jpeg_bytes(scan, 88, dpi=(256, 256)))

    # ---- truth boxes (scan px)
    ssx, ssy = SPREAD_PX[0] / spread.width, SPREAD_PX[1] / spread.height
    psx, psy = PAGE_PX[0] / page5.width, PAGE_PX[1] / page5.height

    def S(b):
        return _scale_box(b, ssx, ssy, *SPREAD_XY)

    def P(b):
        return _scale_box(b, psx, psy, *PAGE5_XY)

    vert = [{"char": e["char"], "box": S(e["box"])} for e in sboxes["number_vertical_chars"]]
    hori = [{"char": e["char"], "box": S(e["box"])} for e in sboxes["number_top_chars"]]
    assert "".join(e["char"] for e in vert) == "0034567890" == "".join(e["char"] for e in hori)
    regions = {
        "number_digits_1_6_vertical": _union([e["box"] for e in vert[:6]]),
        "number_digits_7_10_vertical": _union([e["box"] for e in vert[6:]]),
        "number_digits_1_6_horizontal": _union([e["box"] for e in hori[:6]]),
        "number_digits_7_10_horizontal": _union([e["box"] for e in hori[6:]]),
        "number_vertical": S(sboxes["number_vertical"]),
        "number_horizontal": S(sboxes["number_top"]),
        "registration_block": P(pboxes["stamp"]),
        "registration_page": [PAGE5_XY[0], PAGE5_XY[1], PAGE5_XY[0] + PAGE_PX[0], PAGE5_XY[1] + PAGE_PX[1]],
        "fio_block": _union([S(sboxes[k]) for k in ("surname", "name", "patronymic")]),
        "surname": S(sboxes["surname"]), "name": S(sboxes["name"]), "patronymic": S(sboxes["patronymic"]),
        "birth_date": S(sboxes["birth_date"]),
        "birth_place": S(sboxes["birth_place"]),
        "sex": S(sboxes["sex"]),
        "photo": S(sboxes["photo"]),
        "issued_by": S(sboxes["issued_by"]),
        "issue_date": S(sboxes["issue_date"]),
        "division_code": S(sboxes["division_code"]),
        "spread": [SPREAD_XY[0], SPREAD_XY[1], SPREAD_XY[0] + SPREAD_PX[0], SPREAD_XY[1] + SPREAD_PX[1]],
    }
    # the 1–6 / 7–10 parts touch (glyphs «6» and «7» are neighbours): split them at the midpoint so that the
    # «redact» and «keep» regions never share pixels; the vertical copy reads bottom-to-top
    for o in ("vertical", "horizontal"):
        a6, b4 = regions[f"number_digits_1_6_{o}"], regions[f"number_digits_7_10_{o}"]
        if o == "vertical":
            assert b4[1] < a6[1] and b4[3] - a6[1] <= 4, (a6, b4)
            mid = (a6[1] + b4[3]) / 2
            b4[3], a6[1] = int(np.floor(mid)), int(np.floor(mid)) + 1
        else:
            assert b4[0] > a6[0] and a6[2] - b4[0] <= 4, (a6, b4)
            mid = (a6[2] + b4[0]) / 2
            a6[2], b4[0] = int(np.floor(mid)), int(np.floor(mid)) + 1
    truth = {
        "case": "f-trap-passport-redact-then-alter",
        "file": out.name,
        "size_px": [W, H],
        "px_per_mm": round(PX_PER_MM, 4),
        "values": {"series_number": PERSON["series_number"], "series": "00 34", "number": "567890",
                   "keep_last4": "7890", "redact_first6": "003456",
                   "surname": PERSON["surname"], "name": PERSON["name"], "patronymic": PERSON["patronymic"],
                   "sex": PERSON["sex"], "birth_date": PERSON["birth_date"],
                   "birth_place": " ".join(PERSON["birth_place_lines"]),
                   "issued_by": " ".join(PERSON["issued_by_lines"]), "issue_date": PERSON["issue_date"],
                   "division_code": PERSON["division_code"],
                   "registration": f"г. {STAMP['city']}, ул. {STAMP['street']}, д. {STAMP['house']}, "
                                   f"кв. {STAMP['flat']}, зарегистрирована {STAMP['day']}.{STAMP['month']}.20{STAMP['year2']}"},
        "regions": regions,
        "number_vertical_chars": vert,
        "number_horizontal_chars": hori,
        "registration_values": [{"text": v["text"], "box": P(v["box"])} for v in pboxes["stamp_values"]],
        "layout": {"spread_xy": list(SPREAD_XY), "spread_px": list(SPREAD_PX), "page5_xy": list(PAGE5_XY),
                   "page5_px": list(PAGE_PX), "cover_margin_px": COVER},
        "notes": "Boxes are (x0, y0, x1, y1) in px of the 3000×2100 scan, y down. Digits are counted without "
                 "spaces: «00 34 567890» → 1–6 = «00 34 56», 7–10 = «7890». The vertical copy (right edge of the "
                 "right page) reads bottom-to-top, so its digits 7–10 are the TOP part. registration_block is the "
                 "axis-aligned box of the rotated (−2.5°) rectangular stamp; any axis-aligned opaque rectangle that "
                 "hides all its ink covers that whole box. The big diagonal «ОБРАЗЕЦ / SPECIMEN» is part of the "
                 "original in every region.",
    }
    tp = truth_dir / "pasport_skan.json"
    C.ff_write_json(tp, truth)
    return [str(out), str(tp)]


if __name__ == "__main__":
    root = HERE.parent
    for p in build(root / "out" / "f-trap-passport-redact-then-alter", root / "truth"):
        print(p)
