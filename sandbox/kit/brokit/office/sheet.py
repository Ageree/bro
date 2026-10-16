"""brokit xlsx inspect / recalc and csv sniff.

inspect: what a workbook holds before touching it — sheets (hidden ones too),
used range, merged cells (each one holding a value with the row and column labels
around it), formulas, the header row, data validations, charts.

recalc: openpyxl writes formulas without values, and Excel's cached values may
be stale, so a workbook is recalculated by LibreOffice. LibreOffice never
recalculates a value already cached in an .xlsx by default, so the cached
values of formula cells are dropped first (a zip-level edit: everything else
stays byte for byte); then `soffice --convert-to xlsx` computes every formula.
Formula errors are listed; `lost` names what the LibreOffice re-save dropped.

Both list the columns that hold dates or sums as text (`text_dates`,
`text_numbers`): such a workbook looks right but sorts, filters and sums by
date wrongly. Bare digit strings (ИНН, account and phone numbers) are not
listed: they must stay text.

sniff: encoding (BOM, UTF-8, else charset detection with cp1251 preferred for
Russian), separator, decimal comma, thousands separator, quoting, header, row
count and the lines whose field count differs, plus a pandas call that reads it.
`stopped` names the line of a quote that never closes (the rest of the file
reads as one field).
"""

import csv
import io
import os
import re
import shutil
import tempfile
import zipfile

from brokit.util import KitError, need_file, out_path, parser

ERRORS = ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!", "#SPILL!", "#CALC!")
MAX_LISTED = 50
SAMPLE_BYTES = 4 * 1024 * 1024
FIELD_LIMIT = 16 * 1024 * 1024
LONG_RECORD_LINES = 50
SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_TIME = r"(?:[ T](?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?"
TEXT_DATE = re.compile(
    # A two-digit year only with a padded day and month: «1.1.10» is an outline number, not a date.
    r"(?:(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.\d{4}"
    r"|(?:0[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])\.\d{2}"
    r"|\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))" + _TIME
)
# Sums as Russian banks and 1C print them: thousands grouped by a space or a
# no-break space, or a decimal comma, or digits with a currency mark. A bare
# digit string is an ИНН, an account or a phone as often as a sum.
_RUB = r"\s?(?:₽|руб\.?|р\.)"
TEXT_NUMBER = re.compile(
    r"[-+\u2212]?(?:(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:,\d+)?|\d+,\d+)(?:%s)?|\d+%s)" % (_RUB, _RUB)
)
SCAN_ROWS = 1000
# '#,##0.00' is how the file stores the grouping Russian Excel shows as
# «1 234,56»; '# ##0.00' would group only the last three digits.
TEXT_HINT = (
    "dates or sums stored as text break sorting, filters and SUMIFS by date: in a workbook you make, write "
    "datetime / float into these cells and set number_format ('DD.MM.YYYY', 'DD.MM.YYYY HH:MM', '#,##0.00'); "
    "in a file you only read, parse them"
)
MERGED_HINT = (
    "a merged cell's value covers its whole range (pandas/openpyxl see it only in the top-left cell, the rest "
    "read empty): merged_values gives each range's rows and the labels of its first and last row"
)


def load(path, **options):
    import openpyxl

    need_file(path)
    if not zipfile.is_zipfile(path):
        with open(path, "rb") as handle:
            head = handle.read(8)
        if head.startswith(b"\xd0\xcf\x11\xe0"):
            raise KitError(
                "unsupported",
                "this is an old Excel .xls file",
                "convert it first: soffice --headless --convert-to xlsx --outdir DIR FILE.xls",
            )
        raise KitError("unreadable", "not an .xlsx workbook")
    try:
        return openpyxl.load_workbook(path, **options)
    except Exception as error:  # noqa: BLE001 — openpyxl raises many types on broken files
        raise KitError("unreadable", "openpyxl cannot read it: %s: %s" % (type(error).__name__, str(error)[:120]))


