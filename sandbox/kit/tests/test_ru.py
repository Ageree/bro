"""brokit ru decline / amount (W2 spec §6.12, §9)."""

import os
import tempfile
import unittest

from tests.cli_run import kit

# f-mailmerge-gramoty-dative: nominative, dative and gender of the whole class.
CLASS_5B = [
    ("Белых Ксения", "Белых Ксении", "f"),
    ("Ворона Ангелина", "Вороне Ангелине", "f"),
    ("Голубь Николь", "Голубь Николь", "f"),
    ("Грицук Мария", "Грицук Марии", "f"),
    ("Гурамишвили Нино", "Гурамишвили Нино", "f"),
    ("Иванов Пётр", "Иванову Петру", "m"),
    ("Ким Алина", "Ким Алине", "f"),
    ("Ким Тимур", "Киму Тимуру", "m"),
    ("Кох Ева", "Кох Еве", "f"),
    ("Кузьмина Любовь", "Кузьминой Любови", "f"),
    ("Лебедь Павел", "Лебедю Павлу", "m"),
    ("Ли Даниил", "Ли Даниилу", "m"),
    ("Мороз Ярослав", "Морозу Ярославу", "m"),
    ("Мороз Ярослава", "Мороз Ярославе", "f"),
    ("Никитин Савва", "Никитину Савве", "m"),
    ("Пушкарь Глеб", "Пушкарю Глебу", "m"),
    ("Рябой Михаил", "Рябому Михаилу", "m"),
    ("Смирнова Анна", "Смирновой Анне", "f"),
    ("Соловей Лев", "Соловью Льву", "m"),
    ("Ткаченко Артём", "Ткаченко Артёму", "m"),
    ("Ткаченко Илья", "Ткаченко Илье", "m"),
    ("Толстая Варвара", "Толстой Варваре", "f"),
    ("Черных Дарья", "Черных Дарье", "f"),
    ("Черных Илья", "Черных Илье", "m"),
    ("Шевчук Никита", "Шевчуку Никите", "m"),
]


class DeclineTest(unittest.TestCase):
    def test_dative_and_gender_of_the_whole_class(self):
        with tempfile.TemporaryDirectory() as folder:
            names = os.path.join(folder, "names.txt")
            with open(names, "w", encoding="utf-8") as handle:
                handle.write("\n".join(name for name, _, _ in CLASS_5B) + "\n")
            code, result = kit("ru", "decline", "--file", names, "--case", "dat")
        self.assertEqual(code, 0, result)
        got = [(r["input"], r["result"], r["gender"]) for r in result["results"]]
        self.assertEqual(got, CLASS_5B)

    def test_other_cases_orders_and_double_surnames(self):
        cases = [
            (("Соловей Лев", "--case", "ins"), "Соловьём Львом"),
            (("Ворона Иван", "--case", "gen"), "Вороны Ивана"),
            (("Иванова Анна Петровна", "--case", "gen"), "Ивановой Анны Петровны"),
            (("Анна Петровна Иванова", "--case", "dat", "--order", "if"), "Анне Петровне Ивановой"),
            (("Римский-Корсаков Николай Андреевич", "--case", "pre"), "Римском-Корсакове Николае Андреевиче"),
        ]
        for args, expected in cases:
            code, result = kit("ru", "decline", *args)
            self.assertEqual((code, result["results"][0]["result"]), (0, expected), args)

    def test_unknown_gender_is_flagged_and_can_be_given(self):
        code, result = kit("ru", "decline", "Ким Саша", "--case", "dat")
        self.assertEqual(result["results"][0]["gender"], "unknown")
        self.assertTrue(result["warnings"])
        code, result = kit("ru", "decline", "Ким Саша", "--case", "dat", "--gender", "m")
        self.assertEqual(result["results"][0]["result"], "Киму Саше")


class AmountTest(unittest.TestCase):
    def test_amounts_in_words(self):
        cases = [
            ("24500", "двадцать четыре тысячи пятьсот рублей 00 копеек"),
            ("65000", "шестьдесят пять тысяч рублей 00 копеек"),
            ("1", "один рубль 00 копеек"),
            ("2001", "две тысячи один рубль 00 копеек"),
            ("3 600,50", "три тысячи шестьсот рублей 50 копеек"),
            ("1000000.01", "один миллион рублей 01 копейка"),
            ("112", "сто двенадцать рублей 00 копеек"),
        ]
        for number, words in cases:
            code, result = kit("ru", "amount", number)
            self.assertEqual((code, result["words"]), (0, words), number)

    def test_not_a_number_is_refused(self):
        code, result = kit("ru", "amount", "двадцать")
        self.assertEqual((code, result["code"]), (2, "bad_number"))


class VacationTest(unittest.TestCase):
    def test_holidays_inside_the_leave_lengthen_it(self):
        # f-flat-scan-otpusk-overlay: 14 days from 3 November end on the 17th, 4 November is not counted.
        code, result = kit("ru", "vacation", "--start", "03.11.2026", "--days", "14")
        self.assertEqual((code, result["end"], result["holidays"]), (0, "17.11.2026", ["04.11.2026"]))
        # Over the New Year all of 1-8 January is left out.
        code, result = kit("ru", "vacation", "--start", "28.12.2026", "--days", "14")
        self.assertEqual((result["end"], len(result["holidays"])), ("18.01.2027", 8))
        # A region's own non-working day lengthens it too.
        code, result = kit("ru", "vacation", "--start", "02.11.2026", "--days", "14", "--extra", "06.11.2026")
        self.assertEqual((result["end"], result["holidays"]), ("17.11.2026", ["04.11.2026", "06.11.2026"]))

    def test_given_dates_are_counted_not_moved(self):
        code, result = kit("ru", "vacation", "--start", "01.06.2026", "--end", "14.06.2026")
        self.assertEqual((code, result["end"], result["days"], result["holidays"]), (0, "14.06.2026", 13, ["12.06.2026"]))

    def test_a_bad_date_or_length_is_refused(self):
        self.assertEqual(kit("ru", "vacation", "--start", "31.02.2026", "--days", "5")[1]["code"], "bad_date")
        self.assertEqual(kit("ru", "vacation", "--start", "01.03.2026", "--days", "0")[1]["code"], "bad_args")
        self.assertEqual(kit("ru", "vacation", "--start", "10.03.2026", "--end", "01.03.2026")[1]["code"], "bad_args")


if __name__ == "__main__":
    unittest.main()
