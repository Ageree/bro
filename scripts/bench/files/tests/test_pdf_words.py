"""Words of a field in reading order, also on a tilted scan."""

import unittest

from checks.context import Word
from checks.pdf import words_in_rect


class Page:
    def __init__(self, words):
        self._words = words

    def words(self, pdf, page):
        return self._words


class WordsInRectTest(unittest.TestCase):
    def test_a_line_climbing_across_a_rounding_edge_keeps_its_order(self):
        # A typed line on a scan tilted by a fraction of a degree, as received 16.10.
        page = Page([
            Word("Менеджер", (332.0, 692.9, 383.2, 703.3), 1),
            Word("по", (386.1, 693.3, 398.0, 703.7), 1),
            Word("продажам", (400.9, 693.4, 449.8, 703.8), 1),
            Word("Кузнецова", (331.0, 669.1, 382.7, 679.5), 2),
        ])
        self.assertEqual(words_in_rect(page, None, 1, (320, 685, 470, 712)), "Менеджер по продажам")
        self.assertEqual(words_in_rect(page, None, 1, (320, 660, 470, 712)), "Менеджер по продажам Кузнецова")


if __name__ == "__main__":
    unittest.main()
