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
# The same page lying on its side in a landscape photo.
SIDEWAYS_PHOTO = (2000, 1500)
SIDEWAYS_CORNERS = [(238.0, 188.0), (1688.0, 260.0), (1650.0, 1281.0), (300.0, 1206.0)]
SKIN = (226, 172, 136)


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


def photo(path, corners, turn=0, size=PHOTO):
    """The page, turned by `turn` degrees counter-clockwise, warped onto a dark table with a shadow."""
    page = page_image().rotate(turn, expand=True)
    rng = np.random.default_rng(11)
    table = np.full((size[1], size[0], 3), (110, 75, 45), np.float32) + rng.normal(0, 8, (size[1], size[0], 3))
    target = [(0, 0), (page.width, 0), (page.width, page.height), (0, page.height)]
    # Map photo pixels to page pixels: the inverse of placing the page.
    coefficients = homography(target, corners)
    warped = page.transform(size, Image.PERSPECTIVE, coefficients, Image.BILINEAR, fillcolor=(0, 0, 0))
    inside = Image.new("L", size, 0)
    ImageDraw.Draw(inside).polygon(corners, fill=255)
    mask = np.asarray(inside, dtype=np.float32)[..., None] / 255
    pixels = np.asarray(warped, dtype=np.float32) * mask + table * (1 - mask)
    shadow = np.linspace(-40, 0, size[0], dtype=np.float32)[None, :, None]
    Image.fromarray(np.clip(pixels + shadow, 0, 255).astype(np.uint8)).save(path, quality=90)


def held(path, colour, header=False):
    """The upright photo with a palm and thumb of `colour` reaching from the frame edge over the page's corner."""
    photo(path, CORNERS)
    with Image.open(path) as source:
        image = source.copy()
    draw = ImageDraw.Draw(image)
    if header:
        draw.polygon([CORNERS[0], CORNERS[1], (1211, 425), (316, 338)], fill=(250, 222, 105))
    draw.ellipse([-100, 1750, 300, 2100], fill=colour)
    draw.polygon([(232, 1240), (250, 1330), (120, 1700), (60, 1960), (10, 1900), (100, 1500)], fill=colour)
    image.save(path, quality=90)


def reads_upright(path):
    """True when the scan is portrait and the short last lines of paragraphs start at the left margin."""
    scan = np.asarray(Image.open(path).convert("L")) < 128
    if scan.shape[0] < scan.shape[1]:
        return False
    on = scan.mean(axis=1) > 0.02
    edges = np.flatnonzero(np.diff(np.concatenate([[0], on.astype(np.int8), [0]])))
    spans = []
    for y0, y1 in zip(edges[::2], edges[1::2]):
        columns = np.flatnonzero(scan[y0:y1].any(axis=0))
        spans.append((columns[0], columns[-1]))
    left = min(x0 for x0, _ in spans)
    widest = max(x1 - x0 for x0, x1 in spans)
    short = [(x0, x1) for x0, x1 in spans if x1 - x0 < 0.7 * widest]
    return len(short) >= 6 and all(x0 - left < 0.05 * scan.shape[1] for x0, _ in short)


class ImgScanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.upright = os.path.join(cls.dir.name, "IMG_1.jpg")
        cls.flipped = os.path.join(cls.dir.name, "IMG_2.jpg")
        photo(cls.upright, CORNERS)
        photo(cls.flipped, CORNERS, turn=180)

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

    def test_a_hand_holding_the_page_is_not_part_of_it(self):
        # Skin as bright as the paper joined the page and dragged its lower-left
        # corner onto the thumb. A coloured header on the sheet is not skin.
        for header in (False, True):
            with self.subTest(header=header):
                source = self.path("held%d.jpg" % header)
                held(source, SKIN, header)
                code, result = kit("img", "scan", source, "-o", self.path("held%d.png" % header))
                self.assertEqual(code, 0, result)
                page = result["pages"][0]
                self.assertTrue(page["auto"])
                # The hand may still hide a corner: the agent is asked to look.
                self.assertTrue(any("not a clean quadrilateral" in warning for warning in result["warnings"]))
                for found, truth in zip(page["corners"], CORNERS):
                    self.assertLess(abs(found[0] - truth[0]), 0.03 * PHOTO[0])
                    self.assertLess(abs(found[1] - truth[1]), 0.03 * PHOTO[1])

    def test_a_doubtful_outline_is_flagged(self):
        # A white sleeve over the corner is as neutral as paper: nothing tells it
        # from the page, so the corners come with a request to check them.
        held(self.path("sleeve.jpg"), (232, 232, 228))
        code, result = kit("img", "scan", self.path("sleeve.jpg"), "-o", self.path("sleeve.png"))
        self.assertEqual(code, 0, result)
        self.assertIsNotNone(result["pages"][0]["corners"])
        self.assertTrue(any("not a clean quadrilateral" in warning for warning in result["warnings"]))

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
        self.assertTrue(reads_upright(self.path("flipped.png")))

    def test_turns_a_sideways_page_either_way(self):
        for turn, needed in ((90, 270), (270, 90)):
            source = self.path("side%d.jpg" % turn)
            photo(source, SIDEWAYS_CORNERS, turn=turn, size=SIDEWAYS_PHOTO)
            code, result = kit("img", "scan", source, "-o", self.path("side%d.png" % turn))
            self.assertEqual(code, 0, result)
            self.assertEqual(result["pages"][0]["turned"], needed)
            self.assertTrue(reads_upright(self.path("side%d.png" % turn)), turn)

    def test_black_and_white_pages_make_a_pdf(self):
        code, result = kit("img", "scan", self.upright, self.flipped, "--mode", "bw", "-o", self.path("bw.pdf"))
        self.assertEqual(code, 0, result)
        reader = PdfReader(self.path("bw.pdf"))
        self.assertEqual(len(reader.pages), 2)
        self.assertTrue(reader.metadata.producer.startswith("brokit "))

    def test_paper_filling_the_frame_is_not_cropped(self):
        # No table around the page, only light falling from the right: the
        # brighter half of the same sheet is not a page of its own.
        xs = np.linspace(200, 235, 1600, dtype=np.float32)
        paper = Image.fromarray(np.repeat(np.tile(xs, (1200, 1))[..., None], 3, axis=2).astype(np.uint8))
        ImageDraw.Draw(paper).line([(200, 700), (1400, 650)], fill=(30, 40, 120), width=6)
        paper.save(self.path("full.jpg"), quality=92)
        code, result = kit("img", "scan", self.path("full.jpg"), "-o", self.path("full.png"))
        self.assertEqual(code, 0, result)
        self.assertIsNone(result["pages"][0]["corners"])
        self.assertTrue(any("page edges not found" in warning for warning in result["warnings"]))
        with Image.open(self.path("full.png")) as scan:
            self.assertGreaterEqual(scan.width, 1600)

    def test_corners_off_the_photo_are_refused(self):
        code, result = kit("img", "scan", self.upright, "--corners", "0,0,90000,0,90000,90000,0,90000", "-o", self.path("off.png"))
        self.assertEqual((code, result["code"]), (2, "bad_args"))
        self.assertFalse(os.path.exists(self.path("off.png")))

    def test_photos_make_one_pdf_in_order(self):
        code, result = kit("img", "scan", self.upright, self.flipped, "-o", self.path("both.pdf"))
        self.assertEqual(code, 0, result)
        self.assertEqual([p["source"] for p in result["pages"]], [self.upright, self.flipped])
        reader = PdfReader(self.path("both.pdf"))
        self.assertEqual(len(reader.pages), 2)
        box = reader.pages[0].mediabox
        self.assertAlmostEqual(float(box.width) / 72 * 25.4, 210, delta=2)

    def test_max_mb_lowers_dpi_then_quality_until_the_pdf_fits(self):
        # A photo twice as large gives a page of about 230 dpi: room for 200 and 150.
        with Image.open(self.upright) as source:
            source.resize((PHOTO[0] * 2, PHOTO[1] * 2), Image.BICUBIC).save(self.path("big.jpg"), quality=90)
        code, full = kit("img", "scan", self.path("big.jpg"), "-o", self.path("full.pdf"))
        self.assertEqual(code, 0, full)
        self.assertEqual(full["bytes"], os.path.getsize(self.path("full.pdf")))
        self.assertGreater(full["dpi"], 200)
        limit = full["bytes"] * 0.6 / 1e6
        code, small = kit("img", "scan", self.path("big.jpg"), "--max-mb", "%.4f" % limit, "-o", self.path("small.pdf"))
        self.assertEqual(code, 0, small)
        self.assertLessEqual(os.path.getsize(self.path("small.pdf")), limit * 1e6)
        self.assertEqual(small["bytes"], os.path.getsize(self.path("small.pdf")))
        self.assertLess((small["dpi"], small["quality"]), (full["dpi"], full["quality"]))
        # The page keeps its paper size: only its pixels per inch go down.
        box = PdfReader(self.path("small.pdf")).pages[0].mediabox
        self.assertAlmostEqual(float(box.width) / 72 * 25.4, 210, delta=2)
        # Black and white pages are lossless: only the dpi goes down.
        code, bw = kit("img", "scan", self.path("big.jpg"), "--mode", "bw", "-o", self.path("bw.pdf"))
        self.assertEqual(code, 0, bw)
        limit = bw["bytes"] * 0.8 / 1e6
        code, smaller = kit("img", "scan", self.path("big.jpg"), "--mode", "bw", "--max-mb", "%.6f" % limit, "-o", self.path("bw.pdf"))
        self.assertEqual(code, 0, smaller)
        self.assertLessEqual(smaller["bytes"], limit * 1e6)
        self.assertLess(smaller["dpi"], bw["dpi"])
        self.assertIsNone(smaller["quality"])

    def test_max_mb_that_cannot_be_met_is_refused(self):
        code, result = kit("img", "scan", self.upright, "--max-mb", "0.001", "-o", self.path("tiny.pdf"))
        self.assertEqual((code, result["code"]), (2, "too_big"))
        self.assertFalse(os.path.exists(self.path("tiny.pdf")))

    def test_given_corners_win(self):
        corners = ",".join("%d,%d" % point for point in CORNERS)
        code, result = kit("img", "scan", self.upright, "--corners", corners, "-o", self.path("given.png"))
        self.assertEqual(code, 0, result)
        self.assertFalse(result["pages"][0]["auto"])
        self.assertEqual(result["pages"][0]["corners"], [list(map(float, point)) for point in CORNERS])


if __name__ == "__main__":
    unittest.main()
