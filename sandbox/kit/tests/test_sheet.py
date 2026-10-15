"""brokit xlsx inspect / recalc and csv sniff (W2 spec §6.11, §9)."""

import os
import tempfile
import unittest
import zipfile

import openpyxl
from openpyxl.worksheet.datavalidation import DataValidation

from tests.cli_run import has, kit


def workbook(path):
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.title = "Январь"
    sheet["A1"] = "Продажи за январь"
    sheet.merge_cells("A1:C1")
    sheet.append(["Менеджер", "Сумма", "Статус"])
    sheet.append(["Иванов", 1500.5, "оплачено"])
    sheet.append(["Ким", 200, "отменена"])
    sheet["B5"] = "=SUM(B3:B4)"
    sheet["B6"] = "=B5/0"
    rule = DataValidation(type="list", formula1='"оплачено,отменена"')
    rule.add("C3:C4")
    sheet.add_data_validation(rule)
    hidden = book.create_sheet("old")
    hidden.sheet_state = "hidden"
    hidden["A1"] = "старое"
    book.save(path)


def with_stale_value(source, target, cell, value):
    """A copy whose formula cell carries a wrong cached value, as Excel files often do."""
    with zipfile.ZipFile(source) as archive:
        parts = {name: archive.read(name) for name in archive.namelist()}
    sheet = parts["xl/worksheets/sheet1.xml"].decode("utf-8")
    marker = '<c r="%s"><f>SUM(B3:B4)</f><v></v></c>' % cell
    assert marker in sheet, sheet
    parts["xl/worksheets/sheet1.xml"] = sheet.replace(marker, marker.replace("<v></v>", "<v>%s</v>" % value)).encode()
    with zipfile.ZipFile(target, "w") as archive:
        for name, data in parts.items():
            archive.writestr(name, data)


class SheetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.book = os.path.join(cls.dir.name, "sales.xlsx")
        workbook(cls.book)

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def path(self, name):
        return os.path.join(self.dir.name, name)

    def test_inspect_lists_what_the_workbook_holds(self):
        code, result = kit("xlsx", "inspect", self.book)
        self.assertEqual(code, 0, result)
        first, hidden = result["sheets"]
        self.assertEqual(first["name"], "Январь")
        self.assertEqual(first["merged"], ["A1:C1"])
        self.assertEqual(first["header_row"], 2)
        self.assertEqual(first["formulas"]["count"], 2)
        self.assertEqual(first["validations"][0]["ranges"], "C3:C4")
        self.assertEqual((hidden["name"], hidden["hidden"]), ("old", True))

    def test_csv_sniff_reads_cp1251_semicolons_and_decimal_commas(self):
        lines = ["Дата;Товар;Кол-во;Цена"]
        for n in range(1, 300):
            lines.append("01.01.2025;Творог 5%% 200 г;%d;%d,90" % (n % 4 + 1, 100 + n))
        lines[120] = '01.01.2025;"Печенье ""Юбилейное; традиционное""";1;79,00'
        lines[200] = '01.01.2025;Сок "Сады; мультифрукт" 1 л;1;99,00'
        with open(self.path("kassa.csv"), "wb") as handle:
            handle.write("\r\n".join(lines).encode("cp1251") + b"\r\n")
        code, result = kit("csv", "sniff", self.path("kassa.csv"))
        self.assertEqual(code, 0, result)
        self.assertEqual((result["encoding"], result["sep"], result["decimal"]), ("cp1251", ";", ","))
        self.assertEqual(result["header"], ["Дата", "Товар", "Кол-во", "Цена"])
        self.assertEqual(result["rows"], 299)
        self.assertEqual(result["bad_lines"], {"count": 1, "lines": [201]})
        self.assertIn("encoding='cp1251'", result["pandas"])

    @unittest.skipUnless(has("soffice"), "LibreOffice is not installed")
    def test_recalc_recomputes_stale_values_and_reports_errors(self):
        with_stale_value(self.book, self.path("stale.xlsx"), "B5", "999")
        code, result = kit("xlsx", "recalc", self.path("stale.xlsx"), "-o", self.path("recalc.xlsx"))
        self.assertEqual(code, 0, result)
        self.assertEqual(result["errors"], [{"sheet": "Январь", "cell": "B6", "value": "#DIV/0!"}])
        values = openpyxl.load_workbook(self.path("recalc.xlsx"), data_only=True)["Январь"]
        self.assertEqual(values["B5"].value, 1700.5)
        formulas = openpyxl.load_workbook(self.path("recalc.xlsx"))["Январь"]
        self.assertEqual(formulas["B5"].value, "=SUM(B3:B4)")
        code, result = kit("xlsx", "recalc", self.path("stale.xlsx"), "-o", self.path("checked.xlsx"), "--check")
        self.assertEqual((code, result["code"]), (2, "formula_errors"))


if __name__ == "__main__":
    unittest.main()
