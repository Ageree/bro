"""Fixture for f-pdf-visa-pack-surgery: skany_viza.pdf — 13 scanned pages for a visa pack, all mixed up.

Every page is an image-only PDF page (no text layer): a reportlab document of its own type is rendered with
poppler at 200 dpi (1654×2339 px), turned into a «scan» (warm paper tint, 0.6 px blur, Gaussian noise σ=3 in
luminance + σ=1 per channel), rotated clockwise as the recipe says (rotation baked into the raster, /Rotate=0, so
a 90°/270° page is a landscape page) and stored as colour JPEG q=92 (DCT pass-through), ≈1 MB per page.

Fixture pages (clockwise rotation baked into the raster):
  p1  Выписка по счёту 2/2, 180°      p8  Бронь отеля 2/2, 270°
  p2  Загранпаспорт 1/1               p9  Страховка 1/1
  p3  ПУСТО (σ=3 noise)               p10 ПУСТО (σ=3 noise + 5 dust specks)
  p4  Справка с работы 1/1, 90°       p11 Билеты 1/1
  p5  Выписка по счёту 1/2            p12 Анкета 1/2
  p6  Бронь отеля 1/2                 p13 Анкета 2/2, 180°
  p7  Загранпаспорт (duplicate of p2: same render, other noise, shifted 4 px)

Each document page carries a large heading «<ТИП> — стр. k из n (ОБРАЗЕЦ)», a black triangle in the top-left
corner (up marker), a diagonal «ОБРАЗЕЦ / SPECIMEN» watermark and a specimen footer. Each type has its own layout
(card, bands, tables, boxes) so pages stay distinguishable at 64×91 px.

truth/visa_templates/NN_<slug>.png  clean render of each of the 10 unique pages, upright, gray, 64×91 (LANCZOS)
truth/visa_templates/manifest.json  expected order (labels as in the check), template files, source pages
truth/skany_viza.json               page map of the fixture (kind, rotation, fix), expected split, self-check numbers
"""

from __future__ import annotations

import hashlib
import io
import math
import pathlib
import random
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

FIXTURE = "skany_viza.pdf"
DPI = 200
PAGE_PX = (1654, 2339)          # A4 at 200 dpi (pdftoppm rounding)
JPEG_Q = 92
TEMPLATE_SIZE = (64, 91)
LEGIBILITY_SIZE = (620, 877)    # 75 dpi grid: 64x91 cannot tell a mushy re-encode from a good one (issues file)
SEED = 20261015

# unique pages in the expected order: (key, label in the check, heading type, k, n, slug, file stem for split)
UNIQUE = [
    ("anketa_1", "Анкета 1/2", "Анкета", 1, 2, "anketa_1"),
    ("anketa_2", "Анкета 2/2", "Анкета", 2, 2, "anketa_2"),
    ("pasport", "Загранпаспорт", "Загранпаспорт", 1, 1, "zagranpasport"),
    ("spravka", "Справка с работы", "Справка с работы", 1, 1, "spravka"),
    ("vypiska_1", "Выписка по счёту 1/2", "Выписка по счёту", 1, 2, "vypiska_1"),
    ("vypiska_2", "Выписка по счёту 2/2", "Выписка по счёту", 2, 2, "vypiska_2"),
    ("bron_1", "Бронь отеля 1/2", "Бронь отеля", 1, 2, "bron_1"),
    ("bron_2", "Бронь отеля 2/2", "Бронь отеля", 2, 2, "bron_2"),
    ("bilety", "Билеты", "Билеты", 1, 1, "bilety"),
    ("strahovka", "Страховка", "Страховка", 1, 1, "strahovka"),
]

# fixture pages in order: (kind, key or None, clockwise rotation baked into the raster)
PAGES = [
    ("doc", "vypiska_2", 180),
    ("doc", "pasport", 0),
    ("blank", None, 0),
    ("doc", "spravka", 90),
    ("doc", "vypiska_1", 0),
    ("doc", "bron_1", 0),
    ("duplicate", "pasport", 0),
    ("doc", "bron_2", 270),
    ("doc", "strahovka", 0),
    ("blank_specks", None, 0),
    ("doc", "bilety", 0),
    ("doc", "anketa_1", 0),
    ("doc", "anketa_2", 180),
]

SPLIT = [  # expected split files: name regex in the check, pages (labels)
    ("Анкета", ["Анкета 1/2", "Анкета 2/2"]),
    ("Загранпаспорт", ["Загранпаспорт"]),
    ("Справка с работы", ["Справка с работы"]),
    ("Выписка по счёту", ["Выписка по счёту 1/2", "Выписка по счёту 2/2"]),
    ("Бронь отеля", ["Бронь отеля 1/2", "Бронь отеля 2/2"]),
    ("Билеты", ["Билеты"]),
    ("Страховка", ["Страховка"]),
]

W_PT, H_PT = C.FF_A4


# ============================================================================ drawing helpers (reportlab)

def _rgb(c, r, g, b, fill=True):
    if fill:
        c.setFillColorRGB(r / 255, g / 255, b / 255)
    else:
        c.setStrokeColorRGB(r / 255, g / 255, b / 255)


def _decor(c, doc_type, k, n):
    """Up marker, heading, watermark, footer — the same on every document page."""
    c.saveState()
    _rgb(c, 0, 0, 0)
    p = c.beginPath()
    p.moveTo(18, H_PT - 18)
    p.lineTo(78, H_PT - 18)
    p.lineTo(18, H_PT - 78)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    c.setFont("DejaVuSans-Bold", 18)
    c.drawString(90, H_PT - 44, f"{doc_type} — стр. {k} из {n} (ОБРАЗЕЦ)")
    _rgb(c, 120, 120, 120)
    c.setFont("DejaVuSans", 7.5)
    c.drawCentredString(W_PT / 2, 22, "ОБРАЗЕЦ / SPECIMEN — учебный документ для тестов, все данные вымышлены")
    c.restoreState()


def _watermark(c):
    c.saveState()
    c.setFillColorRGB(0.80, 0.15, 0.15)
    c.setFillAlpha(0.13)
    c.translate(W_PT / 2, H_PT / 2 - 40)
    c.rotate(35)
    c.setFont("DejaVuSans-Bold", 58)
    c.drawCentredString(0, 0, "ОБРАЗЕЦ / SPECIMEN")
    c.restoreState()


