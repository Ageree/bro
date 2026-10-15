"""Fixture generator for f-flat-scan-otpusk-overlay.

Builds zayavlenie_otpusk_scan.pdf: a blank vacation-request form (reportlab, A4),
rasterised at 200 dpi, rotated 0.7° CCW about the page centre, shifted (+9, −6) px,
noised (σ=6), vignetted, JPEG q=60, wrapped into a one-page PDF with no text layer.
Writes truth/zayavlenie_otpusk_scan.json with every field rect re-computed for the
rotation/shift (pt, origin bottom-left of the A4 page).

Deviation from the recipe: the form text is set in LiberationSerif 12 (Times metrics,
like a real HR form) instead of DejaVuSerif 12 — with DejaVuSerif the word
"продолжительностью" alone is 138 pt wide and cannot fit before the `days` blank at
x=180 (see issues/f-flat-scan-otpusk-overlay.md). All rects are exactly the recipe's.
"""

from __future__ import annotations

import io
import math
import pathlib
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageFilter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common as C  # noqa: E402

CASE_ID = "f-flat-scan-otpusk-overlay"
NAME = "zayavlenie_otpusk_scan.pdf"
TRUTH = "zayavlenie_otpusk_scan.json"
PAGE_W, PAGE_H = C.FF_A4
DPI = 200
ANGLE_CCW = 0.7
SHIFT_PX = (9, -6)  # +x right, −y = up in image coordinates
NOISE_SIGMA = 6
JPEG_Q = 60
SEED = 2

BODY = "LiberationSerif"
BOLD = "LiberationSerif-Bold"
FS = 12

# Field rects exactly as in the recipe: [x0, y0, x1, y1] pt from bottom-left.
FIELDS = {
    "dolzhnost": ([330, 688, 545, 706], "text", "менеджера по продажам"),
    "fio": ([330, 664, 545, 682], "text", "Кузнецовой Ольги Сергеевны"),
    "otdel": ([330, 640, 545, 658], "text", "отдела продаж"),
    "start_day": ([205, 560, 225, 576], "text", "03"),
    "start_month": ([235, 560, 320, 576], "text", "ноября"),
    "start_year": ([338, 560, 356, 576], "text", "26"),
    "end_day": ([400, 560, 420, 576], "text", "17"),
    "end_month": ([430, 560, 515, 576], "text", "ноября"),
    "end_year": ([533, 560, 551, 576], "text", "26"),
    "days": ([180, 536, 215, 552], "text", "14"),
    "card": ([60, 480, 72, 492], "checkbox", True),
    "advance": ([60, 456, 72, 468], "checkbox", False),
    "date_day": ([68, 380, 88, 396], "text", "{today:%d}"),
    "date_month": ([98, 380, 183, 396], "text", "{today_month_genitive}"),
    "date_year": ([201, 380, 219, 396], "text", "{today:%y}"),
    "signature": ([300, 378, 420, 398], "signature", None),
    "decoding": ([440, 380, 560, 396], "text", "О. С. Кузнецова"),
}
# Extra blanks that must stay empty (not in the recipe's checks; realistic distractor).
EXTRA_EMPTY = {
    "approver_signature": [262, 318, 372, 336],
    "approver_decoding": [392, 318, 545, 336],
}


