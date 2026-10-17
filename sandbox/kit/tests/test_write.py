"""`pdf write`: text lands in its blank; on a skewed scan it follows the rule's angle."""

import math
import os
import re
import shutil
import subprocess
import tempfile
import unittest

from tests.pdf_fixtures import A4, fonts, kit, render, scan_form, write_json
from tests.test_layout import KOPECKS_X, small_cells_form, vector_form


def word_boxes(path):
    xml = subprocess.run(["pdftotext", "-bbox", path, "-"], capture_output=True, check=True).stdout.decode("utf-8")
    return {
        m.group(5): [float(m.group(i)) for i in range(1, 5)]
        for m in re.finditer(r'xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<', xml)
    }


CELL = 14


def money_row_form(path):
    """A tax-form row: 13 rouble cells, a printed «.», 2 kopeck cells; a date in ДД.ММ.ГГГГ cells."""
    from reportlab.pdfgen import canvas

    fonts()
    c = canvas.Canvas(path, pagesize=A4)
    c.setFont("TestSans", 10)
    c.drawString(60, 645, "Расходы на лечение")
    c.setLineWidth(0.6)
    for i in range(13):
        c.rect(300 + i * CELL, 640, CELL, 18)
    c.drawCentredString(486, 641.5, ".")
    for i in range(2):
        c.rect(490 + i * CELL, 640, CELL, 18)
    c.drawString(60, 585, "Дата")
    for start, count in ((300, 2), (336, 2), (372, 4)):
        for i in range(count):
            c.rect(start + i * CELL, 580, CELL, 18)
    c.drawCentredString(332, 581.5, ".")
    c.drawCentredString(368, 581.5, ".")
    c.showPage()
    c.save()
    return path


def cell_texts(path, xs, y):
    """What each cell of a row (left edges `xs`, bottom `y` in PDF pt) holds: a word's width split evenly between its characters."""
    xml = subprocess.run(["pdftotext", "-bbox", path, "-"], capture_output=True, check=True).stdout.decode("utf-8")
    top, bottom = A4[1] - y - 18, A4[1] - y
    out = [""] * len(xs)
    for m in re.finditer(r'xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<', xml):
        x0, y0, x1, y1 = (float(m.group(i)) for i in range(1, 5))
        text = m.group(5)
        if not text or not top <= (y0 + y1) / 2 <= bottom:
            continue
        step = (x1 - x0) / len(text)
        for i, char in enumerate(text):
            centre = x0 + step * (i + 0.5)
            for index, left in enumerate(xs):
                if left <= centre <= left + CELL:
                    out[index] += char
    return out


ROUBLES = [300 + i * CELL for i in range(13)] + [490, 504]
DATE = [300, 314, 336, 350, 372, 386, 400, 414]


