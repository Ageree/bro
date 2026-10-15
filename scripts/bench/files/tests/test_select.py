"""Which received files a check reads: latest version, negatives over every turn, previews, lost downloads."""

import pathlib
import shutil
import sys
import tempfile
import unittest

from checks import REGISTRY
from tests.runs import make_run
from tests.samples import context, cutout, pdf, png_bytes

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import check  # noqa: E402

CASE = {"id": "f-test", "turns": [], "fixtures": [], "signature_truth": "podpis_test"}


def one_page(text):
    return pdf(texts=[(60, 700, text)])


def two_pages():
    from pypdf import PdfReader, PdfWriter
    import io

    w = PdfWriter()
    for _ in range(2):
        w.add_page(PdfReader(io.BytesIO(one_page("page"))).pages[0])
    b = io.BytesIO()
    w.write(b)
    return b.getvalue()


class SelectTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)

    def run_check(self, item, **run):
        case_dir = make_run(self.root / "out", "f-test", **run)
        ctx = context(CASE, case_dir, self.root / "fixtures")
        try:
            outcome, file = check.evaluate(ctx, item)
        finally:
            ctx.cleanup()
        return outcome, file

    def test_positive_kinds_read_the_latest_turn(self):
        files = [(0, one_page("draft"), "a.pdf"), (1, two_pages(), "b.pdf")]
        outcome, file = self.run_check({"kind": "pdf_page_count", "params": {"equals": 2}}, files=files)
        self.assertEqual(outcome.status, "pass")
        self.assertIn("1-2-", file)
        outcome, _ = self.run_check({"kind": "pdf_page_count", "params": {"equals": 2, "turn": 0}}, files=files)
        self.assertEqual(outcome.status, "fail")

    def test_negative_kinds_read_every_turn(self):
        stamped = pdf([(cutout(101, "С"), [60, 40, 250, 60])])
        files = [(0, stamped, "a.pdf"), (1, one_page("clean"), "b.pdf")]
        item = {"kind": "pdf_no_image_in_bbox", "params": {"rects": [[60, 40, 250, 60]]}}
        outcome, _ = self.run_check(item, files=files)
        self.assertEqual(outcome.status, "fail")

    def test_previews_are_left_out_of_other_kinds(self):
        preview = png_bytes(cutout(101, "С"))
        files = [(0, preview, "Подпись (образец).png")]
        outcome, _ = self.run_check({"kind": "image_aspect", "params": {"ratio": 1.0, "tol": 10}}, files=files)
        self.assertEqual((outcome.status, outcome.detail), ("fail", "нет файла"))
        counted, _ = self.run_check({"kind": "file_count", "params": {"name_regex": "^Подпись \\(образец\\)\\.png$", "min": 1}},
                                    files=files)
        self.assertEqual(counted.status, "pass")

    def test_a_lost_download_is_an_error_not_a_fail(self):
        outcome, _ = self.run_check({"kind": "pdf_page_count", "params": {"equals": 1}},
                                    failed=[(0, "/eve/v1/sandbox-files/x/a.pdf")])
        self.assertEqual((outcome.status, outcome.detail), ("error", "файл не скачан"))
        clean, _ = self.run_check({"kind": "pdf_no_image_in_bbox", "params": {"rects": [[0, 0, 10, 10]]}},
                                  failed=[(0, "/eve/v1/sandbox-files/x/a.pdf")])
        self.assertEqual(clean.status, "error")

    def test_the_combined_file_is_the_matching_pdf_with_most_pages(self):
        files = [(0, two_pages(), "Виза_все.pdf"), (0, one_page("p"), "Виза_01_Анкета.pdf")]
        item = {"kind": "pdf_page_count", "params": {"file_regex": "(?i)виза", "pick": "most_pages", "equals": 2}}
        outcome, _ = self.run_check(item, files=files)
        self.assertEqual(outcome.status, "pass")

    def test_a_copy_still_under_its_password_fails_pdf_unencrypted(self):
        import io

        from pypdf import PdfReader, PdfWriter

        w = PdfWriter(clone_from=PdfReader(io.BytesIO(one_page("buklet"))))
        w.encrypt("1234", algorithm="RC4-128")
        locked = io.BytesIO()
        w.write(locked)
        outcome, _ = self.run_check({"kind": "pdf_unencrypted", "params": {"pages": 1}},
                                    files=[(0, locked.getvalue(), "buklet.pdf")])
        self.assertEqual((outcome.status, outcome.detail), ("fail", "PDF зашифрован"))

    def test_an_unknown_kind_is_manual(self):
        outcome, _ = self.run_check({"kind": "no_such_kind", "params": {}})
        self.assertEqual(outcome.status, "manual")
        self.assertNotIn("no_such_kind", REGISTRY)


if __name__ == "__main__":
    unittest.main()
