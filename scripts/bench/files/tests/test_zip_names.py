"""The ZIP inventory and content checks read a file the way a person would: by its name and its text."""

import unittest

from checks.misc import _text_of
from checks.office import _names_file


class ZipNamesTest(unittest.TestCase):
    def test_a_file_inside_an_archive_is_named_in_any_usual_way(self):
        # Live 16.10: «старое.zip → договор.doc» in the inventory read as «not decoded».
        for cell in ("договор.doc", "старое.zip/договор.doc", "старое.zip → договор.doc", "старое.zip > договор.doc"):
            self.assertTrue(_names_file(cell, "договор.doc"), cell)
        self.assertFalse(_names_file("мойдоговор.doc", "договор.doc"))

    def test_a_note_recoded_from_cp1251_is_the_same_text(self):
        # Live 16.10: a cp1251 note came back in UTF-8, and the content check missed it.
        text = "Список дел на дачу\r\n1. Покрасить забор\r\n"
        self.assertEqual(_text_of(text.encode("cp1251")), _text_of(("﻿" + text.replace("\r\n", "\n")).encode("utf-8")))
        self.assertNotEqual(_text_of("Список дел".encode("cp1251")), _text_of("Список покупок".encode("utf-8")))


if __name__ == "__main__":
    unittest.main()
