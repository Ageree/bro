"""Fixture for f-bank-statement-pdf-categories: vypiska_sentyabr_2026.pdf.

A September 2026 card-account statement of the fictional «АО «Банк Образец»» (own square logo,
ОБРАЗЕЦ / SPECIMEN marks), 142 operations from datagen.bank_ops(seed=5), A4, DejaVuSans 8, 4 pages.

Page 1 header: holder «Тестова Анна Петровна (ОБРАЗЕЦ)», account 40817810000000000000, period
01.09.2026–30.09.2026, «Остаток на 01.09.2026», «Всего пополнений», «Всего списаний»,
«Остаток на 30.09.2026» (all amounts as «154 215,37»).
Table: Дата операции (МСК) | Дата обработки и код авторизации | Категория (банковская) |
Сумма в валюте счёта | Остаток. Every operation takes two lines: line 1 «03.09.2026 14:22 |
03.09.2026 <код> | Супермаркеты | -1 234,56 | 12 345,67», line 2 the description. Credits carry «+».
The table header repeats on every page, operations are kept whole across page breaks except one:
its line 1 is the last line of page 2 and its description (with the marker «ОБРАЗЕЦ-СТЫК»
appended) is the first table line of page 3. Footer «Продолжение на следующей странице».
The diagonal ОБРАЗЕЦ / SPECIMEN watermark is drawn as glyph outlines (no text layer), so it does
not pollute pdftotext / pypdf extraction of the table.

truth/vypiska_sentyabr_2026.json: expected numbers (datagen.bank_expected), every operation with
its page and line positions and own category, the split operation, the header values.
"""

from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402
import datagen as G  # noqa: E402

FIXTURE = "vypiska_sentyabr_2026.pdf"
PAGE_W, PAGE_H = C.FF_A4
ML, MR = 36.0, PAGE_W - 36.0
FONT, BOLD = "DejaVuSans", "DejaVuSans-Bold"
FS = 8.0
LH = 9.0          # line 1 -> line 2 baseline distance
PITCH = 18.0      # operation to operation (baseline of line 1)
SEP_DY = 4.3      # separator below line 2 baseline
Y_MIN = 58.0      # lowest allowed baseline (footer lives below)
X_C1, X_C2, X_C3 = ML, 118.0, 208.0
X_C4R, X_C5R = 478.0, MR
HOLDER = "Тестова Анна Петровна (ОБРАЗЕЦ)"
ACCOUNT = "40817810000000000000"
SPLIT_MARKER = "ОБРАЗЕЦ-СТЫК"
TEAL = (0.04, 0.43, 0.31)


def money(x: float, sign: bool = False) -> str:
    s = f"{abs(x):,.2f}".replace(",", " ").replace(".", ",")
    if sign:
        return ("+" if x > 0 else "-") + s
    return ("-" if x < 0 else "") + s


def _logo(c, x, y, size):
    c.saveState()
    c.setFillColorRGB(*TEAL)
    c.roundRect(x, y, size, size, size * 0.12, stroke=0, fill=1)
    c.setFillColorRGB(1, 1, 1)
    c.setFont(BOLD, size * 0.42)
    c.drawCentredString(x + size / 2, y + size * 0.32, "БО")
    c.restoreState()


def _watermark(c):
    c.saveState()
    c.setFillColorRGB(0.90, 0.90, 0.90)
    c.translate(PAGE_W / 2, PAGE_H / 2 - 20)
    c.rotate(38)
    C.rl_draw_text_outlines(c, "ОБРАЗЕЦ / SPECIMEN", C.ff_font_file(BOLD), 54, 0, -18)
    c.restoreState()


