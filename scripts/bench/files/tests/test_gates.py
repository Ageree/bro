"""Gate patterns: the portable subset Python `re` and the driver's JavaScript `u` regexes read the same way (a bare `$`
is refused: Python's also matches before a final newline); `consent_asked` reads the driver's gate records."""

import json
import pathlib
import re
import shutil
import tempfile
import unittest

from check import evaluate
from checks.behavior import gate_matches, portable_gate
from tests.runs import make_run
from tests.samples import context

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
        for pattern in ("\\w+", "подпис\\w*\\?", "\\d{3}", "\\bда\\b", "(?P<x>да)", "да(?#note)", "да(?i)нет", "(?<name>да)",
                        "Подписываю\\?$"):
            with self.subTest(pattern=pattern), self.assertRaises(ValueError):
                portable_gate(pattern)

    def test_escaped_backslash_and_classes_are_allowed(self):
        for pattern in ("\\\\w", "[(?]да", "(?:да|нет)", "да(?=,)", "(?<!не )да", "[$]", "Подписываю\\?\\s*$"):
            with self.subTest(pattern=pattern):
                portable_gate(pattern)


class ConsentAskedTest(unittest.TestCase):
    def test_the_latest_verdict_of_a_gate_counts(self):
        root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        case_dir = make_run(root / "out", "f-test", gates=[(1, False, None), (1, True, "Подписываю?")])
        ctx = context({"id": "f-test", "turns": [], "fixtures": []}, case_dir, root / "fixtures")
        item = {"kind": "consent_asked", "params": {"turn": 1, "pattern": "(?i)подписываю\\?\\s*$"}}
        self.assertEqual(evaluate(ctx, item)[0].status, "pass")


if __name__ == "__main__":
    unittest.main()
