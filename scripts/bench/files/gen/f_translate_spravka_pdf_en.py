"""Fixture for f-translate-spravka-pdf-en.

spravka_s_raboty.pdf   one A4 page, text PDF (reportlab, Liberation fonts embedded, ToUnicode → pdftotext works):
                       letterhead of ООО «Образец Технологии» with an emblem PNG at [40,760,120,810] pt (ИНН 7700000093,
                       ОГРН, address, phone +7 900 000-00-00), «Исх. № 314 от 15.10.2026», «СПРАВКА», body (Соколова
                       Мария Игоревна, 12.05.1990 г.р., с 01.03.2019, ведущий аналитик отдела данных, average salary
                       185 000 руб., leave 10.12.2026–24.12.2026, «для предъявления в консульство»), a 6×2 table
                       «Месяц | Начислено, руб.» (+ header row), «Генеральный директор ____ П. П. Петров» with a
                       transparent signature PNG at [200,150,320,200] and a round blue seal PNG «ОБРАЗЕЦ» at
                       [330,120,450,240] (both RGBA → image + /SMask), footer with contacts. Every rect is in pt from
                       the bottom-left corner. A diagonal «ОБРАЗЕЦ / SPECIMEN» is drawn as glyph outlines (no text
                       layer, no image), plus a small text mark in the letterhead and the footer.

truth/spravka_layout.json  page size, image rects (and the rects actually found in the PDF), text block rects,
                           table rect / cell rects / values, the facts the checks look for.
"""

from __future__ import annotations

import io
import math
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

CASE = "f-translate-spravka-pdf-en"
PDF_NAME = "spravka_s_raboty.pdf"
W, H = C.FF_A4
LOGO_RECT = [40, 760, 120, 810]
SIG_RECT = [200, 150, 320, 200]
SEAL_RECT = [330, 120, 450, 240]
INK = (31, 45, 140)

COMPANY = "ООО «ОБРАЗЕЦ ТЕХНОЛОГИИ»"
LETTERHEAD = [
    "Общество с ограниченной ответственностью «Образец Технологии»",
    "ИНН 7700000093  ·  КПП 770001001  ·  ОГРН 1000000000093",
    "101000, г. Москва, ул. Образцовая, д. 1, офис 3  ·  Тел.: +7 900 000-00-00",
]
OUT_NO = "Исх. № 314 от 15.10.2026"
TITLE = "СПРАВКА"
BODY = [
    "Дана Соколовой Марии Игоревне, 12.05.1990 г.р., в том, что она действительно работает в ООО «Образец "
    "Технологии» с 01.03.2019 по настоящее время в должности ведущего аналитика отдела данных.",
    "Средняя заработная плата за последние 6 месяцев составляет 185 000 (сто восемьдесят пять тысяч) рублей "
    "00 копеек.",
    "На период с 10.12.2026 по 24.12.2026 ей предоставлен ежегодный оплачиваемый отпуск с сохранением должности "
    "и заработной платы.",
]
TABLE_CAPTION = "Начисленная заработная плата за апрель — сентябрь 2026 г.:"
TABLE_HEAD = ("Месяц", "Начислено, руб.")
TABLE_ROWS = [("апрель 2026", 178000), ("май 2026", 182500), ("июнь 2026", 185000),
              ("июль 2026", 186500), ("август 2026", 188000), ("сентябрь 2026", 190000)]
CLOSING = "Справка выдана для предъявления в консульство."
SIGN_ROLE = "Генеральный директор"
SIGN_NAME = "П. П. Петров"
FOOTER = ("ООО «Образец Технологии»  ·  101000, г. Москва, ул. Образцовая, д. 1, офис 3  ·  +7 900 000-00-00  ·  "
          "info@obrazec-tech.example")
FOOTER_MARK = "ОБРАЗЕЦ / SPECIMEN — документ вымышлен и создан для тестирования"


def _rub(v: int) -> str:
    return f"{v:,.2f}".replace(",", " ").replace(".", ",")


# ------------------------------------------------------------------ images (RGBA, pixel size ≈ 5 px per pt)

