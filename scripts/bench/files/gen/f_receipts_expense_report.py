"""Fixtures for f-receipts-expense-report.

chek_1.jpg  e-receipt screenshot of a taxi ride (1170×2532, PNG-like UI → JPEG), 1 250,00, без НДС
chek_2.jpg  phone photo of an A4 hotel «счёт-чек» with a fiscal block, 9 800,00, НДС не облагается
chek_3.jpg  thermal receipt (cafe) on an open palm, rotated 8° clockwise (PIL angle −8), 1 140,00
chek_4.jpg  thermal receipt (airport express) upside down on a desk, 500,00
chek_5.jpg  THE SAME receipt as chek_3 (identical print, same ФН/ФД/ФП) — other angle, flash glare
chek_6.jpg  thermal receipt (stationery) crumpled (mesh displacement + crease shading), faded, 780,50
chek_7.jpg  thermal receipt (cafe, 14.10) with Gaussian blur σ=1.6 on the whole photo, 2 365,00
chek_8.jpg  thermal receipt (clothes) dated 20.10.2026 — outside the trip (12–14.10), 6 990,00

Photos are 3000×4000 (portrait, EXIF Orientation=1), JPEG q 55–75. Data: datagen.RECEIPTS
(date, seller, ИНН, total, VAT, ФД); everything else here (ФН, ФП, items) is invented and consistent
with those totals. Every receipt prints «ОБРАЗЕЦ / SPECIMEN».

truth/chek_receipts.json        per file: receipt data, items, fiscal attributes, where the receipt
                                lies in the photo (quad TL,TR,BR,BL of the flat render, display px),
                                expected report rows and total (datagen.all_expected()["receipts_total"])
truth/chek_<n>_template.png     upright flat render of each distinct receipt (gray, long side 1024)
                                for pdf_pages_upright / pdf_page_order (chek_5 uses chek_3's template)
"""

from __future__ import annotations

import math
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402
import datagen as DG  # noqa: E402

PHOTO = (3000, 4000)
PPM = 20                      # thermal render: px per mm
RW = 58 * PPM                 # 58 mm paper
COLS = 32                     # characters per line on a 58 mm printer
FONT_PX = 48
LINE_PX = 60

# Invented fiscal attributes (fake series 9999…); ФД comes from datagen.
FISCAL = {
    1: dict(fn="9999078902001765", fp="2781934406", rn="0000000001650011", zn="00000000017650",
            shift=205, check=17, sno="УСН доход", pay="Безналичными", cashier="Автоматический режим"),
    2: dict(fn="9999078902004410", fp="3021987745", rn="0000000001655022", zn="00000000044100",
            shift=88, check=41, sno="ОСН", pay="БЕЗНАЛИЧНЫМИ", cashier="Администратор Тестова Е."),
    3: dict(fn="9999078902007733", fp="1186420973", rn="0000000001655033", zn="00000000077330",
            shift=41, check=118, sno="ОСН", pay="БЕЗНАЛИЧНЫМИ", cashier="Кассир Образцова А."),
    4: dict(fn="9999078902002290", fp="4407712618", rn="0000000001655044", zn="00000000022900",
            shift=12, check=356, sno="ОСН", pay="БЕЗНАЛИЧНЫМИ", cashier="Кассир-автомат №3"),
    6: dict(fn="9999078902005541", fp="0937265518", rn="0000000001655066", zn="00000000055410",
            shift=77, check=63, sno="ОСН", pay="НАЛИЧНЫМИ", cashier="Продавец Специменова О."),
    7: dict(fn="9999078902007733", fp="2650384471", rn="0000000001655033", zn="00000000077330",
            shift=43, check=77, sno="ОСН", pay="БЕЗНАЛИЧНЫМИ", cashier="Кассир Образцова А."),
    8: dict(fn="9999078902008806", fp="5512093384", rn="0000000007700079", zn="00000000088060",
            shift=150, check=212, sno="ОСН", pay="БЕЗНАЛИЧНЫМИ", cashier="Кассир Тестов И."),
}
ADDRESS = {
    1: "420000, г. Казань, ул. Примерная, 1",
    2: "420021, г. Казань, ул. Тестовая, д. 15",
    3: "г. Казань, ул. Образцовая, 7",
    4: "г. Казань, пл. Образцовая, 1",
    6: "г. Казань, ул. Специменная, 3",
    7: "г. Казань, ул. Образцовая, 7",
    8: "г. Казань, пр. Тестовый, 20",
}
PLACE = {1: "taxi-obrazec.example", 4: "Касса-автомат, перрон 1"}
# (name, qty, unit price) — sums equal datagen totals
ITEMS = {
    1: [("Перевозка пассажиров и багажа", 1, 1250.00)],
    2: [("Проживание, номер «Стандарт», 12.10–14.10.2026", 2, 4900.00)],
    3: [("Салат «Образец»", 1, 390.00), ("Суп-лапша домашняя", 1, 260.00),
        ("Эчпочмак", 2, 95.00), ("Чай чёрный, чайник 0,6 л", 1, 300.00)],
    4: [("Билет «Стандарт» Вокзал — Аэропорт", 1, 500.00)],
    6: [("Блокнот А5 в клетку", 2, 145.00), ("Ручка гелевая синяя", 3, 49.50),
        ("Папка-конверт А4", 4, 85.50)],
    7: [("Бизнес-ланч", 2, 520.00), ("Плов по-татарски", 1, 450.00), ("Чак-чак", 1, 275.00),
        ("Морс клюквенный 0,5 л", 2, 160.00), ("Кофе американо", 1, 280.00)],
    8: [("Джемпер мужской, р. 50", 1, 4990.00), ("Футболка базовая", 2, 1000.00)],
}
CATEGORY = {1: "проезд (такси)", 2: "проживание", 3: "питание", 4: "проезд (аэроэкспресс)",
            6: "канцтовары", 7: "питание", 8: "одежда (личное, вне командировки)"}
