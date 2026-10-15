"""brokit qr: GOST R 56042-2014 payment payloads (W2 spec §6.12, §9)."""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest

from brokit.qr import gost_payload
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

    def test_account_that_does_not_match_the_bic_is_flagged(self):
        code, result = kit("qr", "--gost", self.fields, "-o", self.path("pay.png"))
        self.assertEqual(code, 0, result)
        self.assertEqual(len([w for w in result["warnings"] if w.startswith("account_checksum")]), 1)

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
