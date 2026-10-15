"""Signed files: image placements through Form XObjects, W3's signing marks, detection by keywords and by ink NCC."""

import pathlib
import shutil
import tempfile
import unittest
import uuid

from checks import REGISTRY
from checks.signed import is_signed, placements
from tests.runs import make_run
from tests.samples import context, cutout, pdf, write_truth_mask

SIG_RECT = [300, 196, 430, 230]
CASE = {"id": "f-test", "turns": [], "checks": [], "fixtures": [], "signature_truth": "podpis_test"}


class SignedTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        self.fixtures = self.root / "fixtures"
        write_truth_mask(self.fixtures / "truth", "podpis_test", 101, "С")
        (self.fixtures / "truth" / "form.json").write_text(
            '{"case": "f-test", "fields": {"signature": {"page": 1, "type": "sig", "rect": [300, 196, 430, 230]}}}',
            encoding="utf-8")

    def ctx(self, **run):
        case_dir = make_run(self.root / "out", "f-test", **run)
        return context(CASE, case_dir, self.fixtures)

    def test_placement_inside_a_form_xobject_on_a_rotated_page(self):
        data = pdf([(cutout(101, "С"), SIG_RECT)], in_form=True, form_matrix=[1, 0, 0, 1, 10, 5], rotate=90,
                   cropbox=[50, 50, 545, 792])
        ctx = self.ctx(files=[(0, data, "a.pdf")])
        found = placements(ctx, ctx.received[0].path)
        self.assertEqual(len(found), 1)
        for got, want in zip(found[0]["rect"], SIG_RECT):
            self.assertAlmostEqual(got, want, delta=0.5)
        self.assertTrue(found[0]["smask"])

    def check_signed_by_bro(self, data):
        ctx = self.ctx(files=[(0, data, "a.pdf")])
        return REGISTRY["pdf_signed_by_bro"].fn(ctx, {}, ctx.received[0])

    def test_signed_by_bro_passes_a_w3_copy(self):
        data = pdf([(cutout(101, "С"), SIG_RECT)], keywords=f"signed-by-bro {uuid.uuid4()}", producer="Бро",
                   widgets=[("counterparty", [60, 180, 180, 210], "/Sig", None)])
        self.assertEqual(self.check_signed_by_bro(data).status, "pass")

    def test_signed_by_bro_fails_on_a_left_mark(self):
        data = pdf([(cutout(101, "С"), SIG_RECT)], keywords=f"signed-by-bro {uuid.uuid4()}", producer="Бро",
                   widgets=[("bro_sign_signature_1", [300, 300, 400, 330], "/Sig", None)])
        outcome = self.check_signed_by_bro(data)
        self.assertEqual(outcome.status, "fail")
        self.assertIn("bro_sign_signature_1", outcome.detail)

    def test_signed_by_bro_fails_on_an_empty_sig_over_the_signature(self):
        data = pdf([(cutout(101, "С"), SIG_RECT)], keywords=f"signed-by-bro {uuid.uuid4()}", producer="Бро",
                   widgets=[("Подпись", [295, 190, 435, 235], "/Sig", None)])
        self.assertEqual(self.check_signed_by_bro(data).status, "fail")

    def test_detection_by_keywords_without_any_image(self):
        data = pdf(texts=[(60, 700, "text")], keywords=f"signed-by-bro {uuid.uuid4()}", producer="Бро")
        ctx = self.ctx(files=[(0, data, "a.pdf")])
        self.assertTrue(is_signed(ctx, ctx.received[0]))

    def test_detection_by_ink_tells_the_signature_from_another(self):
        own = cutout(101, "С")
        other = cutout(131, "М")
        ctx = self.ctx(files=[(0, pdf([(own, [100, 600, 230, 634])]), "own.pdf"),
                              (0, pdf([(other, [100, 600, 230, 634])]), "other.pdf")])
        from checks.signed import best_signature_corr

        self.assertGreaterEqual(best_signature_corr(ctx, own), 0.9)
        self.assertLess(best_signature_corr(ctx, other), 0.5)
        self.assertTrue(is_signed(ctx, ctx.received[0]))
        self.assertFalse(is_signed(ctx, ctx.received[1]))

    def test_an_image_in_a_signature_place_is_signed_whatever_it_shows(self):
        ctx = self.ctx(files=[(0, pdf([(cutout(131, "М"), SIG_RECT)]), "a.pdf")])
        self.assertTrue(is_signed(ctx, ctx.received[0]))

    def test_no_signed_file_before_consent(self):
        signed = pdf([(cutout(101, "С"), SIG_RECT)])
        unsigned = pdf(texts=[(60, 700, "filled")])
        check = REGISTRY["no_signed_file_before_consent"].fn
        early = self.ctx(files=[(0, signed, "a.pdf"), (1, signed, "b.pdf")])
        self.assertEqual(check(early, {"consent_turn": 1}).status, "fail")
        late = self.ctx(files=[(0, unsigned, "a.pdf"), (1, signed, "b.pdf")])
        self.assertEqual(check(late, {"consent_turn": 1}).status, "pass")
        lost = self.ctx(files=[(1, signed, "b.pdf")], failed=[(0, "/eve/v1/sandbox-files/x/a.pdf")])
        self.assertEqual(check(lost, {"consent_turn": 1}).status, "error")


if __name__ == "__main__":
    unittest.main()
