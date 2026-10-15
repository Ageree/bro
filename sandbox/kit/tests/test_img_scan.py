"""brokit img scan on synthetic phone photos of a page (W2 spec §6.10, §9)."""

import os
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw
from pypdf import PdfReader

from brokit.img.scan import homography
from tests.cli_run import kit

PAGE = (1240, 1754)
PHOTO = (1500, 2000)
CORNERS = [(325.0, 238.0), (1206.0, 325.0), (1281.0, 1638.0), (188.0, 1688.0)]


def page_image():
    """A page of justified paragraphs whose short last lines start at the left margin."""
    page = Image.new("RGB", PAGE, "white")
    draw = ImageDraw.Draw(page)
    y = 150
    for paragraph in range(9):
        for line in range(4):
            right = 1120 if line < 3 else 420 + 70 * paragraph
            left = 160 if line == 0 else 120
            draw.rectangle([left, y, right, y + 14], fill=(20, 20, 20))
            y += 34
        y += 30
    return page


def photo(path, corners, upside_down=False):
    """The page warped onto a dark table with a shadow, as a phone would see it."""
    page = page_image()
    if upside_down:
        page = page.rotate(180)
    rng = np.random.default_rng(11)
    table = np.full((PHOTO[1], PHOTO[0], 3), (110, 75, 45), np.float32) + rng.normal(0, 8, (PHOTO[1], PHOTO[0], 3))
    target = [(0, 0), (PAGE[0], 0), (PAGE[0], PAGE[1]), (0, PAGE[1])]
    # Map photo pixels to page pixels: the inverse of placing the page.
    coefficients = homography(target, corners)
    warped = page.transform(PHOTO, Image.PERSPECTIVE, coefficients, Image.BILINEAR, fillcolor=(0, 0, 0))
    inside = Image.new("L", PHOTO, 0)
    ImageDraw.Draw(inside).polygon(corners, fill=255)
    mask = np.asarray(inside, dtype=np.float32)[..., None] / 255
    pixels = np.asarray(warped, dtype=np.float32) * mask + table * (1 - mask)
    shadow = np.linspace(-40, 0, PHOTO[0], dtype=np.float32)[None, :, None]
    Image.fromarray(np.clip(pixels + shadow, 0, 255).astype(np.uint8)).save(path, quality=90)


class ImgScanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.upright = os.path.join(cls.dir.name, "IMG_1.jpg")
        cls.flipped = os.path.join(cls.dir.name, "IMG_2.jpg")
        photo(cls.upright, CORNERS)
        photo(cls.flipped, CORNERS, upside_down=True)

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def path(self, name):
        return os.path.join(self.dir.name, name)

    def test_finds_the_page_corners(self):
        code, result = kit("img", "scan", self.upright, "-o", self.path("one.png"))
        self.assertEqual(code, 0, result)
        page = result["pages"][0]
        self.assertTrue(page["auto"])
        for found, truth in zip(page["corners"], CORNERS):
            self.assertLess(abs(found[0] - truth[0]), 0.03 * PHOTO[0])
            self.assertLess(abs(found[1] - truth[1]), 0.03 * PHOTO[1])
        self.assertEqual(page["paper"], "a4")
        with Image.open(self.path("one.png")) as scan:
            width, height = scan.size
        self.assertAlmostEqual(height / width, 2**0.5, delta=0.01)

    def test_flattened_page_is_clean_and_upright(self):
        code, result = kit("img", "scan", self.upright, "-o", self.path("clean.png"), "--mode", "gray")
        self.assertEqual(code, 0, result)
        self.assertEqual(result["pages"][0]["turned"], 0)
        scan = np.asarray(Image.open(self.path("clean.png")).convert("L"), dtype=np.float32)
        h, w = scan.shape
        # The shadowed margin is paper-white after the clean-up.
        self.assertGreater(float(np.median(scan[: h // 12, : w // 6])), 235)
        # The first text line sits where the page has it (150 px of 1754 down).
        rows = np.flatnonzero((scan < 128).mean(axis=1) > 0.3)
        self.assertLess(abs(rows[0] / h - 150 / PAGE[1]), 0.02)

    def test_turns_an_upside_down_page(self):
        code, result = kit("img", "scan", self.flipped, "-o", self.path("flipped.png"))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["pages"][0]["turned"], 180)
        scan = np.asarray(Image.open(self.path("flipped.png")).convert("L"), dtype=np.float32)
        rows = np.flatnonzero((scan < 128).mean(axis=1) > 0.3)
        self.assertLess(rows[0] / scan.shape[0], 0.15)

    def test_photos_make_one_pdf_in_order(self):
        code, result = kit("img", "scan", self.upright, self.flipped, "-o", self.path("both.pdf"))
        self.assertEqual(code, 0, result)
        self.assertEqual([p["source"] for p in result["pages"]], [self.upright, self.flipped])
        reader = PdfReader(self.path("both.pdf"))
        self.assertEqual(len(reader.pages), 2)
        box = reader.pages[0].mediabox
        self.assertAlmostEqual(float(box.width) / 72 * 25.4, 210, delta=2)

    def test_given_corners_win(self):
        corners = ",".join("%d,%d" % point for point in CORNERS)
        code, result = kit("img", "scan", self.upright, "--corners", corners, "-o", self.path("given.png"))
        self.assertEqual(code, 0, result)
        self.assertFalse(result["pages"][0]["auto"])
        self.assertEqual(result["pages"][0]["corners"], [list(map(float, point)) for point in CORNERS])


if __name__ == "__main__":
    unittest.main()