@unittest.skipUnless(shutil.which("pdftoppm"), "poppler is missing")
class Write(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="brokit-write-")
        cls.cache = os.path.join(cls.directory, "cache")
        cls.vector = vector_form(os.path.join(cls.directory, "vector.pdf"))
        cls.scan, cls.truth = scan_form(cls.directory)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def blank(self, path, predicate):
        code, result = kit("pdf", "layout", path, cache=self.cache)
        self.assertEqual(code, 0, result)
        return next(b for b in result["pages"][0]["blanks"] if predicate(b))

    def write(self, path, spec):
        output = os.path.join(self.directory, "out-%d.pdf" % len(os.listdir(self.directory)))
        code, result = kit("pdf", "write", path, write_json(output + ".json", spec), "-o", output, cache=self.cache)
        self.assertEqual(code, 0, result)
        return output, result

    def test_text_lands_on_its_rule_and_in_its_box(self):
        line = self.blank(self.vector, lambda b: b["label"].startswith("ФИО"))
        box = self.blank(self.vector, lambda b: b["kind"] == "box")
        output, result = self.write(
            self.vector,
            [{"at": line["id"], "text": "Ёжиков Щедрин"}, {"at": box["id"], "text": "Казань"}, {"page": 1, "box": [60, 151.9, 70, 161.9], "check": True}],
        )
        self.assertEqual([item["status"] for item in result["items"]], ["ok", "ok", "ok"])
        words = word_boxes(output)
        rule_y = A4[1] - 758
        x0, y0, x1, y1 = words["Щедрин"]
        self.assertTrue(100 <= words["Ёжиков"][0] and x1 <= 400, words)
        baseline = y1 - 0.236 * (y1 - y0)  # pdftotext boxes include the font's descent
        self.assertTrue(rule_y - 3 <= baseline <= rule_y, (words["Щедрин"], rule_y))
        bx0, by0, bx1, by1 = box["box"]
        x0, y0, x1, y1 = words["Казань"]
        self.assertTrue(bx0 <= x0 and x1 <= bx1 and by0 <= y0 and y1 <= by1, (words["Казань"], box["box"]))

    def test_a_full_name_in_the_nominative_comes_back_with_a_warning(self):
        line = self.blank(self.vector, lambda b: b["label"].startswith("ФИО"))
        _, result = self.write(self.vector, [{"at": line["id"], "text": "Кузнецова Ольга Сергеевна"}])
        self.assertEqual([w.split(":")[0] for w in result["warnings"]], ["nominative_name"])
        _, result = self.write(self.vector, [{"at": line["id"], "text": "Кузнецовой Ольги Сергеевны"}])
        self.assertEqual(result["warnings"], [])

    def test_written_file_keeps_the_ids_of_its_source(self):
        code, source = kit("pdf", "layout", self.vector, cache=self.cache)
        self.assertEqual(code, 0, source)
        before = {b["id"]: b["box"] for b in source["pages"][0]["blanks"]}
        line = self.blank(self.vector, lambda b: b["label"].startswith("ФИО"))
        output, _ = self.write(self.vector, [{"at": line["id"], "text": "Ёжиков Щедрин"}])
        code, written = kit("pdf", "layout", output, cache=self.cache)
        self.assertEqual(code, 0, written)
        blanks = written["pages"][0]["blanks"]
        self.assertEqual({b["id"]: b["box"] for b in blanks}, before)
        self.assertEqual([b["id"] for b in blanks if b.get("filled")], [line["id"]])
        again = os.path.join(self.directory, "again.pdf")
        code, refused = kit("pdf", "write", output, write_json(again + ".json", [{"at": line["id"], "text": "x"}]), "-o", again, cache=self.cache)
        self.assertEqual((code, refused["code"]), (2, "filled_blank"))

    def test_two_cell_comb_gets_a_character_per_cell(self):
        import numpy

        form = small_cells_form(os.path.join(self.directory, "cells.pdf"))
        kopecks = self.blank(form, lambda b: abs(b["box"][0] - KOPECKS_X) < 2)
        output, result = self.write(form, [{"at": kopecks["id"], "text": "50"}])
        self.assertEqual(result["items"][0]["status"], "ok")
        new = render(output, 1, dpi=144, gray=True) < 100
        x0, y0, x1, y1 = kopecks["box"]
        width = (x1 - x0) / 2
        for index in range(2):
            left = x0 + index * width
            # The cell inside its sides, at 2 px per pt.
            ys, xs = numpy.nonzero(new[round(2 * y0 + 4) : round(2 * y1 - 4), round(2 * left + 4) : round(2 * (left + width) - 4)])
            self.assertGreater(len(xs), 20, index)
            centre = left + 2 + xs.mean() / 2
            self.assertLess(abs(centre - (left + width / 2)), 1.5, (index, centre, kopecks["box"]))

    def money_groups(self):
        form = money_row_form(os.path.join(self.directory, "money.pdf"))
        code, result = kit("pdf", "layout", form, cache=self.cache)
        self.assertEqual(code, 0, result)
        combs = {(round(b["box"][0]), round(A4[1] - b["box"][3])): b for b in result["pages"][0]["blanks"] if b["kind"] == "comb"}
        self.assertEqual({key: b["cells"] for key, b in combs.items()}, {(300, 640): 13, (490, 640): 2, (300, 580): 2, (336, 580): 2, (372, 580): 4})
        return form, combs[(300, 640)]["id"], combs[(490, 640)]["id"], combs[(300, 580)]["id"]

    def test_amount_with_kopecks_goes_on_into_the_kopeck_cells(self):
        # 16.10: «180000.00» at the roubles put «.» and the kopecks into rouble cells, the kopeck cells stayed empty.
        form, roubles, _, day = self.money_groups()
        output, result = self.write(form, [{"at": roubles, "text": "180000.00", "dashes": True}, {"at": day, "text": "16.10.2026"}])
        self.assertEqual([item["status"] for item in result["items"]], ["ok", "ok"], result)
        self.assertEqual(cell_texts(output, ROUBLES, 640), list("180000") + ["-"] * 7 + ["0", "0"])
        self.assertEqual(cell_texts(output, DATE, 580), list("16102026"))

    def test_row_wide_comb_count_spreads_over_the_row_groups(self):
        # «"comb": 15» over the 13 rouble cells drew 15 narrower cells: «-» landed in the cells of digits, status ok.
        form, roubles, _, _ = self.money_groups()
        output, result = self.write(form, [{"at": roubles, "text": "180000-------00", "comb": 15}])
        self.assertEqual(result["items"][0]["status"], "ok", result)
        self.assertEqual(cell_texts(output, ROUBLES, 640), list("180000") + ["-"] * 7 + ["0", "0"])
        output = os.path.join(self.directory, "wrong-comb.pdf")
        code, refused = kit("pdf", "write", form, write_json(output + ".json", [{"at": roubles, "text": "180000", "comb": 9}]), "-o", output, cache=self.cache)
        self.assertEqual((code, refused["code"]), (2, "bad_spec"), refused)

    def test_two_items_on_one_cell_group_are_refused(self):
        # Dashes over the whole group and the digits over them: a cell held «1-».
        form, roubles, kopecks, _ = self.money_groups()
        for spec in (
            [{"at": roubles, "text": "-------------"}, {"at": roubles, "text": "180000"}],
            [{"at": roubles, "text": "180000.00"}, {"at": kopecks, "text": "00"}],
        ):
            output = os.path.join(self.directory, "twice.pdf")
            code, refused = kit("pdf", "write", form, write_json(output + ".json", spec), "-o", output, cache=self.cache)
            self.assertEqual((code, refused["code"]), (2, "bad_spec"), refused)
            self.assertIn("dashes", refused["hint"])

    def test_text_on_a_skewed_scan_follows_the_rule(self):
        import numpy

        start, end = self.truth["from"]
        blank = self.blank(self.scan, lambda b: b["kind"] == "line" and abs(b["line"][0] - start[0]) < 2 and abs(b["line"][1] - start[1]) < 2)
        output, _ = self.write(self.scan, [{"at": blank["id"], "text": "ШШШШШШШШШШШШШШШШШШШШШШ", "size": 12}])
        before, after = render(self.scan, 1, dpi=144, gray=True), render(output, 1, dpi=144, gray=True)
        new = (after < 100) & (before > 160)
        ys, xs = numpy.nonzero(new)
        self.assertGreater(len(xs), 500)
        slope = numpy.polyfit(xs, ys, 1)[0]
        expected = (end[1] - start[1]) / (end[0] - start[0])
        self.assertAlmostEqual(math.degrees(math.atan(slope)), math.degrees(math.atan(expected)), delta=0.25)
        self.assertLess(slope, 0)  # the right end is higher, like the rule
        bottom = numpy.percentile(ys[xs < xs.min() + 40], 95) / 2
        self.assertTrue(start[1] - 4 <= bottom <= start[1] + 0.5, (bottom, start))
