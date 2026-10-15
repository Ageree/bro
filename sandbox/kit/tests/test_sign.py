"""Signature places: sign-mark, sign-places, stamp-sign — the contract Bro's signer relies on (W2 spec §5.2, §5.3)."""

import os
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