def _field(c, x, y, w, h, label, value, *, vsize=9.5):
    c.saveState()
    c.setLineWidth(0.7)
    _rgb(c, 60, 60, 70, fill=False)
    c.rect(x, y, w, h, stroke=1, fill=0)
    _rgb(c, 90, 90, 100)
    c.setFont("DejaVuSans", 6.2)
    c.drawString(x + 2, y + h + 2, label)
    if value:
        _rgb(c, 20, 40, 130)
        c.setFont("DejaVuSans", vsize)
        c.drawString(x + 4, y + (h - vsize) / 2 + 2, value)
    c.restoreState()


def _checkbox(c, x, y, label, checked=False, size=8):
    c.saveState()
    c.setLineWidth(0.7)
    c.rect(x, y, size, size, stroke=1, fill=0)
    if checked:
        _rgb(c, 20, 40, 130, fill=False)
        c.setLineWidth(1.4)
        c.line(x + 1.5, y + 4, x + 3.5, y + 1.5)
        c.line(x + 3.5, y + 1.5, x + 7, y + 7.5)
    _rgb(c, 30, 30, 30)
    c.setFont("DejaVuSans", 7.5)
    c.drawString(x + size + 3, y + 1, label)
    c.restoreState()


def _scribble(c, x, y, w, h, seed, color=(20, 40, 130), width=1.3):
    rnd = random.Random(seed)
    c.saveState()
    _rgb(c, *color, fill=False)
    c.setLineWidth(width)
    p = c.beginPath()
    px, py = x, y + h * 0.4
    p.moveTo(px, py)
    for i in range(9):
        nx = x + w * (i + 1) / 9
        ny = y + h * (0.15 + 0.7 * rnd.random())
        p.curveTo(px + w * 0.06, py + h * (rnd.random() - 0.3), nx - w * 0.05, ny - h * (rnd.random() - 0.3), nx, ny)
        px, py = nx, ny
    c.drawPath(p, stroke=1, fill=0)
    c.line(x - 5, y - 2, x + w * 0.8, y - 4)
    c.restoreState()


def _stamp(c, cx, cy, r, ring, centre, color=(40, 70, 170)):
    c.saveState()
    _rgb(c, *color, fill=False)
    _rgb(c, *color)
    c.setFillAlpha(0.85)
    c.setStrokeAlpha(0.85)
    c.setLineWidth(1.6)
    c.circle(cx, cy, r, stroke=1, fill=0)
    c.setLineWidth(0.8)
    c.circle(cx, cy, r * 0.70, stroke=1, fill=0)
    c.setFont("DejaVuSans-Bold", r * 0.17)
    n = len(ring)
    for i, ch in enumerate(ring):
        a = math.pi / 2 - 2 * math.pi * i / n
        c.saveState()
        c.translate(cx + r * 0.84 * math.cos(a), cy + r * 0.84 * math.sin(a))
        c.rotate(math.degrees(a) - 90)
        c.drawCentredString(0, -r * 0.06, ch)
        c.restoreState()
    c.setFont("DejaVuSans-Bold", r * 0.2)
    lines = centre.split("\n")
    for i, ln in enumerate(lines):
        c.drawCentredString(cx, cy + (len(lines) / 2 - i - 0.8) * r * 0.24, ln)
    c.restoreState()


def _silhouette(c, x, y, w, h):
    c.saveState()
    _rgb(c, 205, 208, 214)
    c.rect(x, y, w, h, stroke=0, fill=1)
    _rgb(c, 140, 144, 152)
    c.circle(x + w / 2, y + h * 0.62, w * 0.22, stroke=0, fill=1)
    c.roundRect(x + w * 0.14, y - h * 0.05, w * 0.72, h * 0.40, w * 0.15, stroke=0, fill=1)
    c.setLineWidth(1)
    _rgb(c, 70, 70, 80, fill=False)
    c.rect(x, y, w, h, stroke=1, fill=0)
    c.restoreState()


def _text_lines(c, x, y, lines, *, size=9.5, leading=None, font="DejaVuSans", color=(25, 25, 30)):
    leading = leading or size * 1.45
    c.saveState()
    _rgb(c, *color)
    c.setFont(font, size)
    for i, ln in enumerate(lines):
        c.drawString(x, y - i * leading, ln)
    c.restoreState()
    return y - len(lines) * leading


def _wrap(text, font, size, width):
    from reportlab.pdfbase.pdfmetrics import stringWidth

    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if stringWidth(t, font, size) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _table(c, x, y_top, col_w, rows, *, row_h=16, head_fill=(205, 205, 210), zebra=None, size=7.5,
           head_color=(20, 20, 20), border=(90, 90, 100)):
    """rows[0] is the header. Returns the y of the bottom edge."""
    c.saveState()
    c.setLineWidth(0.5)
    total_w = sum(col_w)
    for ri, row in enumerate(rows):
        yb = y_top - (ri + 1) * row_h
        if ri == 0 and head_fill:
            _rgb(c, *head_fill)
            c.rect(x, yb, total_w, row_h, stroke=0, fill=1)
        elif zebra and ri % 2 == 0:
            _rgb(c, *zebra)
            c.rect(x, yb, total_w, row_h, stroke=0, fill=1)
        cx = x
        for ci, cell in enumerate(row):
            if ri == 0:
                _rgb(c, *head_color)
                c.setFont("DejaVuSans-Bold", size)
            else:
                _rgb(c, 25, 25, 30)
                c.setFont("DejaVuSans", size)
            c.drawString(cx + 3, yb + (row_h - size) / 2 + 1.5, str(cell))
            cx += col_w[ci]
    _rgb(c, *border, fill=False)
    n = len(rows)
    for ri in range(n + 1):
        c.line(x, y_top - ri * row_h, x + total_w, y_top - ri * row_h)
    cx = x
    for w in [0] + list(col_w):
        cx += w
        c.line(cx, y_top, cx, y_top - n * row_h)
    c.restoreState()
    return y_top - n * row_h


# ============================================================================ the ten pages

