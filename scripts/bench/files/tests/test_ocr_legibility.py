"""OCR legibility of a scan: a page flattened from a photo by a homography passes; the same photo flattened by a
bilinear «quad» map reads as well but its words are off their places; a blurred scan loses its words."""

import io
import pathlib
import shutil
import subprocess
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageFilter

from check import evaluate
from tests.runs import make_run
from tests.samples import context

WORDS = ("garden window river mountain silver orange basket candle forest harbor jacket kettle ladder marble "
         "needle pencil rabbit saddle ticket velvet wagon yellow anchor bridge castle desert engine falcon guitar "
         "hammer island jungle kitten lemon meadow napkin oyster parrot quiver rocket summer tunnel umbrella violin "
         "walnut zipper blanket cactus dolphin eagle feather glacier helmet iceberg jigsaw kingdom lantern magnet "
         "nectar orchid pepper puzzle quartz ribbon sapphire thunder unicorn vortex whistle yogurt zebra almond breeze "
         "copper dragon emerald fountain granite horizon insect journal kayak lagoon mirror nugget olive pirate "
         "rainbow scarlet tomato vintage willow cobalt bamboo canyon dinner elbow fabric goblet hollow ivory jasmine "
         "keyboard lizard mitten noodle otter pillow quilt raven spider teapot turtle valley wizard beacon cherry "
         "daisy ember frost grape honey").split()
# The page's corners TL, TR, BR, BL in a 1400×1900 «photo»: turned and keystoned, as on a phone shot (the bilinear map
# puts the words 2.7 mm off, the homography 0.1 mm).
QUAD = [(300, 120), (1150, 380), (1200, 1500), (150, 1800)]
PARAMS = {"references": ["page1.png"], "ref_dpi": 150, "dpi": 150, "psm": 4, "lang": "eng", "min_len": 4,
          "min_recall": 0.9, "max_shift_mm": 0.5}


def perspective(src, dst):
    """Image.PERSPECTIVE coefficients that take an output point in `dst` to its input point in `src`."""
    rows, rhs = [], []
    for (x, y), (u, v) in zip(dst, src):
        rows += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        rhs += [u, v]
    return np.linalg.solve(np.array(rows, float), np.array(rhs, float)).tolist()


def as_pdf(img) -> bytes:
    out = io.BytesIO()
    img.save(out, "PDF", resolution=150)
    return out.getvalue()


@unittest.skipUnless(shutil.which("tesseract") and shutil.which("pdftoppm"), "needs tesseract and poppler")
class OcrLegibilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from reportlab.lib.pagesizes import A5
        from reportlab.pdfgen import canvas

        cls.root = pathlib.Path(tempfile.mkdtemp())
        truth = cls.root / "fixtures" / "truth"
        truth.mkdir(parents=True)
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=A5, invariant=1)
        c.setFont("Helvetica", 11)
        for n in range(0, len(WORDS), 7):
            c.drawString(40, A5[1] - 60 - n // 7 * 24, " ".join(WORDS[n:n + 7]))
        c.save()
        (cls.root / "page.pdf").write_bytes(buf.getvalue())
        subprocess.run(["pdftoppm", "-r", "150", "-gray", "-png", "-singlefile", str(cls.root / "page.pdf"),
                        str(truth / "page1")], check=True)
        with Image.open(truth / "page1.png") as im:
            page = im.convert("L")
        w, h = page.size
        corners = [(0, 0), (w, 0), (w, h), (0, h)]
        photo = page.transform((1400, 1900), Image.PERSPECTIVE, perspective(corners, QUAD), Image.BICUBIC, fillcolor=90)
        tl, tr, br, bl = QUAD
        cls.flat = photo.transform((w, h), Image.PERSPECTIVE, perspective(QUAD, corners), Image.BICUBIC, fillcolor=255)
        cls.bilinear = photo.transform((w, h), Image.QUAD, (*tl, *bl, *br, *tr), Image.BICUBIC, fillcolor=255)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.root, ignore_errors=True)

    def score(self, img):
        case_dir = make_run(self.root / "out", "f-test", files=[(0, as_pdf(img), "scan.pdf")])
        ctx = context({"id": "f-test", "turns": [], "fixtures": []}, case_dir, self.root / "fixtures")
        try:
            return evaluate(ctx, {"kind": "ocr_legibility", "params": PARAMS})[0]
        finally:
            ctx.cleanup()

    def test_a_page_flattened_by_a_homography_passes(self):
        outcome = self.score(self.flat)
        self.assertEqual(outcome.status, "pass", outcome.detail)

    def test_a_bilinear_quad_flattening_reads_but_its_words_are_off_their_places(self):
        outcome = self.score(self.bilinear)
        self.assertEqual(outcome.status, "fail", outcome.detail)
        self.assertIn("мм от места >", outcome.detail)
        self.assertNotIn("% <", outcome.detail)

    def test_a_blurred_scan_loses_its_words(self):
        outcome = self.score(self.flat.filter(ImageFilter.GaussianBlur(3)))
        self.assertEqual(outcome.status, "fail", outcome.detail)
        self.assertIn("% <", outcome.detail)


if __name__ == "__main__":
    unittest.main()
