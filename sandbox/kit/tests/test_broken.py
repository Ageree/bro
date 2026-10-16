"""Broken PDFs end in a refusal with a code (exit 2) or a result, never in a crash (exit 1)."""

import os
import shutil
import tempfile
import unittest

from tests.pdf_fixtures import TOKEN, contract_pdf, kit, write_json


def broken(path, source, change):
    from pypdf import PdfWriter

    writer = PdfWriter(clone_from=source)
    change(writer)
    writer.write(path)
    return path


def annots_not_array(writer):
    from pypdf.generic import NameObject, NumberObject

    writer.pages[0][NameObject("/Annots")] = NumberObject(5)


def fields_null(writer):
    from pypdf.generic import NameObject, NullObject

    writer._root_object["/AcroForm"][NameObject("/Fields")] = NullObject()


def rect_and_rotate_strings(writer):
    from pypdf.generic import ArrayObject, NameObject, NumberObject, TextStringObject

    page = writer.pages[0]
    page[NameObject("/Rotate")] = TextStringObject("x")
    for entry in page["/Annots"]:
        entry.get_object()[NameObject("/Rect")] = ArrayObject([TextStringObject("a"), NumberObject(1), NumberObject(2), NumberObject(3)])


@unittest.skipUnless(shutil.which("pdftotext"), "poppler is missing")
class Broken(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="brokit-broken-")
        contract = os.path.join(cls.directory, "contract.pdf")
        contract_pdf(contract, native_sig=[330, 182, 450, 210])
        cls.files = {
            change.__name__: broken(os.path.join(cls.directory, change.__name__ + ".pdf"), contract, change)
            for change in (annots_not_array, fields_null, rect_and_rotate_strings)
        }
        cls.values = write_json(os.path.join(cls.directory, "values.json"), {"signature": "x"})
        cls.spec = write_json(os.path.join(cls.directory, "spec.json"), [{"page": 1, "box": [100, 100, 250, 140], "role": "signature"}])
        cls.plan = write_json(
            os.path.join(cls.directory, "plan.json"),
            {"signing_id": "x", "places": [{"field": "signature", "role": "signature"}], "signature": {"kind": "typed", "text": "А", "font": "/nonexistent"}},
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def test_no_command_crashes(self):
        out = os.path.join(self.directory, "out.pdf")
        for name, path in self.files.items():
            for args in (
                ("pdf", "info", path),
                ("pdf", "fill", path, self.values, "-o", out),
                ("pdf", "sign-mark", path, self.spec, "-o", out),
                ("pdf", "sign-spots", path),
                ("pdf", "sign-places", path, "--mark-token", TOKEN),
                ("pdf", "stamp-sign", path, self.plan, "-o", out),
                ("pdf", "rotate", path, "--angle", "90", "-o", out),
            ):
                with self.subTest(file=name, command=args[1]):
                    code, result = kit(*args)
                    self.assertIn(code, (0, 2), result)
                    self.assertNotEqual(result.get("code"), "bug", result)
