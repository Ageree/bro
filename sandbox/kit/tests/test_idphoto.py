"""brokit img idphoto on a synthetic selfie with a rolled head (W2 spec §6.10, §9)."""

import math
import os
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw

from tests.cli_run import kit

SIZE = (1500, 2000)
CENTER = (750, 850)
EYES = [(680, 820), (820, 820)]
ROLL = 4.0
WALL = (200, 196, 186)
SKIN = (224, 182, 150)
HAIR = (55, 38, 28)
SHIRT = (40, 60, 110)


def rolled(point):
    """Where a point of the upright drawing lands after rotate(ROLL) about CENTER."""
    angle = math.radians(ROLL)
    dx, dy = point[0] - CENTER[0], point[1] - CENTER[1]
    return (CENTER[0] + dx * math.cos(angle) + dy * math.sin(angle), CENTER[1] - dx * math.sin(angle) + dy * math.cos(angle))


def selfie(path, busy=False, irises=True):
    person = Image.new("RGBA", SIZE, (0, 0, 0, 0))
    draw = ImageDraw.Draw(person)
    draw.polygon([(250, 2000), (420, 1160), (1080, 1160), (1250, 2000)], fill=SHIRT)
    draw.rectangle([670, 1000, 830, 1180], fill=(34, 52, 98))
    cx, cy = CENTER
    draw.ellipse([cx - 165, cy - 260, cx + 165, cy + 260], fill=HAIR)
    draw.ellipse([cx - 165, cy - 215, cx + 165, cy + 215], fill=SKIN)
    for x, y in EYES:
        draw.ellipse([x - 30, y - 14, x + 30, y + 14], fill=(245, 245, 240))
        if irises:
            draw.ellipse([x - 13, y - 13, x + 13, y + 13], fill=(35, 35, 40))
    draw.line([(705, 960), (795, 960)], fill=(180, 90, 90), width=10)
    person = person.rotate(ROLL, resample=Image.BICUBIC, center=CENTER)
    gradient = np.linspace(10, -10, SIZE[1], dtype=np.float32)[:, None, None]
    noise = np.random.default_rng(9).normal(0, 4, (SIZE[1], SIZE[0], 3)).astype(np.float32)
    wall = Image.fromarray(np.clip(np.array(WALL, np.float32) + gradient + noise, 0, 255).astype(np.uint8))
    if busy:
        # A bookshelf: blocks of every colour, no wall to separate from.
        rng = np.random.default_rng(4)
        blocks = rng.integers(0, 255, (SIZE[1] // 50, SIZE[0] // 50, 3), dtype=np.uint8)
        wall = Image.fromarray(blocks).resize(SIZE, Image.NEAREST)
    wall.paste(person, (0, 0), person)
    wall.save(path, quality=92)


def iris_centres(photo):
    """Centroids of the dark irises inside the face, in the middle of the output photo."""
    pixels = np.asarray(photo.convert("RGB"), dtype=np.float32)
    dark = (pixels.sum(axis=2) < 200) & (abs(pixels[..., 2] - pixels[..., 0]) < 25)
    h, w = dark.shape
    band = dark[int(0.3 * h) : int(0.6 * h), int(0.25 * w) : int(0.75 * w)]
    ys, xs = np.nonzero(band)
    left, right = xs < band.shape[1] / 2, xs >= band.shape[1] / 2
    return (xs[left].mean(), ys[left].mean()), (xs[right].mean(), ys[right].mean())


class IdPhotoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.selfie = os.path.join(cls.dir.name, "selfie.jpg")
        selfie(cls.selfie)

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def path(self, name):
        return os.path.join(self.dir.name, name)

    def check_geometry(self, result, path):
        self.assertLessEqual(abs(result["roll_deg"]), 0.5)
        self.assertTrue(33 <= result["head_mm"] <= 35, result)
        self.assertTrue(23 <= result["eyes_from_bottom_mm"] <= 31, result)
        with Image.open(path) as photo:
            self.assertEqual(photo.size, (413, 531))
            (lx, ly), (rx, ry) = iris_centres(photo)
            self.assertLess(abs(ly - ry), 2.5)
            pixels = np.asarray(photo.convert("L"), dtype=np.float32)
        # 4 mm of white above the crown, then hair, at 300 dpi (11.8 px/mm).
        column = pixels[:, 196:216].mean(axis=1)
        crown = int(np.flatnonzero(column < 150)[0])
        self.assertLess(abs(crown - 47), 8)
        self.assertGreater(float(pixels[:20, :40].mean()), 245)

    def test_levels_the_eyes_and_sizes_the_head(self):
        code, result = kit("img", "idphoto", self.selfie, "-o", self.path("photo.jpg"))
        self.assertEqual(code, 0, result)
        self.assertTrue(result["eyes"]["auto"])
        self.assertAlmostEqual(result["roll_fixed_deg"], ROLL, delta=0.6)
        self.check_geometry(result, self.path("photo.jpg"))

    def test_given_eyes_and_print_sheet(self):
        eyes = ",".join("%.1f,%.1f" % rolled(point) for point in EYES)
        code, result = kit("img", "idphoto", self.selfie, "--eyes", eyes, "--sheet", "10x15", "-o", self.path("given.jpg"))
        self.assertEqual(code, 0, result)
        self.assertFalse(result["eyes"]["auto"])
        self.check_geometry(result, self.path("given.jpg"))
        self.assertEqual(result["copies"], 6)
        with Image.open(result["sheet"]) as sheet:
            self.assertEqual(sheet.size, (1181, 1772))

    def test_mistyped_eyes_show_in_the_measured_roll(self):
        # Eyes typed as if the head were upright: nothing is turned, and the result is measured tilted.
        eyes = ",".join("%.1f,%.1f" % point for point in EYES)
        code, result = kit("img", "idphoto", self.selfie, "--eyes", eyes, "-o", self.path("mistyped.jpg"))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["roll_fixed_deg"], 0)
        self.assertAlmostEqual(result["roll_deg"], -ROLL, delta=1.0)
        self.assertTrue(any("eye line on the result is tilted" in w for w in result["warnings"]), result["warnings"])

    def test_eyes_not_found_on_the_result_leave_the_roll_unknown(self):
        selfie(self.path("no_irises.jpg"), irises=False)
        eyes = ",".join("%.1f,%.1f" % rolled(point) for point in EYES)
        code, result = kit("img", "idphoto", self.path("no_irises.jpg"), "--eyes", eyes, "-o", self.path("no_irises_out.jpg"))
        self.assertEqual(code, 0, result)
        self.assertIsNone(result["roll_deg"])
        self.assertTrue(any("not re-measured" in w for w in result["warnings"]), result["warnings"])

    def test_busy_background_works_from_given_eyes_and_chin(self):
        selfie(self.path("shelf.jpg"), busy=True)
        eyes = ",".join("%.1f,%.1f" % rolled(point) for point in EYES)
        chin = rolled((CENTER[0], CENTER[1] + 215))[1]
        code, result = kit("img", "idphoto", self.path("shelf.jpg"), "--eyes", eyes, "--chin", chin, "-o", self.path("shelf_out.jpg"))
        self.assertEqual(code, 0, result)
        self.assertTrue(any("background not separated" in w for w in result["warnings"]))
        # The given chin is kept (in photo pixels) and the crown is derived from it.
        self.assertAlmostEqual(result["chin_y"], chin, delta=3)
        self.assertTrue(23 <= result["eyes_from_bottom_mm"] <= 31, result)
        with Image.open(self.path("shelf_out.jpg")) as photo:
            (_, ly), (_, ry) = iris_centres(photo)
        self.assertLess(abs(ly - ry), 2.5)

    def test_no_face_asks_for_eyes(self):
        Image.new("RGB", (800, 1000), WALL).save(self.path("wall.jpg"))
        code, result = kit("img", "idphoto", self.path("wall.jpg"), "-o", self.path("wall_out.jpg"))
        self.assertEqual((code, result["code"]), (2, "no_face"))
        self.assertIn("--eyes", result["hint"])


if __name__ == "__main__":
    unittest.main()
