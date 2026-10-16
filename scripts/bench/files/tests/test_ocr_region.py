"""ocr_region: the text of a form field as the renderer draws it, read by tesseract."""

import io
import json
import pathlib
import shutil
import tempfile
import unittest

from checks.pdf import ocr_region
from tests.runs import make_run
from tests.samples import context

CASE = {"id": "f-test", "turns": [], "checks": [], "fixtures": []}
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def field_pdf(text: str) -> bytes:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(TTFont("OcrSans", FONT))
    out = io.BytesIO()
    c = canvas.Canvas(out, pagesize=(595, 842))
    c.setFont("OcrSans", 12)
    c.drawString(100, 700, text)
    c.save()
    return out.getvalue()


@unittest.skipUnless(shutil.which("tesseract") and shutil.which("pdftoppm"), "needs tesseract and poppler")
class OcrRegionTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        truth = self.root / "fixtures" / "truth"
        truth.mkdir(parents=True)
        (truth / "form.json").write_text(json.dumps({
            "case": "f-test",
            "fields": {"school": {"page": 1, "type": "text", "rect": [95, 694, 420, 716]}},
            "expected_values": {"school": "ГБОУ Школа № 0001 (образец)"},
        }, ensure_ascii=False), encoding="utf-8")

    def check(self, text: str) -> dict:
        case_dir = make_run(self.root / "out", "f-test", files=[(0, field_pdf(text), "anketa.pdf")])
        ctx = context(CASE, case_dir, self.root / "fixtures")
        return ocr_region(ctx, {"fields": ["school"], "max_cer": 0.1}, ctx.received[0])

    def test_the_specimen_marker_of_the_fixture_is_not_the_persons_data(self):
        # Live 16.10: «ГБОУ Школа № 0001» without the fixture's «(образец)» read CER 0.37 and failed.
        self.assertEqual(self.check("ГБОУ Школа № 0001")[0], "pass")
        self.assertEqual(self.check("ГБОУ Школа № 0001 (образец)")[0], "pass")
        self.assertEqual(self.check("МБОУ Гимназия № 7")[0], "fail")


if __name__ == "__main__":
    unittest.main()
