"""brokit vcf write: a contacts file (vCard 3.0, RFC 2426) that iPhone and Android import.

SPEC.json:
    {"contacts": [{"name": "Иванова Мария Петровна", "org": "ООО «Ромашка»", "title": "бухгалтер",
                   "phones": [{"tel": "+79161234567", "type": "cell"}, {"tel": "+74950000001,123", "type": "work"}],
                   "emails": ["maria@example.ru", {"email": "m.ivanova@romashka.ru", "type": "work"}],
                   "note": "…", "birthday": "1985-05-12", "address": "Москва, ул. Примерная, 10"}]}

`name` is one string, or `family`, `given`, `middle` (beside it or as its object). A string of 2-3 capitalised
words is read as Фамилия Имя [Отчество] (Имя Отчество Фамилия when the
patronymic stands second; «оглы», «кызы» after the patronymic stay with it);
any other string goes whole into the given name («Мама», «Саша с работы»). A
card with an org and no name is a company card (FN is the org, X-ABShowAs:COMPANY).

A tel is brought to +7… by the rules of `brokit ru phone`, an extension after
its comma (8-495-000-00-01 доб. 123 → +74950000001,123); one those rules cannot
bring for sure («00-12-34» without a code) is written as given and named in
`warnings`. A note that is only an extension («доб. 123») on a card with one
phone without one becomes that phone's extension. Types:
cell, work, home, main (written PREF, as Android does), fax; a Russian mobile
(+79…) without a type is CELL. `address` is a string or {street, city, region,
postcode, country, type: home|work}; `birthday` is YYYY-MM-DD or DD.MM.YYYY,
and without a year DD.MM or --MM-DD, written BDAY:--MM-DD (ISO 8601 without
the year: Android keeps it as is, Google and Apple read it).

Every line ends with CRLF and is folded at 75 octets on a character boundary,
TEXT is escaped (\\ \\; \\, and \\n): the same rules as brokit/ics.py.

`warnings` name a tel without +, a phone or email given twice on one card
(written once), a phone on two cards, two cards of one name, a two-word name
whose second word looks like the family name, and keys the command does not
know. A contact with neither a name, an org nor a phone is refused.
"""

import datetime as dt
import json
import re

from brokit.ics import fold, text
from brokit.ru.phone import phones
from brokit.util import KitError, need_file, out_path, parser

MAX_CONTACTS = 5000
SPEC_HINT = (
    '{"contacts": [{"name": "Фамилия Имя Отчество", "org", "title", "phones": [{"tel": "+79161234567", '
    '"type": "cell|work|home|main|fax"}], "emails": ["a@b.ru"], "note", "birthday": "1985-05-12", "address"}]}'
)
SPEC_KEYS = ("contacts",)
CONTACT_KEYS = (
    "name",
    "family",
    "given",
    "middle",
    "org",
    "title",
    "phones",
    "emails",
    "note",
    "birthday",
    "address",
)
TEL_TYPES = {"cell": "CELL", "mobile": "CELL", "work": "WORK", "home": "HOME", "main": "PREF", "fax": "FAX"}
EMAIL_TYPES = {"home": "HOME", "work": "WORK"}
ADDRESS_TYPES = {"home": "HOME", "work": "WORK"}
ADDRESS_KEYS = ("street", "city", "region", "postcode", "country", "type")
NAME_WORD = re.compile(r"[^\W\d_]+(?:[-'’][^\W\d_]+)*")
PATRONYMIC = re.compile(r"(?:ич|вна|чна)$")
PATRONYMIC_TAILS = ("оглы", "кызы", "улы", "уулу", "гызы")
FAMILY_LIKE = re.compile(r"(?:ов|ев|ёв|ова|ева|ёва|ский|цкий|ская|цкая)$")
RUSSIAN_MOBILE = re.compile(r"\+79\d{9}(?:,\d+)?")
# A tel already in the form a phone dials: +, the digits, an extension after a comma.
WRITTEN_TEL = re.compile(r"\+\d{6,15}(?:,\d{1,6})?")
# A note that is nothing but an extension: «доб. 123», «вн.12», «ext 5».
EXTENSION_NOTE = re.compile(r"(?i)(?:доб(?:авочный)?|вн(?:утр(?:енний)?)?|ext)\.?\s*[:.]?\s*(\d{1,6})\.?")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def line_text(value):
    """A one-line field: control characters out, runs of spaces as one."""
    return " ".join(CONTROL.sub(" ", str(value)).split())


def is_name_word(word):
    return bool(NAME_WORD.fullmatch(word)) and word[0].isupper()


def family_like(word):
    return len(word) >= 5 and bool(FAMILY_LIKE.search(word.lower()))


def split_name(name):
    """(family, given, middle, doubt) of one name string; doubt is a word that may be the family name."""
    words = name.split()
    if 2 <= len(words) <= 3 and all(is_name_word(w) for w in words):
        if len(words) == 3 and PATRONYMIC.search(words[1].lower()) and not PATRONYMIC.search(words[2].lower()):
            return words[2], words[0], words[1], None
        doubt = words[1] if len(words) == 2 and family_like(words[1]) and not family_like(words[0]) else None
        return words[0], words[1], " ".join(words[2:]), doubt
    if len(words) == 4 and words[3].lower() in PATRONYMIC_TAILS and all(is_name_word(w) for w in words[:3]):
        return words[0], words[1], " ".join(words[2:]), None
    return "", name, "", None