def _page_header(c, page_no):
    """Draw the page header; return the y of the table header's top edge."""
    if page_no == 1:
        top = PAGE_H - 40
        _logo(c, ML, top - 34, 34)
        c.setFillColorRGB(0, 0, 0)
        c.setFont(BOLD, 13)
        c.drawString(ML + 44, top - 15, "АО «Банк Образец»")
        c.setFont(FONT, 7)
        c.setFillColorRGB(0.35, 0.35, 0.35)
        c.drawString(ML + 44, top - 26, "Вымышленный банк · лицензия № 0000 (ОБРАЗЕЦ) · 000000, г. Москва, ул. Примерная, д. 0")
        # specimen stamp, top right
        c.saveState()
        c.setStrokeColorRGB(0.78, 0.12, 0.12)
        c.setFillColorRGB(0.78, 0.12, 0.12)
        c.setLineWidth(1.2)
        c.rect(MR - 128, top - 30, 128, 24, stroke=1, fill=0)
        c.setFont(BOLD, 9.5)
        c.drawCentredString(MR - 64, top - 21.5, "ОБРАЗЕЦ / SPECIMEN")
        c.restoreState()

        c.setFillColorRGB(0, 0, 0)
        c.setFont(BOLD, 12)
        c.drawString(ML, top - 62, "Выписка по счёту дебетовой карты")
        info = [
            ("Владелец счёта", HOLDER),
            ("Номер счёта", ACCOUNT),
            ("Карта", "МИР •• 0000 (ОБРАЗЕЦ)"),
            ("Валюта счёта", "российский рубль (RUB)"),
            ("Период выписки", "01.09.2026 – 30.09.2026"),
            ("Дата формирования", "01.10.2026"),
        ]
        y = top - 80
        for k, v in info:
            c.setFont(FONT, 8)
            c.setFillColorRGB(0.35, 0.35, 0.35)
            c.drawString(ML, y, k)
            c.setFillColorRGB(0, 0, 0)
            c.drawString(ML + 92, y, v)
            y -= 11.5
        return y  # caller draws the summary box to the right and the table below

    top = PAGE_H - 36
    _logo(c, ML, top - 14, 14)
    c.setFont(FONT, 7)
    c.setFillColorRGB(0.35, 0.35, 0.35)
    c.drawString(ML + 20, top - 9.5, f"АО «Банк Образец» · Выписка по счёту {ACCOUNT} за 01.09.2026 – 30.09.2026 · "
                                     f"{HOLDER}")
    c.setFillColorRGB(0, 0, 0)
    return top - 26


def _summary_box(c, ops, y_top):
    opening = G.BANK_OPENING
    closing = ops[-1]["balance"]
    tin = sum(o["amount"] for o in ops if o["amount"] > 0)
    tout = -sum(o["amount"] for o in ops if o["amount"] < 0)
    x0, w = 330.0, MR - 330.0
    rows = [("Остаток на 01.09.2026", money(opening)), ("Всего пополнений", money(tin)),
            ("Всего списаний", money(tout)), ("Остаток на 30.09.2026", money(closing))]
    h = 14 + 13 * len(rows)
    c.saveState()
    c.setFillColorRGB(0.95, 0.97, 0.96)
    c.setStrokeColorRGB(0.75, 0.82, 0.79)
    c.rect(x0, y_top - h, w, h, stroke=1, fill=1)
    c.restoreState()
    y = y_top - 15
    for k, (label, val) in enumerate(rows):
        c.setFont(BOLD if k in (0, 3) else FONT, 8.5)
        c.drawString(x0 + 8, y, label + ":")
        c.drawRightString(MR - 8, y, val)
        y -= 13
    return dict(opening=opening, total_in=round(tin, 2), total_out=round(tout, 2), closing=closing,
                strings=dict(rows))


def _table_header(c, y_top):
    """Grey two-line table header; returns baseline of the first operation line."""
    h = 22
    c.saveState()
    c.setFillColorRGB(0.91, 0.91, 0.91)
    c.rect(ML - 2, y_top - h, MR - ML + 4, h, stroke=0, fill=1)
    c.restoreState()
    c.setFont(BOLD, 7.2)
    y1, y2 = y_top - 9, y_top - 18
    c.drawString(X_C1, y1, "Дата операции")
    c.drawString(X_C1, y2, "(МСК)")
    c.drawString(X_C2, y1, "Дата обработки")
    c.drawString(X_C2, y2, "и код авторизации")
    c.drawString(X_C3, y1, "Категория (банковская)")
    c.drawRightString(X_C4R, y1, "Сумма в валюте")
    c.drawRightString(X_C4R, y2, "счёта")
    c.drawRightString(X_C5R, y1, "Остаток")
    return y_top - h - 11


