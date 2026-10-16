"""brokit ru phone: numbers in +7… form, a dialable tel, and what is left as written."""

import os
import tempfile
import unittest

from tests.cli_run import kit


def rows(*numbers):
    code, result = kit("ru", "phone", *numbers)
    if code != 0:
        raise AssertionError(result)
    return result


class PhoneTest(unittest.TestCase):
    def test_russian_forms_become_plus_seven(self):
        cases = [
            ("8 (495) 000-00-01", "+74950000001", "city"),
            ("+7 916 123-45-67", "+79161234567", "mobile"),
            ("89161234567", "+79161234567", "mobile"),
            ("7 916 123 45 67", "+79161234567", "mobile"),
            ("4951234567", "+74951234567", "city"),
            ("тел.: 8-800-555-35-35", "+78005553535", "city"),
            ("8 (3412) 12-34-56", "+73412123456", "city"),
            ("8 727 123 45 67", "+77271234567", "foreign"),  # Kazakhstan shares +7
            ("+44 20 7946 0958", "+442079460958", "foreign"),
            ("00 49 30 1234567", "+49301234567", "foreign"),
        ]
        result = rows(*[text for text, _, _ in cases])
        got = [(row["in"], row["e164"], row["kind"]) for row in result["numbers"]]
        self.assertEqual(got, [(text.strip(), e164, kind) for text, e164, kind in cases])
        self.assertEqual([row["tel"] for row in result["numbers"]], [e164 for _, e164, _ in cases])
        self.assertEqual(result["unsure"], [])

    def test_extension_is_dialed_after_a_comma(self):
        for text, ext in (
            ("8 (495) 000-00-01 доб. 123", "123"),
            ("8 (495) 000-00-01, доб 123", "123"),
            ("+7 495 000-00-01 добавочный 123", "123"),
            ("+7 495 000-00-01 (вн. 45)", "45"),
            ("+7 495 000-00-01 внутр. 45", "45"),
            ("+7 495 000-00-01 ext. 7", "7"),
            ("+7 495 000-00-01 x7", "7"),
            ("84950000001#7", "7"),
        ):
            row = rows(text)["numbers"][0]
            self.assertEqual((row["e164"], row["ext"], row["tel"]), ("+74950000001", ext, "+74950000001," + ext), text)

    def test_what_is_not_sure_stays_as_written(self):
        result = rows("123-45-67", "+8 916 123 45 67", "8916123456", "7012345678", "+7 916 123 45 6")
        problems = [(row["in"], row["tel"], row["e164"], row["problem"]) for row in result["numbers"]]
        self.assertEqual(
            problems,
            [
                ("123-45-67", "123-45-67", None, "no_area_code"),
                ("+8 916 123 45 67", "+8 916 123 45 67", None, "plus_eight"),
                ("8916123456", "8916123456", None, "unknown_code"),  # a digit short, not code 891
                ("7012345678", "7012345678", None, "unknown_code"),
                ("+7 916 123 45 6", "+7 916 123 45 6", None, "bad_length"),
            ],
        )
        self.assertEqual([item["in"] for item in result["unsure"]], [p[0] for p in problems])
        self.assertIn("не дописывай", result["hint"])

    def test_several_numbers_in_one_cell_keep_its_number(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "phones.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("8 495 123-45-67; 8 916 765-43-21\n\nтел./факс 8 812 000-00-02\n8 495 123-45-67, 8 916 765-43-21\n")
            code, result = kit("ru", "phone", "--file", path)
        self.assertEqual(code, 0, result)
        got = [(row["n"], row["e164"]) for row in result["numbers"]]
        self.assertEqual(
            got,
            [
                (1, "+74951234567"),
                (1, "+79167654321"),
                (3, "+78120000002"),
                (4, "+74951234567"),
                (4, "+79167654321"),
            ],
        )
        # Three digits after a comma are no number of their own (an extension
        # without its word?): the cell is not split and stays unsure.
        result = rows("8 495 123-45-67, 123")
        self.assertEqual([item["in"] for item in result["unsure"]], ["8 495 123-45-67, 123"])
        self.assertEqual(result["numbers"][0]["tel"], "8 495 123-45-67, 123")


if __name__ == "__main__":
    unittest.main()
