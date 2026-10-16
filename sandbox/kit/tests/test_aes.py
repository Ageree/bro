"""brokit/aes.py: FIPS-197 vectors, CBC round trips, and PDFs poppler opens both ways."""

import os
import shutil
import subprocess
import tempfile
import unittest

from brokit import aes
from tests.pdf_fixtures import kit, lines_pdf, pdftotext

KEY_128 = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
KEY_256 = bytes.fromhex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
PLAIN = bytes.fromhex("00112233445566778899aabbccddeeff")


class Cipher(unittest.TestCase):
    def test_fips_197_vectors(self):
        self.assertEqual(aes.aes_ecb_encrypt(KEY_128, PLAIN).hex(), "69c4e0d86a7b0430d8cdb78070b4c55a")
        self.assertEqual(aes.aes_ecb_encrypt(KEY_256, PLAIN).hex(), "8ea2b7ca516745bfeafc49904b496089")
        self.assertEqual(aes.Key(KEY_128).encrypt_block(PLAIN).hex(), "69c4e0d86a7b0430d8cdb78070b4c55a")
        self.assertEqual(aes.aes_ecb_decrypt(KEY_256, bytes.fromhex("8ea2b7ca516745bfeafc49904b496089")), PLAIN)
        self.assertEqual(aes.aes_ecb_decrypt(KEY_128, bytes.fromhex("69c4e0d86a7b0430d8cdb78070b4c55a")), PLAIN)

    def test_cbc_round_trips_and_padding(self):
        data, iv = os.urandom(16 * 300), os.urandom(16)
        for key in (KEY_128, KEY_256):
            self.assertEqual(aes.aes_cbc_decrypt(key, iv, aes.aes_cbc_encrypt(key, iv, data)), data)
            crypt = aes.CryptAES(key)
            self.assertEqual(crypt.decrypt(crypt.encrypt(b"short text")), b"short text")


@unittest.skipUnless(shutil.which("pdftotext"), "poppler is missing")
class Pdfs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.mkdtemp(prefix="brokit-aes-")
        cls.plain = lines_pdf(os.path.join(cls.directory, "plain.pdf"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.directory, ignore_errors=True)

    def test_encrypted_by_the_kit_opens_in_poppler(self):
        for bits in ("256", "128"):
            locked = os.path.join(self.directory, "locked-%s.pdf" % bits)
            code, result = kit("pdf", "encrypt", self.plain, "--password", "Kvartira-2026", "--aes", bits, "-o", locked)
            self.assertEqual(code, 0, result)
            self.assertEqual(result["algorithm"], "AES-" + bits)
            self.assertNotIn("Kvartira-2026", str(result))
            self.assertIn("СПРАВКА", pdftotext(locked, "-upw", "Kvartira-2026"))
            failed = subprocess.run(["pdftotext", locked, "-"], capture_output=True)
            self.assertNotEqual(failed.returncode, 0)

    def test_decrypt_with_the_password_and_refusals(self):
        locked = os.path.join(self.directory, "locked.pdf")
        kit("pdf", "encrypt", self.plain, "--password", "secret-1", "-o", locked)
        code, info = kit("pdf", "info", locked)
        self.assertEqual((code, info["needs_password"], info["algorithm"]), (0, True, "AES-256"))
        code, refused = kit("pdf", "text", locked)
        self.assertEqual((code, refused["code"]), (2, "encrypted"))
        code, wrong = kit("pdf", "decrypt", locked, "--password", "nope", "-o", os.path.join(self.directory, "x.pdf"))
        self.assertEqual((code, wrong["code"]), (2, "bad_password"))
        opened = os.path.join(self.directory, "opened.pdf")
        code, result = kit("pdf", "decrypt", locked, "--password", "secret-1", "-o", opened)
        self.assertEqual(code, 0, result)
        self.assertIn("СПРАВКА", pdftotext(opened))

    def test_rc4_and_empty_user_password(self):
        from pypdf import PdfWriter

        rc4 = os.path.join(self.directory, "rc4.pdf")
        writer = PdfWriter(clone_from=self.plain)
        writer.encrypt(user_password="pw", owner_password="owner", algorithm="RC4-128")
        writer.write(rc4)
        code, result = kit("pdf", "decrypt", rc4, "--password", "pw", "-o", os.path.join(self.directory, "rc4-open.pdf"))
        self.assertEqual((code, result["algorithm"]), (0, "RC4-128"))
        restricted = os.path.join(self.directory, "restricted.pdf")
        aes.install()
        writer = PdfWriter(clone_from=self.plain)
        writer.encrypt(user_password="", owner_password="owner", algorithm="AES-256")
        writer.write(restricted)
        code, text = kit("pdf", "text", restricted)
        self.assertEqual(code, 0, text)
        self.assertIn("СПРАВКА", text["text"])
        self.assertTrue(any(w.startswith("encrypted_empty_password") for w in text["warnings"]))