# ----------------------------------------------------------------------------- form
def _form_pdf(path: pathlib.Path, printed: list) -> None:
    from reportlab.pdfbase.pdfmetrics import stringWidth

    C.ff_register_rl_fonts(BODY, BOLD, "LiberationSerif-Italic", "DejaVuSans-Bold", "DejaVuSans")
    c = C.ff_rl_canvas(str(path), title="Заявление на отпуск (бланк, ОБРАЗЕЦ)")

    def text(x, y, s, font=BODY, size=FS, align="left", color=(0, 0, 0), record=True):
        w = stringWidth(s, font, size)
        if align == "right":
            x -= w
        elif align == "center":
            x -= w / 2
        c.setFillColorRGB(*color)
        c.setFont(font, size)
        c.drawString(x, y, s)
        if record:
            # glyph box: descender ≈ −0.22·size, cap/ascender ≈ 0.70·size for Times-like serif
            printed.append({"text": s, "rect": [round(x, 2), round(y - 0.22 * size, 2), round(x + w, 2),
                                                 round(y + 0.70 * size, 2)]})
        return x, x + w

    def justify(x0, x1, y, s, font=BODY, size=FS):
        words = s.split(" ")
        total = sum(stringWidth(w_, font, size) for w_ in words)
        gap = (x1 - x0 - total) / (len(words) - 1)
        x = x0
        c.setFont(font, size)
        c.setFillColorRGB(0, 0, 0)
        for w_ in words:
            c.drawString(x, y, w_)
            x += stringWidth(w_, font, size) + gap
        printed.append({"text": s, "rect": [round(x0, 2), round(y - 0.22 * size, 2), round(x1, 2),
                                             round(y + 0.70 * size, 2)]})

    def blank(rect, dy=2.0, width=0.6):
        x0, y0, x1, _ = rect
        c.setLineWidth(width)
        c.setStrokeColorRGB(0, 0, 0)
        c.line(x0, y0 + dy, x1, y0 + dy)

    def caption(rect, s):
        x0, y0, x1, _ = rect
        text((x0 + x1) / 2, y0 - 5.0, s, size=7, align="center")

    # SPECIMEN label, top-left, red frame
    c.setStrokeColorRGB(0.78, 0.1, 0.1)
    c.setLineWidth(1.2)
    c.rect(40, 792, 178, 24, stroke=1, fill=0)
    text(129, 799, "ОБРАЗЕЦ / SPECIMEN", font="DejaVuSans-Bold", size=11, align="center", color=(0.78, 0.1, 0.1))
    text(40, 778, "Унифицированный бланк ООО «Образец», ф. О-12 (вымышленный)", size=7, color=(0.25, 0.25, 0.25))

    # header block
    text(330, 772, "Генеральному директору")
    text(330, 756, "ООО «Образец»")
    text(330, 740, "Петрову П. П.")
    f = FIELDS
    text(326, f["dolzhnost"][0][1] + 3.5, "от", align="right")
    for key, cap in (("dolzhnost", "(должность)"), ("fio", "(ФИО полностью)"), ("otdel", "(подразделение)")):
        blank(f[key][0])
        caption(f[key][0], cap)

    text(PAGE_W / 2, 610, "ЗАЯВЛЕНИЕ", font=BOLD, size=13, align="center")

    # paragraph: three lines, pitch 24 pt (baselines 587.5 / 563.5 / 539.5)
    y1, y2, y3 = 587.5, 563.5, 539.5
    justify(60 + 35.4, 560, y1, "Прошу в соответствии со статьёй 114 ТК РФ предоставить мне ежегодный основной")
    justify(60, f["start_day"][0][0] - 1.0, y2, "оплачиваемый отпуск с «")
    blank(f["start_day"][0])
    text(f["start_day"][0][2] + 1.0, y2, "»")
    blank(f["start_month"][0])
    text(f["start_year"][0][0] - 0.8, y2, "20", align="right")
    blank(f["start_year"][0])
    text(f["start_year"][0][2] + 2.5, y2, "г.")
    text(f["end_day"][0][0] - 1.0, y2, "по «", align="right")
    blank(f["end_day"][0])
    text(f["end_day"][0][2] + 1.0, y2, "»")
    blank(f["end_month"][0])
    text(f["end_year"][0][0] - 0.8, y2, "20", align="right")
    blank(f["end_year"][0])
    text(f["end_year"][0][2] + 2.0, y2, "г.")
    text(60, y3, "продолжительностью")
    blank(f["days"][0])
    text(f["days"][0][2] + 3.0, y3, "календарных дней.")

    # checkboxes
    for key, label in (("card", "Отпускные прошу перечислить на банковскую карту (реквизиты есть в бухгалтерии)."),
                       ("advance", "Прошу выплатить отпускные не позднее чем за 3 дня до начала отпуска.")):
        x0, y0, x1, y1_ = f[key][0]
        c.setLineWidth(0.8)
        c.setStrokeColorRGB(0, 0, 0)
        c.rect(x0, y0, x1 - x0, y1_ - y0, stroke=1, fill=0)
        text(x1 + 8, y0 + 2.5, label)

    # date / signature / decoding
    yd = f["date_day"][0][1] + 3.5
    text(f["date_day"][0][0] - 1.0, yd, "«", align="right")
    blank(f["date_day"][0])
    text(f["date_day"][0][2] + 1.0, yd, "»")
    blank(f["date_month"][0])
    text(f["date_year"][0][0] - 0.8, yd, "20", align="right")
    blank(f["date_year"][0])
    text(f["date_year"][0][2] + 2.0, yd, "г.")
    text(f["signature"][0][0] - 4.0, yd, "Подпись", align="right")
    sx0, sy0, sx1, _ = f["signature"][0]
    c.setLineWidth(0.6)
    c.line(sx0, yd - 1.5, sx1, yd - 1.5)
    blank(f["decoding"][0])
    caption(f["decoding"][0], "(расшифровка)")

    # approver block (must stay empty)
    text(60, 322, "СОГЛАСОВАНО:", font=BOLD, size=10)
    text(60, 309, "руководитель подразделения", size=10)
    for key, cap in (("approver_signature", "(подпись)"), ("approver_decoding", "(расшифровка)")):
        blank(EXTRA_EMPTY[key])
        caption(EXTRA_EMPTY[key], cap)
    text(60, 276, "Отметка отдела кадров: ______________________________", size=10)

    # big specimen mark in the free lower part of the page
    c.saveState()
    c.setFillColorRGB(0.85, 0.35, 0.35)
    c.translate(PAGE_W / 2, 165)
    c.rotate(14)
    c.setFont("DejaVuSans-Bold", 40)
    c.drawCentredString(0, 0, "ОБРАЗЕЦ / SPECIMEN")
    c.restoreState()
    text(PAGE_W / 2, 40, "Бланк вымышленной организации. Все данные — образец для тестов.", size=7,
         align="center", color=(0.3, 0.3, 0.3))
    c.showPage()
    c.save()


