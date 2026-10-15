"""Gate patterns: the portable subset Python `re` and the driver's JavaScript `u` regexes read the same way."""

import json
import pathlib
import re
import unittest

from checks.behavior import gate_matches, portable_gate

SAMPLES = json.loads((pathlib.Path(__file__).resolve().parent / "gate-samples.json").read_text(encoding="utf-8"))


class GateTest(unittest.TestCase):
    def test_every_sample_matches_as_recorded(self):
        for row in SAMPLES:
            with self.subTest(pattern=row["pattern"], text=row["text"]):
                self.assertEqual(gate_matches(row["pattern"], row["text"]), row["match"])

    def test_leading_flags_become_re_flags(self):
        flags, body = portable_gate("(?is)а.б")
        self.assertEqual(flags, re.IGNORECASE | re.DOTALL)
        self.assertEqual(body, "а.б")

    def test_non_portable_constructs_are_refused(self):
        for pattern in ("\\w+", "подпис\\w*\\?", "\\d{3}", "\\bда\\b", "(?P<x>да)", "да(?#note)", "да(?i)нет", "(?<name>да)"):
            with self.subTest(pattern=pattern), self.assertRaises(ValueError):
                portable_gate(pattern)

    def test_escaped_backslash_and_classes_are_allowed(self):
        for pattern in ("\\\\w", "[(?]да", "(?:да|нет)", "да(?=,)", "(?<!не )да"):
            with self.subTest(pattern=pattern):
                portable_gate(pattern)


if __name__ == "__main__":
    unittest.main()
