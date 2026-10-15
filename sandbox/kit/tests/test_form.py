"""`pdf fill`: Cyrillic appearances, flattening, and signature fields left alone."""

import os
import shutil
import tempfile
import unittest

from tests.pdf_fixtures import TOKEN, form_pdf, kit, pdftotext, write_json

VALUES = {
    "fio": "Иванов-Щедрин Александр Владимирович",
    "passport": "0015 246813",
    "address": "г. Москва, ул. Большая Дмитровка, д. 7/5, стр. 2, кв. 145; домофон 145В",
    "agree": True,
    "gender": "female",
    "city": "Казань",
    "comment": "Повёрнутая страница: ёжик",
}


def widget_names(path):
    from pypdf import PdfReader

    names = []
    for page in PdfReader(path).pages:
        for entry in page.get("/Annots") or []:
            widget = entry.get_object()
            field = widget if "/T" in widget else widget["/Parent"].get_object()
            names.append(str(field["/T"]))
    return names


@unittest.skipUnless(shutil.which("pdftotext"), "poppler is missing")
class Fill(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="brokit-form-")
        cls.form = form_pdf(os.path.join(cls.directory, "form.pdf"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def fill(self, values, *flags):
        output = os.path.join(self.directory, "out-%d.pdf" % len(os.listdir(self.directory)))
        code, result = kit("pdf", "fill", self.form, write_json(output + ".json", values), "-o", output, *flags)
        return code, result, output

    def test_flatten_keeps_cyrillic_text_and_drops_filled_widgets(self):
        code, result, output = self.fill(VALUES)
        self.assertEqual(code, 0, result)
        self.assertEqual(result["problems"], [])
        text = pdftotext(output)
        for value in ("Иванов-Щедрин Александр Владимирович", "Казань", "Повёрнутая страница: ёжик", "Дмитровка"):
            self.assertIn(value, text)
        self.assertIn("0 0 1 5 2 4 6 8 1 3", pdftotext(output, "-layout").replace("  ", " "))
        left = widget_names(output)
        for name in VALUES:
            self.assertNotIn(name, left)
        self.assertIn("note", left)
        self.assertIn("note", result["left_empty"])

    def test_signature_fields_and_marks_are_kept_and_reserved(self):
        code, result, output = self.fill(dict(VALUES, **{"Подпись заявителя": "x", "bro_sign_signature_1": "y"}))
        self.assertEqual(code, 0, result)
        self.assertEqual(sorted(result["kept"]), ["bro_sign_signature_1", "Подпись заявителя"])
        problems = {p["field"]: p["problem"] for p in result["problems"]}
        self.assertEqual(problems, {"Подпись заявителя": "reserved", "bro_sign_signature_1": "reserved"})
        left = widget_names(output)
        self.assertIn("bro_sign_signature_1", left)
        self.assertIn("Подпись заявителя", left)

    def test_problems_comb_overflow_and_missing_option(self):
        code, result, _ = self.fill({"passport": "001524681399", "note": "очень длинное значение, " * 6, "gender": "other"})
        self.assertEqual(code, 0, result)
        problems = {p["field"]: p for p in result["problems"]}
        self.assertEqual(problems["passport"]["problem"], "overflow")
        self.assertEqual(problems["note"]["problem"], "overflow")
        self.assertEqual(problems["gender"]["problem"], "no_option")
        self.assertEqual(sorted(problems["gender"]["options"]), ["female", "male"])
        self.assertNotIn("gender", result["filled"])

    def test_keep_fields_sets_values_and_appearances(self):
        from pypdf import PdfReader

        code, result, output = self.fill({"fio": "Ёжиков Щ. Ю.", "agree": True}, "--keep-fields")
        self.assertEqual(code, 0, result)
        reader = PdfReader(output)
        self.assertIs(reader.trailer["/Root"]["/AcroForm"]["/NeedAppearances"].value, False)
        fields = reader.get_fields()
        self.assertEqual(fields["fio"]["/V"], "Ёжиков Щ. Ю.")
        self.assertEqual(fields["agree"]["/V"], "/Yes")
        widget = next(a.get_object() for a in reader.pages[0]["/Annots"] if a.get_object().get("/T") == "fio")
        self.assertIn("/N", widget["/AP"])

    def test_info_names_fields_and_flags_foreign_marks(self):
        home = os.path.join(self.directory, "home")
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "mark-token"), "w") as handle:
            handle.write(TOKEN)
        code, info = kit("pdf", "info", self.form, home=home)
        self.assertEqual(code, 0, info)
        fields = {field["name"]: field for field in info["fields"]}
        self.assertEqual((fields["passport"]["comb"], fields["passport"]["maxlen"]), (True, 10))
        self.assertEqual(fields["agree"]["label"], "Согласен с условиями")
        self.assertEqual([button["label"] for button in fields["gender"]["widgets"]], ["мужской", "женский"])
        self.assertEqual([(s["name"], s["signed"]) for s in info["signature_fields"]], [("Подпись заявителя", False), ("bro_sign_signature_1", False)])
        self.assertEqual(info["foreign_marks"], [])
        code, elsewhere = kit("pdf", "info", self.form)
        self.assertEqual((code, elsewhere["foreign_marks"]), (0, ["bro_sign_signature_1"]))