def as_list(value, label, key):
    if value is None:
        return []
    if isinstance(value, (str, int, dict)) and not isinstance(value, bool):
        return [value]
    if not isinstance(value, list):
        raise KitError("bad_spec", "%s: %s must be a list" % (label, key), SPEC_HINT)
    return value


def phone_lines(contact, label, warnings):
    """(TEL lines, their duplicate keys) of a contact."""
    lines, keys = [], []
    for item in as_list(contact.get("phones"), label, "phones"):
        tel, kind = (item.get("tel"), item.get("type")) if isinstance(item, dict) else (item, None)
        if tel is None or isinstance(tel, (bool, dict, list)):
            raise KitError("bad_spec", "%s: a phone needs a tel" % label, SPEC_HINT)
        tel = CONTROL.sub("", str(tel)).strip()
        if not tel:
            warnings.append("%s: an empty phone skipped" % label)
            continue
        if not re.search(r"\d", tel):
            raise KitError("bad_spec", "%s: phone %r has no digits" % (label, tel), SPEC_HINT)
        if not WRITTEN_TEL.fullmatch(tel):
            # The task agent once passed «8-495-000-00-01 доб. 123» as it stood, and iPhone dialled it wrong.
            rows = phones(tel)
            if len(rows) == 1 and rows[0]["e164"]:
                tel = rows[0]["tel"]
        key = re.sub(r"[^\d+,]", "", tel)
        if key in keys:
            warnings.append("%s: phone %s is given twice, written once" % (label, tel))
            continue
        keys.append(key)
        if not tel.startswith("+"):
            warnings.append(
                "%s: phone %s does not start with +, a phone abroad dials it wrong (brokit ru phone)" % (label, tel)
            )
        if kind is None or not str(kind).strip():
            kind = "cell" if RUSSIAN_MOBILE.fullmatch(key) else None
        kind = str(kind).strip().lower() if kind is not None else None
        if kind is not None and kind not in TEL_TYPES:
            warnings.append("%s: phone type %r is unknown, written without a type" % (label, kind))
        mapped = TEL_TYPES.get(kind)
        lines.append("TEL" + (";TYPE=" + mapped if mapped else "") + ":" + tel)
    return lines, keys


def email_lines(contact, label, warnings):
    lines, seen = [], set()
    for item in as_list(contact.get("emails"), label, "emails"):
        email, kind = (item.get("email"), item.get("type")) if isinstance(item, dict) else (item, None)
        email = line_text(email) if email is not None else ""
        if not email:
            warnings.append("%s: an empty email skipped" % label)
            continue
        if email.lower() in seen:
            warnings.append("%s: email %s is given twice, written once" % (label, email))
            continue
        seen.add(email.lower())
        if "@" not in email:
            warnings.append("%s: %s does not look like an email" % (label, email))
        kind = str(kind).strip().lower() if kind is not None else ""
        if kind and kind not in EMAIL_TYPES:
            warnings.append("%s: email type %r is unknown, written without one" % (label, kind))
        types = ["INTERNET"] + ([EMAIL_TYPES[kind]] if kind in EMAIL_TYPES else [])
        lines.append("EMAIL;TYPE=%s:%s" % (",".join(types), text(email)))
    return lines


def address_line(value, label, warnings):
    if isinstance(value, dict):
        unknown = sorted(set(value) - set(ADDRESS_KEYS))
        if unknown:
            warnings.append("%s: unknown address keys ignored: %s" % (label, ", ".join(unknown)))
        parts = [line_text(value.get(key) or "") for key in ADDRESS_KEYS[:-1]]
        kind = str(value.get("type") or "").strip().lower()
    else:
        parts, kind = [line_text(value), "", "", "", ""], ""
    if not any(parts):
        return None
    if kind and kind not in ADDRESS_TYPES:
        warnings.append("%s: address type %r is unknown, written without one" % (label, kind))
    # ADR: post office box; extended address; street; locality; region; postal code; country.
    head = "ADR" + (";TYPE=" + ADDRESS_TYPES[kind] if kind in ADDRESS_TYPES else "")
    return head + ":;;" + ";".join(text(part) for part in parts)


def birthday(value, label):
    raw = str(value).strip()
    russian = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", raw)
    yearless = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.?|--(\d{2})-?(\d{2})", raw)
    try:
        if russian:
            return dt.date(int(russian[3]), int(russian[2]), int(russian[1])).isoformat()
        if yearless:
            day, month = (yearless[1], yearless[2]) if yearless[1] else (yearless[4], yearless[3])
            # 2000 is a leap year: 29.02 is a birthday too.
            return "--" + dt.date(2000, int(month), int(day)).isoformat()[5:]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            raise ValueError(raw)
        return dt.date.fromisoformat(raw).isoformat()
    except ValueError:
        raise KitError(
            "bad_spec",
            "%s: birthday %r is not YYYY-MM-DD" % (label, value),
            "YYYY-MM-DD or DD.MM.YYYY; without a year DD.MM",
        )


