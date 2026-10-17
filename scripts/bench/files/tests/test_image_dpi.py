"""f-passport-photo-sheet: a photo at 600 dpi prints at its size when the metadata and the pixels agree on it."""

import io
import pathlib
import shutil
import tempfile
import unittest

from check import evaluate
from tests.runs import make_run
from tests.samples import context

CASE = {"id": "f-test", "turns": [], "fixtures": []}
ITEM = {"kind": "image_dpi", "params": {"dpi": 300, "alt_dpi": [600]}}


def jpeg(size, dpi) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", size, "white").save(out, "JPEG", dpi=(dpi, dpi))
    return out.getvalue()


class ImageDpiTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)

    def outcome(self, data):
        case_dir = make_run(self.root / "out", "f-test", files=[(0, data, "foto_35x45.jpg")])
        ctx = context(CASE, case_dir, self.root / "fixtures")
        try:
            return evaluate(ctx, ITEM)[0]
        finally:
            ctx.cleanup()

    def test_600_dpi_with_its_pixels_passes(self):
        self.assertEqual(self.outcome(jpeg((827, 1063), 600)).status, "pass")

    def test_600_dpi_in_the_metadata_alone_fails(self):
        self.assertEqual(self.outcome(jpeg((500, 700), 600)).status, "fail")


if __name__ == "__main__":
    unittest.main()
