"""Fixture for f-ocr-act-table-docx.

akt_47_foto.jpg  bad phone photo of a one-page A4 act «АКТ № 47 сдачи-приёмки оказанных услуг от 31 октября
                 2026 г. (ОБРАЗЕЦ)»: table of 6 columns × 7 rows from datagen.OCR_ACT_ROWS (row 4 prints
                 18 600,00 although 150 × 120,00 = 18 000,00 — the error is in the original), «Итого:
                 184 950,00», «Без НДС», amount in words, claims paragraph, signatures and a translucent blue
                 round stamp «ОБРАЗЕЦ» over the total (alpha 0.55).
                 reportlab → pdftoppm 200 dpi → perspective (corners moved up to 4 % of the frame), rotation
                 2.5°, shadow gradient −35 %, GaussianBlur 1.2, JPEG q=40, 2000 px wide (2000×2667), table
                 background.

truth/akt_47_foto.json   transcript (rows, totals, words, paragraphs), the page quad in the photo, transforms
truth/akt_47_flat.png    the flat render (gray, long side 1024) for reference
"""

from __future__ import annotations

import io
import math
import pathlib
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402
import datagen as DG  # noqa: E402

DPI = 200
PHOTO = (2000, 2667)
MM = 72 / 25.4
SEED = 947

TITLE_1 = "АКТ № 47"
TITLE_2 = "сдачи-приёмки оказанных услуг"
TITLE_3 = "от 31 октября 2026 г. (ОБРАЗЕЦ)"
PLACE_DATE = ("г. Образцовск", "31 октября 2026 г.")
PARTIES = [
    ("Исполнитель:", "ИП Образцова Елена Сергеевна (ИП Образцова Е. С.), ИНН 000000000047, "
                     "ОГРНИП 300000000000047, г. Образцовск, ул. Тестовая, д. 3"),
    ("Заказчик:", "ООО «Ромашка-Образец», ИНН 0000000047, КПП 000001001, г. Образцовск, ул. Примерная, д. 1"),
    ("Основание:", "договор возмездного оказания услуг № 15/26 от 01.09.2026"),
]
HEAD = ["№", "Наименование работ, услуг", "Ед.", "Кол-во", "Цена, руб.", "Сумма, руб."]
COL_MM = [9, 73, 19, 17, 25, 27]          # 170 mm
TOTAL_LINES = [("Итого:", DG.OCR_ACT_TOTAL), ("Без НДС", "—")]
SUMMARY_1 = f"Всего оказано услуг 7, на сумму {DG.OCR_ACT_TOTAL} руб."
SUMMARY_2 = "(Сто восемьдесят четыре тысячи девятьсот пятьдесят рублей 00 копеек)"
CLAIMS = ("Вышеперечисленные услуги выполнены полностью и в срок. Заказчик претензий по объёму, качеству "
          "и срокам оказания услуг не имеет.")
SIGN = [("ИСПОЛНИТЕЛЬ", "ИП Образцова Е. С.", "/ Образцова Е. С. /"),
        ("ЗАКАЗЧИК", "Генеральный директор", "/ Тестов А. А. /")]


