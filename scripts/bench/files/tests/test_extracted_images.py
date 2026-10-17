"""f-pdf-password-extract: the booklet's photos count whether they come one file each or zipped together."""

import io
import json
import pathlib
import shutil
import tempfile
import unittest
import zipfile

from check import evaluate
from tests.runs import make_run
from tests.samples import context

CASE = {"id": "f-test", "turns": [], "fixtures": []}
ITEM = {"kind": "extracted_images", "params": {"dims": [[40, 30]]}}


def jpeg(size) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", size, (120, 80, 40)).save(out, "JPEG")
    return out.getvalue()


def zipped(**members) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for name, data in members.items():
            z.writestr(f"img/{name}", data)
    return out.getvalue()


class ExtractedImagesTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        truth = self.root / "fixtures" / "truth"
        truth.mkdir(parents=True)
        (truth / "buklet_ZhK.json").write_text(json.dumps({"images": [{"px": [40, 30]}]}))

    def outcome(self, files):
        case_dir = make_run(self.root / "out", "f-test", files=files)
        ctx = context(CASE, case_dir, self.root / "fixtures")
        try:
            return evaluate(ctx, ITEM)[0]
        finally:
            ctx.cleanup()

    def test_the_photos_zipped_together_count(self):
        got = self.outcome([(0, jpeg((20, 20)), "page-1.jpg"), (0, zipped(**{"foto.jpg": jpeg((40, 30))}), "foto.zip")])
        self.assertEqual(got.status, "pass", got.detail)

    def test_a_zip_without_them_fails(self):
        got = self.outcome([(0, zipped(**{"page.jpg": jpeg((20, 20))}), "foto.zip")])
        self.assertEqual(got.status, "fail")


if __name__ == "__main__":
    unittest.main()
