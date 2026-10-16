"""brokit ics write: a calendar file (iCalendar, RFC 5545) for a phone or desktop calendar.

SPEC.json:
    {"name": "Секции Лёвы", "tz": "Europe/Moscow", "alarm_minutes": 60,
     "events": [{"summary": "Плавание", "start": "2026-10-19T17:00", "end": "2026-10-19T18:00",
                 "location": "Бассейн, ул. Примерная, 10", "description": "…",
                 "alarm_minutes": 60, "rrule": "FREQ=WEEKLY;UNTIL=2026-12-31", "exdates": ["2026-11-04T17:00"]}]}

`end` or `minutes`; a start without a time ("2026-11-04") is an all-day event, its `end`
the last day. Times are wall-clock times in `tz` (Europe/Moscow when not given; "UTC"
writes them with Z); a time with an offset ("…T14:00Z", "…+03:00") is converted to `tz`.
An event's `alarm_minutes` overrides the calendar's, null turns its alarm off.

Every line ends with CRLF and is folded at 75 octets on a character boundary (§3.1),
TEXT is escaped (§3.3.11), VTIMEZONE comes from the zone's own offsets over the
years the events cover, every event gets a UID that stays the same when the file
is made again (its title and start), DTSTAMP and, with alarm_minutes, a DISPLAY
alarm. An RRULE's UNTIL is written in UTC, as §3.3.10 wants beside a DTSTART with
TZID; a date there means the end of that day.

The result's `series` groups the occurrences by title, weekday and time with their
length, count and first and last day (a rule without an end by its first week):
check them against the source. `warnings` name
exdates that remove nothing, starts off their own rule, open-ended rules,
duplicates and keys the command does not know.
"""

import datetime as dt
import hashlib
import itertools
import json
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from brokit.util import KitError, need_file, out_path, parser

WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
MAX_EVENTS = 5000
# VTIMEZONE years past the start of a rule with neither COUNT nor UNTIL.
OPEN_ENDED_YEARS = 3
MAX_ALARM_MINUTES = 4 * 7 * 24 * 60
SPEC_HINT = (
    '{"tz": "Europe/Moscow", "alarm_minutes": 60, "events": [{"summary", "start": "2026-10-19T17:00", '
    '"end": "2026-10-19T18:00", "location", "rrule": "FREQ=WEEKLY;UNTIL=2026-12-31", "exdates": ["2026-11-04T17:00"]}]}'
)
RULE_HINT = "like FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=2026-12-31 or FREQ=WEEKLY;COUNT=10"
RULE_KEYS = (
    "FREQ",
    "UNTIL",
    "COUNT",
    "INTERVAL",
    "BYSECOND",
    "BYMINUTE",
    "BYHOUR",
    "BYDAY",
    "BYMONTHDAY",
    "BYYEARDAY",
    "BYWEEKNO",
    "BYMONTH",
    "BYSETPOS",
    "WKST",
)
SPEC_KEYS = ("name", "tz", "alarm_minutes", "events")
EVENT_KEYS = ("summary", "start", "end", "minutes", "location", "description", "alarm_minutes", "rrule", "exdates")
COMPACT = re.compile(r"(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?")
# Control characters TEXT may not carry (§3.3.11); a tab stays, line breaks become \n.
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def text(value):
    """A TEXT value escaped (§3.3.11)."""
    value = str(value).replace("\r\n", "\n").replace("\r", "\n")
    value = CONTROL.sub("", value)
    value = value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
    return value.replace("\n", "\\n")


def fold(line):
    """The line folded at 75 octets, never inside a UTF-8 character (§3.1)."""
    parts, current, size, limit = [], [], 0, 75
    for char in line:
        width = len(char.encode("utf-8"))
        if size + width > limit:
            parts.append("".join(current))
            current, size, limit = [], 0, 74  # a continuation starts with one space
        current.append(char)
        size += width
    parts.append("".join(current))
    return "\r\n ".join(parts)


