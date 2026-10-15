"""brokit xlsx inspect / recalc and csv sniff.

inspect: what a workbook holds before touching it — sheets (hidden ones too),
used range, merged cells, formulas, the header row, data validations, charts.

recalc: openpyxl writes formulas without values, and Excel's cached values may
be stale, so a workbook is recalculated by LibreOffice. LibreOffice never
recalculates a value already cached in an .xlsx by default, so the cached
values of formula cells are dropped first (a zip-level edit: everything else
stays byte for byte); then `soffice --convert-to xlsx` computes every formula.
Formula errors are listed; `lost` names what the LibreOffice re-save dropped.

sniff: encoding (BOM, UTF-8, else charset detection with cp1251 preferred for
Russian), separator, decimal comma, thousands separator, quoting, header, row
count and the lines whose field count differs, plus a pandas call that reads it.
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
SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


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
    """The first of the top rows that is mostly text and is followed by data."""
    rows = list(sheet.iter_rows(min_row=1, max_row=limit + 1, values_only=True))
    for index, row in enumerate(rows[:-1]):
        filled = [value for value in row if value not in (None, "")]
        if len(filled) < 2:
            continue
        texts = [value for value in filled if isinstance(value, str)]
        following = [value for value in rows[index + 1] if value not in (None, "")]
        if len(texts) >= 0.8 * len(filled) and len(following) >= max(2, len(filled) // 2):
            return index + 1
    return None


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
        sheets.append(
            {
                "name": sheet.title,
                "hidden": sheet.sheet_state != "visible",
                "dims": sheet.dimensions,
                "max_row": sheet.max_row,
                "max_column": sheet.max_column,
                "merged": [str(r) for r in sheet.merged_cells.ranges][:MAX_LISTED],
                "formulas": {"count": count, "examples": formulas},
                "header_row": header_row(sheet),
                "validations": validations[:MAX_LISTED],
                "conditional_formats": len(sheet.conditional_formatting),
                "charts": len(getattr(sheet, "_charts", [])),
                "images": len(getattr(sheet, "_images", [])),
                "tables": list(sheet.tables.keys()),
                "freeze": sheet.freeze_panes,
            }
        )
    names = list(workbook.defined_names.keys()) if hasattr(workbook.defined_names, "keys") else []
    return {"sheets": sheets, "defined_names": names[:MAX_LISTED], "features": features(args.file)}


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


def without_cached_values(source, target):
    """Copies an .xlsx dropping the cached values of formula cells."""
    from lxml import etree

    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as out:
        for info in archive.infolist():
            data = archive.read(info.filename)
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
        without_cached_values(args.file, stripped)
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
    return {"output": args.output, "errors": errors[:MAX_LISTED], "error_count": len(errors), "lost": lost}


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
    rows = list(csv.reader(io.StringIO("\n".join(lines[:60])), delimiter=separator, quotechar=quotechar))
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
    if any(re.fullmatch(r"-?\d{1,3}( \d{3})+([.,]\d+)?", v) for v in values):
        thousands = " "
    elif any(re.fullmatch(r"-?\d{1,3}( \d{3})+([.,]\d+)?", v) for v in values):
        thousands = " "
    elif decimal == "," and any(re.fullmatch(r"-?\d{1,3}(\.\d{3})+(,\d+)?", v) for v in values):
        thousands = "."
    total, bad, expected = count_rows(args.file, encoding, separator, quotechar, len(first))
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
        "pandas": call,
    }


def count_rows(path, encoding, separator, quotechar, expected):
    """(records, physical line numbers of records with another field count, field count)."""
    bad = []
    total = 0
    with open(path, encoding=encoding, errors="replace", newline="") as handle:
        reader = csv.reader(handle, delimiter=separator, quotechar=quotechar)
        line = 1
        for record in reader:
            total += 1
            if record and len(record) != expected:
                bad.append(line)
            line = reader.line_num + 1
    return total, bad, expected
