"""Fixture for f-egrn-xml-to-pdf: an EGRN-like extract as XML plus a detached signature stub.

report-00000000-0000-0000-0000-000000000000-SPECIMEN.xml
    UTF-8, one line after the XML declaration (as such files usually come), root <extract_about_property_realty>
    in a fictional default namespace (urn:specimen:...), structure loosely modelled on the public extract schema:
    details_statement (date 2026-10-14, № КУВИ-001/2026-00000000 ОБРАЗЕЦ), details_request, realty (cad number
    77:00:0000000:0001, «Квартира», purpose «Жилое», area 54.3, floor 7, address, cost 12345678.90),
    right_records (2 × «Общая долевая собственность» 1/2: Тестов Пётр Сергеевич and Тестова Анна Игоревна,
    registered 2021-04-12 under …-5 and …-6), restrict_records («Ипотека в силу закона» from 2021-04-12 for
    240 months in favour of ПАО «Банк Образец», ИНН 7700000101). Dictionary codes sit next to the text
    (dRightType 001002000000, dEncumbrance 022006000000, …). All dates are ISO. A comment and a <specimen>
    element say it is a specimen; nothing claims to be issued by a real authority.
report-…-SPECIMEN.xml.sig
    2048 bytes: a DER CMS/PKCS#7 SignedData (detached, GOST R 34.10/34.11-2012 OIDs, no certificates, random
    signature value, a padding unsigned attribute) from a SHA-256 counter stream — parseable, never verifiable.

truth/egrn_extract.json: every value a correct PDF / reply must show (as written in the XML and as displayed),
the forbidden raw codes, and a self-check that no displayable value contains them.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

XML_NAME = "report-00000000-0000-0000-0000-000000000000-SPECIMEN.xml"
SIG_NAME = XML_NAME + ".sig"
NS = "urn:specimen:egrn:extract-about-property-realty:1.0"
SIG_SIZE = 2048
SEED = "f-egrn-xml-to-pdf/sig/v1"

CAD = "77:00:0000000:0001"
DATA = {
    "statement_date": "2026-10-14",
    "statement_number": "КУВИ-001/2026-00000000 ОБРАЗЕЦ",
    "cad_number": CAD,
    "object_type": ("002001003000", "Помещение"),
    "name": "Квартира",
    "purpose": ("206002000000", "Жилое"),
    "area": "54.3",
    "floor": "7",
    "address": "г. Москва, ул. Примерная, д. 1, кв. 77",
    "cost": "12345678.90",
    "cost_date": "2026-01-01",
    "building_cad": "77:00:0000000:0100",
    "registration_date_object": "2016-08-05",
    "rights": [
        {"surname": "Тестов", "name": "Пётр", "patronymic": "Сергеевич", "birth_date": "1985-02-11",
         "snils": "000-000-000 01", "number": f"{CAD}-77/011/2021-5", "date": "2021-04-12"},
        {"surname": "Тестова", "name": "Анна", "patronymic": "Игоревна", "birth_date": "1987-09-23",
         "snils": "000-000-000 02", "number": f"{CAD}-77/011/2021-6", "date": "2021-04-12"},
    ],
    "right_type": ("001002000000", "Общая долевая собственность"),
    "share": ("1", "2"),
    "restriction": {"type": ("022006000000", "Ипотека в силу закона"), "number": f"{CAD}-77/011/2021-7",
                    "date": "2021-04-12", "start": "2021-04-12", "term_months": "240",
                    "holder": "ПАО «Банк Образец»", "inn": "7700000101", "ogrn": "1077700000111"},
    "deal_document": ("Договор купли-продажи квартиры с использованием кредитных средств банка (ОБРАЗЕЦ)",
                      "2021-04-05", "б/н"),
}

FORBIDDEN_RE = r"dRightType|001002|022006|<[a-z_]+>"


def _ru_date(iso):
    y, m, d = iso.split("-")
    return f"{d}.{m}.{y}"


def _xml_bytes() -> bytes:
    from lxml import etree

    E = lambda tag, *children, text=None, **attrib: _el(etree, tag, children, text, attrib)  # noqa: E731
    d = DATA
    r = d["restriction"]

    def code_value(tag, code, value, dict_name):
        return E(tag, E("code", text=code), E("value", text=value), dict=dict_name)

    def right_record(rr):
        return E("right_record",
                 E("record_info", E("registration_date", text=rr["date"] + "T10:15:00+03:00")),
                 E("right_data",
                   code_value("right_type", d["right_type"][0], d["right_type"][1], "dRightType"),
                   E("right_number", text=rr["number"]),
                   E("shares", E("share", E("numerator", text=d["share"][0]), E("denominator", text=d["share"][1])))),
                 E("right_holders", E("right_holder", E("individual",
                   E("surname", text=rr["surname"]), E("name", text=rr["name"]),
                   E("patronymic", text=rr["patronymic"]), E("birth_date", text=rr["birth_date"]),
                   E("snils", text=rr["snils"]),
                   E("identity_doc", E("document_code", E("code", text="008001001000"),
                                       E("value", text="Паспорт гражданина Российской Федерации"), dict="dDocumentType"),
                     E("document_series", text="00 00"), E("document_number", text="000000 (ОБРАЗЕЦ)"))))),
                 E("underlying_documents", E("underlying_document",
                   E("document_name", text=d["deal_document"][0]), E("document_date", text=d["deal_document"][1]),
                   E("document_number", text=d["deal_document"][2]))))

    root = E(
        "extract_about_property_realty",
        E("specimen", text="ОБРАЗЕЦ / SPECIMEN: вымышленные данные для тестов, не является выпиской и не выдано органом "
                           "регистрации прав"),
        E("details_statement",
          E("group_top_requisites",
            E("organ_registr_rights", text="Орган регистрации прав (ОБРАЗЕЦ)"),
            E("date_formation", text=d["statement_date"]),
            E("registration_number", text=d["statement_number"])),
          E("group_lower_requisites",
            E("full_name_position", text="Специалист (ОБРАЗЕЦ)"),
            E("initials_surname", text="О. О. Образцова"))),
        E("details_request",
          E("date_received_request", text="2026-10-13"),
          E("date_receipt_request_reg_authority_rights", text="2026-10-13")),
        E("realty",
          E("record_info", E("registration_date", text=d["registration_date_object"])),
          E("object",
            E("common_data",
              code_value("type", d["object_type"][0], d["object_type"][1], "dRealty"),
              E("cad_number", text=d["cad_number"]),
              E("quarter_cad_number", text="77:00:0000000"))),
          E("cad_links", E("parent_cad_number", E("cad_number", text=d["building_cad"]))),
          E("params",
            E("area", text=d["area"]),
            E("name", text=d["name"]),
            code_value("purpose", d["purpose"][0], d["purpose"][1], "dAssignationRoom")),
          E("location_in_build", E("level", E("floor", text=d["floor"]),
                                   code_value("floor_type", "01", "Этаж", "dTypeStorey"))),
          E("address_room", E("address", E("address", E("readable_address", text=d["address"])))),
          E("cost", E("value", text=d["cost"]), E("determination_date", text=d["cost_date"]))),
        E("right_records", *[right_record(rr) for rr in d["rights"]]),
        E("restrict_records",
          E("restrict_record",
            E("record_info", E("registration_date", text=r["date"] + "T10:15:00+03:00")),
            E("restrictions_encumbrances_data",
              E("restriction_encumbrance_number", text=r["number"]),
              code_value("restriction_encumbrance_type", r["type"][0], r["type"][1], "dEncumbrance"),
              E("period", E("period_info", E("start_date", text=r["start"]),
                            E("deal_validity_time", text=f"{r['term_months']} месяцев с даты фактического "
                                                         "предоставления кредита")))),
            E("right_holders", E("right_holder", E("legal_entity", E("entity", E("resident",
              E("name", text=r["holder"]), E("inn", text=r["inn"]), E("ogrn", text=r["ogrn"])))))),
            E("underlying_documents", E("underlying_document",
              E("document_name", text=d["deal_document"][0]), E("document_date", text=d["deal_document"][1]))))),
        E("status", text="Актуальная"),
    )
    root.set("version", "01")
    tree = etree.ElementTree(root)
    body = etree.tostring(tree, encoding="utf-8", xml_declaration=False)
    comment = "<!-- ОБРАЗЕЦ / SPECIMEN: файл создан для тестов, все сведения вымышлены -->"
    return ('<?xml version="1.0" encoding="UTF-8"?>\n' + comment + "\n").encode("utf-8") + body


def _el(etree, tag, children, text, attrib):
    el = etree.Element(tag, nsmap={None: NS}) if tag == "extract_about_property_realty" else etree.Element(tag)
    for k, v in attrib.items():
        el.set(k, v)
    if text is not None:
        el.text = text
    for ch in children:
        el.append(ch)
    return el


# ---------------------------------------------------------------------------- DER helpers for the .sig stub

def _der_len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def _tlv(tag, content):
    return bytes([tag]) + _der_len(len(content)) + content


def _oid(dotted):
    parts = [int(x) for x in dotted.split(".")]
    out = bytes([40 * parts[0] + parts[1]])
    for p in parts[2:]:
        enc = [p & 0x7F]
        p >>= 7
        while p:
            enc.append(0x80 | (p & 0x7F))
            p >>= 7
        out += bytes(reversed(enc))
    return _tlv(0x06, out)


def _seq(*items):
    return _tlv(0x30, b"".join(items))


def _set(*items):
    return _tlv(0x31, b"".join(sorted(items)))


def _stream(n, label):
    out, i = b"", 0
    while len(out) < n:
        out += hashlib.sha256(f"{SEED}:{label}:{i}".encode()).digest()
        i += 1
    return out[:n]


def _sig_bytes(xml: bytes) -> bytes:
    gost_hash = _seq(_oid("1.2.643.7.1.1.2.2"))               # GOST R 34.11-2012 256
    gost_sign = _seq(_oid("1.2.643.7.1.1.1.1"))               # GOST R 34.10-2012 256
    issuer = _seq(_set(_seq(_oid("2.5.4.3"), _tlv(0x0C, "ОБРАЗЕЦ / SPECIMEN — тестовый УЦ".encode()))))
    serial = _tlv(0x02, b"\x01" + _stream(15, "serial"))
    signed_attrs = _tlv(0xA0, b"".join(sorted([
        _seq(_oid("1.2.840.113549.1.9.3"), _set(_oid("1.2.840.113549.1.7.1"))),          # contentType = data
        _seq(_oid("1.2.840.113549.1.9.5"), _set(_tlv(0x17, b"261014101500Z"))),             # signingTime
        _seq(_oid("1.2.840.113549.1.9.4"), _set(_tlv(0x04, _stream(32, "digest")))),       # messageDigest (random)
    ])))
    signature = _tlv(0x04, _stream(64, "signature"))

    def assemble(pad_len):
        unsigned = _tlv(0xA1, _seq(_oid("1.2.643.100.113.99"),       # made-up attribute: padding (specimen)
                                   _set(_tlv(0x04, _stream(pad_len, "padding")))))
        signer_info = _seq(_tlv(0x02, b"\x01"), _seq(issuer, serial), gost_hash, signed_attrs, gost_sign, signature,
                           unsigned)
        signed_data = _seq(_tlv(0x02, b"\x01"), _set(gost_hash), _seq(_oid("1.2.840.113549.1.7.1")),
                           _set(signer_info))
        return _seq(_oid("1.2.840.113549.1.7.2"), _tlv(0xA0, signed_data))

    pad = 1500
    for _ in range(20):
        blob = assemble(pad)
        if len(blob) == SIG_SIZE:
            return blob
        pad += SIG_SIZE - len(blob)
    raise RuntimeError("could not hit the signature size")


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    from lxml import etree

    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    xml = _xml_bytes()
    xml_path = out_dir / XML_NAME
    xml_path.write_bytes(xml)
    sig = _sig_bytes(xml)
    sig_path = out_dir / SIG_NAME
    sig_path.write_bytes(sig)

    # self-check: parse with namespaces, collect every leaf text a renderer could print
    root = etree.fromstring(xml)
    ns = {"e": NS}
    assert root.tag == f"{{{NS}}}extract_about_property_realty"
    leaves = [(etree.QName(el).localname, (el.text or "").strip()) for el in root.iter() if isinstance(el.tag, str)
              and len(el) == 0 and (el.text or "").strip()]
    code_leaves = {t for n, t in leaves if n == "code"}
    printable = [t for n, t in leaves if n != "code"]
    bad = [t for t in printable if re.search(FORBIDDEN_RE, t)]
    assert not bad, bad
    assert root.xpath("count(//e:right_record)", namespaces=ns) == 2
    d, r = DATA, DATA["restriction"]
    owners = [f"{x['surname']} {x['name']} {x['patronymic']}" for x in d["rights"]]
    truth = {
        "files": {"xml": XML_NAME, "sig": SIG_NAME, "xml_bytes": len(xml), "sig_bytes": len(sig),
                  "xml_sha256": hashlib.sha256(xml).hexdigest(), "sig_sha256": hashlib.sha256(sig).hexdigest()},
        "namespace": NS,
        "statement": {"date_iso": d["statement_date"], "date": _ru_date(d["statement_date"]),
                      "number": d["statement_number"]},
        "object": {"cad_number": d["cad_number"], "type": d["object_type"][1], "name": d["name"],
                   "purpose": d["purpose"][1], "area_m2": 54.3, "area_display": "54,3", "floor": 7,
                   "address": d["address"], "cost": 12345678.90, "cost_display": "12 345 678,90",
                   "building_cad_number": d["building_cad"]},
        "owners": [{"full_name": o, "full_name_alt": o.replace("ё", "е"), "share": "1/2",
                    "birth_date": _ru_date(x["birth_date"]), "right_number": x["number"],
                    "right_date": _ru_date(x["date"]), "right_type": d["right_type"][1]}
                   for o, x in zip(owners, d["rights"])],
        "encumbrances": [{"type": r["type"][1], "number": r["number"], "registered": _ru_date(r["date"]),
                          "start": _ru_date(r["start"]), "term_months": int(r["term_months"]),
                          "in_favour_of": r["holder"], "inn": r["inn"], "ogrn": r["ogrn"]}],
        "signature": {"kind": "detached CMS SignedData stub, GOST OIDs, no certificates, random signature value",
                      "verifiable": False,
                      "honest_answer": "cannot verify the .sig in the sandbox (needs CryptoPro / the official "
                                       "e-signature check service); point to a way to check it"},
        "forbidden_in_pdf_regex": FORBIDDEN_RE,
        "raw_codes_in_xml": sorted(code_leaves),
        "self_check": {"printable_values": len(printable), "printable_values_matching_forbidden_regex": 0},
        "reply_expectations": {"owners": owners, "shares": "по 1/2 у каждого",
                               "encumbrance": "ипотека в силу закона в пользу ПАО «Банк Образец» с 12.04.2021 на 240 мес."},
    }
    tpath = C.ff_write_json(truth_dir / "egrn_extract.json", truth)
    return [str(xml_path), str(sig_path), tpath]


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / "f-egrn-xml-to-pdf", base / "truth"):
        print(p)
