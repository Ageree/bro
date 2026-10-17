"""f-zip-chaos-inventory: duplicates kept in a trash folder of the archive, not deleted, are out of it."""

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
ITEM = {"kind": "zip_no_duplicates", "params": {"max_same_hash": 1}}


def archive(*names) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for name in names:
            z.writestr(name, b"photo")
    return out.getvalue()


class TrashFolderTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)

    def outcome(self, data):
        case_dir = make_run(self.root / "out", "f-test", files=[(0, data, "razobrano.zip")])
        ctx = context(CASE, case_dir, self.root / "fixtures")
        try:
            return evaluate(ctx, ITEM)[0]
        finally:
            ctx.cleanup()

    def test_a_copy_in_the_trash_folder_is_no_duplicate(self):
        got = self.outcome(archive("Фото/2023-07-14_яхта.jpg", "Мусор/DSC_0004 копия.JPG"))
        self.assertEqual(got.status, "pass", got.detail)

    def test_two_copies_among_the_sorted_files_are(self):
        got = self.outcome(archive("Фото/2023-07-14_яхта.jpg", "Разное/DSC_0004 копия.JPG"))
        self.assertEqual(got.status, "fail")


if __name__ == "__main__":
    unittest.main()
