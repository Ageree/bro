"""`pdf lines` + `pdf retext`: a translated PDF keeps its pictures and the place of every line."""

import os
import re
import shutil
import tempfile
import unittest

from tests.pdf_fixtures import kit, lines_pdf, pdftotext, render, write_json

ENGLISH = {
    "СПРАВКА": "CERTIFICATE",
    "Дана Соколовой Марии Игоревне в том, что она работает": "This is to certify that Maria Sokolova works",
    "в ООО «Образец» с 01.03.2019 по настоящее время.": "at Obrazets LLC from 01.03.2019 to date.",
    "Справка выдана для предъявления в консульство.": "Issued for submission to the consulate.",
}


@unittest.skipUnless(shutil.which("pdftotext"), "poppler is missing")
class Retext(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="brokit-lines-")
        cls.source = lines_pdf(os.path.join(cls.directory, "spravka.pdf"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def test_lines_report_alignment(self):
        code, result = kit("pdf", "lines", self.source)
        self.assertEqual(code, 0, result)
        found = {line["text"]: line for page in result["pages"] for line in page["lines"]}
        self.assertEqual(found["СПРАВКА"]["align"], "center")
        self.assertTrue(found["СПРАВКА"]["serif"])
        self.assertEqual(found["15.10.2026"]["align"], "right")
        self.assertEqual(found["Справка выдана для предъявления в консульство."]["id"], "p2l1")

    def test_retext_leaves_no_cyrillic_and_keeps_pictures(self):
        code, listed = kit("pdf", "lines", self.source)
        self.assertEqual(code, 0, listed)
        lines = [line for page in listed["pages"] for line in page["lines"]]
        mapping = {line["id"]: ENGLISH[line["text"]] for line in lines if line["text"] in ENGLISH}
        output = os.path.join(self.directory, "spravka-en.pdf")
        code, result = kit("pdf", "retext", self.source, write_json(os.path.join(self.directory, "map.json"), mapping), "-o", output)
        self.assertEqual(code, 0, result)
        self.assertEqual(result["untranslated"], [])
        self.assertEqual(result["images_before"], 1)
        self.assertEqual(result["images_after"], 1)
        text = pdftotext(output)
        self.assertIsNone(re.search(r"[А-Яа-яЁё]", text), text)
        self.assertIn("CERTIFICATE", text)
        for line in lines:
            if line["id"] not in mapping:
                continue
            page = int(line["id"][1:].split("l")[0])
            image = render(output, page, dpi=72, gray=True)
            x0, y0, x1, y1 = (int(round(v)) for v in line["box"])
            self.assertGreater(int((image[y0:y1 + 1, x0:x1 + 1] < 128).sum()), 10, line)
