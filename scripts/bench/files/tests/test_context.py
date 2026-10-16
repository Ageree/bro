"""Run context: truth found without a manifest or through ~, dates taken from the message a file came in, cleanup turns
left out."""

import json
import pathlib
import shutil
import tempfile
import unittest

from check import evaluate
from checks.context import Context
from tests.runs import make_run
from tests.samples import pdf

CASE = {"id": "f-test", "turns": [{"text": "x", "files": ["form.pdf"]}],
        "fixtures": [{"name": "form.pdf", "generator": {}}]}


class ContextTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        self.truth = self.root / "fixtures" / "truth"
        self.truth.mkdir(parents=True)

    def context(self, **run):
        case_dir = make_run(self.root / "out", "f-test", **run)
        data = json.loads((case_dir / "files-run.json").read_text(encoding="utf-8"))
        return Context(case=CASE, run=data, case_dir=case_dir, fixtures_dir=self.root / "fixtures")

    def test_fixtures_named_from_home_find_their_truth(self):
        import os
        from unittest import mock

        (self.truth / "a.json").write_text(json.dumps({"file": "form.pdf", "fields": {"fio": {"rect": [1, 2, 3, 4]}}}))
        case_dir = make_run(self.root / "out", "f-test")
        run = json.loads((case_dir / "files-run.json").read_text(encoding="utf-8"))
        with mock.patch.dict(os.environ, {"HOME": str(self.root)}):
            ctx = Context(case=CASE, run=run, case_dir=case_dir, fixtures_dir=pathlib.Path("~/fixtures"))
        self.assertEqual(ctx.field_rect("fio"), [1, 2, 3, 4])

    def test_a_lost_download_of_the_cleanup_turn_changes_no_result(self):
        ctx = self.context(failed=[(None, "/eve/v1/sandbox-files/x/a.pdf")])
        outcome, _ = evaluate(ctx, {"kind": "pdf_no_image_in_bbox", "params": {"rects": [[0, 0, 10, 10]]}})
        self.assertEqual(outcome.status, "pass")

    def test_truth_is_found_by_case_or_input_name_without_a_manifest(self):
        (self.truth / "a.json").write_text(json.dumps({"file": "form.pdf", "fields": {"fio": {"rect": [1, 2, 3, 4]}}}))
        (self.truth / "b.json").write_text(json.dumps({"files": [{"file": "other.jpg"}], "case": "f-other"}))
        (self.truth / "c.json").write_text(json.dumps({"case": "f-test", "files": {"docx": "x.docx"}}))
        ctx = self.context()
        self.assertEqual(sorted(ctx.truth), ["a.json", "c.json"])
        self.assertEqual(ctx.field_rect("fio"), [1, 2, 3, 4])

    def test_the_date_comes_from_the_message_the_file_came_in(self):
        late = pdf(texts=[(60, 700, "16.10.2026")])
        ctx = self.context(files=[(0, late, "a.pdf", "2026-10-15T21:30:00Z")], started_at="2026-10-15T20:00:00Z")
        item = {"kind": "pdf_text_contains", "params": {"all_of": ["{today:%d.%m.%Y}"]}}
        try:
            outcome, _ = evaluate(ctx, item)
        finally:
            ctx.cleanup()
        if shutil.which("pdftotext"):
            self.assertEqual(outcome.status, "pass", outcome.detail)
        else:
            self.assertEqual(outcome.status, "error")


if __name__ == "__main__":
    unittest.main()
