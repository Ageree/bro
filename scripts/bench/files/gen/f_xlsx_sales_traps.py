"""Fixture for f-xlsx-sales-traps: prodazhi_Q1.xlsx — a "dirty" Q1 2026 sales workbook.

Sheets «Январь», «Февраль», «Март»:
  row 1  A1:G1 merged title «Продажи за <месяц> 2026 (ОБРАЗЕЦ)»
  row 2  note «Данные вымышленные — ОБРАЗЕЦ / SPECIMEN»
  row 3  merged groups «Сделка» A3:C3, «Клиент» D3:E3, «Сумма» F3, «Статус» G3
  row 4  Дата | № сделки | Менеджер | Клиент | Город | Сумма, руб. | Статус
  row 5+ data; every data row i (one counter over all three sheets, duplicates included)
         is written through datagen.sales_cell_repr(i, deal): mixed date / amount / manager forms
  after one blank row: 4 rows «Итого <менеджер>» =SUMIF(C..,"<Фамилия>*",F..) and
         «ИТОГО ЗА МЕСЯЦ» =SUM(F5:F<last>), with cached values as Excel would compute them
         (SUMIF/SUM skip text amounts, "Фамилия*" misses the « иванов » spelling) — the in-file
         totals are deliberately wrong and must not be trusted.
Duplicates (datagen.sales_q1): 5 inside a sheet right after the original row, 2 January deals
repeated in the middle of «Февраль» with their January date.
Sheet «Справочник»: менеджер → отдел. Hidden sheet «old»: 2025 archive (must be ignored).

truth/prodazhi_Q1.json: expected numbers (datagen.sales_expected), the row map of the fixture
(sheet, row, deal no, kind), cached subtotal values and the live-probe deal.
"""

from __future__ import annotations

import datetime as dt
import pathlib
import random
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402
import datagen as G  # noqa: E402

FIXTURE = "prodazhi_Q1.xlsx"
MONTHS = {1: ("Январь", "январь"), 2: ("Февраль", "февраль"), 3: ("Март", "март")}
HEADERS = ["Дата", "№ сделки", "Менеджер", "Клиент", "Город", "Сумма, руб.", "Статус"]
FIRST_DATA_ROW = 5  # 1-based Excel row
DEPARTMENTS = {
    "Иванов И.И.": ("Отдел продаж № 1 (Москва)", "Образцова Н.Н."),
    "Петрова А.С.": ("Отдел продаж № 1 (Москва)", "Образцова Н.Н."),
    "Сидоров К.М.": ("Отдел продаж № 2 (регионы)", "Тестов П.П."),
    "Ким Е.В.": ("Отдел продаж № 2 (регионы)", "Тестов П.П."),
}
CREATED = dt.datetime(2026, 4, 2, 10, 15, 0)


