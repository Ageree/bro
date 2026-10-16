"""brokit vcf write: a contacts file iPhone and Android import (vCard 3.0)."""

import json
import os
import tempfile
import unittest

from tests.cli_run import kit

NOTE = "Домофон 12#; ключ у соседки, кв. 5\nпуть: C:\\дача. " * 6


def components(value):
    """A value split on its unescaped semicolons, each part unescaped."""
    parts, current, chars = [], "", iter(value)
    for char in chars:
        if char == "\\":
            escaped = next(chars, "")
            current += "\n" if escaped in "nN" else escaped
        elif char == ";":
            parts.append(current)
            current = ""
        else:
            current += char
    return parts + [current]


def parse(raw):
    """Cards of a vCard file, each {NAME: [(params, value)]}, after unfolding."""
    lines = raw.decode("utf-8").replace("\r\n ", "").replace("\r\n\t", "").split("\r\n")
    if lines.pop() != "":
        raise AssertionError("the last line has no CRLF")
    cards, card = [], None
    for line in lines:
        head, _, value = line.partition(":")
        name, *params = head.split(";")
        if line == "BEGIN:VCARD":
            card = {}
        elif line == "END:VCARD":
            cards.append(card)
            card = None
        else:
            card.setdefault(name, []).append((params, value))
    if card is not None:
        raise AssertionError("a card without END")
    return cards


class VcfTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.dir.cleanup()

    def write(self, spec, out="out.vcf"):
        path = os.path.join(self.dir.name, "spec.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(spec, handle, ensure_ascii=False)
        out = os.path.join(self.dir.name, out)
        code, result = kit("vcf", "write", path, "-o", out)
        if code != 0:
            return code, result, None
        with open(out, "rb") as handle:
            return code, result, handle.read()

    def test_cards_round_trip_with_crlf_folding_and_escaping(self):
        spec = {
            "contacts": [
                {
                    "name": "Иванова Мария Петровна",
                    "org": "ООО «Ромашка», бухгалтерия",
                    "title": "главный бухгалтер",
                    "phones": [{"tel": "+79161234567"}, {"tel": "+74950000001,123", "type": "work"}],
                    "emails": [{"email": "m.ivanova@romashka.ru", "type": "work"}],
                    "birthday": "12.05.1985",
                    "address": "Москва, ул. Примерная, д. 10; кв. 5",
                    "note": NOTE,
                },
                {"name": "Пётр Ильич Чайковский", "phones": [{"tel": "+74951112233", "type": "main"}]},
            ]
        }
        code, result, raw = self.write(spec)
        self.assertEqual(code, 0, result)
        self.assertEqual((result["contacts"], result["phones"], result["bytes"]), (2, 3, len(raw)))
        self.assertEqual(result["warnings"], [])
        self.assertEqual(raw.count(b"\n"), raw.count(b"\r\n"))
        for line in raw.split(b"\r\n"):
            self.assertLessEqual(len(line), 75)
            line.decode("utf-8")  # no letter is cut in two by the folding
        first, second = parse(raw)
        self.assertEqual(first["VERSION"], [([], "3.0")])
        self.assertEqual(components(first["N"][0][1]), ["Иванова", "Мария", "Петровна", "", ""])
        self.assertEqual(components(first["FN"][0][1]), ["Иванова Мария Петровна"])
        self.assertEqual(components(first["ORG"][0][1]), ["ООО «Ромашка», бухгалтерия"])
        # The extension's comma stays: after it a phone dials the extension itself.
        self.assertEqual(first["TEL"], [(["TYPE=CELL"], "+79161234567"), (["TYPE=WORK"], "+74950000001,123")])
        self.assertEqual(first["EMAIL"], [(["TYPE=INTERNET,WORK"], "m.ivanova@romashka.ru")])
        self.assertEqual(components(first["ADR"][0][1])[2], "Москва, ул. Примерная, д. 10; кв. 5")
        self.assertEqual(first["BDAY"], [([], "1985-05-12")])
        self.assertEqual(components(first["NOTE"][0][1]), [NOTE.strip()])
        # The patronymic second: Имя Отчество Фамилия.
        self.assertEqual(components(second["N"][0][1])[:3], ["Чайковский", "Пётр", "Ильич"])
        self.assertEqual(second["TEL"], [(["TYPE=PREF"], "+74951112233")])

    def test_a_birthday_without_a_year_is_written_without_one(self):
        # Live 16.10: «ДР мамы 12 мая» was refused, and the card went without it.
        for given in ("12.05", "--05-12", "--0512"):
            code, result, raw = self.write({"contacts": [{"name": "Мама", "birthday": given}]})
            self.assertEqual(code, 0, result)
            self.assertEqual(parse(raw)[0]["BDAY"], [([], "--05-12")], given)
        code, result, _ = self.write({"contacts": [{"name": "Мама", "birthday": "31.02"}]})
        self.assertEqual((code, result["code"]), (2, "bad_spec"))

    def test_company_card_and_warnings(self):
        spec = {
            "contacts": [
                {"org": "Ветклиника «Айболит»", "phones": ["+74950000002", "00-12-34"]},
                {"name": "Иван Петров", "phones": [{"tel": "+74950000002"}, {"tel": "+74950000002"}], "nick": "Ваня"},
            ]
        }
        code, result, raw = self.write(spec)
        self.assertEqual(code, 0, result)
        clinic, ivan = parse(raw)
        self.assertEqual(components(clinic["FN"][0][1]), ["Ветклиника «Айболит»"])
        self.assertEqual(clinic["N"], [([], ";;;;")])
        self.assertEqual(clinic["X-ABShowAs"], [([], "COMPANY")])
        self.assertEqual(len(ivan["TEL"]), 1)
        warnings = " | ".join(result["warnings"])
        self.assertIn("00-12-34 does not start with +", warnings)
        self.assertIn("+74950000002 is given twice, written once", warnings)
        self.assertIn("+74950000002 is also on contact 1", warnings)
        self.assertIn("«Петров» looks like the family name", warnings)
        self.assertIn("unknown keys ignored: nick", warnings)

    def test_numbers_are_brought_to_the_form_a_phone_dials(self):
        # Live 16.10: «8-495-000-00-01 доб. 123» went into the card as it stood.
        spec = {"contacts": [{"name": "Офис", "phones": ["8-495-000-00-01 доб. 123", "8 916 123-45-67", "+7 (495) 000-00-04"]}]}
        code, result, raw = self.write(spec)
        self.assertEqual(code, 0, result)
        tels = parse(raw)[0]["TEL"]
        self.assertEqual([value for _, value in tels], ["+74950000001,123", "+79161234567", "+74950000004"])
        self.assertEqual(tels[1][0], ["TYPE=CELL"])
        self.assertFalse(any("does not start with +" in w for w in result["warnings"]), result["warnings"])

    def test_a_note_that_is_only_an_extension_joins_the_phone(self):
        spec = {"contacts": [{"name": "Офис", "phones": ["+74950000001"], "note": "доб. 123"},
                             {"name": "Склад", "phones": ["+74950000002", "+74950000003"], "note": "доб. 5"}]}
        code, result, raw = self.write(spec)
        self.assertEqual(code, 0, result)
        office, store = parse(raw)
        self.assertEqual(office["TEL"][0][1], "+74950000001,123")
        self.assertNotIn("NOTE", office)
        self.assertIn("extension", " | ".join(result["warnings"]))
        # Two phones: whose extension it is cannot be told, the note stays a note.
        self.assertEqual([value for _, value in store["TEL"]], ["+74950000002", "+74950000003"])
        self.assertEqual(components(store["NOTE"][0][1]), ["доб. 5"])

    def test_bad_specs_are_refused(self):
        refused = [
            {"contacts": [{"note": "без имени и номера", "emails": ["a@b.ru"]}]},
            {"contacts": [{"name": "Мама", "birthday": "12 мая"}]},
            {"contacts": [{"name": "Мама", "phones": [{"tel": "нет"}]}]},
            {"contacts": []},
        ]
        for spec in refused:
            code, result, _ = self.write(spec)
            self.assertEqual((code, result["code"]), (2, "bad_spec"), spec)
        code, result, _ = self.write({"contacts": [{"name": "Мама"}]}, "out.txt")
        self.assertEqual((code, result["code"]), (2, "bad_output"))


if __name__ == "__main__":
    unittest.main()
