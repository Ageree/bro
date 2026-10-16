"""Signature places: sign-mark, sign-places, stamp-sign — the contract Bro's signer relies on (W2 spec §5.2, §5.3)."""

import os
import re
import shutil
import tempfile
import unittest

from tests.pdf_fixtures import (
    DEJAVU,
    TOKEN,
    add_field,
    contract_pdf,
    kit,
    pdftotext,
    render,
    sig_field,
    signature_png,
    text_field,
    write_json,
)

BOX = [100.0, 100.0, 250.0, 140.0]


def near(a, b, tolerance=0.01):
    return all(abs(x - y) <= tolerance for x, y in zip(a, b))


def widgets(path):
    from pypdf import PdfReader

    return [entry.get_object() for page in PdfReader(path).pages for entry in page.get("/Annots") or []]


@unittest.skipUnless(shutil.which("pdftoppm"), "poppler is missing")
class Sign(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="brokit-sign-")
        cls.home = os.path.join(cls.directory, "home")
        cls.bare = os.path.join(cls.directory, "bare")
        os.makedirs(cls.home)
        os.makedirs(cls.bare)
        with open(os.path.join(cls.home, "mark-token"), "w") as handle:
            handle.write(TOKEN)
        cls.png = signature_png(os.path.join(cls.directory, "signature.png"))
        cls.contract = os.path.join(cls.directory, "contract.pdf")
        cls.boxes = contract_pdf(cls.contract)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.directory, name)

    def mark(self, source, spec, home=None, name=None):
        output = self.path(name or "marked-%d.pdf" % len(os.listdir(self.directory)))
        code, result = kit("pdf", "sign-mark", source, write_json(output + ".json", spec), "-o", output, home=home or self.home)
        return code, result, output

    def places(self, path, token=TOKEN):
        args = ["pdf", "sign-places", path] + (["--mark-token", token] if token else [])
        code, result = kit(*args, home=self.bare)
        self.assertEqual(code, 0, result)
        return result

    def stamp(self, source, places, signature=None, name=None):
        output = self.path(name or "signed-%d.pdf" % len(os.listdir(self.directory)))
        plan = {
            "signing_id": "0b8c1d2e-test",
            "date": "15.10.2026",
            "places": places,
            "signature": signature or {"kind": "image", "png": self.png},
        }
        code, result = kit("pdf", "stamp-sign", source, write_json(output + ".json", plan), "-o", output, home=self.bare)
        return code, result, output

    def assert_ink_only_in(self, before, after, boxes, page=1):
        """New ink lies inside the view boxes (± 2 pt) and every box got some."""
        import numpy

        old, new = render(before, page), render(after, page)
        changed = numpy.abs(new - old).sum(axis=2) > 60
        inside = numpy.zeros_like(changed)
        for x0, y0, x1, y1 in boxes:
            region = (slice(max(0, int(y0) - 2), int(y1) + 3), slice(max(0, int(x0) - 2), int(x1) + 3))
            self.assertGreater(int(changed[region].sum()), 20, (x0, y0, x1, y1))
            inside[region] = True
        self.assertLessEqual(int((changed & ~inside).sum()), 3)
        return changed

    def test_marks_round_trip_on_rotated_cropped_pages_and_sign_upright(self):
        import numpy

        for angle in (0, 90, 180, 270):
            with self.subTest(angle=angle):
                source = self.path("rotated-%d.pdf" % angle)
                contract_pdf(source, rotate=angle, crop_offset=50)
                code, marked, output = self.mark(source, [{"page": 1, "box": BOX, "role": "signature"}])
                self.assertEqual(code, 0, marked)
                self.assertTrue(near(marked["marks"][0]["view_box"], BOX))
                listed = self.places(output)
                place = listed["places"][0]
                self.assertTrue(near(place["view_box"], BOX), place)
                self.assertEqual((place["rotate"], place["marked"], place["bro"]), (angle, True, {"role": "signature", "n": 1}))
                signature = {"kind": "typed", "text": "Ёжиков Щ.Ю.", "initials": "Ё.Щ.", "font": DEJAVU} if angle == 90 else None
                code, signed, result = self.stamp(output, [{"field": "bro_sign_signature_1", "role": "signature"}], signature)
                self.assertEqual(code, 0, signed)
                changed = self.assert_ink_only_in(output, result, [BOX])
                ys, xs = numpy.nonzero(changed)
                self.assertGreater(xs.max() - xs.min(), 1.5 * (ys.max() - ys.min()))  # upright: wider than tall

    def test_token_marks_only_with_the_right_token(self):
        code, with_token, marked = self.mark(self.contract, [{"page": 1, "box": self.boxes["tenant"], "role": "signature"}])
        self.assertEqual(code, 0, with_token)
        self.assertTrue(with_token["token"])
        self.assertTrue(self.places(marked)["places"][0]["marked"])
        self.assertFalse(self.places(marked, token="0" * 32)["places"][0]["marked"])
        self.assertFalse(self.places(marked, token=None)["places"][0]["marked"])
        code, without, unmarked = self.mark(self.contract, [{"page": 1, "box": self.boxes["tenant"], "role": "signature"}], home=self.bare)
        self.assertEqual(code, 0, without)
        self.assertFalse(without["token"])
        self.assertTrue(any(w.startswith("no_mark_token") for w in without["warnings"]))
        self.assertNotIn("/BroMark", widgets(unmarked)[0])
        self.assertFalse(self.places(unmarked)["places"][0]["marked"])

    def test_places_take_labels_from_the_page_and_a_mark_vouches_only_for_its_own_place(self):
        from pypdf import PdfWriter
        from pypdf.generic import NameObject, TextStringObject

        code, result, output = self.mark(self.contract, [{"page": 1, "box": self.boxes["landlord"], "role": "signature"}])
        self.assertEqual(code, 0, result)
        with open(output, "rb") as handle:
            self.assertNotIn(TOKEN.encode("ascii"), handle.read())
        writer = PdfWriter(clone_from=output)
        landlord = next(w for w in (a.get_object() for a in writer.pages[0]["/Annots"]) if w.get("/T") == "bro_sign_signature_1")
        landlord[NameObject("/BroLabel")] = TextStringObject("НАНИМАТЕЛЬ: (подпись)")
        copied = sig_field("bro_sign_signature_2", [60, 400, 200, 430])
        copied[NameObject("/BroMark")] = landlord["/BroMark"]
        add_field(writer, 0, copied)
        plain = sig_field("bro_sign_signature_3", [60, 300, 200, 330])
        plain[NameObject("/BroMark")] = TextStringObject(TOKEN)
        add_field(writer, 0, plain)
        writer.write(output)
        listed = {place["field"]: place for place in self.places(output)["places"]}
        self.assertTrue(listed["bro_sign_signature_1"]["label"].startswith("НАЙМОДАТЕЛЬ:"), listed["bro_sign_signature_1"])
        marked = {name: place["marked"] for name, place in listed.items()}
        self.assertEqual(marked, {"bro_sign_signature_1": True, "bro_sign_signature_2": False, "bro_sign_signature_3": False})

    def test_labels_name_each_column_and_roles_are_checked(self):
        code, result, _ = self.mark(
            self.contract,
            [{"page": 1, "box": self.boxes["landlord"], "role": "signature"}, {"page": 1, "box": self.boxes["tenant"], "role": "signature"}],
        )
        self.assertEqual(code, 0, result)
        landlord, tenant = (mark["label"] for mark in result["marks"])
        self.assertTrue(landlord.startswith("НАЙМОДАТЕЛЬ:") and "НАНИМАТЕЛЬ" not in landlord, landlord)
        self.assertTrue(tenant.startswith("НАНИМАТЕЛЬ:") and "НАЙМОДАТЕЛЬ" not in tenant, tenant)
        self.assertIn("(подпись)", tenant)
        for role in ("name", "stamp"):
            code, refused, _ = self.mark(self.contract, [{"page": 1, "box": self.boxes["tenant"], "role": role}])
            self.assertEqual((code, refused["code"]), (2, "bad_role"))

    def test_adopt_renames_a_native_signature_field(self):
        source = self.path("native.pdf")
        contract_pdf(source, native_sig=[330, 182, 450, 210])
        output = self.path("adopted.pdf")
        code, result = kit("pdf", "sign-mark", source, "--adopt", "signature", "-o", output, home=self.home)
        self.assertEqual(code, 0, result)
        self.assertEqual(result["marks"][0]["field"], "bro_sign_signature_1")
        self.assertTrue(result["marks"][0]["adopted"])
        self.assertTrue(result["marks"][0]["label"].startswith("НАНИМАТЕЛЬ:"))
        listed = self.places(output)
        self.assertEqual([(p["field"], p["type"], p["marked"]) for p in listed["places"]], [("bro_sign_signature_1", "signature", True)])
        code, missing = kit("pdf", "sign-mark", source, "--adopt", "nothing", "-o", self.path("x.pdf"), home=self.home)
        self.assertEqual((code, missing["code"]), (2, "adopt_missing"))

    def test_places_report_encryption_and_signed_fields(self):
        from brokit import aes
        from pypdf import PdfWriter

        aes.install()
        locked = self.path("locked.pdf")
        writer = PdfWriter(clone_from=self.contract)
        writer.encrypt(user_password="", owner_password="owner", algorithm="AES-128")
        writer.write(locked)
        self.assertEqual(self.places(locked)["status"], "encrypted")
        signed = self.path("signed-native.pdf")
        writer = PdfWriter(clone_from=self.contract)
        add_field(writer, 0, sig_field("director", [60, 182, 180, 210], signed=True))
        writer.write(signed)
        listed = self.places(signed)
        self.assertEqual((listed["status"], listed["signed_fields"], listed["places"]), ("ok", ["director"], []))
        code, refused, _ = self.stamp(signed, [{"field": "director", "role": "signature"}])
        self.assertEqual((code, refused["code"]), (2, "already_signed"))

    def test_stamp_sign_draws_the_places_and_removes_every_field(self):
        source = self.path("with-native.pdf")
        contract_pdf(source, native_sig=[335, 180, 445, 212])
        from pypdf import PdfWriter

        writer = PdfWriter(clone_from=source)
        add_field(writer, 0, text_field("комментарий", [60, 300, 300, 320], value="уже заполнено"))
        writer.write(source)
        date_box = [362.0, 688.0, 450.0, 704.0]
        code, marked, output = self.mark(
            source,
            [{"page": 1, "box": self.boxes["tenant"], "role": "signature"}, {"page": 1, "box": date_box, "role": "date"}],
        )
        self.assertEqual(code, 0, marked)
        self.assertTrue(any(w.startswith("overlaps_field") for w in marked["warnings"]))
        code, refused, _ = self.stamp(output, [{"field": "bro_sign_signature_9", "role": "signature"}])
        self.assertEqual((code, refused["code"]), (2, "plan_mismatch"))
        code, refused, _ = self.stamp(output, [{"field": "комментарий", "role": "date"}])
        self.assertEqual((code, refused["code"]), (2, "plan_mismatch"))
        code, result, signed = self.stamp(
            output, [{"field": "bro_sign_signature_1", "role": "signature"}, {"field": "bro_sign_date_1", "role": "date"}]
        )
        self.assertEqual(code, 0, result)
        self.assertEqual(sorted(result["removed"]), ["bro_sign_date_1", "bro_sign_signature_1", "signature"])
        self.assertEqual([w.get("/T") for w in widgets(signed)], ["комментарий"])
        self.assert_ink_only_in(output, signed, [self.boxes["tenant"], date_box])
        from pypdf import PdfReader

        info = PdfReader(signed).metadata
        self.assertIn("signed-by-bro 0b8c1d2e-test", info["/Keywords"])
        self.assertEqual(info["/Producer"], "Бро")
        self.assertIn("15.10.2026", pdftotext(signed))
        code, again, _ = self.stamp(signed, [{"field": "комментарий", "role": "signature"}])
        self.assertEqual((code, again["code"]), (2, "signed_by_bro"))

    def test_signed_file_keeps_no_scaffolding_and_no_token(self):
        from pypdf import PdfReader, PdfWriter
        from pypdf.generic import NameObject, TextStringObject

        code, marked, output = self.mark(self.contract, [{"page": 1, "box": self.boxes["tenant"], "role": "signature"}])
        self.assertEqual(code, 0, marked)
        writer = PdfWriter(clone_from=output)
        # A look-alike name (Arabic-Indic digit) is not a mark, and a mark without a widget on any page (left by a script).
        lookalike = sig_field("bro_sign_signature_١", [60, 400, 200, 430])
        lookalike[NameObject("/BroMark")] = TextStringObject(TOKEN)
        add_field(writer, 0, lookalike)
        orphan = writer._add_object(sig_field("bro_sign_initials_7", [60, 500, 200, 530]))
        orphan.get_object()[NameObject("/BroMark")] = TextStringObject(TOKEN)
        writer._root_object["/AcroForm"]["/Fields"].append(orphan)
        writer.write(output)
        listed = {place["raw_name"]: place for place in self.places(output)["places"]}
        self.assertEqual(sorted(listed), ["bro_sign_signature_1", "bro_sign_signature_١"])
        self.assertEqual((listed["bro_sign_signature_١"]["bro"], listed["bro_sign_signature_١"]["marked"]), (None, False))
        code, result, signed = self.stamp(output, [{"field": "bro_sign_signature_1", "role": "signature"}])
        self.assertEqual(code, 0, result)
        reader = PdfReader(signed)
        self.assertEqual(reader.trailer["/Root"]["/AcroForm"]["/Fields"], [])
        self.assertEqual(widgets(signed), [])
        with open(signed, "rb") as handle:
            self.assertNotIn(TOKEN.encode("ascii"), handle.read())

    def test_date_fits_a_narrow_box(self):
        narrow = [362.0, 688.0, 406.0, 702.0]
        code, marked, output = self.mark(
            self.contract, [{"page": 1, "box": self.boxes["tenant"], "role": "signature"}, {"page": 1, "box": narrow, "role": "date"}]
        )
        self.assertEqual(code, 0, marked)
        code, result, signed = self.stamp(
            output, [{"field": "bro_sign_signature_1", "role": "signature"}, {"field": "bro_sign_date_1", "role": "date"}]
        )
        self.assertEqual(code, 0, result)
        self.assert_ink_only_in(output, signed, [self.boxes["tenant"], narrow])
        # The stamp clips to its box, so a date wider than the box would lose its last digits.
        found = re.search(r'xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)" yMax="[\d.]+">15\.10\.2026<', pdftotext(signed, "-bbox"))
        self.assertIsNotNone(found)
        self.assertTrue(narrow[0] <= float(found.group(1)) and float(found.group(2)) <= narrow[2], found.groups())

    def test_mark_stays_on_its_page_when_pages_share_annotations(self):
        from pypdf import PdfWriter
        from pypdf.generic import ArrayObject, NameObject

        writer = PdfWriter()
        for _ in range(2):
            writer.add_blank_page(width=595, height=842)
        shared = writer._add_object(ArrayObject())
        for page in writer.pages:
            page[NameObject("/Annots")] = shared
        source = self.path("shared-annots.pdf")
        writer.write(source)
        code, marked, output = self.mark(source, [{"page": 1, "box": BOX, "role": "signature"}])
        self.assertEqual(code, 0, marked)
        self.assertEqual([(p["field"], p["page"]) for p in self.places(output)["places"]], [("bro_sign_signature_1", 1)])

    def test_mark_by_layout_id_takes_its_page(self):
        cache = self.path("cache")
        code, layout = kit("pdf", "layout", self.contract, cache=cache)
        self.assertEqual(code, 0, layout)
        blank = next(b for b in layout["pages"][0]["blanks"] if b["label"].startswith("НАНИМАТЕЛЬ"))
        output = self.path("marked-at.pdf")
        spec = write_json(output + ".json", [{"at": blank["id"], "role": "signature"}])
        code, result = kit("pdf", "sign-mark", self.contract, spec, "-o", output, home=self.home, cache=cache)
        self.assertEqual(code, 0, result)
        mark = result["marks"][0]
        self.assertEqual((mark["page"], mark["label"]), (1, blank["label"]))
        self.assertTrue(near(mark["view_box"], blank["box"], 0.1), (mark["view_box"], blank["box"]))

    def test_labels_follow_the_text_on_rotated_pages(self):
        from brokit.pdf import geom
        from pypdf import PdfReader

        for angle in (90, 180, 270):
            with self.subTest(angle=angle):
                source = self.path("labels-%d.pdf" % angle)
                contract_pdf(source, rotate=angle, crop_offset=50)
                page = PdfReader(source).pages[0]
                spec = [{"page": 1, "box": geom.user_to_view(page, box), "role": "signature"} for box in ([60, 182, 180, 210], [330, 182, 450, 210])]
                code, result, _ = self.mark(source, spec)
                self.assertEqual(code, 0, result)
                self.assertEqual([mark["label"] for mark in result["marks"]], ["НАЙМОДАТЕЛЬ: · (подпись)", "НАНИМАТЕЛЬ: · (подпись)"])

    def test_a_signature_without_a_widget_still_blocks_signing(self):
        from pypdf import PdfWriter

        code, marked, output = self.mark(self.contract, [{"page": 1, "box": self.boxes["tenant"], "role": "signature"}])
        self.assertEqual(code, 0, marked)
        writer = PdfWriter(clone_from=output)
        writer._root_object["/AcroForm"]["/Fields"].append(writer._add_object(sig_field("notary", [0, 0, 0, 0], signed=True)))
        writer.write(output)
        self.assertEqual(self.places(output)["signed_fields"], ["notary"])
        code, refused, _ = self.stamp(output, [{"field": "bro_sign_signature_1", "role": "signature"}])
        self.assertEqual((code, refused["code"]), (2, "already_signed"))
