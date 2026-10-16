"""Fixtures for f-3ndfl-vychet-form (social deductions for 2025: treatment + son's education).

spravka_med_2025.pdf        — «Справка об оплате медицинских услуг для представления в налоговый орган»
                              (own simplified layout, not the official blank): fictional clinic
                              ООО «Клиника Образец» ИНН 7700000118 with a licence number, patient =
                              taxpayer Морозова Ирина Олеговна ИНН 770000000136, 2025, service code 01,
                              180 000,00.
spravka_obuchenie_2025.pdf  — «Справка об оплате образовательных услуг…»: «Школа программирования
                              Образец» (licence), student = son Морозов Глеб Андреевич (12 years, born
                              14.03.2013), full-time (очная), payer Морозова И. О., 2025, 60 000,00.
spravka_o_dohodah_2025.pdf  — «Справка о доходах и суммах налога физического лица за 2025 год»:
                              agent ООО «Образец Технологии», rate 13 %, 12 × 120 000,00 (code 2000),
                              income = base = 1 440 000,00, tax computed = withheld = 187 200,00.
list_vychety_blank.pdf      — training blank «Расчёт социальных налоговых вычетов» (NOT an official KND
                              form) with character cells: INN 12 cells at x=300, y=700; rows 010/020/030/040
                              at y=640/600/560/520, each 13 integer cells from x=300 + a pre-printed «.» +
                              2 kopeck cells; every cell 14×18 pt.

truth/list_vychety_cells.json — rect of every cell (pt, origin bottom-left of the A4 page), the expected
values of the cell_form check and the deduction arithmetic.

Every page carries a red «ОБРАЗЕЦ / SPECIMEN» line (text layer) and a pale diagonal watermark drawn as
glyph outlines (no text layer). On the blank the watermark stays below the cell area (y < 470) so it never
lands inside a cell rect.
"""

from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402
import datagen as G  # noqa: E402

CASE = "f-3ndfl-vychet-form"
W, H = C.FF_A4

TAXPAYER = dict(name="Морозова Ирина Олеговна", short="Морозова И. О.", inn="770000000136", born="05.05.1988")
SON = dict(name="Морозов Глеб Андреевич", born="14.03.2013", age=12)
CLINIC = dict(name="ООО «Клиника Образец»", inn="7700000118", kpp="770001001",
              licence="№ Л041-00000-77/00000118 от 01.02.2021", address="г. Москва, ул. Примерная, д. 5, стр. 1")
SCHOOL = dict(name="АНО ДО «Школа программирования Образец»", inn="7700000150", kpp="770001001",
              licence="№ Л035-00000-77/00000150 от 10.09.2020", address="г. Москва, Учебный пер., д. 3")
AGENT = dict(name="ООО «Образец Технологии»", inn="7700000167", kpp="770001001", oktmo="45000000")
MONTHLY = 120_000.00

# blank geometry (recipe): cell 14×18 pt, first cell x=300, rows y=640/600/560/520, INN at y=700
CELL_W, CELL_H = 14.0, 18.0
X0 = 300.0
INT_CELLS, FRAC_CELLS = 13, 2
DOT_GAP = 8.0
ROWS = [
    ("010", 640.0, ["Расходы на лечение (код 01)"]),
    ("020", 600.0, ["Расходы на обучение детей"]),
    ("030", 560.0, ["Сумма социальных вычетов", "с учётом ограничений"]),
    ("040", 520.0, ["Сумма налога к возврату"]),
]
INN_Y = 700.0
EXPECTED = {"010": "180000.00", "020": "60000.00", "030": "210000.00", "040": "27300.00", "inn": TAXPAYER["inn"]}


def _rect(x, y):
    return [round(x, 2), round(y, 2), round(x + CELL_W, 2), round(y + CELL_H, 2)]


