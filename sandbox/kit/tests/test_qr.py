"""brokit qr: GOST R 56042-2014 payment payloads (W2 spec §6.12, §9)."""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest

from brokit.qr import gost_payload, qr_matrix
from brokit.util import KitError
from tests.cli_run import has, kit

FIELDS = {
    "Name": "ИП Тестов Тест Тестович",
    "PersonalAcc": "40802810938000000001",
    "BankName": "ПАО Сбербанк",
    "BIC": "044525225",
    "CorrespAcc": "30101810400000000225",
    "Sum": "2450000",
    "Purpose": "Оплата по счёту № 15 от 03.02.2026",
    "PayeeINN": "770000000000",
}


class QrTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.fields = os.path.join(cls.dir.name, "fields.json")
        with open(cls.fields, "w", encoding="utf-8") as handle:
            json.dump(FIELDS, handle, ensure_ascii=False)

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def path(self, name):
        return os.path.join(self.dir.name, name)

    def test_payload_has_the_gost_header_and_required_keys_first(self):
        shuffled = dict(reversed(list(FIELDS.items())))
        payload = gost_payload(shuffled)
        self.assertTrue(payload.startswith("ST00012|Name=ИП Тестов Тест Тестович|PersonalAcc=40802810938000000001|"))
        self.assertIn("Sum=2450000", payload.split("|"))

    def test_bad_values_are_refused(self):
        for broken in ({"Purpose": "оплата | аванс"}, {"BIC": "04452522"}, {"Name": ""}):
            with self.assertRaises(KitError):
                gost_payload(dict(FIELDS, **broken))

    def test_business_account_needs_the_payee_inn(self):
        # Bank apps refuse a payment to an organisation's or ИП's account
        # (405-407, 40802, 40821) without the payee's INN.
        without_inn = {key: value for key, value in FIELDS.items() if key != "PayeeINN"}
        with self.assertRaises(KitError) as caught:
            gost_payload(without_inn)
        self.assertEqual(caught.exception.code, "bad_fields")
        self.assertIn("PayeeINN", caught.exception.error)
        # A person's own account (40817) is paid without it.
        self.assertTrue(gost_payload(dict(without_inn, PersonalAcc="40817810938000000001")).startswith("ST00012|"))

    def test_ready_gost_text_is_checked_like_fields(self):
        def text(fields):
            return "|".join(["ST00012"] + ["%s=%s" % item for item in fields.items()])

        without_inn = {key: value for key, value in FIELDS.items() if key != "PayeeINN"}
        code, result = kit("qr", "--text", text(without_inn), "-o", self.path("ready.png"))
        self.assertEqual((code, result.get("code")), (2, "bad_fields"))
        with self.assertRaises(KitError):
            qr_matrix(text(without_inn))
        code, result = kit("qr", "--text", text(FIELDS), "-o", self.path("ready.png"))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["payload"], gost_payload(FIELDS))
        self.assertTrue(any(w.startswith("account_checksum") for w in result["warnings"]))

    def test_account_that_does_not_match_the_bic_is_flagged(self):
        code, result = kit("qr", "--gost", self.fields, "-o", self.path("pay.png"))
        self.assertEqual(code, 0, result)
        self.assertEqual(len([w for w in result["warnings"] if w.startswith("account_checksum")]), 1)

    def test_text_too_long_for_a_qr_code_is_refused(self):
        code, result = kit("qr", "--text", "я" * 3000, "-o", self.path("long.png"))
        self.assertEqual((code, result["code"]), (2, "too_long"))

    @unittest.skipUnless(importlib.util.find_spec("zxingcpp"), "zxing-cpp is not installed")
    def test_png_and_pdf_decode_back_to_the_payload(self):
        import zxingcpp
        from PIL import Image

        code, result = kit("qr", "--gost", self.fields, "-o", self.path("pay.png"), "--size-mm", "30")
        self.assertEqual(code, 0, result)
        decoded = [r.text for r in zxingcpp.read_barcodes(Image.open(self.path("pay.png")))]
        self.assertEqual(decoded, [result["payload"]])
        code, result = kit("qr", "--gost", self.fields, "-o", self.path("pay.pdf"))
        self.assertEqual(code, 0, result)
        if has("pdftoppm"):
            subprocess.run(["pdftoppm", "-r", "300", "-png", "-singlefile", self.path("pay.pdf"), self.path("page")], check=True)
            decoded = [r.text for r in zxingcpp.read_barcodes(Image.open(self.path("page.png")))]
            self.assertEqual(decoded, [result["payload"]])


if __name__ == "__main__":
    unittest.main()
