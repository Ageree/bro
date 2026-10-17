"""brokit img redact: every block becomes one solid rectangle, padding included."""

import os
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw

from tests.cli_run import kit


class RedactTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.scan = os.path.join(self.dir.name, "scan.jpg")
        page = Image.new("RGB", (800, 600), (236, 230, 214))
        draw = ImageDraw.Draw(page)
        draw.rectangle((300, 200, 600, 400), outline=(90, 70, 160), width=4)
        draw.ellipse((520, 330, 660, 470), outline=(90, 70, 160), width=4)
        draw.text((320, 260), "ул. Примерная, д. 1", fill=(20, 20, 20))
        page.save(self.scan, quality=92)

    def test_blocks_come_out_solid_with_the_padding(self):
        out = os.path.join(self.dir.name, "copy.jpg")
        code, result = kit("img", "redact", self.scan, "--box", "300,200,600,400", "--box", "40,40,120,80", "--pad", "8", "-o", out)
        self.assertEqual(code, 0, result)
        self.assertEqual(result["boxes"], [[292, 192, 608, 408], [32, 32, 128, 88]])
        pixels = np.asarray(Image.open(out).convert("L"), dtype=float)
        for x0, y0, x1, y1 in result["boxes"]:
            inside = pixels[y0 + 3 : y1 - 3, x0 + 3 : x1 - 3]
            self.assertLess(inside.std(), 2)
            self.assertLess(inside.mean(), 6)
        self.assertGreater(pixels[500:560, 100:200].mean(), 180)

    def test_a_box_off_the_image_is_refused(self):
        code, result = kit("img", "redact", self.scan, "--box", "900,700,950,750", "-o", os.path.join(self.dir.name, "x.jpg"))
        self.assertEqual((code, result["code"]), (2, "bad_box"))


if __name__ == "__main__":
    unittest.main()