# ----------------------------------------------------------------------------- geometry
def _fwd(x_pt, y_pt, W, H):
    """Map a point of the blank A4 page (pt) to the scanned page (pt)."""
    px, py = x_pt * DPI / 72.0, (PAGE_H - y_pt) * DPI / 72.0
    cx, cy = W / 2.0, H / 2.0
    th = math.radians(ANGLE_CCW)
    dx, dy = px - cx, py - cy
    qx = cx + dx * math.cos(th) + dy * math.sin(th) + SHIFT_PX[0]
    qy = cy - dx * math.sin(th) + dy * math.cos(th) + SHIFT_PX[1]
    return qx * PAGE_W / W, PAGE_H - qy * PAGE_H / H


def _map_rect(rect, W, H):
    x0, y0, x1, y1 = rect
    quad = [_fwd(x, y, W, H) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    xs, ys = [p[0] for p in quad], [p[1] for p in quad]
    return [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)], \
        [[round(x, 2), round(y, 2)] for x, y in quad]


def _ink(gray: np.ndarray, rect, W, H, thr=128):
    x0, y0, x1, y1 = rect
    sx, sy = W / PAGE_W, H / PAGE_H
    c0, c1 = int(math.floor(x0 * sx)), int(math.ceil(x1 * sx))
    r0, r1 = int(math.floor((PAGE_H - y1) * sy)), int(math.ceil((PAGE_H - y0) * sy))
    sub = gray[r0:r1, c0:c1]
    return round(float((sub < thr).mean()), 4)