def _sheet_rows():
    """Per month: ordered list of (kind, deal) — kind 'deal' or 'dup'."""
    deals, dups = G.sales_q1(seed=4)
    per = {m: [("deal", d) for d in deals if d["sheet"] == m] for m in (1, 2, 3)}
    for dup in dups:
        m = dup["sheet"]
        rows = per[m]
        if dup["date"].month == m:  # within-sheet duplicate: right after its original
            pos = next(k for k, (knd, d) in enumerate(rows) if d["no"] == dup["no"] and knd == "deal")
            rows.insert(pos + 1, ("dup", dup))
        else:  # January deal repeated in the middle of February, January date kept
            rows.insert(len(rows) // 2, ("dup", dup))
    return per


def _sumif_cached(values, mgr_cells, surname):
    """Excel SUMIF(range, "<surname>*", sum_range): case-insensitive prefix match, text amounts skipped."""
    pref = surname.lower()
    return round(sum(v for v, m in zip(values, mgr_cells) if isinstance(v, float) and m.lower().startswith(pref)), 2)


def _old_rows():
    rnd = random.Random(2025)
    rows = []
    for n in range(1, 37):
        m = 1 + rnd.randrange(12)
        day = 1 + rnd.randrange(28)
        mgr = G.SALES_MANAGERS[rnd.randrange(4)]
        client, city = G.SALES_CLIENTS[rnd.randrange(len(G.SALES_CLIENTS))]
        amount = rnd.randrange(400_000, 20_000_000) / 100
        rows.append((dt.datetime(2025, m, day), f"С-25-{n:04d}", mgr, client, city, amount, "оплачено"))
    rows.sort(key=lambda r: (r[0], r[1]))
    return rows


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    import xlsxwriter

    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / FIXTURE

    wb = xlsxwriter.Workbook(str(path), {"strings_to_numbers": False, "strings_to_formulas": False,
                                         "strings_to_urls": False})
    wb.set_properties({"title": "Продажи 1 квартал 2026 (ОБРАЗЕЦ / SPECIMEN)", "author": "ОБРАЗЕЦ / SPECIMEN",
                       "company": "ООО «Образец» (вымышленная организация)", "created": CREATED,
                       "comments": "Учебный файл: все данные вымышленные (ОБРАЗЕЦ / SPECIMEN)"})
    f_title = wb.add_format({"bold": True, "font_size": 14, "align": "center", "valign": "vcenter"})
    f_note = wb.add_format({"italic": True, "font_size": 9, "font_color": "#C00000"})
    f_group = wb.add_format({"bold": True, "align": "center", "bg_color": "#D9E1F2", "border": 1})
    f_head = wb.add_format({"bold": True, "bg_color": "#E7E6E6", "border": 1, "text_wrap": True, "valign": "top"})
    f_date = wb.add_format({"num_format": "dd.mm.yyyy"})
    f_money = wb.add_format({"num_format": "#,##0.00"})
    f_sub_label = wb.add_format({"bold": True, "italic": True})
    f_sub_val = wb.add_format({"bold": True, "italic": True, "num_format": "#,##0.00"})
    f_tot_label = wb.add_format({"bold": True, "bg_color": "#FFF2CC", "border": 1})
    f_tot_val = wb.add_format({"bold": True, "bg_color": "#FFF2CC", "border": 1, "num_format": "#,##0.00"})

    per = _sheet_rows()
    i = 0
    row_map = []
    cached = {}
    for m in (1, 2, 3):
        sheet_name, month_word = MONTHS[m]
        ws = wb.add_worksheet(sheet_name)
        ws.set_header("&CОБРАЗЕЦ / SPECIMEN")
        ws.set_footer("&LДанные вымышленные&RОБРАЗЕЦ / SPECIMEN")
        ws.set_paper(9)
        ws.fit_to_pages(1, 0)
        ws.merge_range(0, 0, 0, 6, f"Продажи за {month_word} 2026 (ОБРАЗЕЦ)", f_title)
        ws.write_string(1, 0, "Данные вымышленные — ОБРАЗЕЦ / SPECIMEN", f_note)
        ws.merge_range(2, 0, 2, 2, "Сделка", f_group)
        ws.merge_range(2, 3, 2, 4, "Клиент", f_group)
        ws.write_string(2, 5, "Сумма", f_group)
        ws.write_string(2, 6, "Статус", f_group)
        for col, h in enumerate(HEADERS):
            ws.write_string(3, col, h, f_head)
        ws.set_row(0, 22)
        for col, w in enumerate([12, 12, 16, 24, 17, 15, 11]):
            ws.set_column(col, col, w)

        r = FIRST_DATA_ROW - 1  # 0-based
        amounts, managers = [], []
        for kind, d in per[m]:
            (dk, dv), (ak, av), mgr = G.sales_cell_repr(i, d)
            if dk == "datetime":
                ws.write_datetime(r, 0, dt.datetime.fromisoformat(dv), f_date)
            elif dk == "serial_general":
                ws.write_number(r, 0, dv)
            else:
                ws.write_string(r, 0, dv)
            ws.write_string(r, 1, d["no"])
            ws.write_string(r, 2, mgr)
            ws.write_string(r, 3, d["client"])
            ws.write_string(r, 4, d["city"])
            if ak == "number":
                ws.write_number(r, 5, av, f_money)
                amounts.append(float(av))
            else:
                ws.write_string(r, 5, av)
                amounts.append(av)
            ws.write_string(r, 6, d["status"])
            managers.append(mgr)
            row_map.append(dict(sheet=sheet_name, row=r + 1, i=i, kind=kind, no=d["no"],
                                date=d["date"].isoformat(), manager=d["manager"], amount=d["amount"],
                                status=d["status"], date_repr=dk, amount_repr=ak, manager_written=mgr))
            i += 1
            r += 1
        last = r  # 1-based number of the last data row == r (0-based next row)
        r += 1  # one blank row
        sheet_cache = {}
        for full in G.SALES_MANAGERS:
            surname = full.split()[0]
            val = _sumif_cached(amounts, managers, surname)
            ws.write_string(r, 2, f"Итого {full}", f_sub_label)
            ws.write_formula(r, 5, f'=SUMIF(C{FIRST_DATA_ROW}:C{last},"{surname}*",F{FIRST_DATA_ROW}:F{last})',
                             f_sub_val, val)
            sheet_cache[f"Итого {full}"] = dict(row=r + 1, value=val)
            r += 1
        total = round(sum(v for v in amounts if isinstance(v, float)), 2)
        ws.merge_range(r, 0, r, 4, "ИТОГО ЗА МЕСЯЦ", f_tot_label)
        ws.write_formula(r, 5, f"=SUM(F{FIRST_DATA_ROW}:F{last})", f_tot_val, total)
        ws.write_blank(r, 6, None, f_tot_label)
        sheet_cache["ИТОГО ЗА МЕСЯЦ"] = dict(row=r + 1, value=total)
        cached[sheet_name] = dict(first_data_row=FIRST_DATA_ROW, last_data_row=last, totals=sheet_cache)
        if m == 1:
            ws.activate()

    ref = wb.add_worksheet("Справочник")
    ref.set_header("&CОБРАЗЕЦ / SPECIMEN")
    ref.write_string(0, 0, "Справочник менеджеров (ОБРАЗЕЦ)", wb.add_format({"bold": True, "font_size": 12}))
    for col, h in enumerate(["Менеджер", "Отдел", "Руководитель отдела"]):
        ref.write_string(2, col, h, f_head)
    for k, mgr in enumerate(G.SALES_MANAGERS):
        dep, boss = DEPARTMENTS[mgr]
        ref.write_string(3 + k, 0, mgr)
        ref.write_string(3 + k, 1, dep)
        ref.write_string(3 + k, 2, boss)
    ref.set_column(0, 0, 16)
    ref.set_column(1, 1, 28)
    ref.set_column(2, 2, 22)

    old = wb.add_worksheet("old")
    old.write_string(0, 0, "Продажи 2025 — архив, не использовать (ОБРАЗЕЦ)", wb.add_format({"bold": True}))
    for col, h in enumerate(HEADERS):
        old.write_string(2, col, h, f_head)
    for k, (d, no, mgr, client, city, amount, status) in enumerate(_old_rows()):
        old.write_datetime(3 + k, 0, d, f_date)
        old.write_string(3 + k, 1, no)
        old.write_string(3 + k, 2, mgr)
        old.write_string(3 + k, 3, client)
        old.write_string(3 + k, 4, city)
        old.write_number(3 + k, 5, amount, f_money)
        old.write_string(3 + k, 6, status)
    old.set_column(0, 6, 14)
    old.hide()
    wb.close()
    C.ooxml_fix_core_dates(path, when=(2026, 4, 2, 10, 15, 0))

    exp = G.sales_expected(seed=4)
    probe = next(x for x in row_map if x["no"] == "С-26-0003" and x["kind"] == "deal")
    truth = dict(
        fixture=FIXTURE, case="f-xlsx-sales-traps", source="datagen.sales_q1(seed=4), datagen.sales_cell_repr",
        expected=exp,
        sheets=list(MONTHS[m][0] for m in (1, 2, 3)), hidden_sheets=["old"], reference_sheet="Справочник",
        rows=row_map,
        duplicates=[dict(no=x["no"], sheet=x["sheet"], row=x["row"]) for x in row_map if x["kind"] == "dup"],
        cancelled=sorted({x["no"] for x in row_map if x["status"] == "отменена"}),
        in_file_totals=cached,
        live_probe=dict(deal_no=probe["no"], sheet=probe["sheet"], row=probe["row"], amount=probe["amount"],
                        manager=probe["manager"], month=1, pivot_before=exp["pivot_manager_month"]["Иванов И.И.|1"],
                        delta=1000, pivot_after=round(exp["pivot_manager_month"]["Иванов И.И.|1"] + 1000, 2)),
    )
    tpath = C.ff_write_json(truth_dir / "prodazhi_Q1.json", truth)
    return [str(path), tpath]


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / "f-xlsx-sales-traps", base / "truth"):
        print(p)