def _p_anketa_1(c):
    c.setFont("DejaVuSans", 9)
    c.drawString(40, 770, "Анкета заявителя на визу — учебная форма, не бланк консульства (ОБРАЗЕЦ)")
    _silhouette(c, 448, 618, 100, 128)
    c.setFont("DejaVuSans", 6.5)
    c.drawCentredString(498, 608, "Фото 35×45 мм")
    left = [
        ("1. Фамилия (как в паспорте)", "ОБРАЗЦОВ / OBRAZTSOV"),
        ("2. Имя (как в паспорте)", "ОЛЕГ / OLEG"),
        ("3. Фамилия при рождении", "ОБРАЗЦОВ"),
        ("4. Дата рождения (ДД.ММ.ГГГГ)", "01.01.1990"),
        ("5. Место рождения", "г. Образцовск"),
        ("6. Гражданство", "Образцовая Республика (ОБРАЗЕЦ)"),
    ]
    y = 735
    for lab, val in left:
        _field(c, 40, y, 390, 18, lab, val)
        y -= 30
    _rgb(c, 30, 30, 30)
    c.setFont("DejaVuSans", 6.5)
    c.drawString(40, y + 12, "7. Пол")
    _checkbox(c, 40, y, "мужской", True)
    _checkbox(c, 110, y, "женский")
    c.drawString(200, y + 12, "8. Семейное положение")
    for i, (lab, ch) in enumerate([("холост", False), ("женат", True), ("разведён", False), ("вдовец", False)]):
        _checkbox(c, 200 + i * 62, y, lab, ch)
    y -= 34
    rows2 = [
        [("9. Номер паспорта", "00 0000000", 180), ("10. Дата выдачи", "15.03.2021", 150), ("11. Действителен до", "15.03.2031", 165)],
        [("12. Кем выдан", "Отдел по вопросам миграции (ОБРАЗЕЦ)", 505)],
        [("13. Домашний адрес", "г. Образцовск, ул. Примерная, д. 1, кв. 12", 505)],
        [("14. Телефон", "+7 000 000-00-00", 240), ("15. Эл. почта", "obrazec@example.com", 255)],
        [("16. Род занятий", "Ведущий инженер", 240), ("17. Работодатель", "ООО «Образец-Софт»", 255)],
    ]
    for row in rows2:
        x = 40
        for lab, val, w in row:
            _field(c, x, y, w, 18, lab, val)
            x += w + 10
        y -= 32
    c.setFont("DejaVuSans", 6.5)
    _rgb(c, 30, 30, 30)
    c.drawString(40, y + 12, "18. Цель поездки")
    goals = [("туризм", True), ("деловая", False), ("учёба", False), ("лечение", False), ("транзит", False),
             ("культура", False), ("спорт", False), ("посещение родственников", False), ("иное", False)]
    for i, (lab, ch) in enumerate(goals):
        _checkbox(c, 40 + (i % 3) * 170, y - (i // 3) * 14, lab, ch)
    y -= 64
    rows3 = [
        [("19. Дата въезда", "01.11.2026", 160), ("20. Дата выезда", "14.11.2026", 160), ("21. Число въездов", "однократный", 165)],
        [("22. Приглашающая сторона / гостиница", "Hotel Specimen ★★★ (ОБРАЗЕЦ)", 505)],
        [("23. Адрес пребывания", "Образцовск, проспект Тестовый, 5", 505)],
        [("24. Расходы оплачивает", "сам заявитель", 240), ("25. Средства", "наличные, банковская карта", 255)],
        [("26. Страховой полис", "ПМС-000000 (ОБРАЗЕЦ)", 240), ("27. Срок страхования", "01.11–14.11.2026", 255)],
    ]
    for row in rows3:
        x = 40
        for lab, val, w in row:
            _field(c, x, y, w, 18, lab, val)
            x += w + 10
        y -= 32
    c.setFont("DejaVuSans", 7)
    _rgb(c, 60, 60, 60)
    c.drawString(40, y + 6, "Продолжение — на странице 2. Заполняется печатными буквами.")


def _p_anketa_2(c):
    y = 760
    for lab, val in [("28. Бывали ли вы в стране ранее", "да, в 2023 году"),
                     ("29. Отпечатки пальцев сдавались ранее", "да, 12.05.2023"),
                     ("30. Разрешение на въезд в страну назначения", "не требуется")]:
        _field(c, 40, y, 515, 18, lab, val)
        y -= 32
    c.setFont("DejaVuSans-Bold", 9)
    c.drawString(40, y + 6, "31. Визы за последние три года")
    rows = [["№", "Страна", "Тип визы", "Срок действия", "Номер визы"],
            ["1", "Образцовая Республика", "C, туризм", "10.05–24.05.2023", "SPC-0000001"],
            ["2", "Республика Тестия", "C, туризм", "01.08–15.08.2024", "TST-0000002"],
            ["3", "Специменское королевство", "C, деловая", "03.03–10.03.2025", "SPM-0000003"],
            ["4", "—", "—", "—", "—"]]
    y = _table(c, 40, y, [26, 160, 90, 120, 119], rows, row_h=20, head_fill=(190, 190, 200))
    y -= 36
    c.setFont("DejaVuSans-Bold", 9)
    c.drawString(40, y, "32. Сведения о членах семьи")
    y -= 10
    rows = [["Степень родства", "Фамилия, имя", "Дата рождения", "Гражданство"],
            ["супруга", "Образцова Ольга", "02.02.1991", "Образцовая Респ."],
            ["сын", "Образцов Тест", "03.03.2018", "Образцовая Респ."]]
    y = _table(c, 40, y, [110, 180, 110, 115], rows, row_h=20, head_fill=(190, 190, 200))
    y -= 30
    decl = ("33. Заявление. Я подтверждаю, что все сведения, указанные мной в анкете, являются полными и "
            "достоверными. Мне известно, что представление ложных сведений влечёт отказ в выдаче визы. Я обязуюсь "
            "покинуть страну до истечения срока действия визы. Согласен на обработку персональных данных в целях "
            "рассмотрения заявления. Документ является учебным образцом и не подаётся в консульство.")
    lines = _wrap(decl, "DejaVuSans", 8.5, 515)
    y = _text_lines(c, 40, y, lines, size=8.5)
    y -= 30
    _rgb(c, 245, 245, 235)
    c.rect(40, y - 70, 515, 80, stroke=0, fill=1)
    _rgb(c, 30, 30, 30)
    c.setFont("DejaVuSans", 8)
    c.drawString(50, y - 4, "34. Место и дата")
    c.drawString(300, y - 4, "35. Подпись заявителя")
    _rgb(c, 20, 40, 130)
    c.setFont("DejaVuSans", 10)
    c.drawString(50, y - 40, "Образцовск, 12.10.2026")
    _scribble(c, 320, y - 55, 150, 34, seed=711)
    _rgb(c, 60, 60, 70, fill=False)
    c.line(300, y - 60, 540, y - 60)


def _p_pasport(c):
    x0, y0, x1, y1 = 50, 430, 545, 772
    c.saveState()
    _rgb(c, 246, 230, 235)
    c.roundRect(x0, y0, x1 - x0, y1 - y0, 14, stroke=0, fill=1)
    _rgb(c, 222, 190, 205, fill=False)
    c.setLineWidth(0.5)
    for k in range(26):
        p = c.beginPath()
        for i in range(0, 101):
            t = i / 100
            xx = x0 + 10 + t * (x1 - x0 - 20)
            yy = y0 + 20 + k * 12 + 5 * math.sin(t * 14 + k * 0.7)
            (p.moveTo if i == 0 else p.lineTo)(xx, yy)
        c.drawPath(p, stroke=1, fill=0)
    _rgb(c, 120, 70, 90, fill=False)
    c.setLineWidth(1.2)
    c.roundRect(x0, y0, x1 - x0, y1 - y0, 14, stroke=1, fill=0)
    c.restoreState()
    _rgb(c, 110, 40, 70)
    c.setFont("DejaVuSans-Bold", 11)
    c.drawString(70, 748, "ОБРАЗЦОВАЯ РЕСПУБЛИКА / SPECIMEN REPUBLIC")
    c.setFont("DejaVuSans", 9)
    c.drawString(70, 734, "ПАСПОРТ / PASSPORT (ОБРАЗЕЦ, НЕ ЯВЛЯЕТСЯ ДОКУМЕНТОМ)")
    _silhouette(c, 70, 540, 125, 165)
    fields = [("Тип / Type", "P"), ("Код / Code", "SPC"), ("Номер / No.", "00 0000000"),
              ("Фамилия / Surname", "ОБРАЗЦОВ / OBRAZTSOV"), ("Имя / Given names", "ОЛЕГ / OLEG"),
              ("Гражданство / Nationality", "ОБРАЗЦОВАЯ РЕСП. / SPC"), ("Дата рождения / Date of birth", "01.01.1990"),
              ("Пол / Sex", "М / M"), ("Место рождения / Place of birth", "ОБРАЗЦОВСК / OBRAZTSOVSK"),
              ("Дата выдачи / Date of issue", "15.03.2021"), ("Дата окончания / Date of expiry", "15.03.2031"),
              ("Орган, выдавший документ / Authority", "МВД 00000 (ОБРАЗЕЦ)")]
    y = 712
    for i, (lab, val) in enumerate(fields):
        col = i % 2
        x = 215 + col * 165
        if col == 0 and i:
            y -= 27
        _rgb(c, 110, 90, 100)
        c.setFont("DejaVuSans", 6)
        c.drawString(x, y, lab)
        _rgb(c, 20, 20, 25)
        c.setFont("DejaVuSans-Bold", 8.5)
        c.drawString(x, y - 10, val)
    _scribble(c, 80, 505, 110, 24, seed=233, color=(30, 30, 40), width=1.0)
    _rgb(c, 20, 20, 25)
    c.setFont("DejaVuSansMono-Bold", 12.5)
    c.drawString(66, 470, "P<SPCOBRAZTSOV<<OLEG<<<<<<<<<<<<<<<<<<<<<<<<")
    c.drawString(66, 450, "0000000000SPC9001013M3103152<<<<<<<<<<<<<<06")
    c.saveState()
    c.setFillColorRGB(0.8, 0.1, 0.1)
    c.setFillAlpha(0.35)
    c.translate(300, 600)
    c.rotate(18)
    c.setFont("DejaVuSans-Bold", 54)
    c.drawCentredString(0, 0, "SPECIMEN")
    c.restoreState()
    _rgb(c, 60, 60, 60)
    c.setFont("DejaVuSans", 8.5)
    c.drawString(50, 405, "Копия страницы с личными данными. Учебный образец: номера и имена вымышлены.")


def _p_spravka(c):
    _rgb(c, 0, 128, 128)
    c.rect(40, 690, 62, 62, stroke=0, fill=1)
    _rgb(c, 255, 255, 255)
    c.setFont("DejaVuSans-Bold", 26)
    c.drawCentredString(71, 710, "ОС")
    _rgb(c, 0, 90, 90)
    c.setFont("DejaVuSans-Bold", 13)
    c.drawString(118, 735, "ООО «Образец-Софт»")
    _rgb(c, 60, 60, 60)
    c.setFont("DejaVuSans", 8)
    c.drawString(118, 721, "ИНН 0000000000, ОГРН 0000000000000 (ОБРАЗЕЦ)")
    c.drawString(118, 709, "г. Образцовск, ул. Тестовая, д. 10, офис 5")
    c.drawString(118, 697, "тел. +7 000 000-00-01, hr@example.com")
    _rgb(c, 0, 128, 128, fill=False)
    c.setLineWidth(2)
    c.line(40, 678, 555, 678)
    _rgb(c, 25, 25, 30)
    c.setFont("DejaVuSans", 9.5)
    c.drawString(40, 650, "Исх. № 117 от 05.10.2026")
    c.drawString(360, 650, "По месту требования")
    c.setFont("DejaVuSans-Bold", 16)
    c.drawCentredString(W_PT / 2, 605, "СПРАВКА")
    body = ("Настоящим подтверждается, что Образцов Олег Олегович, 01.01.1990 года рождения, работает в "
            "ООО «Образец-Софт» в должности ведущего инженера с 01.02.2019 по настоящее время на условиях полной "
            "занятости. Средняя заработная плата за последние шесть месяцев составляет 180 000 (сто восемьдесят "
            "тысяч) рублей в месяц до удержания налога. На период с 01.11.2026 по 14.11.2026 работнику предоставлен "
            "ежегодный оплачиваемый отпуск с сохранением места работы и должности. Справка выдана для "
            "предъявления в визовый центр. Документ является учебным образцом (ОБРАЗЕЦ / SPECIMEN).")
    y = _text_lines(c, 60, 572, _wrap(body, "DejaVuSans", 10.5, 470), size=10.5, leading=17)
    y -= 50
    _rgb(c, 25, 25, 30)
    c.setFont("DejaVuSans", 10.5)
    c.drawString(60, y, "Генеральный директор")
    c.drawString(400, y, "И. И. Иванов-Образец")
    _scribble(c, 245, y - 6, 120, 30, seed=404)
    _stamp(c, 215, y - 20, 48, "★ ООО «ОБРАЗЕЦ-СОФТ» ★ ОБРАЗЕЦ ", "ДЛЯ\nСПРАВОК")
    y -= 70
    c.setFont("DejaVuSans", 10.5)
    _rgb(c, 25, 25, 30)
    c.drawString(60, y, "Главный бухгалтер")
    c.drawString(400, y, "Т. Т. Тестова")
    _scribble(c, 260, y - 4, 100, 24, seed=405)


def _p_vypiska(c, k):
    green = (20, 95, 60)
    rnd = random.Random(500 + k)
    if k == 1:
        _rgb(c, *green)
        c.rect(30, 735, 535, 50, stroke=0, fill=1)
        _rgb(c, 255, 255, 255)
        c.setFont("DejaVuSans-Bold", 15)
        c.drawString(45, 760, "БАНК «ОБРАЗЕЦ»")
        c.setFont("DejaVuSans", 9)
        c.drawString(45, 744, "Выписка по счёту (учебный образец)")
        _rgb(c, 25, 25, 30)
        info = [("Клиент:", "Образцов Олег Олегович"), ("Счёт:", "40817 810 0 0000 0000000 (ОБРАЗЕЦ)"),
                ("Период:", "01.07.2026 – 30.09.2026"), ("Валюта:", "RUB"),
                ("Входящий остаток:", "412 300,00")]
        for i, (a, b) in enumerate(info):
            c.setFont("DejaVuSans-Bold", 8.5)
            c.drawString(40, 715 - i * 14, a)
            c.setFont("DejaVuSans", 8.5)
            c.drawString(140, 715 - i * 14, b)
        y_top, n_rows = 630, 27
    else:
        y_top, n_rows = 770, 11
    rows = [["Дата", "Описание операции", "Приход", "Расход", "Остаток"]]
    bal = 412300.0 if k == 1 else 389410.0
    day0 = 1 if k == 1 else 20
    descr = ["Заработная плата", "Оплата в магазине «Образец»", "Перевод (ОБРАЗЕЦ)", "Коммунальные платежи",
             "Кафе «Тестовое»", "Аптека «Специмен»", "Кэшбэк", "Такси «Образец»", "Мобильная связь"]
    for i in range(n_rows):
        d = descr[rnd.randrange(len(descr))]
        if d in ("Заработная плата", "Кэшбэк"):
            inc, out = rnd.randrange(500, 90000), 0
        else:
            inc, out = 0, rnd.randrange(150, 12000)
        bal += inc - out
        day = day0 + i * 3
        mon = 7 + (day - 1) // 31
        dd = (day - 1) % 31 + 1
        rows.append([f"{min(dd, 30):02d}.{mon:02d}.2026", d, f"{inc:,.2f}".replace(",", " ") if inc else "",
                     f"{out:,.2f}".replace(",", " ") if out else "", f"{bal:,.2f}".replace(",", " ")])
    y = _table(c, 30, y_top, [62, 220, 80, 80, 93], rows, row_h=18, head_fill=(170, 205, 185),
               zebra=(228, 242, 233), size=7.5)
    if k == 1:
        c.setFont("DejaVuSans", 8)
        _rgb(c, 60, 60, 60)
        c.drawString(30, y - 16, "Продолжение — на странице 2.")
    else:
        _rgb(c, 228, 242, 233)
        c.rect(300, y - 120, 265, 90, stroke=0, fill=1)
        _rgb(c, *green, fill=False)
        c.setLineWidth(1.2)
        c.rect(300, y - 120, 265, 90, stroke=1, fill=0)
        _rgb(c, 25, 25, 30)
        for i, (a, b) in enumerate([("Поступления за период:", "512 840,00"), ("Списания за период:", "301 190,00"),
                                    ("Исходящий остаток:", "623 950,00")]):
            c.setFont("DejaVuSans-Bold" if i == 2 else "DejaVuSans", 9)
            c.drawString(310, y - 50 - i * 22, a)
            c.drawRightString(555, y - 50 - i * 22, b)
        _stamp(c, 150, y - 90, 50, "★ БАНК «ОБРАЗЕЦ» ★ ОБРАЗЕЦ ", "ВЫПИСКА\nВЕРНА", color=(30, 110, 70))
        _rgb(c, 25, 25, 30)
        c.setFont("DejaVuSans", 8.5)
        c.drawString(40, y - 170, "Операционист _____________  Т. С. Тестова     Дата выдачи: 05.10.2026")


def _hotel_photo(c, x, y, w, h):
    c.saveState()
    _rgb(c, 160, 200, 235)
    c.rect(x, y, w, h, stroke=0, fill=1)
    _rgb(c, 110, 160, 90)
    c.rect(x, y, w, h * 0.18, stroke=0, fill=1)
    _rgb(c, 225, 205, 170)
    c.rect(x + w * 0.18, y + h * 0.18, w * 0.64, h * 0.62, stroke=0, fill=1)
    _rgb(c, 150, 80, 60)
    p = c.beginPath()
    p.moveTo(x + w * 0.14, y + h * 0.80)
    p.lineTo(x + w * 0.50, y + h * 0.95)
    p.lineTo(x + w * 0.86, y + h * 0.80)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    _rgb(c, 70, 100, 140)
    for r in range(5):
        for k in range(6):
            c.rect(x + w * (0.22 + k * 0.1), y + h * (0.24 + r * 0.11), w * 0.06, h * 0.07, stroke=0, fill=1)
    _rgb(c, 255, 255, 255)
    c.setFont("DejaVuSans-Bold", 10)
    c.drawCentredString(x + w / 2, y + h * 0.06, "фото отеля — ОБРАЗЕЦ")
    c.restoreState()


def _p_bron(c, k):
    blue = (25, 70, 150)
    if k == 1:
        _rgb(c, *blue)
        c.rect(30, 700, 535, 85, stroke=0, fill=1)
        _rgb(c, 255, 255, 255)
        c.setFont("DejaVuSans-Bold", 20)
        c.drawString(45, 752, "HOTEL SPECIMEN ★★★")
        c.setFont("DejaVuSans", 10)
        c.drawString(45, 730, "Подтверждение бронирования / Booking confirmation (ОБРАЗЕЦ)")
        c.drawString(45, 714, "Образцовск, проспект Тестовый, 5 · +000 00 000 000 · hotel@example.com")
        _hotel_photo(c, 30, 470, 270, 215)
        kv = [("Номер брони", "SPC-000123"), ("Гость", "OBRAZTSOV OLEG"), ("Заезд", "01.11.2026, с 14:00"),
              ("Выезд", "14.11.2026, до 12:00"), ("Ночей", "13"), ("Номер", "Стандарт, 1 гость"),
              ("Питание", "завтрак"), ("Оплата", "оплачено полностью"), ("Итого", "1 690,00 EUR")]
        for i, (a, b) in enumerate(kv):
            yy = 668 - i * 22
            _rgb(c, 236, 241, 250) if i % 2 == 0 else _rgb(c, 255, 255, 255)
            c.rect(315, yy - 6, 250, 22, stroke=0, fill=1)
            _rgb(c, 90, 90, 100)
            c.setFont("DejaVuSans", 8)
            c.drawString(322, yy + 1, a)
            _rgb(c, 20, 20, 25)
            c.setFont("DejaVuSans-Bold", 9)
            c.drawString(410, yy + 1, b)
        rows = [["Дата", "Тариф", "Цена, EUR", "Статус"]]
        for i in range(13):
            rows.append([f"{1 + i:02d}.11.2026", "Стандарт + завтрак", "130,00", "оплачено"])
        _table(c, 30, 440, [120, 200, 100, 115], rows, row_h=19, head_fill=(200, 215, 240), size=8)
    else:
        txt = ("Условия проживания. Заселение с 14:00, выезд до 12:00. Ранний заезд и поздний выезд — по наличию "
               "мест и за отдельную плату. Курение в номерах запрещено. Домашние животные не допускаются. Гость "
               "предъявляет при заселении паспорт и подтверждение бронирования. Отель вправе заблокировать на "
               "карте гостя депозит за мини-бар и порчу имущества. Городской налог оплачивается на месте. "
               "Wi-Fi бесплатный. Завтрак с 7:00 до 10:30. Трансфер из аэропорта — по запросу. ")
        col_lines = _wrap(txt * 4, "DejaVuSans", 7.2, 245)
        half = len(col_lines) // 2
        _text_lines(c, 40, 770, col_lines[:half], size=7.2, leading=10.5)
        _text_lines(c, 310, 770, col_lines[half:], size=7.2, leading=10.5)
        _rgb(c, 255, 236, 150)
        c.rect(40, 170, 515, 95, stroke=0, fill=1)
        _rgb(c, 200, 150, 0, fill=False)
        c.setLineWidth(1.5)
        c.rect(40, 170, 515, 95, stroke=1, fill=0)
        _rgb(c, 60, 45, 0)
        c.setFont("DejaVuSans-Bold", 13)
        c.drawString(55, 236, "Бесплатная отмена до 25.10.2026")
        c.setFont("DejaVuSans", 9)
        c.drawString(55, 214, "После этой даты удерживается стоимость первой ночи (130,00 EUR).")
        c.drawString(55, 198, "Отмена — по ссылке из письма или по телефону отеля. Бронь SPC-000123 (ОБРАЗЕЦ).")
        _rgb(c, 25, 70, 150)
        c.setFont("DejaVuSans-Bold", 11)
        c.drawString(40, 120, "HOTEL SPECIMEN ★★★ — до встречи!")


def _barcode(c, x, y, w, h, seed):
    rnd = random.Random(seed)
    c.saveState()
    _rgb(c, 0, 0, 0)
    xx = x
    while xx < x + w - 4:
        bw = rnd.choice([1.0, 1.0, 2.0, 3.0])
        if rnd.random() < 0.55:
            c.rect(xx, y, bw, h, stroke=0, fill=1)
        xx += bw
    c.restoreState()


def _p_bilety(c):
    orange = (230, 120, 20)
    _rgb(c, *orange)
    c.rect(30, 60, 18, 690, stroke=0, fill=1)
    _rgb(c, 25, 25, 30)
    c.setFont("DejaVuSans-Bold", 12)
    c.drawString(65, 760, "Электронный билет / маршрут-квитанция (ОБРАЗЕЦ)")
    c.setFont("DejaVuSans", 9)
    c.drawString(65, 742, "Авиакомпания «Образец Авиа» · Номер билета 000 0000000000 · Бронь SPCXYZ")
    c.drawString(65, 728, "Пассажир: OBRAZTSOV OLEG MR · Паспорт 00 0000000")
    segs = [("SP 1234", "Москва (SVO)", "Образцовск (OBR)", "01.11.2026", "08:15", "12:40", "14A"),
            ("SP 1235", "Образцовск (OBR)", "Москва (SVO)", "14.11.2026", "15:30", "19:55", "21C")]
    for i, (fl, a, b, d, t1, t2, seat) in enumerate(segs):
        yb = 560 - i * 150
        _rgb(c, 252, 236, 218)
        c.rect(65, yb + 105, 500, 25, stroke=0, fill=1)
        _rgb(c, *orange, fill=False)
        c.setLineWidth(1.3)
        c.rect(65, yb, 500, 130, stroke=1, fill=0)
        _rgb(c, 90, 45, 0)
        c.setFont("DejaVuSans-Bold", 10)
        c.drawString(75, yb + 113, f"Рейс {fl} · {d} · Эконом · Багаж 1×23 кг · Место {seat}")
        _rgb(c, 20, 20, 25)
        c.setFont("DejaVuSans-Bold", 22)
        c.drawString(75, yb + 60, t1)
        c.drawString(390, yb + 60, t2)
        c.setFont("DejaVuSans", 10)
        c.drawString(75, yb + 40, a)
        c.drawString(390, yb + 40, b)
        c.setLineWidth(1)
        c.line(165, yb + 68, 375, yb + 68)
        c.drawCentredString(270, yb + 74, "✈ в пути 4 ч 25 мин")
        c.setFont("DejaVuSans", 8)
        c.drawString(75, yb + 15, "Регистрация закрывается за 40 минут до вылета. Терминал уточняйте в аэропорту.")
    _barcode(c, 65, 250, 500, 60, seed=4242)
    c.setFont("DejaVuSans", 8)
    _rgb(c, 25, 25, 30)
    c.drawCentredString(315, 238, "SPCXYZ · 000 0000000000 · ОБРАЗЕЦ")
    rows = [["Тариф", "Таксы и сборы", "Итого", "Форма оплаты"],
            ["21 400 RUB", "3 380 RUB", "24 780 RUB", "банковская карта"]]
    _table(c, 65, 205, [125, 125, 125, 125], rows, row_h=22, head_fill=(252, 220, 190), size=8.5)


def _p_strahovka(c):
    navy = (20, 50, 110)
    c.saveState()
    _rgb(c, 40, 150, 110)
    p = c.beginPath()
    p.moveTo(480, 785)
    p.lineTo(545, 785)
    p.lineTo(545, 745)
    p.curveTo(545, 725, 520, 712, 512, 708)
    p.curveTo(504, 712, 480, 725, 480, 745)
    p.close()
    c.drawPath(p, stroke=0, fill=1)
    _rgb(c, 255, 255, 255)
    c.setFont("DejaVuSans-Bold", 16)
    c.drawCentredString(512, 745, "СО")
    c.restoreState()
    _rgb(c, *navy)
    c.setFont("DejaVuSans-Bold", 11)
    c.drawString(40, 760, "АО «Страхование-Образец»")
    _rgb(c, 25, 25, 30)
    c.setFont("DejaVuSans", 9)
    c.drawString(40, 744, "Полис медицинского страхования выезжающих за рубеж № ПМС-000000 (ОБРАЗЕЦ)")
    c.drawString(40, 730, "Застрахованный: OBRAZTSOV OLEG, 01.01.1990 · Паспорт 00 0000000")
    _rgb(c, 222, 234, 250)
    c.rect(40, 605, 515, 105, stroke=0, fill=1)
    _rgb(c, *navy, fill=False)
    c.setLineWidth(1.5)
    c.rect(40, 605, 515, 105, stroke=1, fill=0)
    _rgb(c, *navy)
    c.setFont("DejaVuSans-Bold", 22)
    c.drawString(55, 670, "Страховая сумма 30 000 EUR")
    c.setFont("DejaVuSans", 10)
    c.drawString(55, 645, "Территория: Образцовая Республика и страны Шенгенского соглашения")
    c.drawString(55, 627, "Период: 01.11.2026 – 14.11.2026 (14 дней) · Франшиза: нет · Спорт: нет")
    rows = [["Риск", "Лимит, EUR"], ["Медицинская помощь при болезни", "30 000"],
            ["Медицинская помощь при травме", "30 000"], ["Экстренная стоматология", "300"],
            ["Медицинская транспортировка", "10 000"], ["Репатриация", "5 000"],
            ["Визит родственника", "2 000"], ["Возвращение детей", "2 000"], ["Юридическая помощь", "1 000"],
            ["Потеря документов", "300"], ["Задержка рейса", "—"], ["Несчастный случай", "—"]]
    _table(c, 40, 580, [365, 150], rows, row_h=21, head_fill=navy, head_color=(255, 255, 255), size=8.5,
           zebra=(240, 244, 252))
    from reportlab.graphics import renderPDF
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing

    qr = QrCodeWidget("https://example.com/specimen/policy/PMS-000000")
    b = qr.getBounds()
    s = 90.0
    dr = Drawing(s, s, transform=[s / (b[2] - b[0]), 0, 0, s / (b[3] - b[1]), 0, 0])
    dr.add(qr)
    renderPDF.draw(dr, c, 455, 100)
    _rgb(c, 25, 25, 30)
    c.setFont("DejaVuSans", 9)
    c.drawString(40, 190, "Страхователь: ____________  Образцов О. О.")
    c.drawString(40, 160, "Представитель страховщика: ____________  Тестова Т. Т.")
    _scribble(c, 120, 186, 70, 16, seed=909)
    _scribble(c, 200, 156, 70, 16, seed=910)
    _stamp(c, 330, 150, 40, "★ СТРАХОВАНИЕ-ОБРАЗЕЦ ★ ОБРАЗЕЦ ", "ПОЛИС\nОБРАЗЕЦ", color=navy)


_DRAW = {
    "anketa_1": _p_anketa_1, "anketa_2": _p_anketa_2, "pasport": _p_pasport, "spravka": _p_spravka,
    "vypiska_1": lambda c: _p_vypiska(c, 1), "vypiska_2": lambda c: _p_vypiska(c, 2),
    "bron_1": lambda c: _p_bron(c, 1), "bron_2": lambda c: _p_bron(c, 2),
    "bilety": _p_bilety, "strahovka": _p_strahovka,
}


def _render_documents():
    """One reportlab PDF with the 10 unique pages (expected order) -> list of RGB PIL images at 200 dpi."""
    C.ff_register_rl_fonts("DejaVuSans", "DejaVuSans-Bold", "DejaVuSansMono-Bold")
    buf = io.BytesIO()
    c = C.ff_rl_canvas(buf, title="Сканы для визы — исходные страницы (ОБРАЗЕЦ)")
    for key, _label, doc_type, k, n, _slug in UNIQUE:
        _watermark(c)
        _DRAW[key](c)
        _decor(c, doc_type, k, n)
        c.showPage()
    c.save()
    imgs = C.px_pdf_to_pil(buf.getvalue(), DPI)
    for im in imgs:
        assert im.size == PAGE_PX, im.size
    return dict(zip([u[0] for u in UNIQUE], imgs))


# ============================================================================ scan simulation

PAPER = np.array([0.985, 0.978, 0.962], np.float32)


def _scanify(img, seed, *, shift=(0, 0)):
    """Paper tint, slight blur, optional shift, Gaussian noise σ=3 (luminance) + σ=1 (chroma)."""
    if shift != (0, 0):
        canvas = Image.new("RGB", img.size, (255, 255, 255))
        canvas.paste(img, shift)
        img = canvas
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    a = np.asarray(img, np.float32) * PAPER
    rng = np.random.default_rng(seed)
    h, w = a.shape[:2]
    a += rng.normal(0, 3.0, (h, w, 1)).astype(np.float32)
    a += rng.normal(0, 1.0, (h, w, 3)).astype(np.float32)
    return Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8), "RGB")


