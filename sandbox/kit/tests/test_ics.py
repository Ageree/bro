"""brokit ics write: a calendar file phones import (RFC 5545)."""

import json
import os
import re
import tempfile
import unittest

from tests.cli_run import kit

LONG_NOTE = "Взять: шапочку, очки; полотенце\nи тапочки. " * 6


def unfold(raw):
    return re.sub(r"\r\n[ \t]", "", raw.decode("utf-8")).split("\r\n")


def unescape(value):
    return re.sub(r"\\([\\;,nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value)


def props(lines, name):
    return [line for line in lines if re.match(name + r"[;:]", line)]


class IcsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.dir.cleanup()

    def write(self, spec, out="out.ics"):
        path = os.path.join(self.dir.name, "spec.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(spec, handle, ensure_ascii=False)
        out = os.path.join(self.dir.name, out)
        code, result = kit("ics", "write", path, "-o", out)
        if code != 0:
            return code, result, None
        with open(out, "rb") as handle:
            return code, result, handle.read()

    def test_lines_are_crlf_folded_on_characters_and_text_escaped(self):
        code, result, raw = self.write(
            {"events": [{"summary": "Лёва: плавание, 25 м", "start": "2026-10-19T17:00", "minutes": 60, "description": LONG_NOTE}]}
        )
        self.assertEqual(code, 0, result)
        self.assertEqual(result["bytes"], len(raw))
        self.assertEqual(raw.count(b"\n"), raw.count(b"\r\n"))
        for line in raw.split(b"\r\n"):
            self.assertLessEqual(len(line), 75)
            line.decode("utf-8")  # no letter is cut in two by the folding
        lines = unfold(raw)
        self.assertEqual(unescape(props(lines, "DESCRIPTION")[0].split(":", 1)[1]), LONG_NOTE.strip())
        self.assertEqual(props(lines, "SUMMARY"), ["SUMMARY:Лёва: плавание\\, 25 м"])

    def test_weekly_rule_with_exdates_alarm_and_moscow_time(self):
        spec = {
            "name": "Секции Лёвы",
            "alarm_minutes": 60,
            "events": [
                {
                    "summary": "Плавание",
                    "start": "2026-10-19T17:00",
                    "end": "2026-10-19T18:00",
                    "location": "Бассейн «Образец», ул. Примерная, 10",
                    "rrule": "FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=2026-12-31",
                    # A day alone means the event's own time on it.
                    "exdates": ["2026-11-04T17:00", "2026-10-28"],
                }
            ],
        }
        code, result, raw = self.write(spec)
        self.assertEqual(code, 0, result)
        lines = unfold(raw)
        self.assertIn("TZID:Europe/Moscow", lines)
        self.assertEqual(props(lines, "DTSTART")[-1], "DTSTART;TZID=Europe/Moscow:20261019T170000")
        # UNTIL beside a TZID start is UTC: the end of 31.12 in Moscow.
        self.assertEqual(props(lines, "RRULE"), ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T205959Z"])
        self.assertEqual(
            props(lines, "EXDATE"),
            ["EXDATE;TZID=Europe/Moscow:20261028T170000", "EXDATE;TZID=Europe/Moscow:20261104T170000"],
        )
        self.assertEqual(props(lines, "TRIGGER"), ["TRIGGER:-PT1H"])
        series = {item["weekday"]: (item["count"], item["first"], item["last"]) for item in result["series"]}
        self.assertEqual(series, {"Пн": (11, "2026-10-19", "2026-12-28"), "Ср": (9, "2026-10-21", "2026-12-30")})
        self.assertEqual((result["events"], result["occurrences"], result["warnings"]), (1, 20, []))

    def test_slips_are_warned(self):
        spec = {
            "events": [
                {
                    "summary": "Шахматы",
                    "start": "2026-10-20T16:00",
                    "minutes": 90,
                    "rrule": "FREQ=WEEKLY;COUNT=5",
                    "exdates": ["2026-10-27T17:00"],
                    "place": "ДДТ",
                },
                {"summary": "Шахматы", "start": "2026-10-20T16:00", "minutes": 90},
            ]
        }
        code, result, raw = self.write(spec)
        self.assertEqual(code, 0, result)
        warnings = " | ".join(result["warnings"])
        self.assertIn("exdate 2026-10-27T17:00", warnings)  # 16:00 is the lesson, 17:00 removes nothing
        self.assertIn("unknown keys ignored: place", warnings)
        self.assertIn("repeats event 1", warnings)
        # A copy still gets a UID of its own, and the UIDs stay put on the next run.
        uids = props(unfold(raw), "UID")
        self.assertEqual(len(set(uids)), 2)
        self.assertEqual(props(unfold(self.write(spec, "again.ics")[2]), "UID"), uids)

    def test_utc_all_day_and_daylight_zones(self):
        code, result, raw = self.write(
            {"tz": "UTC", "events": [{"summary": "Созвон", "start": "2026-10-19T17:00+03:00", "minutes": 30, "rrule": "FREQ=DAILY;UNTIL=2026-10-21"}]}
        )
        self.assertEqual(code, 0, result)
        lines = unfold(raw)
        self.assertEqual(props(lines, "DTSTART"), ["DTSTART:20261019T140000Z"])
        self.assertEqual(props(lines, "RRULE"), ["RRULE:FREQ=DAILY;UNTIL=20261021T235959Z"])
        self.assertEqual(props(lines, "TZID"), [])
        self.assertEqual(result["occurrences"], 3)

        code, result, raw = self.write({"events": [{"summary": "Каникулы", "start": "2026-11-04", "end": "2026-11-05"}]})
        self.assertEqual(code, 0, result)
        lines = unfold(raw)
        self.assertEqual(props(lines, "DTSTART")[-1], "DTSTART;VALUE=DATE:20261104")
        self.assertEqual(props(lines, "DTEND"), ["DTEND;VALUE=DATE:20261106"])

        code, result, raw = self.write(
            {"tz": "Europe/Berlin", "events": [{"summary": "Встреча", "start": "2026-03-20T10:00", "minutes": 60}]}
        )
        self.assertEqual(code, 0, result)
        text = raw.decode("utf-8")
        self.assertIn("BEGIN:DAYLIGHT\r\nDTSTART:20260329T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200", text)

    def test_bad_specs_are_refused(self):
        refused = [
            {"events": [{"summary": "x", "start": "2026-10-19T17:00", "end": "2026-10-19T16:00"}]},
            {"events": [{"summary": "x", "start": "2026-10-19T17:00"}]},
            {"tz": "MSK", "events": [{"summary": "x", "start": "2026-10-19T17:00", "minutes": 60}]},
            {"events": [{"summary": "x", "start": "2026-10-19T17:00", "minutes": 60, "rrule": "FREQ=WEEKLY;COUNT=3;UNTIL=2026-12-31"}]},
            {"events": [{"summary": "x", "start": "19.10.2026 17:00", "minutes": 60}]},
        ]
        for spec in refused:
            code, result, _ = self.write(spec)
            self.assertEqual((code, result["code"]), (2, "bad_spec"), spec)
        code, result, _ = self.write({"events": [{"summary": "x", "start": "2026-10-19", "end": "2026-10-19"}]}, "out.txt")
        self.assertEqual((code, result["code"]), (2, "bad_output"))


if __name__ == "__main__":
    unittest.main()
