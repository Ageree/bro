"""f-egrn-xml-to-pdf: a value wrapped inside a table cell is found whole, though reading order interleaves it with the
next column's lines."""

import pathlib
import shutil
import tempfile
import unittest

from check import evaluate
from tests.runs import make_run
from tests.samples import context, pdf

CASE = {"id": "f-test", "turns": [], "fixtures": []}

# Drawn cell by cell, as a table is: the first column's two lines, then the second's.
TABLE = pdf(texts=[(60, 700, "Ipoteka v sile"), (60, 688, "zakona"), (140, 700, "PAO Bank"), (140, 688, "Obrazec, INN")])


@unittest.skipUnless(shutil.which("pdftotext"), "needs poppler")
class WrappedCellTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)

    def outcome(self, wanted):
        case_dir = make_run(self.root / "out", "f-test", files=[(0, TABLE, "vypiska.pdf")])
        ctx = context(CASE, case_dir, self.root / "fixtures")
        try:
            return evaluate(ctx, {"kind": "pdf_text_contains", "params": {"all_of": wanted}})[0]
        finally:
            ctx.cleanup()

    def test_the_wrapped_value_is_found(self):
        got = self.outcome(["Bank Obrazec"])
        self.assertEqual(got.status, "pass", got.detail)

    def test_words_that_are_not_there_still_fail(self):
        self.assertEqual(self.outcome(["Bank Specimen"]).status, "fail")


if __name__ == "__main__":
    unittest.main()