def _blank(seed, specks=0):
    rng = np.random.default_rng(seed)
    w, h = PAGE_PX
    a = np.empty((h, w, 3), np.float32)
    a[:] = 255.0 * PAPER
    a += rng.normal(0, 3.0, (h, w, 1)).astype(np.float32)
    a += rng.normal(0, 1.0, (h, w, 3)).astype(np.float32)
    rnd = random.Random(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    speck_list = []
    for _ in range(specks):
        cx, cy = rnd.randrange(150, w - 150), rnd.randrange(150, h - 150)
        r = 1.5 + 3.0 * rnd.random()
        dark = 60 + rnd.randrange(80)
        sl = (slice(max(0, cy - 8), cy + 9), slice(max(0, cx - 8), cx + 9))
        d2 = ((xx[sl] - cx) / r) ** 2 + ((yy[sl] - cy) / (r * (0.6 + 0.8 * rnd.random()))) ** 2
        m = np.clip(1.4 - d2, 0, 1)[..., None]
        a[sl] = a[sl] * (1 - m) + dark * m
        speck_list.append({"x_px": cx, "y_px": cy, "r_px": round(r, 2)})
    return Image.fromarray(np.clip(a + 0.5, 0, 255).astype(np.uint8), "RGB"), speck_list


def _rotate_cw(img, deg):
    return {0: img, 90: img.transpose(Image.ROTATE_270), 180: img.transpose(Image.ROTATE_180),
            270: img.transpose(Image.ROTATE_90)}[deg]


def _template(img):
    return img.convert("L").resize(TEMPLATE_SIZE, Image.LANCZOS)


# ============================================================================ verification helpers (also used by tests)

def _corr(a, b):
    a = np.asarray(a, np.float64).ravel()
    b = np.asarray(b, np.float64).ravel()
    a = a - a.mean()
    b = b - b.mean()
    den = math.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / den) if den > 0 else 0.0