def header_row(sheet, limit=15):
    """The first of the top rows that is mostly text and is followed by data.

    A header across most of the sheet counts over a sparse grid too: a timetable's next row
    holds a time and one lesson.
    """
    columns = sheet.max_column
    rows = list(sheet.iter_rows(min_row=1, max_row=limit + 1, values_only=True))
    for index, row in enumerate(rows[:-1]):
        filled = [value for value in row if value not in (None, "")]
        if len(filled) < 2:
            continue
        texts = [value for value in filled if isinstance(value, str)]
        following = [value for value in rows[index + 1] if value not in (None, "")]
        dense = len(following) >= max(2, len(filled) // 2)
        wide = bool(following) and len(filled) >= columns / 2
        if len(texts) >= 0.8 * len(filled) and (dense or wide):
            return index + 1
    return None


def _filled(value):
    return value is not None and not (isinstance(value, str) and not value.strip())


def _plain(value):
    """A cell value for JSON: numbers stay numbers, dates and times in ISO form, text cut to 60 characters."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)[:60]


def merged_values(sheet, header):
    """([merged ranges holding a value, where each lies], whether one of them covers data cells).

    A row label is the value left of the range in the label column (the leftmost column holding
    data below the header: times, names, numbers); the column label is the header's cell above it.
    """
    from openpyxl.cell.cell import MergedCell

    ranges = sorted(sheet.merged_cells.ranges, key=lambda r: (r.min_row, r.min_col))
    valued = [r for r in ranges if _filled(sheet.cell(r.min_row, r.min_col).value)]
    if not valued:
        return [], False
    if header is not None:
        spread = any(r.min_row > header for r in valued)
    else:
        spread = any(r.max_row > r.min_row for r in valued)
    start = (header or 0) + 1
    label_column = None
    for row in sheet.iter_rows(min_row=start, max_row=min(sheet.max_row, start + 200), values_only=True):
        column = next((n for n, value in enumerate(row, 1) if _filled(value)), None)
        if column is not None and (label_column is None or column < label_column):
            label_column = column

    def shown(row, column):
        cell = sheet.cell(row, column)
        if isinstance(cell, MergedCell):
            owner = next((r for r in ranges if r.min_row <= row <= r.max_row and r.min_col <= column <= r.max_col), None)
            return _plain(sheet.cell(owner.min_row, owner.min_col).value) if owner else None
        return _plain(cell.value)

    listed = []
    for r in valued[:MAX_LISTED]:
        labelled = label_column is not None and label_column < r.min_col
        listed.append(
            {
                "range": str(r),
                "value": _plain(sheet.cell(r.min_row, r.min_col).value),
                "rows": [r.min_row, r.max_row],
                "row_labels": [shown(row, label_column) if labelled else None for row in (r.min_row, r.max_row)],
                "column_label": shown(header, r.min_col) if header is not None and r.min_row > header else None,
            }
        )
    return listed, spread


def inspect(argv):
    p = parser("xlsx inspect")
    p.add_argument("file")
    args = p.parse_args(argv)
    workbook = load(args.file)
    sheets = []
    for sheet in workbook.worksheets:
        formulas = []
        count = 0
        for row in sheet.iter_rows():
            for cell in row:
                if cell.data_type == "f":
                    count += 1
                    if len(formulas) < 20:
                        formulas.append({"cell": cell.coordinate, "formula": str(cell.value)[:200]})
        validations = [
            {"ranges": str(v.sqref), "type": v.type, "formula": v.formula1}
            for v in sheet.data_validations.dataValidation
        ]
        # Before header_row and merged_values: reading a cell past the used range creates it.
        dims, max_row, max_column = sheet.dimensions, sheet.max_row, sheet.max_column
        header = header_row(sheet)
        valued, spread = merged_values(sheet, header)
        entry = {
            "name": sheet.title,
            "hidden": sheet.sheet_state != "visible",
            "dims": dims,
            "max_row": max_row,
            "max_column": max_column,
            "merged": [str(r) for r in sheet.merged_cells.ranges][:MAX_LISTED],
            "merged_values": valued,
            "formulas": {"count": count, "examples": formulas},
            "header_row": header,
            "validations": validations[:MAX_LISTED],
            "conditional_formats": len(sheet.conditional_formatting),
            "charts": len(getattr(sheet, "_charts", [])),
            "images": len(getattr(sheet, "_images", [])),
            "tables": list(sheet.tables.keys()),
            "freeze": sheet.freeze_panes,
        }
        if spread:
            entry["hint"] = MERGED_HINT
        sheets.append(entry)
    names = list(workbook.defined_names.keys()) if hasattr(workbook.defined_names, "keys") else []
    result = {"sheets": sheets, "defined_names": names[:MAX_LISTED], "features": features(args.file)}
    result.update(text_typed(args.file))
    return result


def text_typed(path):
    """Columns holding dates or sums as text in the first SCAN_ROWS rows of each sheet, and a hint when any."""
    from openpyxl.utils import get_column_letter

    workbook = load(path, read_only=True, data_only=True)
    found = {"text_dates": [], "text_numbers": []}
    try:
        for sheet in workbook.worksheets:
            # A dimension tag some writers get wrong would cut the rows short.
            sheet.reset_dimensions()
            filled = {}
            hits = {"text_dates": {}, "text_numbers": {}}
            for row in sheet.iter_rows(max_row=SCAN_ROWS, values_only=True):
                for column, value in enumerate(row, 1):
                    text = value.strip() if isinstance(value, str) else value
                    if text is None or text == "":
                        continue
                    filled[column] = filled.get(column, 0) + 1
                    if not isinstance(text, str):
                        continue
                    if TEXT_DATE.fullmatch(text):
                        hits["text_dates"].setdefault(column, []).append(text)
                    elif TEXT_NUMBER.fullmatch(text):
                        hits["text_numbers"].setdefault(column, []).append(text)
            for kind, columns in hits.items():
                for column in sorted(columns):
                    cells = columns[column]
                    if len(cells) >= 5 or 2 * len(cells) >= filled[column]:
                        found[kind].append(
                            {
                                "sheet": sheet.title,
                                "column": get_column_letter(column),
                                "cells": len(cells),
                                "example": cells[0],
                            }
                        )
    finally:
        workbook.close()
    result = {kind: columns[:MAX_LISTED] for kind, columns in found.items()}
    if any(result.values()):
        result["hint"] = TEXT_HINT
    return result


def features(path):
    """Counts of parts LibreOffice may drop on a re-save."""
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        counts = {
            "charts": sum(1 for n in names if re.match(r"xl/charts/chart\d+\.xml$", n)),
            "pivots": sum(1 for n in names if re.match(r"xl/pivotTables/pivotTable\d+\.xml$", n)),
            "images": sum(1 for n in names if n.startswith("xl/media/")),
            "macros": sum(1 for n in names if n.endswith("vbaProject.bin")),
            "comments": sum(1 for n in names if re.match(r"xl/comments\d*\.xml$", n)),
            "tables": sum(1 for n in names if re.match(r"xl/tables/table\d+\.xml$", n)),
            "validations": 0,
            "conditional_formats": 0,
            "defined_names": 0,
        }
        for name in names:
            if re.match(r"xl/worksheets/sheet\d+\.xml$", name):
                data = archive.read(name)
                counts["validations"] += data.count(b"<dataValidation ")
                counts["conditional_formats"] += data.count(b"<conditionalFormatting")
        if "xl/workbook.xml" in names:
            counts["defined_names"] = archive.read("xl/workbook.xml").count(b"<definedName ")
    return counts


# Russian Excel shows date codes in Russian, but the file keeps them in English: «ДД.ММ.ГГГГ» written into a
# number format is no date code at all, and the cell reads as a bare number (16.10: every date of a statement).
LOCAL_CODES = str.maketrans("ДдМмГгЧчСс", "DdMmYyHhSs")
LOCAL_DATE = re.compile(r"ДД|дд|ММ|ГГ|гг|чч")


def english_code(code):
    """A number format with Russian date and time codes in English ones; text in quotes stays."""
    parts = re.split(r'("[^"]*")', code)
    return "".join(part if part.startswith('"') else part.translate(LOCAL_CODES) for part in parts)


def without_cached_values(source, target, fixed=None):
    """Copies an .xlsx dropping the cached values of formula cells; Russian date codes of number formats go into
    English ones, each named in `fixed`."""
    from lxml import etree

    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as out:
        for info in archive.infolist():
            data = archive.read(info.filename)
            if info.filename == "xl/styles.xml":
                root = etree.fromstring(data, etree.XMLParser(huge_tree=True, resolve_entities=False))
                changed = False
                for fmt in root.iter("{%s}numFmt" % SHEET_NS):
                    code = fmt.get("formatCode") or ""
                    if LOCAL_DATE.search(re.sub(r'"[^"]*"', "", code)):
                        fmt.set("formatCode", english_code(code))
                        changed = True
                        if fixed is not None:
                            fixed.append("%s -> %s" % (code, fmt.get("formatCode")))
                if changed:
                    data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
            if re.match(r"xl/worksheets/sheet\d+\.xml$", info.filename) and b"<f" in data:
                root = etree.fromstring(data, etree.XMLParser(huge_tree=True, resolve_entities=False))
                for cell in root.iter("{%s}c" % SHEET_NS):
                    if cell.find("{%s}f" % SHEET_NS) is None:
                        continue
                    for value in cell.findall("{%s}v" % SHEET_NS):
                        cell.remove(value)
                    if cell.get("t") in ("str", "e", "b", "n"):
                        del cell.attrib["t"]
                data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
            if info.filename == "xl/calcChain.xml":
                continue
            out.writestr(info, data)


def formula_errors(path):
    workbook = load(path, data_only=True, read_only=True)
    errors = []
    try:
        for sheet in workbook.worksheets:
            for row in sheet.iter_rows():
                for cell in row:
                    if isinstance(cell.value, str) and cell.value in ERRORS:
                        errors.append({"sheet": sheet.title, "cell": cell.coordinate, "value": cell.value})
    finally:
        workbook.close()
    return errors


def recalc(argv):
    from brokit.office import soffice

    p = parser("xlsx recalc")
    p.add_argument("file")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--check", action="store_true", help="exit 2 when a formula gives an error")
    args = p.parse_args(argv)
    load(args.file, read_only=True).close()
    out_path(args.output, args.file)
    with tempfile.TemporaryDirectory(prefix="brokit-recalc-") as work:
        stripped = os.path.join(work, "in.xlsx")
        fixed = []
        without_cached_values(args.file, stripped, fixed)
        converted = soffice.convert([stripped], "xlsx:Calc MS Excel 2007 XML", os.path.join(work, "out"))[0]
        shutil.copyfile(converted, args.output)
    errors = formula_errors(args.output)
    before, after = features(args.file), features(args.output)
    lost = ["%s: %d -> %d" % (key, before[key], after[key]) for key in before if after[key] < before[key]]
    if args.check and errors:
        raise KitError(
            "formula_errors",
            "%d formula cells give an error" % len(errors),
            "fix the formulas and recalc again",
            errors=errors[:MAX_LISTED],
            output=args.output,
        )
    result = {"output": args.output, "errors": errors[:MAX_LISTED], "error_count": len(errors), "lost": lost}
    if fixed:
        result["fixed_formats"] = fixed[:MAX_LISTED]
        result["formats_hint"] = "number formats take English codes: 'DD.MM.YYYY', 'DD.MM.YYYY hh:mm'"
    result.update(text_typed(args.output))
    return result


# ---------------------------------------------------------------- csv


def detect_encoding(sample):
    if sample.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if sample.startswith((b"\xff\xfe", b"\xfe\xff")):
        return "utf-16"
    try:
        sample.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError as error:
        # A sample cut inside a character still counts as UTF-8.
        if error.start >= len(sample) - 3 and len(sample) >= SAMPLE_BYTES:
            return "utf-8"
    from charset_normalizer import from_bytes

    best = from_bytes(sample[:256 * 1024]).best()
    guess = best.encoding if best else "cp1251"
    # charset detection confuses the Cyrillic single-byte code pages; cp1251
    # is what Russian Excel and 1C write.
    if guess in ("mac_cyrillic", "koi8_r", "cp866", "iso8859_5", "kz1048", "ptcp154") or not best:
        try:
            sample.decode("cp1251")
            return "cp1251"
        except UnicodeDecodeError:
            pass
    return guess


def sniff(argv):
    p = parser("csv sniff")
    p.add_argument("file")
    args = p.parse_args(argv)
    need_file(args.file)
    # The csv module refuses fields over 128 KB; a long text cell or a quote
    # that never closes is reported, not a crash.
    csv.field_size_limit(FIELD_LIMIT)
    with open(args.file, "rb") as handle:
        sample = handle.read(SAMPLE_BYTES)
    if b"\x00" in sample[:4096] and not sample.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise KitError("unreadable", "a binary file, not CSV text")
    encoding = detect_encoding(sample)
    text_sample = sample.decode(encoding, errors="replace")
    lines = text_sample.splitlines()[:200]
    head = "\n".join(lines)
    try:
        dialect = csv.Sniffer().sniff(head, delimiters=";,\t|")
        separator, quotechar = dialect.delimiter, dialect.quotechar
    except csv.Error:
        counts = {sep: head.count(sep) for sep in ";,\t|"}
        separator, quotechar = max(counts, key=counts.get), '"'
    try:
        rows = list(csv.reader(io.StringIO("\n".join(lines[:60])), delimiter=separator, quotechar=quotechar))
    except csv.Error as error:
        raise KitError("unreadable", "not CSV text: " + str(error)[:120])
    first = rows[0] if rows else []
    second = rows[1] if len(rows) > 1 else []
    numeric = re.compile(r"^-?[\d\s .,]+$")
    has_header = bool(first) and not any(numeric.match(v.strip()) for v in first if v.strip()) and any(
        numeric.match(v.strip()) for v in second if v.strip()
    )
    values = [v.strip() for row in rows[1:] for v in row]
    comma_decimal = sum(1 for v in values if re.fullmatch(r"-?\d[\d\s ]*,\d+", v))
    dot_decimal = sum(1 for v in values if re.fullmatch(r"-?\d[\d,]*\.\d+", v))
    decimal = "," if comma_decimal > dot_decimal else "."
    thousands = None
    # No-break spaces (Excel and 1C), a plain space, or dots before a decimal comma.
    marks = ("\u00a0", "\u202f", " ", ".") if decimal == "," else ("\u00a0", "\u202f", " ")
    for mark in marks:
        if any(re.fullmatch(r"-?\d{1,3}(%s\d{3})+([.,]\d+)?" % re.escape(mark), v) for v in values):
            thousands = mark
            break
    total, bad, expected, stopped = count_rows(args.file, encoding, separator, quotechar, len(first))
    call = "pd.read_csv(%r, encoding=%r, sep=%r, decimal=%r%s%s, quotechar=%r, on_bad_lines='warn')" % (
        args.file,
        encoding,
        separator,
        decimal,
        ", thousands=%r" % thousands if thousands else "",
        "" if has_header else ", header=None",
        quotechar,
    )
    return {
        "encoding": encoding,
        "sep": separator,
        "decimal": decimal,
        "thousands": thousands,
        "quotechar": quotechar,
        "header": first if has_header else None,
        "columns": expected,
        "rows": total - (1 if has_header else 0),
        "bad_lines": {"count": len(bad), "lines": bad[:MAX_LISTED]},
        "stopped": stopped,
        "pandas": call,
    }


def count_rows(path, encoding, separator, quotechar, expected):
    """(records, physical line numbers of records with another field count, field count, stop or None).

    A quote that never closes swallows the rest of the file into one field; the
    count stops there and says on which line.
    """
    bad = []
    total = 0
    stopped = None
    with open(path, encoding=encoding, errors="replace", newline="") as handle:
        reader = csv.reader(handle, delimiter=separator, quotechar=quotechar)
        line = 1
        try:
            for record in reader:
                total += 1
                if record and len(record) != expected:
                    bad.append(line)
                if stopped is None and reader.line_num - line >= LONG_RECORD_LINES:
                    stopped = {
                        "line": line,
                        "error": "a quote opened here is never closed: %d lines read as one record"
                        % (reader.line_num - line + 1),
                    }
                line = reader.line_num + 1
        except csv.Error as error:
            stopped = {"line": line, "error": str(error)[:120]}
    return total, bad, expected, stopped