def _logo() -> Image.Image:
    S = 6
    w, h = (LOGO_RECT[2] - LOGO_RECT[0]) * S, (LOGO_RECT[3] - LOGO_RECT[1]) * S       # 480 × 300
    img = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)
    blue, teal = (24, 70, 150, 255), (0, 150, 160, 255)
    cx, cy, r = 150, 132, 120
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=blue)
    d.ellipse((cx - r + 14, cy - r + 14, cx + r - 14, cy + r - 14), outline=(255, 255, 255, 255), width=6)
    for k, bh in enumerate((60, 100, 140)):                           # ascending data bars
        x0 = cx - 66 + k * 48
        d.rectangle((x0, cy + 70 - bh, x0 + 32, cy + 70), fill=(255, 255, 255, 255))
    d.line([(cx - 80, cy + 10), (cx - 20, cy - 30), (cx + 20, cy - 10), (cx + 84, cy - 78)], fill=teal, width=12,
           joint="curve")
    f = C.ff_pil_font("DejaVuSans-Bold", 96)
    d.text((300, 92), "ОТ", font=f, fill=blue, anchor="lm")
    f2 = C.ff_pil_font("DejaVuSans-Bold", 34)
    d.text((300, 182), "ОБРАЗЕЦ", font=f2, fill=(190, 32, 32, 255), anchor="lm")
    f3 = C.ff_pil_font("DejaVuSans", 30)
    d.text((300, 230), "технологии", font=f3, fill=teal, anchor="lm")
    d.text((300, 268), "SPECIMEN", font=C.ff_pil_font("DejaVuSans", 26), fill=(190, 32, 32, 255), anchor="lm")
    return img