def read_spec(path):
    need_file(path)
    try:
        with open(path, encoding="utf-8-sig") as handle:
            spec = json.load(handle)
    except (OSError, ValueError) as error:
        raise KitError("bad_spec", "SPEC.json: %s" % error, SPEC_HINT)
    contacts = spec.get("contacts") if isinstance(spec, dict) else None
    if not isinstance(contacts, list) or not contacts or len(contacts) > MAX_CONTACTS:
        raise KitError("bad_spec", "SPEC.json needs 1-%d contacts" % MAX_CONTACTS, SPEC_HINT)
    return spec, contacts


def write(argv):
    p = parser("vcf write")
    p.add_argument("spec")
    p.add_argument("-o", "--out", required=True)
    args = p.parse_args(argv)
    if not args.out.lower().endswith(".vcf"):
        raise KitError("bad_output", "the output must be .vcf", "phones import contacts from a .vcf file")
    spec, contacts = read_spec(args.spec)
    out_path(args.out, args.spec)
    warnings = []
    unknown = sorted(set(spec) - set(SPEC_KEYS))
    if unknown:
        warnings.append("unknown keys ignored: " + ", ".join(unknown))
    body, phones, names, numbers = [], 0, {}, {}
    for n, contact in enumerate(contacts, 1):
        if not isinstance(contact, dict):
            raise KitError("bad_spec", "contact %d is not an object" % n, SPEC_HINT)
        name, source = contact.get("name") or "", contact
        if isinstance(name, dict):
            name, source = "", name  # {"name": {"family", "given", "middle"}}
        elif not isinstance(name, str):
            raise KitError("bad_spec", "contact %d: name must be a string" % n, SPEC_HINT)
        name = line_text(name)
        parts = [line_text(source.get(key) or "") for key in ("family", "given", "middle")]
        org, title = line_text(contact.get("org") or ""), line_text(contact.get("title") or "")
        label = "contact %d (%s)" % (n, name or " ".join(p for p in parts if p) or org or "no name")
        unknown = sorted(set(contact) - set(CONTACT_KEYS))
        if unknown:
            warnings.append("%s: unknown keys ignored: %s" % (label, ", ".join(unknown)))
        family, given, middle = parts
        if not any(parts) and name:
            family, given, middle, doubt = split_name(name)
            if doubt:
                warnings.append(
                    "%s: split as Фамилия Имя, but «%s» looks like the family name; give family and given"
                    % (label, doubt)
                )
        tels, keys = phone_lines(contact, label, warnings)
        note = str(contact.get("note") or "").strip()
        lone = EXTENSION_NOTE.fullmatch(note)
        if lone and len(tels) == 1 and "," not in keys[0]:
            # 17.10 the task agent kept «доб. 123» in the note and the bare number in the card: iPhone
            # would dial the office without the extension.
            tels[0], keys[0] = tels[0] + "," + lone.group(1), keys[0] + "," + lone.group(1)
            warnings.append("%s: the note «%s» is the phone's extension, written after its comma" % (label, note))
            note = ""
        full = name or " ".join(p for p in (family, given, middle) if p)
        if not full and not org and not tels:
            raise KitError("bad_spec", "contact %d needs a name, an org or a phone" % n, SPEC_HINT)
        if full:
            if full.lower() in names:
                warnings.append("%s repeats contact %d: the same name" % (label, names[full.lower()]))
            names.setdefault(full.lower(), n)
        for key, tel in zip(keys, tels):
            if key in numbers:
                warnings.append("%s: %s is also on contact %d" % (label, tel.split(":", 1)[1], numbers[key]))
            numbers.setdefault(key, n)
        company = not full and bool(org)
        if not full and not org:
            warnings.append("%s has neither a name nor an org: phones show it by its number" % label)
        card = [
            "BEGIN:VCARD",
            "VERSION:3.0",
            "N:" + ";".join(text(part) for part in (family, given, middle, "", "")),
            "FN:" + text(full or org or tels[0].split(":", 1)[1]),
        ]
        if org:
            card.append("ORG:" + text(org))
        if title:
            card.append("TITLE:" + text(title))
        card += tels + email_lines(contact, label, warnings)
        if contact.get("address"):
            address = address_line(contact["address"], label, warnings)
            if address:
                card.append(address)
        if contact.get("birthday"):
            card.append("BDAY:" + birthday(contact["birthday"], label))
        if note:
            card.append("NOTE:" + text(note))
        if company:
            card.append("X-ABShowAs:COMPANY")
        body += card + ["END:VCARD"]
        phones += len(tels)
    data = "".join(fold(line) + "\r\n" for line in body).encode("utf-8")
    with open(args.out, "wb") as handle:
        handle.write(data)
    return {"output": args.out, "contacts": len(contacts), "phones": phones, "bytes": len(data), "warnings": warnings}
