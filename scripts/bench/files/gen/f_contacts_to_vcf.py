"""Fixture for f-contacts-to-vcf: kontakty.xlsx — contacts exported from an old phone.

One sheet «Контакты (ОБРАЗЕЦ)», header row «Имя | Телефон | Телефон 2 | Email | Заметка | ДР», then the
60 rows of datagen.contacts_rows() in order (15 hard rows with 5 duplicate pairs + 45 ordinary rows),
every value stored as text exactly as typed («8 (916) 000-12-34», «8-495-000-00-01 доб. 123»,
«+375 29 000-00-00», «000-12-34», birthdays «12.05» / «03.11.1985»). The specimen mark is in the sheet
name, the page header/footer and the document properties (a stamp row would shift the header).

truth/kontakty.json: expected numbers (datagen.contacts_expected), every row with its expected E.164
numbers, the 5 merge groups (by number), the expected merged cards, birthdays as vCard values.
"""

from __future__ import annotations

import datetime as dt
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402
import datagen as G  # noqa: E402

FIXTURE = "kontakty.xlsx"
HEADER = ["Имя", "Телефон", "Телефон 2", "Email", "Заметка", "ДР"]
SHEET = "Контакты (ОБРАЗЕЦ)"


def _bday_vcard(s: str):
    if not s:
        return None
    parts = s.split(".")
    if len(parts) == 2:
        d, m = parts
        return dict(without_year=True, values=[f"--{m}{d}", f"--{m}-{d}", f"1604-{m}-{d}"])
    d, m, y = parts
    return dict(without_year=False, values=[f"{y}-{m}-{d}", f"{y}{m}{d}"])


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    import xlsxwriter

    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = G.contacts_rows()
    assert len(rows) == 60
    path = out_dir / FIXTURE
    wb = xlsxwriter.Workbook(str(path), {"strings_to_numbers": False, "strings_to_formulas": False,
                                         "strings_to_urls": False})
    wb.set_properties({"title": "Контакты со старого телефона (ОБРАЗЕЦ / SPECIMEN)", "author": "ОБРАЗЕЦ / SPECIMEN",
                       "created": dt.datetime(2026, 10, 12, 21, 5, 0),
                       "comments": "Учебный файл: все контакты вымышленные (ОБРАЗЕЦ / SPECIMEN)"})
    f_head = wb.add_format({"bold": True, "bg_color": "#D9E1F2", "border": 1})
    f_text = wb.add_format({"num_format": "@"})
    ws = wb.add_worksheet(SHEET)
    ws.set_header("&CОБРАЗЕЦ / SPECIMEN — контакты вымышленные")
    ws.set_footer("&RОБРАЗЕЦ / SPECIMEN")
    ws.set_paper(9)
    ws.fit_to_pages(1, 0)
    for col, h in enumerate(HEADER):
        ws.write_string(0, col, h, f_head)
    for r, (name, p1, p2, email, note, bday, _) in enumerate(rows, start=1):
        for col, v in enumerate([name, p1, p2, email, note, bday]):
            if v:
                ws.write_string(r, col, v, f_text)
    for col, w in enumerate([24, 26, 18, 26, 14, 12]):
        ws.set_column(col, col, w)
    ws.freeze_panes(1, 0)
    ws.autofilter(0, 0, len(rows), len(HEADER) - 1)
    wb.close()
    C.ooxml_fix_core_dates(path, when=(2026, 10, 12, 21, 5, 0))

    # merge groups: rows sharing a planted E.164 number
    by_num = {}
    for k, r in enumerate(rows):
        for num in r[6]:
            if num:
                by_num.setdefault(num, []).append(k)
    groups = [v for v in by_num.values() if len(v) > 1]
    merged = []
    for g in groups:
        nums, emails, notes, bdays = [], [], [], []
        for k in g:
            for n in rows[k][6]:
                if n and n not in nums:
                    nums.append(n)
            if rows[k][3]:
                emails.append(rows[k][3])
            if rows[k][4]:
                notes.append(rows[k][4])
            if rows[k][5]:
                bdays.append(_bday_vcard(rows[k][5]))
        merged.append(dict(names=[rows[k][0] for k in g], rows=[k + 2 for k in g], phones=nums, emails=emails,
                           notes=notes, bday=bdays[0] if bdays else None))
    exp = G.contacts_expected()
    truth = dict(
        fixture=FIXTURE, case="f-contacts-to-vcf", source="datagen.contacts_rows()", sheet=SHEET, header=HEADER,
        expected=exp, cards_after_merge=exp["contacts_after_merge"], merge_groups=merged,
        rows=[dict(row=k + 2, name=r[0], phone=r[1], phone2=r[2], email=r[3], note=r[4], bday=r[5],
                   e164=r[6], bday_vcard=_bday_vcard(r[5]), keep_as_typed_and_flag=(r[6] == [None]))
              for k, r in enumerate(rows)],
        notes=dict(ext="«доб. 123» → +74950000001;ext=123 (also accepted: ,123 / p123 / « доб. 123»)",
                   foreign="+375 29 000-00-00 is Belarus, not +7",
                   no_area_code="«000-12-34» (Консьерж) has no area code: keep as typed and say so"),
    )
    tpath = C.ff_write_json(truth_dir / "kontakty.json", truth)
    return [str(path), tpath]


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / "f-contacts-to-vcf", base / "truth"):
        print(p)
