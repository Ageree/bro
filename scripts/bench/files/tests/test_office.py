"""DOCX kinds that compare an answer with the case's input."""

import io
import pathlib
import shutil
import tempfile
import unittest

from check import evaluate
from tests.runs import make_run
from tests.samples import context


def docx_bytes(text: str) -> bytes:
    import docx

    document = docx.Document()
    document.add_paragraph(text)
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


class PartsUnchangedTest(unittest.TestCase):
    def test_parts_the_input_does_not_have_prove_nothing(self):
        root = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        case = {"id": "f-test", "turns": [{"text": "x", "files": ["dogovor.docx"]}], "fixtures": []}
        (root / "fixtures" / "f-test").mkdir(parents=True)
        (root / "fixtures" / "f-test" / "dogovor.docx").write_bytes(docx_bytes("Договор"))
        case_dir = make_run(root / "out", "f-test", files=[(0, docx_bytes("Договор, правки"), "dogovor.docx")])
        ctx = context(case, case_dir, root / "fixtures")
        outcome, _ = evaluate(ctx, {"kind": "docx_parts_unchanged", "params": {"parts": ["word/header*.xml"]}})
        self.assertEqual(outcome.status, "error")


if __name__ == "__main__":
    unittest.main()