def moment(value, where, zone):
    """A naive wall-clock datetime in zone (a value with an offset is converted), or a date for an all-day value."""
    if value is None or not str(value).strip():
        raise KitError("bad_spec", "%s is missing" % where, SPEC_HINT)
    raw = str(value).strip()
    compact = COMPACT.fullmatch(raw.upper())
    if compact:
        year, month, day, hour, minute, _, utc = compact.groups()
        raw = "%s-%s-%s" % (year, month, day) + ("T%s:%s%s" % (hour, minute, "Z" if utc else "") if hour else "")
    try:
        if len(raw) == 10:
            return dt.date.fromisoformat(raw)
        parsed = dt.datetime.fromisoformat(raw.replace(" ", "T").replace("Z", "+00:00"))
    except ValueError:
        raise KitError("bad_spec", "%s: %r is not YYYY-MM-DD or YYYY-MM-DDTHH:MM" % (where, value), SPEC_HINT)
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(zone)
    return parsed.replace(second=0, microsecond=0, tzinfo=None)


def stamp(value):
    if isinstance(value, dt.datetime):
        return value.strftime("%Y%m%dT%H%M%S")
    return value.strftime("%Y%m%d")


def utc_stamp(value, zone):
    """A wall-clock time in zone as a UTC DATE-TIME with Z."""
    return value.replace(tzinfo=zone).astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def offset(delta):
    minutes = int(delta.total_seconds() // 60)
    sign = "-" if minutes < 0 else "+"
    return "%s%02d%02d" % (sign, abs(minutes) // 60, abs(minutes) % 60)


def vtimezone(name, zone, first_year, last_year):
    """VTIMEZONE of the zone's offsets from Jan 1 of first_year to the end of last_year."""

    def at(moment_utc):
        return moment_utc.astimezone(zone)

    begin = dt.datetime(first_year, 1, 1, tzinfo=dt.timezone.utc)
    end = dt.datetime(last_year + 1, 1, 1, tzinfo=dt.timezone.utc)
    first = at(begin)
    lines = [
        "BEGIN:VTIMEZONE",
        "TZID:" + name,
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000",
        "TZOFFSETFROM:" + offset(first.utcoffset()),
        "TZOFFSETTO:" + offset(first.utcoffset()),
        "TZNAME:" + (first.tzname() or name),
        "END:STANDARD",
    ]
    step, now = dt.timedelta(hours=6), begin
    while now < end:
        later = now + step
        if at(later).utcoffset() != at(now).utcoffset():
            low, high = now, later
            while high - low > dt.timedelta(seconds=1):
                middle = low + (high - low) / 2
                low, high = (low, middle) if at(middle).utcoffset() != at(low).utcoffset() else (middle, high)
            change = high.replace(second=0, microsecond=0)
            before, after = at(change - dt.timedelta(seconds=1)).utcoffset(), at(change)
            kind = "DAYLIGHT" if after.dst() else "STANDARD"
            lines += [
                "BEGIN:" + kind,
                "DTSTART:" + (change.replace(tzinfo=None) + before).strftime("%Y%m%dT%H%M%S"),
                "TZOFFSETFROM:" + offset(before),
                "TZOFFSETTO:" + offset(after.utcoffset()),
                "TZNAME:" + (after.tzname() or name),
                "END:" + kind,
            ]
        now = later
    return lines + ["END:VTIMEZONE"]


def parse_rule(rule, where):
    """{KEY: value} of an RRULE; the "RRULE:" prefix and the case of names do not matter."""
    rule = str(rule).strip()
    if rule.upper().startswith("RRULE:"):
        rule = rule[6:]
    parts = {}
    for part in rule.split(";"):
        if not part.strip():
            continue
        key, sep, value = part.partition("=")
        key, value = key.strip().upper(), value.strip()
        if not sep or key not in RULE_KEYS or not value:
            raise KitError("bad_spec", "%s: %r is not a KEY=VALUE of RFC 5545" % (where, part.strip()), RULE_HINT)
        if key in parts:
            raise KitError("bad_spec", "%s: %s is given twice" % (where, key), RULE_HINT)
        parts[key] = value if key == "UNTIL" else value.upper()
    if "FREQ" not in parts:
        raise KitError("bad_spec", "%s needs FREQ" % where, RULE_HINT)
    if "UNTIL" in parts and "COUNT" in parts:
        raise KitError("bad_spec", "%s: UNTIL and COUNT cannot go together (§3.3.10)" % where, RULE_HINT)
    return parts


def rule_until(parts, start, zone, where):
    """The rule's UNTIL as a wall-clock value of DTSTART's kind (a date means its whole day), or None."""
    if "UNTIL" not in parts:
        return None
    until = moment(parts["UNTIL"], where + " UNTIL", zone)
    if isinstance(start, dt.datetime) and not isinstance(until, dt.datetime):
        return dt.datetime.combine(until, dt.time(23, 59, 59))
    if not isinstance(start, dt.datetime) and isinstance(until, dt.datetime):
        return until.date()
    return until


def rule_line(parts, until, zone, utc):
    """RRULE value, FREQ first, UNTIL in UTC beside a timed DTSTART (§3.3.10)."""
    values = dict(parts)
    if until is not None:
        if not isinstance(until, dt.datetime):
            values["UNTIL"] = stamp(until)
        elif utc:
            values["UNTIL"] = until.strftime("%Y%m%dT%H%M%SZ")
        else:
            values["UNTIL"] = utc_stamp(until, zone)
    keys = ["FREQ"] + [key for key in values if key != "FREQ"]
    return ";".join("%s=%s" % (key, values[key]) for key in keys)


def expand(parts, start, until, where, horizon):
    """Starts of the rule's occurrences (at most MAX_EVENTS; up to `horizon` for an open-ended rule)."""
    from dateutil.rrule import rrulestr

    first = start if isinstance(start, dt.datetime) else dt.datetime.combine(start, dt.time())
    local = dict(parts)
    if until is not None:
        local["UNTIL"] = stamp(until if isinstance(until, dt.datetime) else dt.datetime.combine(until, dt.time()))
    try:
        rule = rrulestr(";".join("%s=%s" % item for item in local.items()), dtstart=first)
        found = []
        for value in itertools.islice(rule, MAX_EVENTS + 1):
            if horizon is not None and value > horizon:
                break
            found.append(value)
    except (ValueError, TypeError) as error:
        raise KitError("bad_spec", "%s: %s" % (where, error), RULE_HINT)
    if len(found) > MAX_EVENTS:
        raise KitError("too_many", "%s makes more than %d occurrences" % (where, MAX_EVENTS), "add UNTIL or COUNT")
    return [value if isinstance(start, dt.datetime) else value.date() for value in found]


def alarm_trigger(value, where):
    """TRIGGER of an alarm `value` minutes before the start."""
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        raise KitError("bad_spec", "%s: alarm_minutes must be whole minutes, not %r" % (where, value), SPEC_HINT)
    if not 0 <= minutes <= MAX_ALARM_MINUTES:
        raise KitError("bad_spec", "%s: alarm_minutes must be 0..%d" % (where, MAX_ALARM_MINUTES))
    return "-PT%dH" % (minutes // 60) if minutes and minutes % 60 == 0 else "-PT%dM" % minutes


def when(prop, value, name, utc):
    """DTSTART, DTEND or EXDATE: a DATE, a UTC time with Z, or a wall-clock time with TZID."""
    if not isinstance(value, dt.datetime):
        return "%s;VALUE=DATE:%s" % (prop, stamp(value))
    if utc:
        return "%s:%s" % (prop, value.strftime("%Y%m%dT%H%M%SZ"))
    return "%s;TZID=%s:%s" % (prop, name, stamp(value))


def read_spec(path):
    need_file(path)
    try:
        with open(path, encoding="utf-8-sig") as handle:
            spec = json.load(handle)
    except (OSError, ValueError) as error:
        raise KitError("bad_spec", "SPEC.json: %s" % error, SPEC_HINT)
    events = spec.get("events") if isinstance(spec, dict) else None
    if not isinstance(events, list) or not events or len(events) > MAX_EVENTS:
        raise KitError("bad_spec", "SPEC.json needs 1-%d events" % MAX_EVENTS, SPEC_HINT)
    return spec, events


def write(argv):
    p = parser("ics write")
    p.add_argument("spec")
    p.add_argument("-o", "--out", required=True)
    args = p.parse_args(argv)
    if not args.out.lower().endswith(".ics"):
        raise KitError("bad_output", "the output must be .ics", "phones open a calendar file by its .ics name")
    spec, events = read_spec(args.spec)
    out_path(args.out, args.spec)
    warnings = []
    unknown = sorted(set(spec) - set(SPEC_KEYS))
    if unknown:
        warnings.append("unknown keys ignored: " + ", ".join(unknown))
    name = str(spec.get("tz") or "Europe/Moscow").strip()
    utc = name.upper() in ("UTC", "Z")
    try:
        zone = dt.timezone.utc if utc else ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise KitError("bad_spec", "unknown tz %r" % name, "an IANA name like Europe/Moscow, or UTC")
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    body, series, years, seen = [], {}, set(), {}
    for n, event in enumerate(events, 1):
        if not isinstance(event, dict) or not str(event.get("summary") or "").strip():
            raise KitError("bad_spec", "event %d needs a summary" % n, SPEC_HINT)
        summary = str(event["summary"]).strip()
        label = "event %d (%s)" % (n, summary)
        unknown = sorted(set(event) - set(EVENT_KEYS))
        if unknown:
            warnings.append("%s: unknown keys ignored: %s" % (label, ", ".join(unknown)))
        start = moment(event.get("start"), label + " start", zone)
        timed = isinstance(start, dt.datetime)
        if event.get("end") is not None:
            end = moment(event["end"], label + " end", zone)
            if not timed and not isinstance(end, dt.datetime):
                end += dt.timedelta(days=1)  # the last day, inclusive
        elif event.get("minutes") is not None and timed:
            try:
                end = start + dt.timedelta(minutes=int(event["minutes"]))
            except (TypeError, ValueError):
                raise KitError("bad_spec", "%s: minutes must be a whole number" % label, SPEC_HINT)
        else:
            end = None if timed else start + dt.timedelta(days=1)
        if end is None or isinstance(end, dt.datetime) != timed or end <= start:
            raise KitError(
                "bad_spec",
                "%s: end (or minutes) must be after start, both with or both without a time" % label,
                SPEC_HINT,
            )
        key = (summary, start)
        copies = seen.get(key, [])
        if copies:
            warnings.append("%s repeats event %d: the same title and start" % (label, copies[0]))
        seen[key] = copies + [n]
        digest = hashlib.sha1(("%s|%s" % (summary, start.isoformat())).encode("utf-8")).hexdigest()[:20]
        uid = digest + ("-%d" % len(copies) if copies else "")
        body += [
            "BEGIN:VEVENT",
            "UID:%s@brokit" % uid,
            "DTSTAMP:" + now,
            when("DTSTART", start, name, utc),
            when("DTEND", end, name, utc),
            "SUMMARY:" + text(summary),
        ]
        for field, prop in (("location", "LOCATION"), ("description", "DESCRIPTION")):
            if str(event.get(field) or "").strip():
                body.append(prop + ":" + text(str(event[field]).strip()))
        exdates = event.get("exdates") or []
        if not isinstance(exdates, list):
            exdates = [exdates]
        # An exdate of the kind DTSTART has: a day of a timed event at its time,
        # a time of an all-day event as its day.
        exdates = [moment(e, label + " exdates", zone) for e in exdates]
        exdates = [
            dt.datetime.combine(e, start.time()) if timed and not isinstance(e, dt.datetime) else e for e in exdates
        ]
        exdates = sorted({e.date() if not timed and isinstance(e, dt.datetime) else e for e in exdates})
        starts, open_ended = [start], False
        if str(event.get("rrule") or "").strip():
            where = label + " rrule"
            parts = parse_rule(event["rrule"], where)
            until = rule_until(parts, start, zone, where)
            open_ended = until is None and "COUNT" not in parts
            horizon = dt.datetime(start.year + OPEN_ENDED_YEARS, 12, 31, 23, 59) if open_ended else None
            if open_ended:
                warnings.append("%s: the rrule has neither UNTIL nor COUNT, it repeats forever" % label)
            body.append("RRULE:" + rule_line(parts, until, zone, utc))
            body.extend(when("EXDATE", e, name, utc) for e in exdates)
            starts = expand(parts, start, until, where, horizon)
            if not starts:
                warnings.append("%s: the rrule makes no occurrences (UNTIL before the start?)" % label)
            elif starts[0] != start:
                warnings.append(
                    "%s: start %s is not on its own rrule, calendars disagree on it; start on the first occurrence (%s)"
                    % (label, start.isoformat(), starts[0].isoformat())
                )
            known = set(starts)
            for e in exdates:
                # Past the horizon of a rule without an end nothing is known.
                if e not in known and starts and (not open_ended or e <= starts[-1]):
                    warnings.append(
                        "%s: exdate %s is no occurrence of its rrule (another day or time?), it removes nothing"
                        % (label, e.isoformat())
                    )
            excluded = set(exdates)
            starts = [s for s in starts if s not in excluded]
        elif exdates:
            warnings.append("%s: exdates without an rrule are ignored" % label)
        minutes = event["alarm_minutes"] if "alarm_minutes" in event else spec.get("alarm_minutes")
        if minutes is not None:
            body += [
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                "TRIGGER:" + alarm_trigger(minutes, label),
                "DESCRIPTION:" + text(summary),
                "END:VALARM",
            ]
        body.append("END:VEVENT")
        years.update({start.year, end.year}, (s.year for s in starts), (e.year for e in exdates))
        if open_ended:
            years.add(start.year + OPEN_ENDED_YEARS)
        length = int((end - start).total_seconds() // 60) if timed else None
        if open_ended and starts:
            # A rule without an end is shown by its first week only.
            starts = [s for s in starts if s < starts[0] + dt.timedelta(days=7)]
        for begin in starts:
            group = (
                summary,
                begin.weekday(),
                begin.strftime("%H:%M") if timed else "весь день",
                (begin + (end - start)).strftime("%H:%M") if timed else "",
                length,
            )
            entry = series.setdefault(group, {"count": 0, "first": None, "last": None, "open_ended": False})
            entry["open_ended"] = entry["open_ended"] or open_ended
            entry["count"] += 1
            day = begin.date() if isinstance(begin, dt.datetime) else begin
            entry["first"] = min(entry["first"] or day, day)
            entry["last"] = max(entry["last"] or day, day)
    head = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bro//brokit//RU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"]
    if str(spec.get("name") or "").strip():
        head.append("X-WR-CALNAME:" + text(str(spec["name"]).strip()))
    if not utc:
        head += ["X-WR-TIMEZONE:" + name] + vtimezone(name, zone, min(years), max(years))
    data = "".join(fold(line) + "\r\n" for line in head + body + ["END:VCALENDAR"]).encode("utf-8")
    with open(args.out, "wb") as handle:
        handle.write(data)
    listed = [
        {
            "summary": summary,
            "weekday": WEEKDAYS[weekday],
            "time": begin + ("–" + finish if finish else ""),
            "minutes": length,
            "count": entry["count"],
            "first": entry["first"].isoformat(),
            "last": entry["last"].isoformat(),
            **({"open_ended": True} if entry["open_ended"] else {}),
        }
        for (summary, weekday, begin, finish, length), entry in sorted(
            series.items(), key=lambda item: (item[0][1], item[0][2], item[0][0])
        )
    ]
    return {
        "output": args.out,
        "events": len(events),
        "occurrences": sum(item["count"] for item in listed),
        "bytes": len(data),
        "series": listed,
        "warnings": warnings,
    }