JPEG_Q = {1: 75, 2: 70, 3: 62, 4: 68, 5: 58, 6: 60, 7: 55, 8: 72}

RECEIPTS = {r["n"]: r for r in DG.RECEIPTS}


# ------------------------------------------------------------------ formatting

def _money(v, sep=" ", dec=","):
    s = f"{v:,.2f}".replace(",", " ").replace(".", dec).replace(" ", sep)
    return s


def _lr(left, right, width=COLS):
    return left + " " * max(1, width - len(left) - len(right)) + right


def _wrap(text, width=COLS, indent=""):
    words, lines, cur = text.split(), [], ""
    for w in words:
        cand = (cur + " " + w).strip() if cur else w
        if len(cand) <= width:
            cur = cand
        else:
            lines.append(cur)
            cur = indent + w
    if cur:
        lines.append(cur)
    return lines


def _vat_amount(n):
    r = RECEIPTS[n]
    return round(r["total"] / 6, 2) if "20%" in r["vat"] else None


def _qr_payload(n):
    r, f = RECEIPTS[n], FISCAL[n]
    d, t = r["date"].split()
    dd, mm, yy = d.split(".")
    return f"t={yy}{mm}{dd}T{t.replace(':', '')}&s={r['total']:.2f}&fn={f['fn']}&i={r['fd']}&fp={f['fp']}&n=1"


# ------------------------------------------------------------------ thermal receipt (flat)

def _thermal_lines(n):
    r, f = RECEIPTS[n], FISCAL[n]
    date, time = r["date"].split()
    L = [("*** ОБРАЗЕЦ / SPECIMEN ***", "c"), ("", "n")]
    L += [(s, "cb") for s in _wrap(r["seller"])]
    L += [(s, "c") for s in _wrap(ADDRESS[n])]
    L += [(f"ИНН {r['inn']}", "c"), ("-" * COLS, "n"), ("КАССОВЫЙ ЧЕК / ПРИХОД", "cb"),
          (_lr(f"Смена {f['shift']}", f"Чек {f['check']}"), "n"), (_lr(date, time), "n")]
    L += [(s, "n") for s in _wrap(f["cashier"])]
    L.append(("-" * COLS, "n"))
    for i, (name, q, p) in enumerate(ITEMS[n], 1):
        L += [(s, "n") for s in _wrap(f"{i}. {name}", indent="   ")]
        L.append((_lr(f"   {q} x {p:.2f}", f"={q * p:.2f}"), "n"))
        L.append(("   НДС 20%" if "20%" in r["vat"] else "   БЕЗ НДС", "n"))
    L.append(("-" * COLS, "n"))
    L.append((_lr("ИТОГ", f"≡{r['total']:.2f}", 17), "big"))
    L.append((_lr(f["pay"], f"≡{r['total']:.2f}"), "n"))
    vat = _vat_amount(n)
    if vat is not None:
        L.append((_lr("СУММА НДС 20%", f"={vat:.2f}"), "n"))
    else:
        L.append((_lr("СУММА БЕЗ НДС", f"={r['total']:.2f}"), "n"))
    L.append((_lr("СНО:", f["sno"]), "n"))
    if n in PLACE:
        L += [(s, "n") for s in _wrap("Место расчётов: " + PLACE[n])]
    L += [("-" * COLS, "n"), (_lr("ФН", f["fn"]), "n"), (_lr(f"ФД {r['fd']}", f"ФП {f['fp']}"), "b"),
          (_lr("РН ККТ", f["rn"]), "n"), (_lr("ЗН ККТ", f["zn"]), "n"),
          ("Сайт ФНС: www.nalog.gov.ru", "c"), ("QR", "qr"),
          ("СПАСИБО ЗА ПОКУПКУ!", "c"), ("", "n"), ("*** ОБРАЗЕЦ / SPECIMEN ***", "c")]
    return L


