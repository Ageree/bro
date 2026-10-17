"""Labels of signing places: a box over two printed lines is named by the line at its middle."""

import unittest

from brokit.labels import label_for


def word(text, x0, y0, x1):
    return {"t": text, "box": [x0, y0, x1, y0 + 14.3]}


class LabelTest(unittest.TestCase):
    # The act's last lines (17.10, f-rent): the landlord's over the tenant's, 36 pt apart.
    WORDS = [
        word("Наймодатель", 71.0, 653.5, 132.7),
        word("____________________", 138.2, 653.5, 248.2),
        word("Наниматель", 71.0, 690.0, 127.5),
        word("01.11.2026", 133.0, 690.0, 182.5),
    ]

    def test_a_tall_box_takes_the_line_at_its_middle(self):
        self.assertEqual(label_for(self.WORDS, [187.9, 672.0, 305.0, 702.0]), "Наниматель 01.11.2026")

    def test_a_box_on_the_upper_line_takes_that_line(self):
        self.assertEqual(label_for(self.WORDS, [140.0, 650.0, 250.0, 668.0]), "Наймодатель")


if __name__ == "__main__":
    unittest.main()
