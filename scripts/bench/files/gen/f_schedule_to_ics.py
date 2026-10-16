"""Fixture for f-schedule-to-ics: raspisanie_Lyovy.xlsx — Lyova's weekly activities grid.

Sheet «Неделя»: row 1 title (ОБРАЗЕЦ / SPECIMEN), row 2 «Время | Пн … Вс», rows 3–20 are the
30-minute slots 11:00–11:30 … 19:30–20:00 (the label names the slot range, so a merged block's
end time is unambiguous). Every activity of datagen.SCHEDULE is a vertically merged block with
«<Занятие>\\n<адрес>» (Плавание Пн/Ср 17:00–18:00; Шахматы Вт 16:00–17:30; Английский Чт 18:30–19:30
and Сб 11:00–12:00; Футбол Пт 17:30–19:00). Only the top-left cell of a merged block holds text.
Sheet «Исключения»: validity 15.10.2026–31.12.2026, autumn break 26.10–01.11, 04.11 holiday with
swimming moved to 05.11 17:00, no classes on 31.12.

truth/raspisanie_Lyovy.json: expected numbers (datagen.schedule_expected), all 60 occurrences
(datagen.schedule_occurrences) with MSK and UTC times, the merged-block map, the exception texts.
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

FIXTURE = "raspisanie_Lyovy.xlsx"
DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
FIRST_SLOT = dt.time(11, 0)
N_SLOTS = 18  # 11:00 … 19:30 starts
SLOT_ROW0 = 2  # 0-based row of the 11:00 slot (Excel row 3)
COLORS = {"Плавание": "#DDEBF7", "Шахматы": "#E2EFDA", "Английский": "#FFF2CC", "Футбол": "#FCE4D6"}
EXCEPTIONS = [
    "Действует с 15.10.2026 по 31.12.2026",
    "Осенние каникулы 26.10–01.11 — занятий нет",
    "04.11 (праздник) плавание переносится на 05.11 в 17:00",
    "31.12 занятий нет",
]


def _slot(t: str) -> int:
    h, m = map(int, t.split(":"))
    return (h * 60 + m - (FIRST_SLOT.hour * 60 + FIRST_SLOT.minute)) // 30


def _label(k: int) -> str:
    a = FIRST_SLOT.hour * 60 + FIRST_SLOT.minute + 30 * k
    b = a + 30
    return f"{a // 60:02d}:{a % 60:02d}–{b // 60:02d}:{b % 60:02d}"


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    import xlsxwriter

    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / FIXTURE
    wb = xlsxwriter.Workbook(str(path), {"strings_to_numbers": False, "strings_to_formulas": False,
                                         "strings_to_urls": False})
    wb.set_properties({"title": "Расписание секций Лёвы (ОБРАЗЕЦ / SPECIMEN)", "author": "ОБРАЗЕЦ / SPECIMEN",
                       "created": dt.datetime(2026, 10, 10, 20, 30, 0),
                       "comments": "Учебный файл: все данные вымышленные (ОБРАЗЕЦ / SPECIMEN)"})
    f_title = wb.add_format({"bold": True, "font_size": 13, "align": "center", "valign": "vcenter"})
    f_head = wb.add_format({"bold": True, "align": "center", "valign": "vcenter", "bg_color": "#D9D9D9", "border": 1})
    f_time = wb.add_format({"align": "center", "valign": "vcenter", "border": 1, "font_size": 9, "font_color": "#404040"})
    f_empty = wb.add_format({"border": 1})
    f_weekend = wb.add_format({"border": 1, "bg_color": "#F7F7F7"})
    lesson_fmt = {name: wb.add_format({"text_wrap": True, "valign": "top", "border": 2, "bg_color": col, "font_size": 9})
                  for name, col in COLORS.items()}

    lesson_bold = wb.add_format({"bold": True, "font_size": 9})
    ws = wb.add_worksheet("Неделя")
    ws.set_header("&CОБРАЗЕЦ / SPECIMEN")
    ws.set_footer("&LДанные вымышленные&RОБРАЗЕЦ / SPECIMEN")
    ws.set_landscape()
    ws.set_paper(9)
    ws.fit_to_pages(1, 1)
    ws.merge_range(0, 0, 0, 7, "Расписание секций Лёвы, осень 2026 — ОБРАЗЕЦ / SPECIMEN", f_title)
    ws.set_row(0, 24)
    ws.write_string(1, 0, "Время", f_head)
    for k, d in enumerate(DAYS):
        ws.write_string(1, 1 + k, d, f_head)
    ws.set_column(0, 0, 13)
    ws.set_column(1, 7, 21)
    for k in range(N_SLOTS):
        r = SLOT_ROW0 + k
        ws.set_row(r, 24)
        ws.write_string(r, 0, _label(k), f_time)
        for col in range(1, 8):
            ws.write_blank(r, col, None, f_weekend if col >= 6 else f_empty)
    blocks = []
    for name, wds, s, e, loc in G.SCHEDULE:
        k0, k1 = _slot(s), _slot(e) - 1
        for wd in wds:
            r0, r1 = SLOT_ROW0 + k0, SLOT_ROW0 + k1
            ws.merge_range(r0, 1 + wd, r1, 1 + wd, "", lesson_fmt[name])
            ws.write_rich_string(r0, 1 + wd, lesson_bold, name, "\n" + loc, lesson_fmt[name])
            blocks.append(dict(activity=name, weekday=DAYS[wd], start=s, end=e, location=loc,
                               excel_range=f"{chr(ord('B') + wd)}{r0 + 1}:{chr(ord('B') + wd)}{r1 + 1}"))
    ws.freeze_panes(2, 1)
    ws.activate()

    ex = wb.add_worksheet("Исключения")
    ex.set_header("&CОБРАЗЕЦ / SPECIMEN")
    ex.write_string(0, 0, "Исключения и сроки — ОБРАЗЕЦ / SPECIMEN", wb.add_format({"bold": True, "font_size": 12}))
    for k, line in enumerate(EXCEPTIONS):
        ex.write_string(2 + k, 0, line)
    ex.set_column(0, 0, 62)
    wb.close()
    C.ooxml_fix_core_dates(path, when=(2026, 10, 10, 20, 30, 0))

    occ = G.schedule_occurrences()
    msk = dt.timezone(dt.timedelta(hours=3))
    occurrences = []
    for name, day, s, e, loc in occ:
        d = dt.date.fromisoformat(day)
        st = dt.datetime.combine(d, dt.time.fromisoformat(s), msk)
        en = dt.datetime.combine(d, dt.time.fromisoformat(e), msk)
        occurrences.append(dict(summary=name, start=st.isoformat(), end=en.isoformat(),
                                start_utc=st.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"), location=loc))
    truth = dict(fixture=FIXTURE, case="f-schedule-to-ics", source="datagen.SCHEDULE, datagen.schedule_occurrences()",
                 tz="Europe/Moscow", valid_from=G.SCHED_START.isoformat(), valid_to=G.SCHED_END.isoformat(),
                 expected=G.schedule_expected(), blocks=blocks, exceptions_sheet=EXCEPTIONS,
                 occurrences=occurrences)
    tpath = C.ff_write_json(truth_dir / "raspisanie_Lyovy.json", truth)
    return [str(path), tpath]


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / "f-schedule-to-ics", base / "truth"):
        print(p)