# ----------------------------------------------------------------------------- build
def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    printed: list = []
    with tempfile.TemporaryDirectory() as td:
        td = pathlib.Path(td)
        blank_pdf = td / "blank.pdf"
        _form_pdf(blank_pdf, printed)
        subprocess.run([C.require_tool("pdftoppm"), "-r", str(DPI), "-png", "-singlefile", str(blank_pdf), str(td / "blank")],
                       check=True)
        im = Image.open(td / "blank.png").convert("RGB")
        W, H = im.size

        # scanner optics: slight blur, paper tint, rotation + shift with lid-gray fill
        im = im.filter(ImageFilter.GaussianBlur(0.55))
        a = np.asarray(im, float) / 255.0
        a = a * np.array([250, 248, 241], float)
        im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
        im = im.rotate(ANGLE_CCW, resample=Image.BICUBIC, center=(W / 2, H / 2), translate=SHIFT_PX,
                       fillcolor=(214, 214, 210))
        a = np.asarray(im, float)
        rng = np.random.default_rng(SEED)
        yy, xx = np.mgrid[0:H, 0:W].astype(float)
        r2 = ((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2
        vign = 1.0 - 0.075 * r2 / 2.0
        a = a * vign[..., None]
        a = a + rng.normal(0, NOISE_SIGMA, (H, W))[..., None] + rng.normal(0, 1.5, (H, W, 3))
        scan = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
        jpg = C.ff_jpeg_bytes(scan, JPEG_Q, dpi=(DPI, DPI))

        pdf_path = out_dir / NAME
        c = C.ff_rl_canvas(str(pdf_path), title="Скан 2026-10-14 (ОБРАЗЕЦ)", author="ScanStation (ОБРАЗЕЦ)",
                           creator="ScanStation 3000 (вымышленный сканер)")
        C.ff_rl_draw_jpeg(c, jpg, 0, 0, PAGE_W, PAGE_H)
        c.showPage()
        c.save()

        gray = np.asarray(Image.open(io.BytesIO(jpg)).convert("L"), float)

    fields = {}
    for name, (rect, kind, expected) in FIELDS.items():
        aabb, quad = _map_rect(rect, W, H)
        item = {"kind": kind, "rect": aabb, "quad": quad, "rect_unrotated": rect, "expected": expected,
                "blank_ink": _ink(gray, aabb, W, H)}
        if kind == "checkbox":
            inner = [aabb[0] + 2.5, aabb[1] + 2.5, aabb[2] - 2.5, aabb[3] - 2.5]
            item["inner_rect"] = [round(v, 2) for v in inner]
            item["blank_ink_inner"] = _ink(gray, inner, W, H)
        fields[name] = item
    for name, rect in EXTRA_EMPTY.items():
        aabb, quad = _map_rect(rect, W, H)
        fields[name] = {"kind": "must_stay_empty", "rect": aabb, "quad": quad, "rect_unrotated": rect,
                        "expected": None, "blank_ink": _ink(gray, aabb, W, H)}
    printed_t = []
    for p in printed:
        aabb, _ = _map_rect(p["rect"], W, H)
        printed_t.append({"text": p["text"], "rect": aabb})

    truth = {
        "case": CASE_ID,
        "file": NAME,
        "page": 1,
        "page_size_pt": [PAGE_W, PAGE_H],
        "units": "pt, origin bottom-left of the PDF page; 'rect' = axis-aligned box of the field after rotation/shift, 'quad' = its 4 corners (ll, lr, ur, ul)",
        "scan": {
            "dpi": DPI,
            "raster_px": [W, H],
            "rotate_ccw_deg": ANGLE_CCW,
            "rotation_center_px": [W / 2, H / 2],
            "shift_px": list(SHIFT_PX),
            "shift_note": "+x = right, −y = up in image pixels (≈ +3.24 pt right, +2.16 pt up on the page)",
            "noise_sigma": NOISE_SIGMA,
            "jpeg_quality": JPEG_Q,
            "text_layer": False,
            "mapping": "blank pt -> px=(x·200/72, (841.89−y)·200/72) -> rotate CCW about centre, +shift -> pt=(px·595.28/W, 841.89−py·841.89/H)",
        },
        "form_font": "LiberationSerif 12 (Times metrics); captions 7 pt",
        "line_pitch_pt": 24,
        "ink_measure": {
            "dpi": DPI,
            "luma_threshold": 128,
            "note": "blank_ink = share of pixels darker than the threshold inside 'rect' on the BLANK scan itself "
                    "(underlines and checkbox borders are printed inside the rects). mark/no_mark checks should "
                    "measure NEW ink (output darker than the blank scan) or subtract blank_ink; for checkboxes use "
                    "inner_rect (2.5 pt inset, border excluded).",
        },
        "fields": fields,
        "printed_text_boxes": printed_t,
        "expected_notes": {
            "end_date": "3 ноября 2026 + 14 календарных дней; 4 ноября 2026 — нерабочий праздничный день (ст. 112 ТК РФ), "
                        "в число календарных дней отпуска не включается (ст. 120 ТК РФ) → последний день 17 ноября 2026",
            "decoding": "расшифровка не проверяется машинно; ожидаемо «О. С. Кузнецова»",
        },
    }
    C.ff_write_json(truth_dir / TRUTH, truth)
    return [str(out_dir / NAME), str(truth_dir / TRUTH)]


if __name__ == "__main__":
    base = pathlib.Path(__file__).resolve().parent.parent
    print("\n".join(build(base / "out" / CASE_ID, base / "truth")))
