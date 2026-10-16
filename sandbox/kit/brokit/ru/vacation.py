"""brokit ru vacation: the days of an annual paid leave (basic or additional).

Non-working holidays (art. 112 of the Labour Code: 1-8 January, 23 February,
8 March, 1 and 9 May, 12 June, 4 November) that fall within an annual paid
leave are not counted in its calendar days and lengthen it (art. 120).
Weekends and the days the government moves are counted: only the holidays
themselves are left out, so the dates do not depend on the year's decree.
Other leave (unpaid, study, maternity) counts holidays as ordinary days: not
for this command. A region's own non-working days come in with --extra.

    --start D --days N   the last day of a leave of N calendar days
    --start D --end E    the calendar days a leave from D to E counts
"""

import datetime as dt
import re

from brokit.util import KitError, parser

HOLIDAYS = {(1, day) for day in range(1, 9)} | {(2, 23), (3, 8), (5, 1), (5, 9), (6, 12), (11, 4)}
MAX_DAYS = 366
SCOPE = "annual paid leave only (art. 120): federal holidays of art. 112 and --extra are not counted; unpaid, study and maternity leave count every day"


def main(argv):
    p = parser("ru vacation")
    p.add_argument("--start", required=True)
    length = p.add_mutually_exclusive_group(required=True)
    length.add_argument("--days", type=int)
    length.add_argument("--end")
    p.add_argument("--extra", default="", help="regional non-working days, DD.MM.YYYY,DD.MM.YYYY")
    args = p.parse_args(argv)
    start = parse_date(args.start)
    extra = {parse_date(text) for text in args.extra.split(",") if text.strip()}

    def holiday(day):
        return (day.month, day.day) in HOLIDAYS or day in extra

    skipped, counted, day = [], 0, start
    if args.days is not None:
        if not 1 <= args.days <= MAX_DAYS:
            raise KitError("bad_args", "--days must be 1..%d" % MAX_DAYS)
        while True:
            if holiday(day):
                skipped.append(day)
            else:
                counted += 1
                if counted == args.days:
                    break
            day += dt.timedelta(days=1)
        end = day
    else:
        end = parse_date(args.end)
        if end < start or (end - start).days >= MAX_DAYS * 2:
            raise KitError("bad_args", "--end must be on or after --start, within two years")
        while day <= end:
            if holiday(day):
                skipped.append(day)
            else:
                counted += 1
            day += dt.timedelta(days=1)
    return {
        "start": start.strftime("%d.%m.%Y"),
        "end": end.strftime("%d.%m.%Y"),
        "days": counted,
        "holidays": [d.strftime("%d.%m.%Y") for d in skipped],
        "scope": SCOPE,
    }


def parse_date(text):
    match = re.fullmatch(r"\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*|\s*(\d{4})-(\d{2})-(\d{2})\s*", text)
    if match is None:
        raise KitError("bad_date", "bad date: " + text, "DD.MM.YYYY or YYYY-MM-DD")
    day, month, year = match.group(1, 2, 3) if match.group(1) else reversed(match.group(4, 5, 6))
    try:
        return dt.date(int(year), int(month), int(day))
    except ValueError:
        raise KitError("bad_date", "no such date: " + text)