def _thermal_flat(n, *, seed):
    """Flat RGBA render of a 58 mm thermal receipt (alpha = paper, jagged cutter edges)."""
    lines = _thermal_lines(n)
    fn = C.ff_pil_font("DejaVuSansMono", FONT_PX)
    fb = C.ff_pil_font("DejaVuSansMono-Bold", FONT_PX)
    fbig = C.ff_pil_font("DejaVuSansMono-Bold", int(FONT_PX * 1.55))
    char_w = fn.getlength("0")
    x0 = int((RW - COLS * char_w) / 2)
    qr = C.px_qr_image(_qr_payload(n), module_px=8, border=2)
    heights = {"big": int(LINE_PX * 1.55), "qr": qr.height + 30}
    H = 90 + sum(heights.get(st, LINE_PX) for _, st in lines) + 110
    ink = Image.new("L", (RW, H), 0)
    d = ImageDraw.Draw(ink)
    y = 90
    boxes = {}
    for text, st in lines:
        h = heights.get(st, LINE_PX)
        if st == "qr":
            ink.paste(Image.eval(qr, lambda v: 255 - v), (int(RW / 2 - qr.width / 2), y + 10))
            boxes["qr"] = [int(RW / 2 - qr.width / 2), y + 10, int(RW / 2 + qr.width / 2), y + 10 + qr.height]
        elif st in ("c", "cb"):
            d.text((RW / 2, y + h - 14), text, font=fb if st == "cb" else fn, fill=255, anchor="ms")
        elif st == "big":
            d.text((x0, y + h - 16), text, font=fbig, fill=255, anchor="ls")
            boxes["total_line"] = [x0, y, x0 + int(fbig.getlength(text)), y + h]
        else:
            d.text((x0, y + h - 14), text, font=fb if st == "b" else fn, fill=255, anchor="ls")
            if text.startswith("ФД "):
                boxes["fd_line"] = [x0, y, x0 + int(fb.getlength(text)), y + h]
        y += h
    rng = np.random.default_rng(seed)
    a = np.asarray(ink, np.float32) / 255.0
    # print density: low-frequency variation along the paper + a weak dot column dropout
    dens = 0.86 + 0.12 * np.clip(C.px_smooth_noise((H, RW), 160, seed, octaves=2), -1, 1)
    col = int(rng.integers(int(RW * 0.3), int(RW * 0.7)))
    dens[:, col:col + 3] *= 0.55
    a = a * dens
    paper = np.empty((H, RW, 3), np.float32)
    paper[:] = (247, 246, 241)
    paper += rng.normal(0, 1.6, (H, RW, 1)).astype(np.float32)
    # curl shading across the width (receipts never lie flat)
    xs = np.linspace(-1, 1, RW, dtype=np.float32)
    paper *= (1.0 - 0.07 * xs ** 2 + 0.02 * xs)[None, :, None]
    inkc = np.array((38, 36, 44), np.float32)
    rgb = paper * (1 - a[..., None]) + inkc * a[..., None]
    # cutter edges: small serration at top and bottom
    alpha = np.full((H, RW), 255, np.uint8)
    xs_i = np.arange(RW)
    top = (6 + 4 * np.abs(((xs_i / 9.0) % 2) - 1) + rng.normal(0, 0.8, RW)).astype(int)
    bot = (H - 6 - 4 * np.abs(((xs_i / 11.0) % 2) - 1) + rng.normal(0, 0.8, RW)).astype(int)
    for x in range(RW):
        alpha[:top[x], x] = 0
        alpha[bot[x]:, x] = 0
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")
    img.putalpha(Image.fromarray(alpha, "L"))
    return img, boxes


# ------------------------------------------------------------------ e-receipt screenshot (#1)

def _ereceipt_screenshot():
    n = 1
    r, f = RECEIPTS[n], FISCAL[n]
    W, H = 1170, 2532
    img = Image.new("RGB", (W, H), (242, 242, 247))
    d = ImageDraw.Draw(img)
    F = C.ff_pil_font
    # status bar
    d.text((90, 62), "7:41", font=F("DejaVuSans-Bold", 44), fill=(0, 0, 0), anchor="lm")
    for i in range(4):
        d.rectangle([880 + i * 22, 74 - 10 - i * 7, 894 + i * 22, 74 + 10], fill=(0, 0, 0))
    d.text((985, 62), "LTE", font=F("DejaVuSans-Bold", 30), fill=(0, 0, 0), anchor="lm")
    d.rounded_rectangle([1050, 46, 1118, 80], radius=9, outline=(0, 0, 0), width=3)
    d.rectangle([1056, 52, 1098, 74], fill=(0, 0, 0))
    d.rectangle([1120, 56, 1125, 70], fill=(0, 0, 0))
    # nav
    d.text((40, 180), "‹ Чеки", font=F("DejaVuSans", 44), fill=(0, 110, 230), anchor="lm")
    d.text((W / 2, 180), "Электронный чек", font=F("DejaVuSans-Bold", 44), fill=(0, 0, 0), anchor="mm")
    d.text((W - 40, 180), "⋯", font=F("DejaVuSans-Bold", 48), fill=(0, 110, 230), anchor="rm")
    d.rounded_rectangle([40, 260, W - 40, 2400], radius=40, fill=(255, 255, 255))
    y = 320
    d.ellipse([W / 2 - 60, y, W / 2 + 60, y + 120], fill=(232, 232, 236))
    d.text((W / 2, y + 60), "ТО", font=F("DejaVuSans-Bold", 50), fill=(110, 110, 120), anchor="mm")
    y += 170
    d.text((W / 2, y), r["seller"], font=F("DejaVuSans-Bold", 50), fill=(0, 0, 0), anchor="mm")
    y += 66
    d.text((W / 2, y), f"ИНН {r['inn']}", font=F("DejaVuSans", 40), fill=(60, 60, 67), anchor="mm")
    y += 56
    d.text((W / 2, y), ADDRESS[n], font=F("DejaVuSans", 34), fill=(120, 120, 128), anchor="mm")
    y += 90
    d.text((W / 2, y), "КАССОВЫЙ ЧЕК / ПРИХОД", font=F("DejaVuSans-Bold", 44), fill=(0, 0, 0), anchor="mm")
    y += 64
    date, time = r["date"].split()
    d.text((W / 2, y), f"Чек № {f['check']} · Смена № {f['shift']} · {date} {time}", font=F("DejaVuSans", 34),
           fill=(60, 60, 67), anchor="mm")
    y += 60
    lx, rx = 100, W - 100

    def sep(yy):
        d.line([(lx, yy), (rx, yy)], fill=(222, 222, 228), width=3)

    def row(yy, left, right, size=38, bold=False, color=(0, 0, 0)):
        fnt = F("DejaVuSans-Bold" if bold else "DejaVuSans", size)
        d.text((lx, yy), left, font=fnt, fill=color, anchor="lm")
        d.text((rx, yy), right, font=fnt, fill=color, anchor="rm")

    sep(y)
    y += 70
    name, q, p = ITEMS[n][0]
    d.text((lx, y), name, font=F("DejaVuSans-Bold", 40), fill=(0, 0, 0), anchor="lm")
    y += 54
    d.text((lx, y), "Аэропорт — ул. Образцовая, 7 · 12.10.2026 07:02–07:38", font=F("DejaVuSans", 32),
           fill=(120, 120, 128), anchor="lm")
    y += 60
    row(y, f"{q} × {_money(p)} ₽", f"{_money(q * p)} ₽")
    y += 56
    d.text((lx, y), "НДС не облагается", font=F("DejaVuSans", 32), fill=(120, 120, 128), anchor="lm")
    y += 60
    sep(y)
    y += 80
    row(y, "ИТОГ", f"{_money(r['total'])} ₽", size=56, bold=True)
    y += 84
    row(y, f["pay"], f"{_money(r['total'])} ₽")
    y += 60
    row(y, "Сумма без НДС", f"{_money(r['total'])} ₽")
    y += 60
    row(y, "СНО", f["sno"])
    y += 60
    row(y, "Место расчётов", PLACE[n])
    y += 60
    row(y, "Кассир", f["cashier"], color=(60, 60, 67))
    y += 50
    sep(y)
    y += 70
    for k, v in (("ФН", f["fn"]), ("ФД", r["fd"]), ("ФП", f["fp"]), ("РН ККТ", f["rn"]), ("ЗН ККТ", f["zn"]),
                 ("Сайт ФНС", "www.nalog.gov.ru")):
        row(y, k, v, size=36, color=(40, 40, 46))
        y += 52
    y += 20
    qr = C.px_qr_image(_qr_payload(n), module_px=8, border=2).convert("RGB")
    img.paste(qr, (int(W / 2 - qr.width / 2), y))
    y += qr.height + 46
    assert y < 2370, y
    d.text((W / 2, y), "ОБРАЗЕЦ / SPECIMEN — данные вымышлены", font=F("DejaVuSans-Bold", 36),
           fill=(200, 30, 30), anchor="mm")
    # bottom buttons and home indicator
    d.rounded_rectangle([40, 2420, W / 2 - 15, 2490], radius=24, fill=(229, 229, 234))
    d.rounded_rectangle([W / 2 + 15, 2420, W - 40, 2490], radius=24, fill=(229, 229, 234))
    d.text((W / 4 + 12, 2455), "Поделиться", font=F("DejaVuSans", 34), fill=(0, 110, 230), anchor="mm")
    d.text((3 * W / 4 - 12, 2455), "Скачать PDF", font=F("DejaVuSans", 34), fill=(0, 110, 230), anchor="mm")
    d.rounded_rectangle([W / 2 - 200, 2508, W / 2 + 200, 2520], radius=6, fill=(0, 0, 0))
    return img


