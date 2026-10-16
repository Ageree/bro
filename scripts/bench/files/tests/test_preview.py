"""signature_preview on W2's preview layout: a clean cut-out passes, grid lines or the red stamp fail."""

import pathlib
import shutil
import tempfile
import unittest

from PIL import Image, ImageDraw, ImageFont

from checks import REGISTRY
from tests.runs import make_run
from tests.samples import context, cutout, png_bytes, write_truth_mask

DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEJAVU_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
CASE = {"id": "f-test", "turns": [], "fixtures": [], "signature_truth": "podpis_test"}
PARAMS = {"tolerance": 0.15, "paper_max": 0.005, "halo_px": 2, "caption_strip_px": 52}


def font(size, bold=False):
    try:
        return ImageFont.truetype(DEJAVU_BOLD if bold else DEJAVU, size)
    except OSError:
        return ImageFont.load_default()


def with_stamp(sig):
    """The cut-out with the photo's red «ОБРАЗЕЦ / SPECIMEN» stamp kept below the stroke (an extractor that missed it)."""
    out = Image.new("RGBA", (sig.width, sig.height + 70), (0, 0, 0, 0))
    out.paste(sig, (0, 0))
    draw = ImageDraw.Draw(out)
    draw.rectangle([sig.width - 330, sig.height + 10, sig.width - 10, sig.height + 60], outline=(196, 32, 32, 215), width=4)
    draw.text((sig.width - 315, sig.height + 18), "ОБРАЗЕЦ / SPECIMEN", font=font(26, bold=True), fill=(196, 32, 32, 215))
    return out


def preview(sig, *, grid=False):
    """W2's preview: the signature at (24, 24) on white, a 52 px caption strip at the bottom."""
    w, h = sig.width + 48, sig.height + 24 + 52
    canvas = Image.new("RGB", (w, h), "white")
    draw = ImageDraw.Draw(canvas)
    if grid:
        for x in range(10, w, 30):
            draw.line([(x, 0), (x, h - 52)], fill=(150, 175, 215), width=2)
    canvas.paste(sig, (24, 24), sig)
    draw.text((24, h - 28), "образец подписи · сохранён у Бро", font=font(14), fill=(150, 150, 150))
    return canvas


class PreviewTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        write_truth_mask(self.root / "fixtures" / "truth", "podpis_test", 101, "С")
        self.sig = cutout(101, "С")

    def outcome(self, img):
        case_dir = make_run(self.root / "out", "f-test", files=[(0, png_bytes(img), "Подпись (образец).png")])
        ctx = context(CASE, case_dir, self.root / "fixtures")
        return REGISTRY["signature_preview"].fn(ctx, PARAMS, ctx.received[0])

    def test_clean_preview_passes(self):
        outcome = self.outcome(preview(self.sig))
        self.assertEqual(outcome.status, "pass", outcome.detail)

    def test_grid_left_from_the_notebook_fails(self):
        self.assertEqual(self.outcome(preview(self.sig, grid=True)).status, "fail")

    def test_stamp_left_on_the_sample_fails(self):
        self.assertEqual(self.outcome(preview(with_stamp(self.sig))).status, "fail")


if __name__ == "__main__":
    unittest.main()