def _wrap(c, text, font, size, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        cand = (cur + " " + w).strip()
        if c.stringWidth(cand, font, size) <= width:
            cur = cand
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _stamp(c, cx, cy, r, alpha=0.55):
    from reportlab.lib.colors import Color

    col = Color(0.12, 0.25, 0.70, alpha=alpha)
    c.saveState()
    c.setStrokeColor(col)
    c.setFillColor(col)
    c.setLineWidth(1.6)
    c.circle(cx, cy, r, stroke=1, fill=0)
    c.setLineWidth(0.9)
    c.circle(cx, cy, r * 0.70, stroke=1, fill=0)
    ring = "ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ ОБРАЗЦОВА Е. С. * ОБРАЗЕЦ * "
    n = len(ring)
    c.setFont("DejaVuSans-Bold", r * 0.16)
    for i, ch in enumerate(ring):
        a = math.pi / 2 - 2 * math.pi * i / n
        c.saveState()
        c.translate(cx + r * 0.83 * math.cos(a), cy + r * 0.83 * math.sin(a))
        c.rotate(math.degrees(a) - 90)
        c.drawCentredString(0, -r * 0.055, ch)
        c.restoreState()
    c.setFont("DejaVuSans-Bold", r * 0.22)
    c.drawCentredString(cx, cy + r * 0.08, "ОБРАЗЕЦ")
    c.setFont("DejaVuSans", r * 0.13)
    c.drawCentredString(cx, cy - r * 0.22, "г. Образцовск")
    c.restoreState()


def _scribble(c, x, y, w, seed):
    from reportlab.lib.colors import Color

    rng = np.random.default_rng(seed)
    c.saveState()
    c.setStrokeColor(Color(0.13, 0.18, 0.55, alpha=0.9))
    c.setLineWidth(1.0)
    p = c.beginPath()
    p.moveTo(x, y)
    n = 22
    for k in range(1, n + 1):
        t = k / n
        p.curveTo(x + w * (t - 0.03), y + 9 * math.sin(k * 1.7 + rng.uniform(0, 0.6)),
                  x + w * (t - 0.015), y - 6 * math.cos(k * 1.3),
                  x + w * t, y + 3 * math.sin(k * 0.9))
    c.drawPath(p, stroke=1, fill=0)
    c.restoreState()


def _act_pdf():
    from reportlab.lib.colors import Color, black

    C.ff_register_rl_fonts("LiberationSerif", "LiberationSerif-Bold", "DejaVuSans", "DejaVuSans-Bold")
    buf = io.BytesIO()
    c = C.ff_rl_canvas(buf, title="Акт № 47 сдачи-приёмки оказанных услуг (ОБРАЗЕЦ)")
    W, H = C.FF_A4
    L, R = 25 * MM, W - 15 * MM
    pos = {}
    c.setFillColor(Color(0.78, 0.1, 0.1))
    c.setFont("DejaVuSans", 7.5)
    c.drawRightString(R, H - 10 * MM, "ОБРАЗЕЦ / SPECIMEN — все данные вымышлены")
    c.setFillColor(black)
    y = H - 22 * MM
    c.setFont("LiberationSerif-Bold", 15)
    c.drawCentredString(W / 2, y, TITLE_1)
    y -= 6.5 * MM
    c.setFont("LiberationSerif-Bold", 13)
    c.drawCentredString(W / 2, y, TITLE_2)
    y -= 6 * MM
    c.setFont("LiberationSerif", 12)
    c.drawCentredString(W / 2, y, TITLE_3)
    y -= 11 * MM
    c.setFont("LiberationSerif", 11.5)
    c.drawString(L, y, PLACE_DATE[0])
    c.drawRightString(R, y, PLACE_DATE[1])
    y -= 10 * MM
    for label, text in PARTIES:
        lines = _wrap(c, text, "LiberationSerif", 11.5, R - L - 27 * MM)
        c.setFont("LiberationSerif-Bold", 11.5)
        c.drawString(L, y, label)
        c.setFont("LiberationSerif", 11.5)
        for i, ln in enumerate(lines):
            c.drawString(L + 27 * MM, y - i * 5.2 * MM, ln)
        y -= (len(lines) * 5.2 + 2.2) * MM
    y -= 4 * MM
    # table
    xs = [L]
    for w in COL_MM:
        xs.append(xs[-1] + w * MM)
    head_h, row_h = 12 * MM, 8.4 * MM
    top = y
    c.setLineWidth(0.9)
    c.setStrokeColor(black)
    rows = [HEAD] + [list(map(str, r)) for r in DG.OCR_ACT_ROWS]
    cell_boxes = []
    yy = top
    for ri, row in enumerate(rows):
        h = head_h if ri == 0 else row_h
        boxes = []
        for ci in range(6):
            c.rect(xs[ci], yy - h, xs[ci + 1] - xs[ci], h)
            boxes.append([round(xs[ci], 2), round(yy - h, 2), round(xs[ci + 1], 2), round(yy, 2)])
            txt = row[ci]
            if ri == 0:
                c.setFont("LiberationSerif-Bold", 10.5)
                parts = _wrap(c, txt, "LiberationSerif-Bold", 10.5, xs[ci + 1] - xs[ci] - 2 * MM)
                for k, part in enumerate(parts):
                    c.drawCentredString((xs[ci] + xs[ci + 1]) / 2, yy - h / 2 + ((len(parts) - 1) / 2 - k) * 4.4 * MM - 1.3 * MM,
                                        part)
                continue
            c.setFont("LiberationSerif", 11)
            base = yy - h / 2 - 1.3 * MM
            if ci == 1:
                c.drawString(xs[ci] + 1.6 * MM, base, txt)
            elif ci in (0, 2, 3):
                c.drawCentredString((xs[ci] + xs[ci + 1]) / 2, base, txt)
            else:
                c.drawRightString(xs[ci + 1] - 1.6 * MM, base, txt)
        cell_boxes.append(boxes)
        yy -= h
    pos["table_rect_pt"] = [round(xs[0], 2), round(yy, 2), round(xs[-1], 2), round(top, 2)]
    pos["table_cells_pt"] = cell_boxes
    y = yy - 7 * MM
    for label, val in TOTAL_LINES:
        c.setFont("LiberationSerif-Bold", 11.5)
        c.drawRightString(xs[5] - 2 * MM, y, label)
        c.drawRightString(xs[6] - 1.6 * MM, y, val)
        if label.startswith("Итого"):
            pos["total_line_pt"] = [round(xs[4], 2), round(y - 1.5 * MM, 2), round(xs[6], 2), round(y + 4 * MM, 2)]
        y -= 6 * MM
    y -= 5 * MM
    c.setFont("LiberationSerif", 11.5)
    c.drawString(L, y, SUMMARY_1)
    y -= 5.4 * MM
    c.setFont("LiberationSerif-Bold", 11.5)
    c.drawString(L, y, SUMMARY_2)
    y -= 10 * MM
    c.setFont("LiberationSerif", 11.5)
    for ln in _wrap(c, CLAIMS, "LiberationSerif", 11.5, R - L):
        c.drawString(L, y, ln)
        y -= 5.4 * MM
    # signatures
    y -= 14 * MM
    colx = [L, L + 92 * MM]
    for k, (role, who, name) in enumerate(SIGN):
        x = colx[k]
        c.setFont("LiberationSerif-Bold", 11.5)
        c.drawString(x, y, role)
        c.setFont("LiberationSerif", 11)
        c.drawString(x, y - 6 * MM, who)
        c.drawString(x, y - 18 * MM, "_______________ " + name)
        c.setFont("LiberationSerif", 9.5)
        c.drawString(x + 4 * MM, y - 27 * MM, "М.П.")
        _scribble(c, x + 3 * MM, y - 17 * MM, 30 * MM, SEED + k)
    pos["signatures_top_pt"] = round(y + 5 * MM, 2)
    # light specimen mark over the signature area (vector outlines, no text layer)
    c.saveState()
    c.setFillColor(Color(0.85, 0.15, 0.15, alpha=0.13))
    c.translate(W / 2, y - 40 * MM)
    c.rotate(14)
    C.rl_draw_text_outlines(c, "ОБРАЗЕЦ / SPECIMEN", C.ff_font_file("DejaVuSans-Bold"), 40, 0, 0)
    c.restoreState()
    c.setFont("DejaVuSans", 7.5)
    c.setFillColor(Color(0.4, 0.4, 0.4))
    c.drawCentredString(W / 2, 12 * MM, "ОБРАЗЕЦ / SPECIMEN · документ сгенерирован для тестов · стр. 1 из 1")
    # translucent blue stamp over the total
    tl = pos["total_line_pt"]
    st = (tl[0] + 27 * MM, tl[1] + 1.5 * MM - 8 * MM, 16 * MM)
    _stamp(c, *st)
    pos["stamp_circle_pt"] = [round(v, 2) for v in st]
    c.showPage()
    c.save()
    return buf.getvalue(), pos


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir, truth_dir = pathlib.Path(out_dir), pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    pdf, pos = _act_pdf()
    page = C.px_pdf_to_pil(pdf, DPI)[0]                       # 1654×2339
    pw, ph = page.size
    W, H = PHOTO
    # base placement, then 2.5° rotation, then corner jitter (≤ 4 % of the frame)
    dw = 1640
    dh = dw * ph / pw
    cx, cy = W / 2 + 10, H / 2 + 8
    base = [(cx - dw / 2, cy - dh / 2), (cx + dw / 2, cy - dh / 2), (cx + dw / 2, cy + dh / 2), (cx - dw / 2, cy + dh / 2)]
    rot = C.ff_rotate_quad(base, cx, cy, 2.5)                 # +2.5° = clockwise on screen (y down)
    jitter = [(0.035, 0.030), (-0.020, 0.030), (-0.010, -0.012), (0.012, -0.025)]   # share of W, H (keystone)
    quad = [(x + jx * W, y + jy * H) for (x, y), (jx, jy) in zip(rot, jitter)]
    bg = C.ff_photo_wood(W, H, SEED, base=(118, 92, 70))
    img, Hm = C.ff_photo_on_table(page, quad, (W, H), bg, SEED, shadow=(18, 26))
    a = np.asarray(img, np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    t = np.clip((xx / W) * 0.45 + (yy / H) * 0.55, 0, 1)      # 0 at top-left → 1 at bottom-right
    a *= (1.0 - 0.35 * t ** 1.3)[..., None]
    a *= np.array((1.03, 1.0, 0.93), np.float32)               # warm indoor light
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB").filter(ImageFilter.GaussianBlur(1.2))
    out = out_dir / "akt_47_foto.jpg"
    out.write_bytes(C.ff_jpeg_bytes(img, 40, exif=C.ff_exif_bytes(1, when="2026:11:02 18:41:09")))
    flat_png = truth_dir / "akt_47_flat.png"
    C.px_save_png_deterministic(C.ff_gray_template(page, long_side=1024), flat_png)

    rows = [list(r) for r in DG.OCR_ACT_ROWS]
    computed = []
    for r in DG.OCR_ACT_ROWS:
        q = float(r[3].replace(" ", "").replace(",", "."))
        p = float(r[4].replace(" ", "").replace(",", "."))
        s = float(r[5].replace(" ", "").replace(",", "."))
        computed.append({"row": r[0], "qty_x_price": round(q * p, 2), "printed_sum": s, "matches": abs(q * p - s) < 0.005})
    printed_total = round(sum(x["printed_sum"] for x in computed), 2)
    assert f"{printed_total:,.2f}".replace(",", " ").replace(".", ",") == DG.OCR_ACT_TOTAL, printed_total
    assert [x["row"] for x in computed if not x["matches"]] == [4]
    truth = {
        "case": "f-ocr-act-table-docx",
        "file": out.name,
        "photo_size_px": [W, H],
        "page_render": {"dpi": DPI, "size_px": [pw, ph], "template": flat_png.name},
        "page_quad_TL_TR_BR_BL_px": [[round(x, 1), round(y, 1)] for x, y in quad],
        "transforms": {"rotation_deg_clockwise": 2.5, "corner_jitter_share": jitter, "shadow_gradient": -0.35,
                       "blur_sigma": 1.2, "jpeg_quality": 40, "background": "wooden table"},
        "transcript": {
            "title": [TITLE_1, TITLE_2, TITLE_3],
            "place_date": list(PLACE_DATE),
            "parties": [{"label": a_, "text": b_} for a_, b_ in PARTIES],
            "table_header": HEAD,
            "table_rows": rows,
            "totals": [{"label": a_, "value": b_} for a_, b_ in TOTAL_LINES],
            "summary": [SUMMARY_1, SUMMARY_2],
            "claims": CLAIMS,
            "signatures": [{"role": a_, "who": b_, "name": c_} for a_, b_, c_ in SIGN],
        },
        "arithmetic": {"rows": computed, "printed_total": printed_total,
                       "total_if_row4_were_correct": round(printed_total - 600, 2),
                       "note": "Row 4 prints 18 600,00 while 150 × 120,00 = 18 000,00; the printed total 184 950,00 "
                               "is the sum of the printed row sums. Keep both as printed."},
        "layout_pt": pos,
        "notes": "layout_pt is in pt from the bottom-left of the A4 page; the stamp (alpha 0.55, blue) overlaps the "
                 "«Итого» line. There is no text layer: the only input is the JPEG.",
    }
    tp = truth_dir / "akt_47_foto.json"
    C.ff_write_json(tp, truth)
    return [str(out), str(flat_png), str(tp)]


if __name__ == "__main__":
    root = HERE.parent
    for p in build(root / "out" / "f-ocr-act-table-docx", root / "truth"):
        print(p)