# ------------------------------------------------------------------ hotel A4 (#2)

def _hotel_a4():
    from reportlab.lib.colors import Color, black

    n = 2
    r, f = RECEIPTS[n], FISCAL[n]
    C.ff_register_rl_fonts("DejaVuSans", "DejaVuSans-Bold", "DejaVuSansMono", "DejaVuSansMono-Bold",
                           "LiberationSerif", "LiberationSerif-Bold")
    import io

    buf = io.BytesIO()
    c = C.ff_rl_canvas(buf, title="Счёт-чек гостиницы (ОБРАЗЕЦ)")
    W, H = C.FF_A4
    mm = 72 / 25.4
    L, R = 20 * mm, W - 15 * mm
    c.setFillColor(Color(0.85, 0.12, 0.12))
    c.setFont("DejaVuSans-Bold", 8)
    c.drawRightString(R, H - 10 * mm, "ОБРАЗЕЦ / SPECIMEN — данные вымышлены")
    c.setFillColor(black)
    c.setStrokeColor(Color(0.2, 0.3, 0.45))
    c.setLineWidth(1.2)
    c.roundRect(L, H - 36 * mm, 16 * mm, 16 * mm, 3 * mm, stroke=1, fill=0)
    c.setFont("LiberationSerif-Bold", 15)
    c.drawCentredString(L + 8 * mm, H - 29.5 * mm, "ГО")
    c.setFont("DejaVuSans-Bold", 13)
    c.drawString(L + 20 * mm, H - 25 * mm, r["seller"])
    c.setFont("DejaVuSans", 9)
    c.drawString(L + 20 * mm, H - 30 * mm, ADDRESS[n] + " (ОБРАЗЕЦ)")
    c.drawString(L + 20 * mm, H - 34.5 * mm, f"ИНН {r['inn']}   КПП 165501001   тел. +7 (000) 000-00-00")
    c.line(L, H - 39 * mm, R, H - 39 * mm)
    c.setFont("DejaVuSans-Bold", 15)
    c.drawCentredString(W / 2, H - 51 * mm, "СЧЁТ-ЧЕК № 3127 от 12.10.2026")
    c.setFont("DejaVuSans", 10)
    y = H - 62 * mm
    for k, v in (("Гость:", "Тестов Андрей Андреевич"), ("Номер:", "412, категория «Стандарт»"),
                 ("Заезд:", "12.10.2026 14:00"), ("Выезд:", "14.10.2026 12:00"), ("Кол-во суток:", "2")):
        c.setFont("DejaVuSans-Bold", 10)
        c.drawString(L, y, k)
        c.setFont("DejaVuSans", 10)
        c.drawString(L + 32 * mm, y, v)
        y -= 6 * mm
    # table
    cols = [L, L + 10 * mm, L + 98 * mm, L + 118 * mm, L + 145 * mm, R]
    heads = ["№", "Наименование услуги", "Кол-во", "Цена, руб.", "Сумма, руб."]
    y -= 4 * mm
    rows = [heads] + [[str(i), nm, f"{q} сут.", _money(p), _money(q * p)] for i, (nm, q, p) in enumerate(ITEMS[n], 1)]
    rh = 9 * mm
    c.setLineWidth(0.8)
    c.setStrokeColor(black)
    for ri, row in enumerate(rows):
        top = y - ri * rh
        for ci in range(5):
            c.rect(cols[ci], top - rh, cols[ci + 1] - cols[ci], rh)
            c.setFont("DejaVuSans-Bold" if ri == 0 else "DejaVuSans", 8.6 if ci == 1 else 9.5)
            txt = row[ci]
            if ci in (0,):
                c.drawCentredString((cols[ci] + cols[ci + 1]) / 2, top - rh + 3.2 * mm, txt)
            elif ci == 1 or ri == 0:
                c.drawString(cols[ci] + 1.5 * mm, top - rh + 3.2 * mm, txt)
            else:
                c.drawRightString(cols[ci + 1] - 1.5 * mm, top - rh + 3.2 * mm, txt)
    y = y - len(rows) * rh - 8 * mm
    c.setFont("DejaVuSans-Bold", 11)
    c.drawRightString(R, y, f"Итого: {_money(r['total'])} руб.")
    y -= 6 * mm
    c.setFont("DejaVuSans", 10)
    c.drawRightString(R, y, "НДС не облагается")
    y -= 6 * mm
    c.drawRightString(R, y, f"Оплачено банковской картой: {_money(r['total'])} руб.")
    y -= 7 * mm
    c.drawString(L, y, "Сумма прописью: Девять тысяч восемьсот рублей 00 копеек.")
    # fiscal block (as printed by the front-desk KKT)
    y -= 14 * mm
    bx0, bx1 = L, L + 92 * mm
    c.setDash(3, 2)
    c.rect(bx0, y - 74 * mm, bx1 - bx0, 78 * mm)
    c.setDash()
    date, time = r["date"].split()
    fy = y - 3 * mm
    c.setFont("DejaVuSansMono-Bold", 10)
    c.drawCentredString((bx0 + bx1) / 2, fy, "КАССОВЫЙ ЧЕК / ПРИХОД")
    c.setFont("DejaVuSansMono", 9)
    for ln in (_lr(f"Смена {f['shift']}", f"Чек {f['check']}", 40), _lr(date, time, 40),
               _lr("Проживание", f"={r['total']:.2f}", 40), _lr("ИТОГ", f"≡{r['total']:.2f}", 40),
               _lr(f["pay"], f"≡{r['total']:.2f}", 40), _lr("НДС", "не облагается", 40),
               _lr("СНО:", f["sno"], 40), _lr("ФН", f["fn"], 40), _lr(f"ФД {r['fd']}", f"ФП {f['fp']}", 40),
               _lr("РН ККТ", f["rn"], 40), "Сайт ФНС: www.nalog.gov.ru"):
        fy -= 4.6 * mm
        if ln.startswith("ИТОГ") or ln.startswith("ФД"):
            c.setFont("DejaVuSansMono-Bold", 9.5)
        else:
            c.setFont("DejaVuSansMono", 9)
        c.drawString(bx0 + 3 * mm, fy, ln)
    qr = C.px_qr_image(_qr_payload(n), module_px=6, border=2)
    qbuf = io.BytesIO()
    qr.convert("RGB").save(qbuf, "PNG")
    from reportlab.lib.utils import ImageReader

    c.drawImage(ImageReader(io.BytesIO(qbuf.getvalue())), bx1 + 8 * mm, y - 50 * mm, 34 * mm, 34 * mm)
    c.setFont("DejaVuSans", 9)
    c.drawString(L, 40 * mm, "Администратор ____________________ / Тестова Е. /")
    c.setStrokeColor(Color(0.15, 0.2, 0.55))
    c.setLineWidth(1.1)
    p = c.beginPath()
    p.moveTo(L + 30 * mm, 41 * mm)
    for k in range(1, 26):
        p.lineTo(L + 30 * mm + k * 1.6 * mm, 41 * mm + 3 * mm * math.sin(k * 1.3) + (2 if k % 5 == 0 else 0))
    c.drawPath(p, stroke=1, fill=0)
    c.setFillColor(Color(0.82, 0.12, 0.12, alpha=0.16))
    C.rl_draw_text_outlines(c, "ОБРАЗЕЦ", C.ff_font_file("DejaVuSans-Bold"), 70, W / 2, 95 * mm)
    c.setFillColor(black)
    c.setFont("DejaVuSans", 8)
    c.drawCentredString(W / 2, 15 * mm, "Спасибо, что выбрали «Гостиницу Образец»! · ОБРАЗЕЦ / SPECIMEN")
    c.showPage()
    c.save()
    page = C.px_pdf_to_pil(buf.getvalue(), 150)[0]
    return page.convert("RGBA")


