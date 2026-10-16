"""brokit img signature on synthetic phone photos (W2 spec §6.9, §9)."""

import math
import os
import random
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from brokit.img.signature import CAPTION_STRIP_PX
from tests.cli_run import kit

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
INK = (28, 42, 120)
STAMP = (200, 40, 40)
PAPER = (243, 240, 232)


def signature_points():
    points = [(380 + 22 * i, 420 - int(110 * math.sin(i / 2.2))) for i in range(40)]
    return points + [(1240, 520), (1180, 560), (400, 555)]


def ink_aspect(size, width):
    """w/h of the ink bbox as drawn, from a mask drawn with the same strokes."""
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).line(signature_points(), fill=255, width=width, joint="curve")
    ys, xs = np.nonzero(np.asarray(mask) > 127)
    return (xs.max() - xs.min() + 1) / (ys.max() - ys.min() + 1), (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)


def photo(path, stamp=True, ruled=True):
    """A phone photo: lined paper, a shadow, blue ink and a red «ОБРАЗЕЦ» stamp."""
    size = (1600, 900)
    image = Image.new("RGB", size, PAPER)
    draw = ImageDraw.Draw(image)
    if ruled:
        for y in range(40, size[1], 60):
            draw.line([(0, y), (size[0], y)], fill=(150, 175, 215), width=2)
    draw.line(signature_points(), fill=INK, width=9, joint="curve")
    if stamp:
        font = ImageFont.truetype(FONT, 64)
        draw.rectangle([1080, 700, 1520, 820], outline=STAMP, width=6)
        draw.text((1110, 715), "ОБРАЗЕЦ", font=font, fill=STAMP)
    pixels = np.asarray(image, dtype=np.float32)
    shadow = np.linspace(-25, 0, size[0], dtype=np.float32)[None, :, None]
    noise = np.random.default_rng(7).normal(0, 3, pixels.shape).astype(np.float32)
    shaded = Image.fromarray(np.clip(pixels + shadow + noise, 0, 255).astype(np.uint8))
    shaded.filter(ImageFilter.GaussianBlur(0.8)).save(path, quality=90)


class ImgSignatureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.photo = os.path.join(cls.dir.name, "podpis.jpg")
        photo(cls.photo)
        cls.aspect, cls.box = ink_aspect((1600, 900), 9)

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def path(self, name):
        return os.path.join(self.dir.name, name)

    def test_keeps_the_signature_and_drops_stamp_rules_and_shadow(self):
        code, result = kit("img", "signature", self.photo, "-o", self.path("sig.png"), "--preview", self.path("prev.png"))
        self.assertEqual(code, 0, result)
        self.assertLess(abs(result["aspect"] - self.aspect) / self.aspect, 0.1)
        self.assertIn("stamp_removed", result["warnings"])
        signature = Image.open(self.path("sig.png"))
        self.assertEqual((signature.mode, signature.height), ("RGBA", 240))
        rgba = np.asarray(signature)
        solid = rgba[..., 3] > 200
        red = solid & (rgba[..., 0].astype(int) > rgba[..., 2].astype(int) + 40)
        self.assertEqual(int(red.sum()), 0)
        # Transparent outside the strokes: rules and paper did not come along.
        self.assertLess(float((rgba[..., 3] > 0).mean()), 0.3)

    def test_preview_caption_stays_in_the_bottom_strip(self):
        code, result = kit("img", "signature", self.photo, "-o", self.path("sig2.png"), "--preview", self.path("prev2.png"))
        self.assertEqual(code, 0, result)
        preview = np.asarray(Image.open(self.path("prev2.png")).convert("RGB")).astype(int)
        # The caption is neutral grey; the ink's anti-aliased edges are bluish.
        neutral = preview.max(axis=2) - preview.min(axis=2) <= 6
        gray = neutral & (preview[..., 0] >= 140) & (preview[..., 0] <= 215)
        caption_rows = np.flatnonzero(gray.any(axis=1))
        self.assertGreater(len(caption_rows), 0)
        self.assertGreaterEqual(caption_rows.min(), preview.shape[0] - CAPTION_STRIP_PX)
        body = preview[: preview.shape[0] - CAPTION_STRIP_PX]
        lightness = 0.299 * body[..., 0] + 0.587 * body[..., 1] + 0.114 * body[..., 2]
        ys, xs = np.nonzero(lightness < 110)
        self.assertLess(abs((xs.max() - xs.min() + 1) / (ys.max() - ys.min() + 1) - self.aspect) / self.aspect, 0.1)

    def test_tight_crop_keeps_the_underline(self):
        x0, y0, x1, y1 = self.box
        Image.open(self.photo).crop((x0 - 15, y0 - 15, x1 + 15, y1 + 15)).save(self.path("tight.jpg"), quality=92)
        code, result = kit("img", "signature", self.path("tight.jpg"), "-o", self.path("tight.png"))
        self.assertEqual(code, 0, result)
        self.assertLess(abs(result["aspect"] - self.aspect) / self.aspect, 0.1)
        alpha = np.asarray(Image.open(self.path("tight.png")))[..., 3]
        bottom = alpha[int(alpha.shape[0] * 0.75) :]
        # The underline runs across most of the width without gaps.
        covered = (bottom > 128).any(axis=0)
        self.assertGreater(covered.mean(), 0.8)

    def test_same_photo_gives_the_same_png(self):
        # Bro's signer extracts again at confirm and compares the sha256 with
        # the one the person saw.
        outputs = []
        for name in ("again1.png", "again2.png"):
            code, result = kit("img", "signature", self.photo, "-o", self.path(name))
            self.assertEqual(code, 0, result)
            with open(self.path(name), "rb") as handle:
                outputs.append(handle.read())
        self.assertEqual(outputs[0], outputs[1])

    def test_transparent_png_reads_as_ink_on_white(self):
        transparent = Image.new("RGBA", (1600, 900), (0, 0, 0, 0))
        ImageDraw.Draw(transparent).line(signature_points(), fill=INK + (255,), width=9, joint="curve")
        transparent.save(self.path("cut.png"))
        code, result = kit("img", "signature", self.path("cut.png"), "-o", self.path("cut_out.png"))
        self.assertEqual(code, 0, result)
        self.assertLess(abs(result["aspect"] - self.aspect) / self.aspect, 0.1)

    def test_two_level_scan_reads_as_ink(self):
        # A 1-bit scan, or pure black ink without anti-aliasing: nothing between ink and paper.
        scan = Image.new("1", (1600, 900), 1)
        ImageDraw.Draw(scan).line(signature_points(), fill=0, width=9, joint="curve")
        scan.save(self.path("bw.png"))
        code, result = kit("img", "signature", self.path("bw.png"), "-o", self.path("bw_out.png"))
        self.assertEqual(code, 0, result)
        self.assertLess(abs(result["aspect"] - self.aspect) / self.aspect, 0.1)
        self.assertNotIn("low_contrast", result["warnings"])
        self.assertEqual(int(np.asarray(Image.open(self.path("bw_out.png")))[..., 3].max()), 255)

    def test_blank_sheet_has_no_ink(self):
        blank = Image.new("RGB", (1200, 800), PAPER)
        noise = np.random.default_rng(3).normal(0, 3, (800, 1200, 3))
        Image.fromarray(np.clip(np.asarray(blank) + noise, 0, 255).astype(np.uint8)).save(self.path("blank.jpg"))
        code, result = kit("img", "signature", self.path("blank.jpg"), "-o", self.path("blank.png"))
        self.assertEqual((code, result["code"]), (2, "no_ink"))
        self.assertFalse(os.path.exists(self.path("blank.png")))

    def test_typed_page_is_unclear(self):
        page = Image.new("RGB", (1240, 1754), "white")
        draw = ImageDraw.Draw(page)
        font = ImageFont.truetype(FONT, 26)
        words = "Договор найма жилого помещения заключён между сторонами о нижеследующем".split()
        rng = random.Random(5)
        for row in range(40):
            line = " ".join(rng.choice(words) for _ in range(7))
            draw.text((80, 80 + row * 40), line, font=font, fill="black")
        page.save(self.path("page.jpg"), quality=90)
        code, result = kit("img", "signature", self.path("page.jpg"), "-o", self.path("page.png"))
        self.assertEqual((code, result["code"]), (2, "unclear"))

    def test_not_an_image_is_unreadable(self):
        with open(self.path("note.jpg"), "w", encoding="utf-8") as handle:
            handle.write("not a photo")
        code, result = kit("img", "signature", self.path("note.jpg"), "-o", self.path("note.png"))
        self.assertEqual((code, result["code"]), (2, "unreadable"))


if __name__ == "__main__":
    unittest.main()
