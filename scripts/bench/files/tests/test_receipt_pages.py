"""Receipt pages (f-receipts): a summary page in front of the receipts is named once, by the page count, not again by
the orientation and the order; a page like no receipt in the middle is a receipt too crooked to know."""

import io
import json
import pathlib
import shutil
import tempfile
import unittest

from check import evaluate
from tests.runs import make_run
from tests.samples import context, pdf

CASE = {"id": "f-test", "turns": [], "fixtures": []}


def receipt(seed: int):
    """A receipt-like picture: dark lines of text at widths of the seed's own."""
    import random

    from PIL import Image, ImageDraw

    rng = random.Random(seed)
    img = Image.new("L", (200, 420), 255)
    draw = ImageDraw.Draw(img)
    for y in range(12, 408, 14):
        draw.rectangle([10, y, 10 + rng.randint(30, 180), y + 6], fill=rng.randint(0, 90))
    return img


def pages(*parts) -> bytes:
    """One PDF of single-page PDFs."""
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter()
    for part in parts:
        writer.append(PdfReader(io.BytesIO(part)))
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def receipt_page(img) -> bytes:
    return pdf([(img, [100, 100, 400, 730])])


SUMMARY = pdf(texts=[(60, 780, "Avansovyi otchet"), (60, 760, "1  12.10  Taxi  1250,00"),
                     (60, 745, "2  12.10  Hotel  9800,00"), (60, 730, "Itogo  11050,00")])


@unittest.skipUnless(shutil.which("pdftoppm"), "needs poppler")
class ReceiptPagesTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        truth = self.root / "fixtures" / "truth"
        truth.mkdir(parents=True)
        self.receipts = [receipt(n) for n in (1, 2, 3)]
        for n, img in enumerate(self.receipts, start=1):
            img.save(truth / f"chek_{n}.png")
        doc = {"receipts": [{"n": n, "template": f"chek_{n}.png"} for n in (1, 2, 3)]}
        (truth / "chek_receipts.json").write_text(json.dumps(doc))

    def outcomes(self, data: bytes) -> dict:
        case_dir = make_run(self.root / "out", "f-test", files=[(0, data, "cheki.pdf")])
        ctx = context(CASE, case_dir, self.root / "fixtures")
        items = {"upright": {"kind": "pdf_pages_upright", "params": {}},
                 "order": {"kind": "pdf_page_order", "params": {"expected_receipts": [1, 2, 3]}}}
        try:
            return {key: evaluate(ctx, item)[0] for key, item in items.items()}
        finally:
            ctx.cleanup()

    def test_a_summary_in_front_is_no_receipt(self):
        got = self.outcomes(pages(SUMMARY, *(receipt_page(img) for img in self.receipts)))
        self.assertEqual(got["upright"].status, "pass", got["upright"].detail)
        self.assertIn("не чек: стр. 1", got["upright"].detail)
        self.assertEqual(got["order"].status, "pass", got["order"].detail)

    def test_a_page_like_no_receipt_in_the_middle_fails(self):
        first, second, third = (receipt_page(img) for img in self.receipts)
        got = self.outcomes(pages(first, SUMMARY, second, third))
        self.assertEqual(got["upright"].status, "fail")
        self.assertIn("стр. 2", got["upright"].detail)


if __name__ == "__main__":
    unittest.main()
