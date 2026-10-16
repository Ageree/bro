"""`pdf write`: text lands in its blank; on a skewed scan it follows the rule's angle."""

import math
import os
import re
import shutil
import subprocess
import tempfile
import unittest

from tests.pdf_fixtures import A4, kit, render, scan_form, write_json
from tests.test_layout import vector_form


def word_boxes(path):
    xml = subprocess.run(["pdftotext", "-bbox", path, "-"], capture_output=True, check=True).stdout.decode("utf-8")
    return {
        m.group(5): [float(m.group(i)) for i in range(1, 5)]
        for m in re.finditer(r'xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<', xml)
    }


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
