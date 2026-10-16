"""`pdf layout`: blanks of a vector form, and of a skewed noisy scan with «__»/«20__» blanks."""

import math
import os
import shutil
import tempfile
import unittest

from tests.pdf_fixtures import A4, fonts, kit, scan_form


def vector_form(path):
    from reportlab.pdfgen import canvas

    fonts()
    c = canvas.Canvas(path, pagesize=A4)
    c.setFont("TestSans", 11)
    c.drawString(60, 760, "ФИО:")
    c.setLineWidth(0.8)
    c.line(100, 758, 400, 758)
    c.drawString(60, 720, "Адрес")
    c.rect(120, 712, 250, 22)
    c.rect(60, 680, 10, 10)
    c.drawString(76, 681, "Согласен на рассылку")
    c.drawString(60, 640, "Дата:____________")
    c.drawString(60, 600, "ИНН")
    for i in range(8):
        c.rect(100 + i * 16, 596, 16, 18)
    c.showPage()
    c.save()
    return path


def near(a, b, tolerance):
    return all(abs(x - y) <= tolerance for x, y in zip(a, b))


@unittest.skipUnless(shutil.which("pdftoppm"), "poppler is missing")
class Layout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="brokit-layout-")
        cls.cache = os.path.join(cls.directory, "cache")
        cls.vector = vector_form(os.path.join(cls.directory, "vector.pdf"))
        cls.scan, cls.truth = scan_form(cls.directory)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def blanks(self, path):
        code, result = kit("pdf", "layout", path, cache=self.cache)
        self.assertEqual(code, 0, result)
        return result["pages"][0]

    def test_vector_form_blanks_and_labels(self):
        page = self.blanks(self.vector)
        self.assertFalse(page["scan"])
        by_kind = {}
        for blank in page["blanks"]:
            by_kind.setdefault(blank["kind"], []).append(blank)
        line = next(b for b in by_kind["line"] if b["label"].startswith("ФИО"))
        self.assertTrue(near([line["box"][0], line["box"][2], line["box"][3]], [100, 400, A4[1] - 758], 1.5), line)
        box = by_kind["box"][0]
        self.assertTrue(near(box["box"], [120, A4[1] - 734, 370, A4[1] - 712], 1.5), box)
        self.assertEqual(box["label"].split(" · ")[0], "Адрес")
        checkbox = by_kind["checkbox"][0]
        self.assertTrue(near(checkbox["box"], [60, A4[1] - 690, 70, A4[1] - 680], 1.5), checkbox)
        underscores = by_kind["underscores"][0]
        self.assertEqual(underscores["label"], "Дата:")
        comb = by_kind["comb"][0]
        self.assertEqual(comb["cells"], 8)
        self.assertEqual(comb["label"], "ИНН")
        self.assertEqual(len(page["blanks"]), 5, page["blanks"])

    def test_skewed_scan_one_blank_per_rule(self):
        page = self.blanks(self.scan)
        self.assertTrue(page["scan"])
        self.assertLessEqual(abs(page["skew_deg"] - 0.7), 0.2)
        lines = [b for b in page["blanks"] if b["kind"] == "line"]
        for name, (start, end) in self.truth.items():
            matches = [b for b in lines if near(b["line"][:2], start, 2) and near(b["line"][2:], end, 2)]
            self.assertEqual(len(matches), 1, (name, start, end, [b["line"] for b in lines]))
            self.assertAlmostEqual(matches[0]["angle"], math.degrees(math.atan2(start[1] - end[1], end[0] - start[0])), delta=0.3)
        self.assertEqual(len(lines), len(self.truth), [b["line"] for b in lines])

    def test_marks_picture_per_page(self):
        marks = os.path.join(self.directory, "marks")
        code, result = kit("pdf", "layout", self.vector, "--marks", marks, cache=self.cache)
        self.assertEqual(code, 0, result)
        from PIL import Image

        with Image.open(result["marks"][0]) as image:
            self.assertEqual(max(image.size), 1280)
