"""The suite file: built from build_cases.py, every check kind answered by the checker, generators deterministic."""

import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

from checks import MANUAL_KINDS, REGISTRY

FILES = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FILES))
import build_cases  # noqa: E402
import fixtures  # noqa: E402


class SuiteTest(unittest.TestCase):
    def test_committed_cases_match_build_cases_and_validate(self):
        res = subprocess.run([sys.executable, str(FILES / "build_cases.py"), "--check"], capture_output=True, text=True,
                             timeout=300)
        self.assertEqual(res.returncode, 0, res.stderr[-2000:])

    def test_every_kind_is_registered_or_manual_with_a_reason(self):
        kinds = {c["kind"] for case in build_cases.cases for c in case["checks"]}
        for kind in sorted(kinds):
            with self.subTest(kind=kind):
                self.assertTrue(kind in REGISTRY or MANUAL_KINDS.get(kind))

    def test_validation_refuses_a_when_turn_without_a_gate(self):
        case = {"id": "f-x", "turns": [{"text": "да", "files": [], "when": "после вопроса"}], "fixtures": [],
                "checks": [], "cleanup": [], "consent_turn": None}
        errors = build_cases.validate([case])
        self.assertTrue(any("needs a `gate`" in e for e in errors))

    def test_validation_refuses_a_file_the_web_chat_does_not_accept(self):
        case = {"id": "f-x", "turns": [{"text": "вот", "files": ["a.heic"]}], "checks": [], "cleanup": [],
                "consent_turn": None, "fixtures": [{"name": "a.heic", "generator": {}}]}
        errors = build_cases.validate([case])
        self.assertTrue(any("accept list" in e for e in errors))


class DeterminismTest(unittest.TestCase):
    def test_two_builds_of_fast_generators_are_byte_identical(self):
        suite = {c["id"]: c for c in fixtures.load_suite()}
        root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        for case_id in ("f-contacts-to-vcf", "f-schedule-to-ics"):
            builds = []
            for n in (1, 2):
                out = root / f"run{n}"
                (out / "truth").mkdir(parents=True, exist_ok=True)
                builds.append(fixtures.build_case(suite[case_id], out, out / "truth", sys.executable, 600))
            with self.subTest(case=case_id):
                self.assertTrue(builds[0]["ok"], builds[0]["error"])
                self.assertTrue(builds[0]["files"])
                self.assertEqual(builds[0]["files"], builds[1]["files"])
                self.assertEqual(builds[0]["truth"], builds[1]["truth"])


if __name__ == "__main__":
    unittest.main()