def _signature() -> Image.Image:
    alpha, _pts = C.sig_ink_alpha(7314, "М")
    x0, y0, x1, y1 = C.sig_alpha_bbox(alpha, 0.05)
    pad = 30
    crop = alpha[max(0, y0 - pad):y1 + pad, max(0, x0 - pad):x1 + pad]
    S = 5
    tw, th = (SIG_RECT[2] - SIG_RECT[0]) * S, (SIG_RECT[3] - SIG_RECT[1]) * S          # 600 × 250
    a_img = Image.fromarray((np.clip(crop, 0, 1) * 255).astype(np.uint8), "L")
    k = min(tw / a_img.width, th / a_img.height)
    a_img = a_img.resize((max(1, round(a_img.width * k)), max(1, round(a_img.height * k))), Image.LANCZOS)
    a_full = Image.new("L", (tw, th), 0)
    a_full.paste(a_img, ((tw - a_img.width) // 2, (th - a_img.height) // 2 + 18))
    a_arr = np.asarray(a_full, np.float32) / 255.0
    a_arr = np.clip(a_arr * 1.08, 0, 1) * 0.93
    rgba = np.zeros((th, tw, 4), np.uint8)
    rgba[..., 0], rgba[..., 1], rgba[..., 2] = INK
    rgba[..., 3] = (a_arr * 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def _ring_text(layer, cx, cy, radius, text, font, fill, start_deg=-90.0):
    """Characters along a circle, upright to the centre, spaced by their advance widths over the full turn."""
    d = ImageDraw.Draw(layer)
    widths = [d.textlength(ch, font=font) for ch in text]
    total = sum(widths)
    ang = math.radians(start_deg)
    for ch, wch in zip(text, widths):
        a = ang + math.pi * 2 * (wch / 2) / total
        size = int(font.size * 1.8)
        tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(tile).text((size / 2, size / 2), ch, font=font, fill=fill, anchor="mm")
        tile = tile.rotate(-math.degrees(a) - 90, resample=Image.BICUBIC)
        x, y = cx + radius * math.cos(a), cy + radius * math.sin(a)
        layer.alpha_composite(tile, (int(round(x - size / 2)), int(round(y - size / 2))))
        ang += math.pi * 2 * wch / total


def _seal() -> Image.Image:
    S = 5
    n = (SEAL_RECT[2] - SEAL_RECT[0]) * S                                              # 600
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    col = (36, 64, 176, 235)
    cx = cy = n / 2
    r = n / 2 - 12
    d = ImageDraw.Draw(img)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=col, width=9)
    d.ellipse((cx - r + 16, cy - r + 16, cx + r - 16, cy + r - 16), outline=col, width=3)
    ri = r * 0.64
    d.ellipse((cx - ri, cy - ri, cx + ri, cy + ri), outline=col, width=5)
    ring = "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ «ОБРАЗЕЦ ТЕХНОЛОГИИ» ★ г. МОСКВА ★ "
    _ring_text(img, cx, cy, r * 0.82, ring, C.ff_pil_font("DejaVuSans-Bold", 30), col)
    d = ImageDraw.Draw(img)
    d.text((cx, cy - 46), "ОБРАЗЕЦ", font=C.ff_pil_font("DejaVuSans-Bold", 50), fill=col, anchor="mm")
    d.text((cx, cy + 14), "SPECIMEN", font=C.ff_pil_font("DejaVuSans-Bold", 30), fill=col, anchor="mm")
    d.text((cx, cy + 62), "ОГРН 1000000000093", font=C.ff_pil_font("DejaVuSans-Bold", 22), fill=col, anchor="mm")
    d.text((cx, cy + 98), "★ ★ ★", font=C.ff_pil_font("DejaVuSans", 22), fill=col, anchor="mm")
    # uneven stamp-pad ink: modulate alpha with smooth noise and speckles (deterministic)
    arr = np.asarray(img, np.float32)
    noise = C.px_smooth_noise((n, n), 60, seed=2718, octaves=3)
    rng = np.random.default_rng(2719)
    speck = rng.random((n, n)) > 0.06
    a = arr[..., 3] * np.clip(0.80 + 0.22 * noise, 0.45, 1.0) * speck
    arr[..., 3] = np.clip(a, 0, 255)
    out = Image.fromarray(arr.astype(np.uint8), "RGBA")
    return out.filter(ImageFilter.GaussianBlur(0.6))


# ------------------------------------------------------------------ PDF

def _draw_png(c, img: Image.Image, rect):
    from reportlab.lib.utils import ImageReader

    buf = io.BytesIO()
    img.save(buf, "PNG", compress_level=9)
    buf.seek(0)
    c.drawImage(ImageReader(buf), rect[0], rect[1], width=rect[2] - rect[0], height=rect[3] - rect[1], mask="auto")


def _paragraph(c, text, x, y_top, width, *, font="LiberationSerif", size=12.0, leading=18.0, indent=28.0):
    from reportlab.lib.enums import TA_JUSTIFY
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Paragraph

    st = ParagraphStyle("b", fontName=font, fontSize=size, leading=leading, alignment=TA_JUSTIFY,
                        firstLineIndent=indent)
    p = Paragraph(text.replace("&", "&amp;").replace("<", "&lt;"), st)
    _w, h = p.wrap(width, 1000)
    p.drawOn(c, x, y_top - h)
    return [round(x, 2), round(y_top - h, 2), round(x + width, 2), round(y_top, 2)]


def _build_pdf(path: pathlib.Path):
    from reportlab.lib.colors import Color

    C.ff_register_rl_fonts("LiberationSerif", "LiberationSerif-Bold", "LiberationSans", "LiberationSans-Bold")
    c = C.ff_rl_canvas(str(path), title="Справка с места работы (ОБРАЗЕЦ)",
                       author="ООО «Образец Технологии» (ОБРАЗЕЦ / SPECIMEN)",
                       subject="Справка с места работы, вымышленные данные (ОБРАЗЕЦ)")
    blocks = {}

    # diagonal specimen mark: outlines only (no text layer, no image)
    c.saveState()
    c.setFillColor(Color(0.75, 0.10, 0.10, alpha=0.10))
    c.translate(W / 2, H / 2 + 20)
    c.rotate(38)
    C.rl_draw_text_outlines(c, "ОБРАЗЕЦ / SPECIMEN", C.ff_font_file("DejaVuSans-Bold"), 58, 0, 0)
    c.restoreState()

    # letterhead
    _draw_png(c, _logo(), LOGO_RECT)
    c.setFillColorRGB(0.09, 0.27, 0.59)
    c.setFont("LiberationSans-Bold", 14)
    c.drawString(132, 796, COMPANY)
    c.setFillColorRGB(0.2, 0.2, 0.25)
    c.setFont("LiberationSans", 8.4)
    for k, line in enumerate(LETTERHEAD):
        c.drawString(132, 783 - k * 10.5, line)
    blocks["letterhead"] = [132, 758, 540, 810]
    c.setFillColorRGB(0.75, 0.12, 0.12)
    c.setFont("LiberationSans-Bold", 7.5)
    c.drawRightString(W - 40, 818, "ОБРАЗЕЦ / SPECIMEN")
    c.setStrokeColorRGB(0.09, 0.27, 0.59)
    c.setLineWidth(1.6)
    c.line(40, 750, W - 40, 750)
    c.setLineWidth(0.5)
    c.line(40, 747, W - 40, 747)

    c.setFillColorRGB(0, 0, 0)
    c.setFont("LiberationSerif", 11)
    c.drawString(56, 722, OUT_NO)
    blocks["outgoing_number"] = [56, 718, 56 + c.stringWidth(OUT_NO, "LiberationSerif", 11), 731]
    c.setFont("LiberationSerif-Bold", 16)
    c.drawCentredString(W / 2, 684, TITLE)
    tw = c.stringWidth(TITLE, "LiberationSerif-Bold", 16)
    blocks["title"] = [round(W / 2 - tw / 2, 2), 680, round(W / 2 + tw / 2, 2), 696]

    x, width = 56.0, W - 56.0 - 56.0
    y = 660.0
    para_rects = []
    for text in BODY:
        r = _paragraph(c, text, x, y, width)
        para_rects.append(r)
        y = r[1] - 8
    blocks["body_paragraphs"] = para_rects

    # table
    y -= 8
    c.setFont("LiberationSerif", 12)
    c.drawString(x, y - 12, TABLE_CAPTION)
    blocks["table_caption"] = [x, y - 16, x + c.stringWidth(TABLE_CAPTION, "LiberationSerif", 12), y]
    y -= 24
    col_x = [86.0, 296.0, 456.0]
    row_h = 19.0
    t_top = y
    cells = []
    c.setLineWidth(0.7)
    c.setStrokeColorRGB(0.15, 0.15, 0.2)
    for ri in range(len(TABLE_ROWS) + 1):
        top, bot = t_top - ri * row_h, t_top - (ri + 1) * row_h
        if ri == 0:
            c.setFillColorRGB(0.91, 0.93, 0.97)
            c.rect(col_x[0], bot, col_x[2] - col_x[0], row_h, stroke=0, fill=1)
            c.setFillColorRGB(0, 0, 0)
            c.setFont("LiberationSerif-Bold", 11.5)
            vals = TABLE_HEAD
        else:
            c.setFont("LiberationSerif", 11.5)
            vals = (TABLE_ROWS[ri - 1][0], _rub(TABLE_ROWS[ri - 1][1]))
        c.drawString(col_x[0] + 8, bot + 5.5, vals[0])
        if ri == 0:
            c.drawCentredString((col_x[1] + col_x[2]) / 2, bot + 5.5, vals[1])
        else:
            c.drawRightString(col_x[2] - 10, bot + 5.5, vals[1])
        cells.append([{"rect": [col_x[0], bot, col_x[1], top], "text": vals[0]},
                      {"rect": [col_x[1], bot, col_x[2], top], "text": vals[1]}])
    t_bot = t_top - (len(TABLE_ROWS) + 1) * row_h
    for k in range(len(TABLE_ROWS) + 2):
        yy = t_top - k * row_h
        c.line(col_x[0], yy, col_x[2], yy)
    for xx in col_x:
        c.line(xx, t_bot, xx, t_top)
    blocks["table"] = {"rect": [col_x[0], t_bot, col_x[2], t_top], "header_rows": 1, "data_rows": len(TABLE_ROWS),
                       "cols": 2, "cells": cells}
    y = t_bot - 14
    blocks["closing"] = _paragraph(c, CLOSING, x, y, width)

    # signature line (signature image sits over the blank, the seal over the name)
    c.setFont("LiberationSerif", 12)
    c.drawString(56, 168, SIGN_ROLE)
    c.setLineWidth(0.6)
    c.line(196, 165, 324, 165)
    c.drawString(338, 168, SIGN_NAME)
    blocks["signature_line"] = {"role": [56, 164, 56 + c.stringWidth(SIGN_ROLE, "LiberationSerif", 12), 177],
                                "blank": [196, 165, 324, 165],
                                "name": [338, 164, 338 + c.stringWidth(SIGN_NAME, "LiberationSerif", 12), 177]}
    c.setFont("LiberationSerif", 9)
    c.drawString(292, 132, "М. П.")
    blocks["mp"] = [292, 129, 292 + c.stringWidth("М. П.", "LiberationSerif", 9), 139]
    _draw_png(c, _signature(), SIG_RECT)
    _draw_png(c, _seal(), SEAL_RECT)

    # footer
    c.setStrokeColorRGB(0.09, 0.27, 0.59)
    c.setLineWidth(0.8)
    c.line(40, 62, W - 40, 62)
    c.setFillColorRGB(0.25, 0.25, 0.3)
    c.setFont("LiberationSans", 7.4)
    c.drawCentredString(W / 2, 50, FOOTER)
    c.setFillColorRGB(0.72, 0.12, 0.12)
    c.setFont("LiberationSans", 7)
    c.drawCentredString(W / 2, 38, FOOTER_MARK)
    blocks["footer"] = [40, 34, W - 40, 62]
    c.showPage()
    c.save()
    return blocks


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf = out_dir / PDF_NAME
    blocks = _build_pdf(pdf)

    placed = C.od_pdf_image_placements(pdf)
    expected = {"logo": LOGO_RECT, "signature": SIG_RECT, "seal": SEAL_RECT}
    found = {}
    for role, rect in expected.items():
        best = max(placed, key=lambda p: C.od_rect_iou(p["rect"], rect))
        assert C.od_rect_iou(best["rect"], rect) > 0.999, (role, best)
        found[role] = best
    assert len(placed) == 3, placed
    amounts = [v for _m, v in TABLE_ROWS]
    assert sum(amounts) / len(amounts) == 185000

    truth = {
        "case": CASE,
        "file": PDF_NAME,
        "page_size_pt": [W, H],
        "coords": "pt from the bottom-left corner of the page",
        "images": [{"role": role, "rect": rect, "found_rect": found[role]["rect"], "px": found[role]["px"],
                    "has_smask": found[role]["smask"]} for role, rect in expected.items()],
        "blocks": blocks,
        "facts": {
            "employee_ru": "Соколова Мария Игоревна", "employee_passport_latin": "SOKOLOVA MARIIA",
            "birth_date": "12.05.1990", "employed_since": "01.03.2019",
            "position_ru": "ведущий аналитик отдела данных", "position_en_hint": "Lead Analyst, Data Department",
            "average_salary_rub": 185000, "average_salary_words_ru": "сто восемьдесят пять тысяч",
            "leave": ["10.12.2026", "24.12.2026"], "leave_kind_ru": "ежегодный оплачиваемый отпуск с сохранением "
                                                                   "должности и заработной платы",
            "outgoing": {"number": "314", "date": "15.10.2026"},
            "company_ru": "ООО «Образец Технологии»", "inn": "7700000093", "ogrn": "1000000000093",
            "director": "П. П. Петров", "purpose_ru": "для предъявления в консульство",
            "salary_table": [{"month_ru": m, "month_en": e, "amount": v} for (m, v), e in
                             zip(TABLE_ROWS, ["April 2026", "May 2026", "June 2026", "July 2026", "August 2026",
                                              "September 2026"])],
            "salary_table_average": 185000,
        },
        "specimen_marks": ["diagonal «ОБРАЗЕЦ / SPECIMEN» as vector glyph outlines (no text, no image)",
                           "«ОБРАЗЕЦ / SPECIMEN» text top-right and in the footer", "«ОБРАЗЕЦ» in the seal image",
                           "«ОБРАЗЕЦ»/«SPECIMEN» in the logo image"],
    }
    tp = truth_dir / "spravka_layout.json"
    C.ff_write_json(tp, truth)
    return [str(pdf), str(tp)]


if __name__ == "__main__":
    root = HERE.parent
    for p in build(root / "out" / CASE, root / "truth"):
        print(p)
