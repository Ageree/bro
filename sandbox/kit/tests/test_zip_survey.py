"""brokit zip unpack / pack and files survey (W2 spec §6.12, §9)."""

import io
import os
import stat
import tempfile
import unittest
import zipfile
from unittest import mock

import docx
from PIL import Image
from reportlab.pdfgen import canvas

from tests.cli_run import kit


class Cp866Info(zipfile.ZipInfo):
    """An entry named in cp866 without the UTF-8 flag, as old Windows archivers write."""

    def _encodeFilenameFlags(self):
        return self.filename.encode("cp437"), self.flag_bits & ~0x800


def cp866_entry(name):
    return Cp866Info(name.encode("cp866").decode("cp437"), date_time=(2024, 9, 1, 12, 0, 0))


def jpeg_bytes(colour=(200, 120, 40)):
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), colour).save(buffer, "JPEG")
    return buffer.getvalue()


def pdf_bytes(text):
    buffer = io.BytesIO()
    page = canvas.Canvas(buffer)
    page.setFont("Helvetica", 14)
    page.drawString(72, 760, text)
    page.save()
    return buffer.getvalue()


class ZipTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        inner = io.BytesIO()
        with zipfile.ZipFile(inner, "w") as archive:
            archive.writestr(cp866_entry("договор.txt"), "договор подряда".encode("cp1251"))
        cls.archive = os.path.join(cls.dir.name, "razobrat.zip")
        with zipfile.ZipFile(cls.archive, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(cp866_entry("чек_ozon.pdf"), pdf_bytes("Receipt 1"))
            archive.writestr(cp866_entry("Новая папка/фото.jpg"), jpeg_bytes())
            archive.writestr(cp866_entry("старое.zip"), inner.getvalue())
            archive.writestr("../escape.txt", b"x")
            link = zipfile.ZipInfo("link")
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, "/etc/passwd")
            archive.writestr("plain.txt", b"hello")

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def path(self, name):
        return os.path.join(self.dir.name, name)

    def test_unpack_repairs_cp866_names_and_unpacks_nested_archives(self):
        code, result = kit("zip", "unpack", self.archive, "-o", self.path("out"))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["renamed_encoding"], "cp866")
        targets = sorted(f["to"] for f in result["files"])
        self.assertEqual(targets, ["plain.txt", "Новая папка/фото.jpg", "старое.zip/договор.txt", "чек_ozon.pdf"])
        self.assertEqual(result["nested"], ["старое.zip"])
        with open(self.path("out/старое.zip/договор.txt"), "rb") as handle:
            self.assertEqual(handle.read().decode("cp1251"), "договор подряда")
        skipped = {item["name"]: item["why"] for item in result["skipped"]}
        self.assertEqual(set(skipped), {"../escape.txt", "link"})
        self.assertFalse(os.path.exists(self.path("escape.txt")))
        self.assertFalse(os.path.lexists(self.path("out/link")))

    def test_unpack_stops_at_the_actual_size_cap_and_leaves_nothing(self):
        big = self.path("big.zip")
        with zipfile.ZipFile(big, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("a.bin", b"\0" * 3_000_000)
            archive.writestr("b.bin", b"\0" * 3_000_000)
        with mock.patch("brokit.zipx.MAX_TOTAL_BYTES", 4_000_000):
            code, result = kit("zip", "unpack", big, "-o", self.path("big"))
        self.assertEqual((code, result["code"]), (2, "too_big"))
        self.assertEqual(os.listdir(self.path("big")), [])

    def test_rar_is_refused(self):
        with open(self.path("x.rar"), "wb") as handle:
            handle.write(b"Rar!\x1a\x07\x01\x00" + b"\0" * 64)
        code, result = kit("zip", "unpack", self.path("x.rar"), "-o", self.path("rar"))
        self.assertEqual((code, result["code"]), (2, "unsupported"))

    def test_pack_writes_utf8_names(self):
        folder = self.path("tosend")
        os.makedirs(os.path.join(folder, "Чеки"))
        with open(os.path.join(folder, "Чеки", "чек.pdf"), "wb") as handle:
            handle.write(pdf_bytes("x"))
        code, result = kit("zip", "pack", folder, "-o", self.path("sent.zip"))
        self.assertEqual((code, result["files"]), (0, 1))
        with zipfile.ZipFile(self.path("sent.zip")) as archive:
            info = archive.infolist()[0]
        self.assertEqual(info.filename, "Чеки/чек.pdf")
        self.assertTrue(info.flag_bits & 0x800)


class SurveyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        root = cls.dir.name
        photo = jpeg_bytes()
        for name in ("IMG_2392.jpg", "IMG_2392 (1).jpg"):
            with open(os.path.join(root, name), "wb") as handle:
                handle.write(photo)
        with open(os.path.join(root, "IMG_0042.JPG"), "wb") as handle:
            handle.write(jpeg_bytes((10, 200, 30))[:300])
        with open(os.path.join(root, "Thumbs.db"), "wb") as handle:
            handle.write(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 600)
        with open(os.path.join(root, "scan.pdf"), "wb") as handle:
            handle.write(pdf_bytes("Invoice No 15 from 03.02.2024"))
        document = docx.Document()
        document.add_paragraph("Договор оказания услуг № 7")
        document.save(os.path.join(root, "Документ (3).docx"))
        with open(os.path.join(root, "notes.txt"), "wb") as handle:
            handle.write("Список дел на дачу".encode("cp1251"))

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def test_survey_finds_types_duplicates_junk_and_broken_files(self):
        code, result = kit("files", "survey", self.dir.name)
        self.assertEqual(code, 0, result)
        files = {f["path"]: f for f in result["files"]}
        self.assertEqual(result["duplicates"], [["IMG_2392.jpg", "IMG_2392 (1).jpg"]])
        self.assertEqual(files["IMG_2392 (1).jpg"]["dup_of"], "IMG_2392.jpg")
        self.assertEqual(result["junk"], ["Thumbs.db"])
        self.assertEqual(result["broken"], ["IMG_0042.JPG"])
        self.assertEqual(files["Документ (3).docx"]["type"], "docx")
        self.assertEqual(files["Документ (3).docx"]["text"], "Договор оказания услуг № 7")
        self.assertEqual((files["scan.pdf"]["type"], files["scan.pdf"]["pages"]), ("pdf", 1))
        self.assertIn("Invoice No 15", files["scan.pdf"]["text"])
        self.assertEqual(files["notes.txt"]["text"], "Список дел на дачу")


if __name__ == "__main__":
    unittest.main()
