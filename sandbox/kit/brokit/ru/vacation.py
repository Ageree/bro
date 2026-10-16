"""brokit ru vacation: the last day of a leave of N calendar days.

Non-working holidays (art. 112 of the Labour Code: 1-8 January, 23 February,
8 March, 1 and 9 May, 12 June, 4 November) that fall within a leave are not
counted in its calendar days and lengthen it (art. 120). Weekends and the
days the government moves are counted: only the holidays themselves are left
out, so the dates do not depend on the year's decree.
"""

import datetime as dt
import re

from brokit.util import KitError, parser

HOLIDAYS = {(1, day) for day in range(1, 9)} | {(2, 23), (3, 8), (5, 1), (5, 9), (6, 12), (11, 4)}
MAX_DAYS = 366


def main(argv):
    p = parser("ru vacation")
    p.add_argument("--start", required=True)
    p.add_argument("--days", type=int, required=True)
    args = p.parse_args(argv)
    if not 1 <= args.days <= MAX_DAYS:
        raise KitError("bad_args", "--days must be 1..%d" % MAX_DAYS)
    start = parse_date(args.start)
    day, counted, skipped = start, 0, []
    while True:
        if (day.month, day.day) in HOLIDAYS:
            skipped.append(day)
        else:
            counted += 1
            if counted == args.days:
                break
        day += dt.timedelta(days=1)
    return {
        "start": start.strftime("%d.%m.%Y"),
        "end": day.strftime("%d.%m.%Y"),
        "days": args.days,
        "holidays": [d.strftime("%d.%m.%Y") for d in skipped],
        "back_to_work": first_after(day).strftime("%d.%m.%Y"),
        "note": "holidays inside the leave are not counted and lengthen it (art. 120)" if skipped else None,
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


def first_after(day):
    """The day after the leave that is no holiday (a weekend may still follow)."""
    nxt = day + dt.timedelta(days=1)
    while (nxt.month, nxt.day) in HOLIDAYS:
        nxt += dt.timedelta(days=1)
    return nxt