def cell_layout() -> dict:
    rows = {"inn": dict(label="ИНН", y=INN_Y, cells=[_rect(X0 + i * CELL_W, INN_Y) for i in range(12)])}
    for code, y, label in ROWS:
        ints = [_rect(X0 + i * CELL_W, y) for i in range(INT_CELLS)]
        dot_x0 = X0 + INT_CELLS * CELL_W
        fx = dot_x0 + DOT_GAP
        fracs = [_rect(fx + i * CELL_W, y) for i in range(FRAC_CELLS)]
        rows[code] = dict(label=" ".join(label), y=y, int_cells=ints, frac_cells=fracs,
                          dot_rect=[round(dot_x0, 2), y, round(fx, 2), y + CELL_H], cells=ints + fracs)
    return rows


# ---------------------------------------------------------------- drawing helpers

def _marks(c, *, wm_cy=430.0, wm_angle=33):
    c.setFillColorRGB(0.78, 0.1, 0.1)
    c.setFont("LiberationSans-Bold", 9)
    c.drawRightString(W - 28, H - 22, "ОБРАЗЕЦ / SPECIMEN — вымышленные данные")
    C.bk_rl_watermark(c, cx=W / 2, cy=wm_cy, size=56, angle=wm_angle, alpha=0.10)
    c.setFillColorRGB(0, 0, 0)


