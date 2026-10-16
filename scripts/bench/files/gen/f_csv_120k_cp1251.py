"""Fixture for f-csv-120k-cp1251: kassa_2025.csv — a till export for 2025.

datagen.csv_rows(seed=17) verbatim: header + 120 000 lines, cp1251, «;» separator, CRLF line ends
(the last line too), no BOM, decimal comma. 200 lines carry a correctly quoted product with «;»
(«"Печенье ""Юбилейное; традиционное"" 112 г"»), 37 lines carry an unquoted product with «;»
(«Сок "Сады; мультифрукт" 1 л») and therefore 12 fields, 422 lines are returns (Кол-во −1,
Способ оплаты «Возврат», negative sum). A CSV cannot carry a visible stamp without breaking the
«header + 120 000 lines» contract, so the specimen mark lives in the data itself: every shop is
«Образец-маркет №N».

truth/kassa_2025.json: expected numbers (datagen.csv_expected), 1-based file line numbers of the
broken, quoted and return lines, file size and sha256.
"""

from __future__ import annotations

import hashlib
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402
import datagen as G  # noqa: E402

FIXTURE = "kassa_2025.csv"


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = G.csv_rows(seed=17)
    assert len(rows) == 120_000
    lines = [";".join(G.CSV_HEADER)] + [raw for _, raw, _ in rows]
    data = ("\r\n".join(lines) + "\r\n").encode("cp1251")  # strict: fails on any non-cp1251 char
    path = out_dir / FIXTURE
    path.write_bytes(data)

    kinds = {"broken": [], "quoted": [], "return": []}
    for n, (_, _, kind) in enumerate(rows, start=2):  # file line 1 is the header
        if kind in kinds:
            kinds[kind].append(n)
    exp = G.csv_expected(seed=17)
    truth = dict(
        fixture=FIXTURE, case="f-csv-120k-cp1251", source="datagen.csv_rows(seed=17)",
        encoding="cp1251", delimiter=";", line_terminator="CRLF", bom=False, header=G.CSV_HEADER,
        data_lines=len(rows), size_bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
        broken_product=G.CSV_BROKEN_PRODUCT, quoted_product=G.CSV_QUOTED_PRODUCT,
        line_numbers=kinds, expected=exp,
    )
    tpath = C.ff_write_json(truth_dir / "kassa_2025.json", truth)
    return [str(path), tpath]


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / "f-csv-120k-cp1251", base / "truth"):
        print(p)