# ------------------------------------------------------------------ photo backgrounds

def _bg_desk(seed):
    W, H = PHOTO
    return C.ff_photo_desk(W, H, seed, base=(176, 180, 184))


def _bg_wood(seed, base=(150, 108, 74)):
    W, H = PHOTO
    return C.ff_photo_wood(W, H, seed, base=base)


def _bg_palm(seed, quad):
    """Out-of-focus floor + an open palm under the receipt; returns (bg array, thumb RGBA over layer)."""
    W, H = PHOTO
    rng = np.random.default_rng(seed)
    low = C.px_smooth_noise((H, W), 260, seed, octaves=2)
    bg = np.empty((H, W, 3), np.float32)
    bg[:] = (92, 86, 80)
    bg *= (0.85 + 0.12 * low)[..., None]
    s = 4
    (tlx, tly), (trx, try_), (brx, bry), (blx, bly) = quad
    cx = (tlx + trx + brx + blx) / 4
    shapes = [("ellipse", [cx - 900, 2500, cx + 860, 4300])]
    for dx, top in ((-760, 1350), (-300, 820), (180, 760), (620, 1060)):
        x = cx + dx
        shapes.append(("rrect", [x - 150, top, x + 150, 3000]))
    masks, rounds = [], []
    for kind, (x0, y0, x1, y1) in shapes:
        m = Image.new("L", (W // s, H // s), 0)
        md = ImageDraw.Draw(m)
        if kind == "ellipse":
            md.ellipse([x0 / s, y0 / s, x1 / s, y1 / s], fill=255)
        else:
            md.rounded_rectangle([x0 / s, y0 / s, x1 / s, y1 / s], radius=150 / s, fill=255)
        masks.append(np.asarray(m, np.float32) / 255.0)
        rounds.append(np.asarray(m.filter(ImageFilter.GaussianBlur(18)), np.float32) / 255.0)
    msmall = np.max(masks, axis=0)
    rsmall = np.max(rounds, axis=0)
    hm = np.asarray(Image.fromarray((msmall * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC)
                    .filter(ImageFilter.GaussianBlur(5)), np.float32) / 255.0
    rr = np.asarray(Image.fromarray(rsmall.astype(np.float32), "F").resize((W, H), Image.BICUBIC), np.float32)
    shade = 0.66 + 0.34 * np.clip(rr * 1.7 - 0.25, 0, 1)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    skin = np.empty((H, W, 3), np.float32)
    skin[:] = (216, 164, 134)
    skin *= (shade * (1.0 - 0.14 * (yy / H)) + 0.04 * C.px_smooth_noise((H, W), 90, seed + 1))[..., None]
    skin[..., 0] += 6 * (1 - shade)            # redder in the shaded folds
    skin += rng.normal(0, 2.0, (H, W, 1)).astype(np.float32)
    bg = bg * (1 - hm[..., None]) + skin * hm[..., None]
    # thumb over the lower-left corner of the receipt (covers only the paper margin)
    th = Image.new("L", (W // s, H // s), 0)
    td = ImageDraw.Draw(th)
    bx, by = blx, bly
    pts = [(bx - 560, by + 420), (bx - 300, by + 560), (bx + 110, by - 140), (bx + 60, by - 360), (bx - 160, by - 300)]
    td.polygon([(x / s, y / s) for x, y in pts], fill=255)
    td.ellipse([(bx - 80) / s, (by - 420) / s, (bx + 150) / s, (by - 120) / s], fill=255)
    thr = np.asarray(th.filter(ImageFilter.GaussianBlur(14)), np.float32) / 255.0
    thr = np.asarray(Image.fromarray(thr, "F").resize((W, H), Image.BICUBIC), np.float32)
    th = th.resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(4))
    tskin = np.empty((H, W, 3), np.float32)
    tskin[:] = (222, 170, 140)
    tskin *= (0.70 + 0.32 * np.clip(thr * 1.7 - 0.25, 0, 1))[..., None]
    over = np.dstack([np.clip(tskin, 0, 255), np.asarray(th, np.float32)]).astype(np.uint8)
    return bg, Image.fromarray(over, "RGBA")


# ------------------------------------------------------------------ geometry & composition

def _quad(center, size, rot_deg, *, tilt=0.0, skew=0.0):
    """TL, TR, BR, BL of a w×h document centred at center, keystone tilt (top edge shorter by
    `tilt` share), horizontal skew, then in-plane rotation by rot_deg (PIL sense: + = CCW)."""
    cx, cy = center
    w, h = size
    pts = [(-w / 2 * (1 - tilt) + skew, -h / 2), (w / 2 * (1 - tilt) + skew, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    th = math.radians(-rot_deg)  # image y is down: CCW on screen = negative math angle
    out = []
    for x, y in pts:
        out.append((cx + x * math.cos(th) - y * math.sin(th), cy + x * math.sin(th) + y * math.cos(th)))
    return out


def _compose(flat_rgba, quad, bg, seed, *, shadow=(34, 48), shadow_k=0.42, over=None, glare=None,
             tint=(1.03, 1.0, 0.94), light=0.12, vignette=0.12, cam_blur=0.9, extra_blur=0.0, noise=2.6,
             flash=False):
    W, H = PHOTO
    fw, fh = flat_rgba.size
    src = [(0, 0), (fw, 0), (fw, fh), (0, fh)]
    coeffs = C.ff_perspective_coeffs(src, quad)
    warped = flat_rgba.transform((W, H), Image.PERSPECTIVE, coeffs, resample=Image.BICUBIC, fillcolor=(0, 0, 0, 0))
    wa = np.asarray(warped, np.float32)
    m = wa[..., 3:4] / 255.0
    sh = Image.fromarray(np.asarray(warped.getchannel("A")), "L")
    sh = sh.transform((W, H), Image.AFFINE, (1, 0, -shadow[0], 0, 1, -shadow[1]), fillcolor=0)
    sh = np.asarray(sh.filter(ImageFilter.GaussianBlur(30 if not flash else 12)), np.float32) / 255.0
    a = bg * (1 - shadow_k * sh)[..., None]
    a = a * (1 - m) + wa[..., :3] * m
    if over is not None:
        oa = np.asarray(over, np.float32)
        om = oa[..., 3:4] / 255.0
        a = a * (1 - om) + oa[..., :3] * om
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    if flash:
        r2 = ((xx - W * 0.52) / (W * 0.62)) ** 2 + ((yy - H * 0.45) / (H * 0.62)) ** 2
        a *= (1.06 - 0.38 * np.clip(r2, 0, 1.6))[..., None]
    else:
        a *= (1.0 + light / 2 - light * (xx / W * 0.5 + yy / H * 0.5))[..., None]
        r2 = ((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2
        a *= (1 - vignette * r2 / 2)[..., None]
    a *= np.array(tint, np.float32)
    if glare is not None:
        gx, gy, sx_, sy_, k = glare
        g = np.exp(-(((xx - gx) / sx_) ** 2 + ((yy - gy) / sy_) ** 2))
        core = np.exp(-(((xx - gx) / (sx_ * 0.35)) ** 2 + ((yy - gy) / (sy_ * 0.35)) ** 2))
        a = a + (255.0 - a) * np.clip(k * g + 0.6 * core, 0, 1)[..., None]
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    if cam_blur:
        img = img.filter(ImageFilter.GaussianBlur(cam_blur))
    if extra_blur:
        img = img.filter(ImageFilter.GaussianBlur(extra_blur))
    rng = np.random.default_rng(seed)
    a = np.asarray(img, np.float32) + rng.normal(0, noise, (H, W, 1)).astype(np.float32) \
        + rng.normal(0, noise * 0.35, (H, W, 3)).astype(np.float32)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")


def _crumple(flat_rgba, seed, amp=7.0):
    """Crumpled paper: smooth displacement (MESH warp) + crease shading from a height field."""
    w, h = flat_rgba.size
    hgt = C.px_smooth_noise((h, w), 240, seed, octaves=3)
    gy, gx = np.gradient(hgt)
    nx = C.px_smooth_noise((h, w), 220, seed + 1, octaves=2)
    ny = C.px_smooth_noise((h, w), 220, seed + 2, octaves=2)

    def inv(xs, ys):
        xi = np.clip(xs.astype(int), 0, w - 1)
        yi = np.clip(ys.astype(int), 0, h - 1)
        return xs + amp * nx[yi, xi], ys + amp * ny[yi, xi]

    warped = C.px_mesh_warp(flat_rgba, inv, (w, h), step=24, fill=(0, 0, 0, 0))
    a = np.asarray(warped, np.float32)
    shade = 1.0 + 9.0 * (gx * 0.7 - gy * 0.7)
    creases = np.exp(-(np.abs(hgt - 0.25) / 0.03) ** 2) + np.exp(-(np.abs(hgt + 0.4) / 0.03) ** 2)
    shade = np.clip(shade - 0.10 * creases, 0.72, 1.12)
    a[..., :3] *= shade[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")


def _fade(flat_rgba, k=0.5, paper=(244, 238, 222)):
    """Thermal fade: ink lightens towards a brownish gray, paper yellows."""
    a = np.asarray(flat_rgba, np.float32)
    rgb = a[..., :3]
    lum = rgb.mean(axis=2, keepdims=True)
    inkness = np.clip((235 - lum) / 200, 0, 1)
    target = np.array(paper, np.float32)
    faded = rgb + (target - rgb) * (k * inkness + 0.35 * (1 - inkness))
    faded[..., 0] += 6 * inkness[..., 0]          # brownish residue of faded thermal ink
    a[..., :3] = faded
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")


def _exif(n):
    r = RECEIPTS[RECEIPTS[n].get("dup", n)]
    d, t = r["date"].split()
    dd, mm, yy = d.split(".")
    hh, mi = t.split(":")
    mi2 = (int(mi) + (3 if n != 5 else 9)) % 60
    hh2 = int(hh) + (1 if int(mi) + (3 if n != 5 else 9) >= 60 else 0)
    return C.ff_exif_bytes(1, when=f"{yy}:{mm}:{dd} {hh2:02d}:{mi2:02d}:17")


# ------------------------------------------------------------------ build

def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir, truth_dir = pathlib.Path(out_dir), pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    written, truth_files = [], {}

    flats, boxes = {}, {}
    for n in (3, 4, 6, 7, 8):
        flats[n], boxes[n] = _thermal_flat(n, seed=500 + n)
    flats[1] = _ereceipt_screenshot().convert("RGBA")
    flats[2] = _hotel_a4()

    # chek_6 is photographed crumpled and faded: its template is that sheet, flattened only by perspective
    f6 = _fade(_crumple(flats[6], 61), k=0.42)
    tpl_src = dict(flats)
    tpl_src[6] = f6

    # templates (upright flat renders, as they lie in the photo before the perspective warp)
    for n in (1, 2, 3, 4, 6, 7, 8):
        bg = Image.new("RGB", tpl_src[n].size, (255, 255, 255))
        bg.paste(tpl_src[n], (0, 0), tpl_src[n])
        p = truth_dir / f"chek_{n}_template.png"
        C.px_save_png_deterministic(C.ff_gray_template(bg, long_side=1024), p)
        truth_files[n] = p.name
        written.append(str(p))

    photos = {}
    scale = 1.16
    rh = {n: flats[n].height * scale for n in (3, 4, 6, 7, 8)}
    rw = RW * scale

    # 1: screenshot, no photo
    photos[1] = dict(img=flats[1].convert("RGB"), quad=None, note="screenshot, upright, no photo")
    # 2: hotel A4 on a wooden table
    q2 = _quad((1500, 2010), (2560, 2560 * 1.4142), 1.5, tilt=0.07, skew=20)
    photos[2] = dict(img=_compose(flats[2], q2, _bg_wood(21), 21, tint=(1.04, 1.0, 0.92)), quad=q2,
                     note="A4 on a wooden table, keystone 7 %, rotation +1.5°")
    # 3: cafe receipt on a palm, rotated −8° (clockwise 8°)
    q3 = _quad((1530, 1990), (rw, rh[3]), -8.0, tilt=0.04)
    bg3, over3 = _bg_palm(31, q3)
    photos[3] = dict(img=_compose(flats[3], q3, bg3, 31, over=over3, shadow=(26, 34), shadow_k=0.35,
                                  tint=(1.05, 1.0, 0.93)), quad=q3, note="on an open palm, rotated 8° clockwise")
    # 4: airport-express receipt upside down on a desk
    q4 = _quad((1480, 2000), (rw * 1.15, rh[4] * 1.15), 180 + 2.0, tilt=0.05)
    photos[4] = dict(img=_compose(flats[4], q4, _bg_desk(41), 41, tint=(0.99, 1.0, 1.03)), quad=q4,
                     note="upside down (rotated 180° + 2°) on a gray desk")
    # 5: same receipt as 3, other angle, flash glare, wooden table
    q5 = _quad((1560, 2060), (rw * 0.98, rh[3] * 0.98), 11.0, tilt=0.16, skew=-60)
    fx = (q5[0][0] + q5[1][0] + q5[2][0] + q5[3][0]) / 4 + 120
    fy = q5[0][1] + (q5[3][1] - q5[0][1]) * 0.36
    photos[5] = dict(img=_compose(flats[3], q5, _bg_wood(51, base=(122, 84, 56)), 51, flash=True,
                                  glare=(fx, fy, 330, 260, 0.85), shadow=(10, 14), shadow_k=0.55,
                                  tint=(0.98, 1.0, 1.04)),
                     quad=q5, note="same print as chek_3: rotated +11°, strong keystone, camera flash glare over the items",
                     glare_center=[round(fx), round(fy)])
    # 6: stationery receipt crumpled and faded on wood
    q6 = _quad((1500, 2000), (rw * 1.25, rh[6] * 1.25), 3.0, tilt=0.03)
    photos[6] = dict(img=_compose(f6, q6, _bg_wood(61, base=(170, 128, 90)), 61, tint=(1.05, 1.0, 0.92)), quad=q6,
                     note="crumpled (displacement ±7 px at 20 px/mm) and faded thermal print")
    # 7: second cafe receipt, blurred
    q7 = _quad((1500, 2000), (rw * 0.97, rh[7] * 0.97), -2.5, tilt=0.03)
    photos[7] = dict(img=_compose(flats[7], q7, _bg_desk(71), 71, extra_blur=1.6, tint=(1.02, 1.0, 0.97)), quad=q7,
                     note="Gaussian blur σ=1.6 px over the whole photo (on top of the camera softness)")
    # 8: clothes receipt (outside trip dates)
    q8 = _quad((1490, 1990), (rw * 1.02, rh[8] * 1.02), 4.0, tilt=0.05)
    photos[8] = dict(img=_compose(flats[8], q8, _bg_desk(81), 81, tint=(1.0, 1.0, 1.0)), quad=q8,
                     note="clean photo; date 20.10.2026 is outside the trip 12–14.10.2026")

    files = {}
    for n in range(1, 9):
        p = out_dir / f"chek_{n}.jpg"
        ph = photos[n]
        exif = None if n == 1 else _exif(n)
        p.write_bytes(C.ff_jpeg_bytes(ph["img"], JPEG_Q[n], exif=exif))
        files[n] = p
        written.append(str(p))

    expected = DG.all_expected()["receipts_total"]
    included = [1, 2, 3, 4, 6, 7]
    recs = []
    for n in range(1, 9):
        base_n = RECEIPTS[n].get("dup", n)
        r = RECEIPTS[base_n]
        f = FISCAL[base_n]
        ph = photos[n]
        recs.append({
            "file": files[n].name,
            "n": n,
            "duplicate_of": RECEIPTS[n].get("dup"),
            "kind": RECEIPTS[n]["kind"],
            "in_report": n in included,
            "date": r["date"], "seller": r["seller"], "inn": r["inn"], "address": ADDRESS[base_n],
            "total": r["total"], "vat": r["vat"], "vat_amount": _vat_amount(base_n),
            "fd": r["fd"], "fn": f["fn"], "fp": f["fp"], "rn_kkt": f["rn"], "sno": f["sno"], "payment": f["pay"],
            "items": [{"name": nm, "qty": q, "price": p, "sum": round(q * p, 2)} for nm, q, p in ITEMS[base_n]],
            "category": CATEGORY[base_n],
            "qr_payload": _qr_payload(base_n),
            "template": truth_files[base_n],
            "flat_size_px": list(flats[base_n].size),
            "photo_size_px": list(ph["img"].size),
            "photo_quad_TL_TR_BR_BL": None if ph["quad"] is None else [[round(x, 1), round(y, 1)] for x, y in ph["quad"]],
            "photo_note": ph["note"],
            "jpeg_quality": JPEG_Q[n],
            **({"glare_center_px": ph["glare_center"]} if "glare_center" in ph else {}),
        })
    truth = {
        "case": "f-receipts-expense-report",
        "trip": {"city": "Казань", "from": "12.10.2026", "to": "14.10.2026"},
        "receipts": recs,
        "report_rows_by_datetime": included,
        "pdf_page_order_receipts": included,
        "excluded": {"5": "duplicate of chek_3 (same ФН/ФД/ФП)", "8": "20.10.2026 — outside the trip dates"},
        "expected_total": expected,
        "expected_total_check": round(sum(RECEIPTS[n]["total"] for n in included), 2),
        "vat_total_20pct": round(sum(_vat_amount(n) or 0 for n in included), 2),
        "notes": "Quads are in display px of the 3000×4000 photo; the flat render's TL corner maps to quad[0]. "
                 "Templates are upright flat renders (gray, long side 1024) of the sheet as it lies in the photo "
                 "(chek_6: the crumpled, faded sheet); chek_5 shares chek_3's template. A perfect perspective "
                 "unwarp of each photo correlates 0.86–0.997 with its template at long side 1024.",
    }
    assert abs(truth["expected_total"] - truth["expected_total_check"]) < 0.005, truth
    for n in ITEMS:
        assert abs(sum(q * p for _, q, p in ITEMS[n]) - RECEIPTS[n]["total"]) < 0.005, n
    tp = truth_dir / "chek_receipts.json"
    C.ff_write_json(tp, truth)
    written.append(str(tp))
    return written


if __name__ == "__main__":
    root = HERE.parent
    for p in build(root / "out" / "f-receipts-expense-report", root / "truth"):
        print(p)