def _wrap(c, text, font, size, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if c.stringWidth(t, font, size) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _kv_table(c, y, rows, *, x0=40, x1=W - 40, split=250, size=9.5):
    """Bordered two-column table «field | value», value wraps; returns the y below it."""
    c.setLineWidth(0.6)
    c.line(x0, y, x1, y)
    for label, value in rows:
        llines = _wrap(c, label, "LiberationSerif", size, split - x0 - 8)
        vlines = _wrap(c, value, "LiberationSerif-Bold", size, x1 - split - 8)
        n = max(len(llines), len(vlines))
        h = 6 + n * (size + 2.5)
        c.setFont("LiberationSerif", size)
        for i, s in enumerate(llines):
            c.drawString(x0 + 4, y - 4 - (i + 1) * (size + 1.5), s)
        c.setFont("LiberationSerif-Bold", size)
        for i, s in enumerate(vlines):
            c.drawString(split + 4, y - 4 - (i + 1) * (size + 1.5), s)
        c.line(x0, y - h, x1, y - h)
        c.line(x0, y, x0, y - h)
        c.line(split, y, split, y - h)
        c.line(x1, y, x1, y - h)
        y -= h
    return y


def _org_header(c, org, extra_line):
    c.setFont("LiberationSerif-Bold", 10)
    c.drawString(40, H - 50, org["name"] + " (вымышленная организация)")
    c.setFont("LiberationSerif", 9)
    c.drawString(40, H - 63, f"ИНН {org['inn']} / КПП {org['kpp']}    {org['address']}")
    c.drawString(40, H - 76, extra_line)
    c.setLineWidth(0.8)
    c.line(40, H - 84, W - 40, H - 84)


def _sign_block(c, y, role, name, seed, ring):
    c.setFont("LiberationSerif", 10)
    c.drawString(40, y, role)
    c.line(220, y - 2, 340, y - 2)
    c.drawString(350, y, name)
    C.bk_rl_signature(c, 228, y - 6, 100, 24, seed=seed)
    c.setFont("LiberationSerif", 8)
    c.drawString(240, y - 12, "(подпись)")
    c.drawString(60, y - 30, "М.П.")
    C.bk_rl_round_stamp(c, 140, y - 26, 34, ring, ["ОБРАЗЕЦ", "SPECIMEN"])


def _footer(c):
    c.setFont("LiberationSans", 7)
    c.setFillColorRGB(0.35, 0.35, 0.35)
    c.drawString(40, 30, "Учебный документ для тестов. Организации, лица, номера и лицензии вымышлены. "
                         "Не является официальной формой. ОБРАЗЕЦ / SPECIMEN.")
    c.setFillColorRGB(0, 0, 0)


def build_med(path):
    c = C.ff_rl_canvas(str(path), title="Справка об оплате медицинских услуг (ОБРАЗЕЦ)",
                       subject="Справка об оплате медицинских услуг за 2025 год — ОБРАЗЕЦ")
    _marks(c, wm_cy=360)
    _org_header(c, CLINIC, f"Лицензия на осуществление медицинской деятельности {CLINIC['licence']}")
    c.setFont("LiberationSerif-Bold", 13)
    c.drawCentredString(W / 2, H - 120, "СПРАВКА")
    c.setFont("LiberationSerif-Bold", 11)
    c.drawCentredString(W / 2, H - 136, "об оплате медицинских услуг для представления в налоговый орган")
    c.setFont("LiberationSerif", 10)
    c.drawCentredString(W / 2, H - 152, "№ 2026-00417 от 20.01.2026")
    rows = [
        ("Налоговый период (год)", "2025"),
        ("Налогоплательщик (Ф. И. О.)", TAXPAYER["name"]),
        ("ИНН налогоплательщика", TAXPAYER["inn"]),
        ("Пациент является налогоплательщиком", "1 — да"),
        ("Пациент (Ф. И. О.)", TAXPAYER["name"]),
        ("Дата рождения пациента", TAXPAYER["born"]),
        ("Код услуги", "01"),
        ("Сумма оплаты медицинских услуг, руб.",
         f"{C.bk_fmt_money(180_000)} ({C.bk_rub_words(180_000, capitalize=True)})"),
    ]
    y = _kv_table(c, H - 175, rows)
    c.setFont("LiberationSerif", 8.5)
    c.drawString(40, y - 14, "Код услуги: 01 — медицинские услуги (кроме дорогостоящих видов лечения); "
                             "02 — дорогостоящие виды лечения.")
    c.drawString(40, y - 26, "Оплата произведена налогоплательщиком в 2025 году из собственных средств.")
    _sign_block(c, y - 70, "Главный врач", "А. А. Клинова", 118, "ООО КЛИНИКА ОБРАЗЕЦ • ИНН 7700000118")
    _footer(c)
    c.showPage()
    c.save()


def build_edu(path):
    c = C.ff_rl_canvas(str(path), title="Справка об оплате образовательных услуг (ОБРАЗЕЦ)",
                       subject="Справка об оплате образовательных услуг за 2025 год — ОБРАЗЕЦ")
    _marks(c, wm_cy=330)
    _org_header(c, SCHOOL, f"Лицензия на осуществление образовательной деятельности {SCHOOL['licence']}")
    c.setFont("LiberationSerif-Bold", 13)
    c.drawCentredString(W / 2, H - 120, "СПРАВКА")
    c.setFont("LiberationSerif-Bold", 11)
    c.drawCentredString(W / 2, H - 136, "об оплате образовательных услуг для представления в налоговый орган")
    c.setFont("LiberationSerif", 10)
    c.drawCentredString(W / 2, H - 152, "№ 25/112 от 22.01.2026")
    rows = [
        ("Налоговый период (год)", "2025"),
        ("Налогоплательщик (Ф. И. О.)", TAXPAYER["name"]),
        ("ИНН налогоплательщика", TAXPAYER["inn"]),
        ("Обучающийся является налогоплательщиком", "0 — нет (обучающийся — сын налогоплательщика)"),
        ("Обучающийся (Ф. И. О.)", SON["name"]),
        ("Дата рождения обучающегося", f"{SON['born']} ({SON['age']} лет)"),
        ("Форма обучения", "очная"),
        ("Образовательная программа",
         "дополнительная общеразвивающая программа «Основы программирования на Python», "
         "обучение с 01.02.2025 по 31.12.2025"),
        ("Сумма оплаты образовательных услуг, руб.",
         f"{C.bk_fmt_money(60_000)} ({C.bk_rub_words(60_000, capitalize=True)})"),
    ]
    y = _kv_table(c, H - 175, rows)
    c.setFont("LiberationSerif", 8.5)
    c.drawString(40, y - 14, f"Плательщик по договору № 0112/25 от 01.02.2025 — {TAXPAYER['short']} (мать обучающегося).")
    _sign_block(c, y - 60, "Директор", "В. В. Учебнова", 150, "ШКОЛА ПРОГРАММИРОВАНИЯ ОБРАЗЕЦ • ИНН 7700000150")
    _footer(c)
    c.showPage()
    c.save()


def build_income(path):
    c = C.ff_rl_canvas(str(path), title="Справка о доходах и суммах налога физического лица за 2025 год (ОБРАЗЕЦ)",
                       subject="Справка о доходах за 2025 год — ОБРАЗЕЦ")
    _marks(c, wm_cy=430)
    c.setFont("LiberationSerif-Bold", 12)
    c.drawCentredString(W / 2, H - 52, "СПРАВКА О ДОХОДАХ И СУММАХ НАЛОГА ФИЗИЧЕСКОГО ЛИЦА")
    c.setFont("LiberationSerif", 10)
    c.drawCentredString(W / 2, H - 67, "за 2025 год  от 15.01.2026")
    c.setFont("LiberationSerif-Bold", 9.5)
    c.drawString(40, H - 92, "Данные о налоговом агенте")
    y = _kv_table(c, H - 97, [
        ("Наименование", AGENT["name"] + " (вымышленная организация)"),
        ("ИНН / КПП", f"{AGENT['inn']} / {AGENT['kpp']}"),
        ("Код по ОКТМО", AGENT["oktmo"]),
    ], size=9)
    c.setFont("LiberationSerif-Bold", 9.5)
    c.drawString(40, y - 16, "Данные о физическом лице — получателе дохода")
    y = _kv_table(c, y - 21, [
        ("ИНН в Российской Федерации", TAXPAYER["inn"]),
        ("Фамилия, имя, отчество", TAXPAYER["name"]),
        ("Статус налогоплательщика", "1 — налоговый резидент РФ"),
        ("Дата рождения", TAXPAYER["born"]),
        ("Гражданство (код страны)", "643"),
    ], size=9)
    c.setFont("LiberationSerif-Bold", 9.5)
    c.drawString(40, y - 16, "Доходы, облагаемые по ставке 13 %")
    # monthly table
    y -= 21
    cols = [40, 110, 200, 320, 410, W - 40]
    heads = ["Месяц", "Код дохода", "Сумма дохода", "Код вычета", "Сумма вычета"]
    c.setLineWidth(0.6)
    c.line(cols[0], y, cols[-1], y)
    c.setFont("LiberationSerif-Bold", 8.5)
    for i, h in enumerate(heads):
        c.drawCentredString((cols[i] + cols[i + 1]) / 2, y - 11, h)
    y_top = y
    y -= 15
    c.line(cols[0], y, cols[-1], y)
    c.setFont("LiberationSerif", 8.5)
    for m in range(1, 13):
        vals = [f"{m:02d}", "2000", C.bk_fmt_money(MONTHLY), "", ""]
        for i, v in enumerate(vals):
            if i == 2:
                c.drawRightString(cols[i + 1] - 6, y - 10, v)
            else:
                c.drawCentredString((cols[i] + cols[i + 1]) / 2, y - 10, v)
        y -= 13.5
        c.line(cols[0], y, cols[-1], y)
    for x in cols:
        c.line(x, y_top, x, y)
    total = MONTHLY * 12
    tax = round(total * 0.13, 2)
    c.setFont("LiberationSerif-Bold", 9.5)
    c.drawString(40, y - 16, "Общие суммы дохода и налога (ставка налога 13 %)")
    y = _kv_table(c, y - 21, [
        ("Общая сумма дохода", C.bk_fmt_money(total)),
        ("Налоговая база", C.bk_fmt_money(total)),
        ("Сумма налога исчисленная", C.bk_fmt_money(tax)),
        ("Сумма налога удержанная", C.bk_fmt_money(tax)),
        ("Сумма налога перечисленная", C.bk_fmt_money(tax)),
        ("Сумма налога, излишне удержанная налоговым агентом", "0,00"),
        ("Сумма налога, не удержанная налоговым агентом", "0,00"),
    ], size=9, split=330)
    c.setFont("LiberationSerif", 9.5)
    c.drawString(40, y - 26, "Налоговый агент: Генеральный директор")
    c.line(240, y - 28, 340, y - 28)
    c.drawString(350, y - 26, "А. А. Цифров")
    C.bk_rl_signature(c, 248, y - 32, 86, 20, seed=167)
    C.bk_rl_round_stamp(c, 470, y - 22, 30, "ООО ОБРАЗЕЦ ТЕХНОЛОГИИ • ИНН 7700000167", ["ОБРАЗЕЦ", "SPECIMEN"])
    _footer(c)
    c.showPage()
    c.save()
    return dict(total_income=total, base=total, tax_computed=tax, tax_withheld=tax)


def _fake_barcode(c, x, y, seed=136):
    import random

    rnd = random.Random(seed)
    cx = x
    for _ in range(46):
        w = rnd.choice((0.8, 0.8, 1.6, 2.4))
        if rnd.random() < 0.6:
            c.rect(cx, y, w, 26, stroke=0, fill=1)
        cx += w + 0.8
    return cx


def build_blank(path, layout):
    c = C.ff_rl_canvas(str(path), title="Расчёт социальных налоговых вычетов — учебный бланк (ОБРАЗЕЦ)",
                       subject="Учебный бланк со знакоместами, не является официальной формой КНД — ОБРАЗЕЦ")
    c.setFillColorRGB(0.78, 0.1, 0.1)
    c.setFont("LiberationSans-Bold", 9)
    c.drawRightString(W - 28, H - 22, "ОБРАЗЕЦ / SPECIMEN — учебный бланк")
    # watermark well below the cell area (cells occupy y 520..718)
    C.bk_rl_watermark(c, cx=W / 2, cy=300, size=58, angle=24, alpha=0.10)
    c.setFillColorRGB(0, 0, 0)

    # FNS-like corner markers and a fake barcode (not a real KND code)
    for (mx, my) in ((28, H - 46), (W - 46, H - 46), (28, 40), (W - 46, 40)):
        c.rect(mx, my, 18, 18, stroke=0, fill=1)
    end = _fake_barcode(c, 58, H - 72)
    c.setFont("LiberationSans", 7)
    c.drawString(58, H - 82, "0000 1234  (учебный штрихкод)")
    c.setFont("LiberationSans", 8)
    c.drawString(end + 16, H - 52, "Учебный бланк — не является официальной формой КНД.")
    c.drawString(end + 16, H - 63, "Все данные вымышленные. ОБРАЗЕЦ / SPECIMEN.")

    c.setFont("LiberationSans", 9)
    c.drawString(40, 745, "Фамилия, имя, отчество")
    c.setLineWidth(0.5)
    c.line(160, 743, W - 40, 743)

    c.setStrokeColorRGB(0.45, 0.45, 0.45)
    c.setLineWidth(0.6)

    def cells(rects):
        for x0, y0, x1, y1 in rects:
            c.rect(x0, y0, x1 - x0, y1 - y0, stroke=1, fill=0)

    # INN
    c.setFillColorRGB(0, 0, 0)
    c.setFont("LiberationSans-Bold", 10)
    c.drawRightString(X0 - 8, INN_Y + 5, "ИНН")
    cells(layout["inn"]["cells"])

    c.setFont("LiberationSans-Bold", 12.5)
    c.drawCentredString(W / 2, 674, "Расчёт социальных налоговых вычетов")
    c.setFont("LiberationSans", 8)
    c.drawString(40, 662, "Показатели")
    c.drawString(255, 662, "Код строки")
    c.drawString(X0, 662, "Значение показателя (руб. коп.)")

    for code, y, label in ROWS:
        c.setFont("LiberationSans", 9)
        for i, s in enumerate(label):
            c.drawString(40, y + 10 - i * 11 + (5 if len(label) > 1 else 0) - 5, s)
        c.setFont("LiberationSans-Bold", 10)
        c.drawString(258, y + 5, code)
        r = layout[code]
        cells(r["int_cells"])
        cells(r["frac_cells"])
        dx = (r["dot_rect"][0] + r["dot_rect"][2]) / 2
        c.setFont("LiberationSans-Bold", 12)
        c.drawCentredString(dx, y + 1.5, ".")
        c.setDash(1, 2)
        c.line(40, y - 8, W - 40, y - 8)
        c.setDash()

    c.setFont("LiberationSans", 8)
    notes = [
        "Строка 010 — фактические расходы на лечение (код 01) по справке медицинской организации.",
        "Строка 020 — расходы на очное обучение детей до 24 лет по справке образовательной организации.",
        "Строки 030 и 040 заполняются с учётом ограничений, установленных статьёй 219 НК РФ.",
        "Заполняется слева направо, по одному символу в знакоместе; в незаполненных знакоместах ставится прочерк.",
    ]
    for i, s in enumerate(notes):
        c.drawString(40, 488 - i * 11, s)

    c.setFont("LiberationSans", 9)
    c.drawString(40, 120, "Достоверность и полноту сведений подтверждаю:")
    c.drawString(40, 98, "Подпись")
    c.line(85, 96, 220, 96)
    c.drawString(250, 98, "Дата")
    c.line(278, 96, 380, 96)
    c.setFont("LiberationSans", 7)
    c.setFillColorRGB(0.35, 0.35, 0.35)
    c.drawString(40, 30, "Учебный бланк для тестов, в стиле форм ФНС, но не копия официальной формы. ОБРАЗЕЦ / SPECIMEN.")
    c.showPage()
    c.save()


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    C.ff_register_rl_fonts("LiberationSans", "LiberationSans-Bold", "LiberationSerif", "LiberationSerif-Bold")
    paths = {n: out_dir / n for n in ("spravka_med_2025.pdf", "spravka_obuchenie_2025.pdf",
                                      "spravka_o_dohodah_2025.pdf", "list_vychety_blank.pdf")}
    build_med(paths["spravka_med_2025.pdf"])
    build_edu(paths["spravka_obuchenie_2025.pdf"])
    income = build_income(paths["spravka_o_dohodah_2025.pdf"])
    layout = cell_layout()
    build_blank(paths["list_vychety_blank.pdf"], layout)

    nd = G.all_expected()["ndfl"]
    truth = dict(
        case=CASE,
        file="list_vychety_blank.pdf",
        page=1,
        page_size=[W, H],
        units="pt, origin bottom-left of the page",
        cell_size=[CELL_W, CELL_H],
        format=("each money row = 13 integer cells (left-aligned digits), a pre-printed '.' in dot_rect, "
                "2 kopeck cells; INN = 12 cells; unused cells may hold dashes"),
        rows=layout,
        expected=EXPECTED,
        arithmetic=dict(treatment=nd["treatment"], child_edu=nd["child_edu"], social_limit=nd["social_limit"],
                        child_limit=nd["child_limit"], deduction=nd["deduction"], refund=nd["refund"],
                        tax_withheld=income["tax_withheld"],
                        rule="min(лечение, 150 000) + min(обучение ребёнка, 110 000) = 150 000 + 60 000 = 210 000; "
                             "210 000 × 13 % = 27 300 ≤ удержанного 187 200"),
        forbidden_values=["240000", "31200"],
        taxpayer=TAXPAYER, son=SON, income=income,
    )
    tpath = C.ff_write_json(truth_dir / "list_vychety_cells.json", truth)
    return [str(p) for p in paths.values()] + [tpath]


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / CASE, base / "truth"):
        print(p)
