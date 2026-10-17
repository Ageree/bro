"""Files that may come zipped: page JPGs inside the ZIP count only where the check asks for `zipped`."""

import io
import pathlib
import shutil
import tempfile
import unittest
import zipfile

from check import evaluate
from tests.runs import make_run
from tests.samples import context

CASE = {"id": "f-test", "turns": [], "fixtures": []}
PAGES = {"ext": "jpg", "page_images": 2, "min_long_side": 1600, "page_aspect": 1.414, "aspect_tol": 0.02}


def jpeg(size, shade) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", size, (shade, 80, 40)).save(out, "JPEG")
    return out.getvalue()


def zipped(members: dict) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for name, data in members.items():
            z.writestr(f"pages/{name}", data)
    return out.getvalue()


class ZippedFilesTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "fixtures" / "truth").mkdir(parents=True)

    def outcome(self, params):
        page = jpeg((1600, 1131), 120)
        files = [(0, page, "page_01.jpg"), (0, zipped({"page_01.jpg": page, "page_02.jpg": jpeg((1600, 1131), 200)}), "pages.zip")]
        case_dir = make_run(self.root / "out", "f-test", files=files)
        ctx = context(CASE, case_dir, self.root / "fixtures")
        try:
            return evaluate(ctx, {"kind": "file_count", "params": params})[0]
        finally:
            ctx.cleanup()

    def test_pages_in_the_zip_count_when_asked(self):
        got = self.outcome({**PAGES, "zipped": True})
        self.assertEqual(got.status, "pass", got.detail)

    def test_pages_in_the_zip_do_not_count_otherwise(self):
        self.assertEqual(self.outcome(PAGES).status, "fail")


if __name__ == "__main__":
    unittest.main()