def _footer(c, page_no, n_pages):
    c.setStrokeColorRGB(0.7, 0.7, 0.7)
    c.setLineWidth(0.4)
    c.line(ML, 44, MR, 44)
    c.setFont(FONT, 7)
    c.setFillColorRGB(0.35, 0.35, 0.35)
    if page_no < n_pages:
        c.setFillColorRGB(0, 0, 0)
        c.setFont(FONT, 7.5)
        c.drawRightString(MR, 48, "Продолжение на следующей странице")
        c.setFont(FONT, 7)
        c.setFillColorRGB(0.35, 0.35, 0.35)
    c.drawString(ML, 33, "АО «Банк Образец» — вымышленный банк. Документ-образец для тестирования: ОБРАЗЕЦ / SPECIMEN.")
    c.drawRightString(MR, 33, f"Страница {page_no} из {n_pages}")
    c.setFillColorRGB(0, 0, 0)


def _line1(o):
    return (f"{o['date']:%d.%m.%Y} {o['time']}", f"{o['date']:%d.%m.%Y} {o['auth']}", o["bank_cat"],
            money(o["amount"], sign=o["amount"] > 0), money(o["balance"]))


def _layout(ops, first_table_y):
    """Assign every operation line to (page, baseline). Returns pages: list of dict(items=[...])."""
    pages = []
    page = dict(no=1, items=[])
    y = first_table_y[1]
    split_done = False
    i = 0
    pending_l2 = None
    while i < len(ops):
        if pending_l2 is not None:  # description of the split op at the top of the page
            page["items"].append(("L2", pending_l2, y))
            page["items"].append(("SEP", pending_l2, y - SEP_DY))
            y -= PITCH - LH
            pending_l2 = None
            continue
        fits = y - LH - 3 >= Y_MIN
        if fits:
            page["items"].append(("L1", i, y))
            page["items"].append(("L2", i, y - LH))
            page["items"].append(("SEP", i, y - LH - SEP_DY))
            y -= PITCH
            i += 1
            continue
        # page is full
        if page["no"] == 2 and not split_done:
            if y - 3 >= Y_MIN:  # room for one more line: line 1 of op i
                page["items"].append(("L1", i, y))
                split = i
            else:  # move the last whole op's description to the next page
                split = i - 1
                page["items"] = [it for it in page["items"] if not (it[1] == split and it[0] in ("L2", "SEP"))]
            pending_l2 = split
            i = split + 1
            split_done = True
        pages.append(page)
        page = dict(no=page["no"] + 1, items=[])
        y = first_table_y[2]
    pages.append(page)
    return pages


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    from reportlab.pdfbase.pdfmetrics import stringWidth

    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    C.ff_register_rl_fonts(FONT, BOLD)
    ops = G.bank_ops(seed=5)
    assert len(ops) == 142

    # geometry: where the first operation line sits on page 1 and on later pages
    # (page 1: info block ~ 6 lines, summary box at right; then the table header)
    y_info_end = PAGE_H - 40 - 80 - 11.5 * 6
    p1_table_top = y_info_end - 8
    later_table_top = PAGE_H - 36 - 26
    first_y = {1: p1_table_top - 22 - 11, 2: later_table_top - 22 - 11}
    pages = _layout(ops, first_y)
    n_pages = len(pages)

    # column collision guard
    for o in ops:
        l1 = _line1(o)
        assert X_C1 + stringWidth(l1[0], FONT, FS) < X_C2 - 4, l1
        assert X_C2 + stringWidth(l1[1], FONT, FS) < X_C3 - 4, l1
        assert X_C3 + stringWidth(l1[2], FONT, FS) < X_C4R - stringWidth(l1[3], FONT, FS) - 6, l1
        assert X_C4R + 6 < X_C5R - stringWidth(l1[4], FONT, FS), l1
        assert X_C3 + stringWidth(o["desc"] + " " + SPLIT_MARKER, FONT, FS) < MR, o["desc"]

    split_idx = next(it[1] for it in pages[1]["items"][::-1] if it[0] == "L1")
    path = out_dir / FIXTURE
    c = C.ff_rl_canvas(str(path), title="Выписка по счёту за сентябрь 2026 (ОБРАЗЕЦ)",
                       subject="Выписка по счёту дебетовой карты — вымышленные данные (ОБРАЗЕЦ / SPECIMEN)",
                       author="АО «Банк Образец» (вымышленный банк)")
    positions = {}
    header_values = None
    for page in pages:
        _watermark(c)
        y_head = _page_header(c, page["no"])
        if page["no"] == 1:
            header_values = _summary_box(c, ops, PAGE_H - 40 - 50)
            _table_header(c, p1_table_top)
        else:
            _table_header(c, later_table_top)
        c.setFillColorRGB(0, 0, 0)
        for kind, i, y in page["items"]:
            o = ops[i]
            if kind == "L1":
                a, b, cat, amt, bal = _line1(o)
                c.setFont(FONT, FS)
                c.drawString(X_C1, y, a)
                c.drawString(X_C2, y, b)
                c.drawString(X_C3, y, cat)
                if o["amount"] > 0:
                    c.setFillColorRGB(0.05, 0.45, 0.2)
                c.drawRightString(X_C4R, y, amt)
                c.setFillColorRGB(0, 0, 0)
                c.drawRightString(X_C5R, y, bal)
                positions.setdefault(i, {})["line1"] = dict(page=page["no"], baseline=round(y, 2))
            elif kind == "L2":
                desc = o["desc"] + (" " + SPLIT_MARKER if i == split_idx else "")
                c.setFont(FONT, FS)
                c.setFillColorRGB(0.25, 0.25, 0.25)
                c.drawString(X_C3, y, desc)
                c.setFillColorRGB(0, 0, 0)
                positions.setdefault(i, {})["line2"] = dict(page=page["no"], baseline=round(y, 2))
            else:
                c.setStrokeColorRGB(0.85, 0.85, 0.85)
                c.setLineWidth(0.3)
                c.line(ML, y, MR, y)
        _footer(c, page["no"], n_pages)
        c.showPage()
    c.save()

    exp = G.bank_expected(seed=5)
    assert abs(header_values["closing"] - exp["closing"]) < 0.005
    assert abs(header_values["total_in"] - exp["total_in"]) < 0.005
    assert abs(header_values["total_out"] - exp["total_out"]) < 0.005
    so = ops[split_idx]
    truth = dict(
        fixture=FIXTURE, case="f-bank-statement-pdf-categories", source="datagen.bank_ops(seed=5)",
        pages=n_pages, expected=exp, header=header_values,
        split_operation=dict(index=split_idx, date=so["date"].isoformat(), time=so["time"], auth=so["auth"],
                             amount=so["amount"], balance=so["balance"],
                             description=so["desc"] + " " + SPLIT_MARKER, my_category=so["my_cat"],
                             line1=positions[split_idx]["line1"], line2=positions[split_idx]["line2"]),
        operations=[dict(n=k + 1, date=o["date"].isoformat(), time=o["time"], auth=o["auth"],
                         bank_category=o["bank_cat"],
                         description=o["desc"] + (" " + SPLIT_MARKER if k == split_idx else ""),
                         amount=o["amount"], balance=o["balance"], my_category=o["my_cat"], **positions[k])
                    for k, o in enumerate(ops)],
        ops_per_page={p["no"]: sorted({it[1] for it in p["items"] if it[0] == "L1"}) for p in pages},
    )
    tpath = C.ff_write_json(truth_dir / "vypiska_sentyabr_2026.json", truth)
    return [str(path), tpath]


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / "f-bank-statement-pdf-categories", base / "truth"):
        print(p)