def match_page(gray_img, templates):
    """Best (template index, clockwise rotation applied to the page, corr) over 0/90/180/270."""
    best = (-1, 0, -2.0)
    scores = {}
    for rot in (0, 90, 180, 270):
        g = _rotate_cw(gray_img, rot).resize(TEMPLATE_SIZE, Image.LANCZOS)
        for ti, t in enumerate(templates):
            r = _corr(g, t)
            scores[(ti, rot)] = r
            if r > best[2]:
                best = (ti, rot, r)
    return best, scores


# ============================================================================ build

def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    tdir = truth_dir / "visa_templates"
    tdir.mkdir(parents=True, exist_ok=True)

    renders = _render_documents()
    written = []

    # templates
    manifest = []
    for i, (key, label, doc_type, k, n, slug) in enumerate(UNIQUE, start=1):
        t = _template(renders[key])
        tp = tdir / f"{i:02d}_{slug}.png"
        C.px_save_png_deterministic(t, tp)
        written.append(str(tp))
        lp = tdir / "legibility" / f"{i:02d}_{slug}_620x877.png"
        C.px_save_png_deterministic(renders[key].convert("L").resize(LEGIBILITY_SIZE, Image.LANCZOS), lp)
        written.append(str(lp))
        src_pages = [pi for pi, (kind, kk, _r) in enumerate(PAGES, start=1) if kk == key and kind == "doc"]
        manifest.append({"index": i, "label": label, "heading": f"{doc_type} — стр. {k} из {n} (ОБРАЗЕЦ)",
                         "template": f"visa_templates/{tp.name}", "legibility_ref": f"visa_templates/legibility/{lp.name}",
                         "fixture_page": src_pages[0],
                         "sha256": hashlib.sha256(tp.read_bytes()).hexdigest()})

    # fixture pages
    page_jpegs, page_info = [], []
    for pi, (kind, key, rot) in enumerate(PAGES, start=1):
        seed = SEED + pi * 101
        info = {"page": pi, "kind": kind, "rotation_cw_baked": rot, "fix_rotate_cw": (360 - rot) % 360}
        if kind in ("doc", "duplicate"):
            shift = (4, 4) if kind == "duplicate" else (0, 0)
            img = _scanify(renders[key], seed, shift=shift)
            info.update({"label": [u[1] for u in UNIQUE if u[0] == key][0], "shift_px": list(shift)})
            if kind == "duplicate":
                info["duplicate_of_page"] = 2
        else:
            img, specks = _blank(seed, specks=5 if kind == "blank_specks" else 0)
            info["noise_sigma"] = 3.0
            if specks:
                info["specks"] = specks
        img = _rotate_cw(img, rot)
        jb = C.ff_jpeg_bytes(img, JPEG_Q)
        info["jpeg_bytes"] = len(jb)
        info["px"] = list(img.size)
        page_jpegs.append((jb, img.size))
        page_info.append(info)

    pdf_path = out_dir / FIXTURE
    c = C.ff_rl_canvas(str(pdf_path), title="Сканы для визы (ОБРАЗЕЦ / SPECIMEN)",
                       subject="Сканы 200 dpi, учебный набор (ОБРАЗЕЦ)", creator="Scanner SPECIMEN-200")
    for jb, (w, h) in page_jpegs:
        wp, hp = w * 72.0 / DPI, h * 72.0 / DPI
        c.setPageSize((wp, hp))
        C.ff_rl_draw_jpeg(c, jb, 0, 0, wp, hp)
        c.showPage()
    c.save()
    written.insert(0, str(pdf_path))

    # self-check on the fixture itself: each document page, rotated back, best matches its template at 0°
    templates = [Image.open(tdir / f"{i:02d}_{u[5]}.png").convert("L") for i, u in enumerate(UNIQUE, start=1)]
    fixture_imgs = C.px_pdf_to_pil(pdf_path.read_bytes(), 60, gray=True)
    checks = []
    for info, g in zip(page_info, fixture_imgs):
        (ti, rot, r), scores = match_page(g, templates)
        row = {"page": info["page"], "best_template": UNIQUE[ti][1] if ti >= 0 else None,
               "best_rotation_cw": rot, "corr": round(r, 4)}
        if info["kind"] in ("doc", "duplicate"):
            exp_ti = [u[1] for u in UNIQUE].index(info["label"])
            others = [v for (t2, r2), v in scores.items() if not (t2 == exp_ti and r2 == info["fix_rotate_cw"])]
            row["margin_vs_next"] = round(r - max(others), 4)
            assert ti == exp_ti and rot == info["fix_rotate_cw"], (info, row)
        checks.append(row)

    truth = {
        "fixture": FIXTURE,
        "page_size_px_portrait": list(PAGE_PX), "dpi": DPI, "jpeg_quality": JPEG_Q,
        "pdf_bytes": pdf_path.stat().st_size,
        "pages": page_info,
        "remove": {"blank_pages": [3, 10], "duplicate_pages": [7], "duplicate_of": {"7": 2}},
        "expected_order": [{"label": m["label"], "fixture_page": m["fixture_page"],
                            "fix_rotate_cw": page_info[m["fixture_page"] - 1]["fix_rotate_cw"],
                            "template": m["template"]} for m in manifest],
        "expected_split": [{"document": d, "pages": len(lbls), "labels": lbls} for d, lbls in SPLIT],
        "template_method": "page rendered (any dpi) -> gray -> rotated -> resized to 64x91 with LANCZOS -> Pearson "
                           "correlation with the template PNG",
        "legibility_method": "page rendered at 150 dpi -> gray -> resized to 620x877 with LANCZOS -> Pearson correlation "
                             "with legibility/NN_<slug>_620x877.png; 150 dpi q60 re-encode of the scan: ~0.997, 100 dpi q40: "
                             "~0.987, 40 dpi q10 mush: ~0.81 (proposed threshold 0.9, see issues/f-pdf-visa-pack-surgery.md)",
        "self_check_fixture_60dpi": checks,
    }
    C.ff_write_json(tdir / "manifest.json", {"templates": manifest, "size": list(TEMPLATE_SIZE)})
    written.append(str(tdir / "manifest.json"))
    written.append(C.ff_write_json(truth_dir / "skany_viza.json", truth))
    return written


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / "f-pdf-visa-pack-surgery", base / "truth"):
        print(p)
