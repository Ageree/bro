"""brokit ru decline: Russian full names in a grammatical case.

The rules are petrovich-rules (brokit/ru/rules.py, MIT): exceptions match the
whole word, suffixes the end; a rule's mod per case drops one letter per "-" and
appends the rest. Gender comes from the patronymic, then the first name, then
the surname. Parts of a double name ("Римский-Корсаков") decline separately.

LOCAL holds surnames the rules get wrong (W2 spec §6.12): «Ворона» declines as
the noun («Вороне», not «Вороной»), and surnames with a fleeting «е»
(«Соловей» -> «Соловью») lose it. LOCAL_GENDER holds first names the gender
table does not know.
"""

from brokit.util import KitError, need_file, parser

CASES = ("gen", "dat", "acc", "ins", "pre")
PARTS = {"fio": ("last", "first", "middle"), "if": ("first", "middle", "last")}
RULE_PART = {"last": "lastname", "first": "firstname", "middle": "middlename"}
GENDERS = {"m": "male", "f": "female"}

# Surname -> {gender or "any": mods for gen, dat, acc, ins, pre}.
NOUN_A = ["-ы", "-е", "-у", "-ой", "-е"]
FLEETING_E = ["--ья", "--ью", "--ья", "--ьём", "--ье"]
UNCHANGED = [".", ".", ".", ".", "."]
LOCAL = {
    "ворона": {"any": NOUN_A},
    "соловей": {"male": FLEETING_E, "female": UNCHANGED},
    "воробей": {"male": FLEETING_E, "female": UNCHANGED},
    "муравей": {"male": FLEETING_E, "female": UNCHANGED},
}
LOCAL_GENDER = {"нино": "female", "натела": "female", "кетеван": "female"}


def main(argv):
    p = parser("ru decline")
    p.add_argument("name", nargs="?")
    p.add_argument("--case", required=True, choices=CASES)
    p.add_argument("--gender", default="auto", choices=("auto", "m", "f"))
    p.add_argument("--order", default="fio", choices=tuple(PARTS))
    p.add_argument("--file")
    args = p.parse_args(argv)
    names = []
    if args.name:
        names.append(args.name)
    if args.file:
        need_file(args.file)
        with open(args.file, encoding="utf-8-sig") as handle:
            names.extend(line.strip() for line in handle if line.strip())
    if not names:
        raise KitError("bad_args", "give a name or --file NAMES.txt")
    if len(names) > 5000:
        raise KitError("too_many", "more than 5000 names in one call")
    forced = GENDERS.get(args.gender)
    results = []
    warnings = []
    for name in names:
        result, gender = decline(name, args.case, args.order, forced)
        results.append({"input": name, "case": args.case, "gender": short_gender(gender), "result": result})
        if gender == "androgynous":
            warnings.append("gender_unknown: " + name + " (pass --gender m|f)")
    return {"results": results, "warnings": warnings}


def short_gender(gender):
    return {"male": "m", "female": "f"}.get(gender, "unknown")


def decline(full_name, case, order="fio", gender=None):
    """(declined name, gender) for "Фамилия Имя [Отчество]" (order fio) or "Имя [Отчество] Фамилия" (order if)."""
    words = full_name.split()
    if not words:
        return full_name, "androgynous"
    keys = PARTS[order]
    if len(words) == 2:
        keys = ("last", "first") if order == "fio" else ("first", "last")
    elif len(words) == 1:
        keys = (keys[0],)
    elif len(words) > 3:
        # Extra words (a second given name, «оглы», «кызы») stay as written.
        keys = keys + ("keep",) * (len(words) - 3)
    parts = dict(zip(keys, words))
    found = gender or detect_gender(parts.get("first"), parts.get("middle"), parts.get("last"))
    declined = [
        word if key == "keep" else decline_part(RULE_PART[key], word, found, case)
        for key, word in zip(keys, words)
    ]
    return " ".join(declined), found


def detect_gender(first=None, middle=None, last=None):
    for part, value in (("middlename", middle), ("firstname", first), ("lastname", last)):
        if value:
            found = gender_of(part, value)
            if found in ("male", "female"):
                return found
    return "androgynous"


def gender_of(part, value):
    from brokit.ru.rules import GENDER

    table = GENDER[part]
    low = value.lower()
    if part == "firstname" and low in LOCAL_GENDER:
        return LOCAL_GENDER[low]
    for gender, words in table.get("exceptions", {}).items():
        if low in words:
            return gender
    best = None
    for gender, suffixes in table.get("suffixes", {}).items():
        for suffix in suffixes:
            if low.endswith(suffix) and (best is None or len(suffix) > len(best[1])):
                best = (gender, suffix)
    return best[0] if best else None


def decline_part(part, value, gender, case):
    pieces = value.split("-")
    out = []
    for index, piece in enumerate(pieces):
        tags = {"first_word"} if index == 0 and len(pieces) > 1 else set()
        mods = local_mods(part, piece, gender) or rule_mods(part, piece, gender, tags)
        out.append(apply(piece, mods[CASES.index(case)]) if mods else piece)
    return "-".join(out)


def local_mods(part, piece, gender):
    if part != "lastname":
        return None
    entry = LOCAL.get(piece.lower())
    if entry is None:
        return None
    return entry.get(gender) or entry.get("any") or UNCHANGED


def rule_mods(part, piece, gender, tags):
    from brokit.ru.rules import RULES

    rules = RULES[part]
    low = piece.lower()
    for kind, whole in (("exceptions", True), ("suffixes", False)):
        for rule in rules.get(kind, []):
            if set(rule.get("tags", [])) - tags:
                continue
            if rule["gender"] != "androgynous" and rule["gender"] != gender:
                continue
            for test in rule["test"]:
                if (low == test) if whole else low.endswith(test):
                    return rule["mods"]
    return None


def apply(word, mod):
    result = word
    for char in mod:
        if char == "-":
            result = result[:-1]
        elif char != ".":
            result += char
    if word.isupper() and len(word) > 1:
        return result.upper()
    return result
