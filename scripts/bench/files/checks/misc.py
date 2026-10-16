"""ZIP, ICS and VCF kinds and the discrepancy search."""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import posixpath
import re
import zipfile

from . import CheckError, check, failed, passed


# ------------------------------------------------------------------ zip
def zip_entries(ctx, item) -> list:
    """(decoded name, utf8 flag, sha256) of every file in the archive, nested archives included as «outer/inner»."""
    if "zip" in item.cache:
        return item.cache["zip"]
    out = []

    def walk(data: bytes, prefix: str, depth: int):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if info.is_dir() or info.file_size > 200 * 1024 * 1024:
                    continue
                body = z.read(info)
                name = prefix + info.filename
                out.append((name, bool(info.flag_bits & 0x800), hashlib.sha256(body).hexdigest(), info))
                if depth < 2 and name.lower().endswith(".zip"):
                    try:
                        walk(body, name + "/", depth + 1)
                    except zipfile.BadZipFile:
                        pass

    try:
        walk(item.path.read_bytes(), "", 0)
    except zipfile.BadZipFile as e:
        raise CheckError(f"ZIP не открывается: {e}") from e
    item.cache["zip"] = out
    return out


def _manifest(ctx) -> dict:
    return ctx.truth_doc("zip_manifest.json")


def _cyrillic(s: str) -> bool:
    return re.search(r"[а-яёА-ЯЁ]", s) is not None


def _mojibake(name: str, forbidden: set) -> bool:
    if any(ch in forbidden for ch in name):
        return True
    if re.search(r"[À-ÿͰ-Ͽ═-╿]", name) and not _cyrillic(name):
        return True
    try:
        return _cyrillic(name.encode("cp437").decode("cp866")) and not _cyrillic(name)
    except UnicodeError:
        return False


@check("zip_utf8_names", "zip")
def zip_utf8_names(ctx, params, item):
    forbidden = set(params.get("forbid_chars", []))
    if params.get("mojibake_from_truth"):
        chars = _manifest(ctx).get("self_check", {}).get("cp437_mojibake_chars", [])
        forbidden |= {c for c in chars if c not in "«»"}
    for name, utf8, _, _ in zip_entries(ctx, item):
        if not utf8 and not name.isascii():
            return failed(f"имя без флага UTF-8: «{name}»")
        if _mojibake(name, forbidden):
            return failed(f"кракозябры в имени «{name}»")
    return passed(f"{len(zip_entries(ctx, item))} имён в порядке")


def _source_records(ctx, exclude) -> list:
    return [r for r in _manifest(ctx)["records"] if r.get("category") not in set(exclude)]


def _text_of(data: bytes) -> str | None:
    """A text file's words whatever its encoding (UTF-8 with or without BOM, cp1251), its line ends alike."""
    for encoding in ("utf-8-sig", "cp1251"):
        try:
            return data.decode(encoding).replace("\r\n", "\n").strip()
        except UnicodeDecodeError:
            continue
    return None


def _bodies(data: bytes) -> dict:
    """sha256 → bytes of every file in an archive, nested archives included."""
    bodies = {}

    def walk(data: bytes, depth: int):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if info.is_dir() or info.file_size > 200 * 1024 * 1024:
                    continue
                body = z.read(info)
                bodies[hashlib.sha256(body).hexdigest()] = body
                if depth < 2 and info.filename.lower().endswith(".zip"):
                    try:
                        walk(body, depth + 1)
                    except zipfile.BadZipFile:
                        pass

    walk(data, 0)
    return bodies


@check("zip_preserves_content", "zip")
def zip_preserves_content(ctx, params, item):
    have = {sha for _, _, sha, _ in zip_entries(ctx, item)}
    missing = sorted({r["path"] for r in _source_records(ctx, params.get("exclude_categories", [])) if r["sha256"] not in have})
    if missing:
        # issues: 16.10 a cp1251 note came back in UTF-8 — the same text, new bytes; it opens on a phone now.
        records = {r["path"]: r for r in _manifest(ctx)["records"]}
        sources = {}
        for fixture in ctx.case.get("turns", [{}])[0].get("files", []):
            if fixture.lower().endswith(".zip"):
                sources.update(_bodies(ctx.fixture_path(fixture).read_bytes()))
        texts = {_text_of(body) for body in _bodies(item.path.read_bytes()).values() if len(body) < 1024 * 1024}
        missing = [
            path
            for path in missing
            if not (path.lower().endswith((".txt", ".csv")) and _text_of(sources.get(records[path]["sha256"], b"\xff\xfe\x00")) in texts - {None})
        ]
    if missing:
        return failed(f"нет {len(missing)}: " + ", ".join(missing[:6]))
    return passed("все нужные файлы на месте")


@check("zip_no_duplicates", "zip")
def zip_no_duplicates(ctx, params, item):
    counts = {}
    for name, _, sha, info in zip_entries(ctx, item):
        if info.file_size:
            counts.setdefault(sha, []).append(name)
    worst = max(counts.values(), key=len, default=[])
    if len(worst) > int(params.get("max_same_hash", 1)):
        return failed("дубли: " + ", ".join(worst[:3]))
    return passed("дублей нет")


def _by_source(ctx, item) -> dict:
    records = {r["path"]: r for r in _manifest(ctx)["records"]}
    where = {}
    for name, _, sha, _ in zip_entries(ctx, item):
        where.setdefault(sha, []).append(name)
    return {path: where.get(r["sha256"], []) for path, r in records.items()}


@check("zip_same_folder", "zip")
def zip_same_folder(ctx, params, item):
    found = _by_source(ctx, item)
    for group in params["groups"]:
        folders = set()
        for path in group["files"]:
            names = found.get(path) or []
            if not names:
                return failed(f"нет файла {path}")
            folders.add(posixpath.dirname(names[0]))
        if len(folders) != 1:
            return failed(f"{group['files'][0]}…: разные папки {sorted(folders)}")
        folder = folders.pop()
        if not re.search(group["folder_regex"], folder):
            return failed(f"папка «{folder}» не подходит под {group['folder_regex']}")
    return passed(f"{len(params['groups'])} групп по папкам")


def _date_forms(iso: str) -> list:
    y, m, d = iso.split("-")
    return [f"{y}-{m}-{d}", f"{y}_{m}_{d}", f"{y}.{m}.{d}", f"{y}{m}{d}", f"{d}.{m}.{y}", f"{d}-{m}-{y}", f"{d}_{m}_{y}"]


@check("zip_names_have_dates", "zip")
def zip_names_have_dates(ctx, params, item):
    found = _by_source(ctx, item)
    missing = []
    for path, iso in params["files"].items():
        names = found.get(path) or []
        if not names:
            missing.append(f"{path} (нет файла)")
            continue
        if not any(f in posixpath.basename(n) for n in names for f in _date_forms(iso)):
            missing.append(f"{posixpath.basename(names[0])} без {iso}")
    if missing:
        return failed("; ".join(missing[:5]))
    return passed(f"{len(params['files'])} имён с датами")


# ------------------------------------------------------------------ ics
def _unfold(text: str) -> list:
    return re.sub(r"\r?\n[ \t]", "", text).splitlines()


def _prop(line: str):
    head, _, value = line.partition(":")
    name, *params = head.split(";")
    return name.upper(), dict(p.split("=", 1) for p in params if "=" in p), value


def ics_events(ctx, item) -> list:
    if "ics" in item.cache:
        return item.cache["ics"]
    raw = item.path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise CheckError("ICS не в UTF-8") from e
    events, cur, alarm = [], None, None
    for line in _unfold(text):
        if not line.strip():
            continue
        name, prm, value = _prop(line)
        if name == "BEGIN" and value.upper() == "VEVENT":
            cur = {"props": [], "alarms": []}
        elif name == "END" and value.upper() == "VEVENT" and cur is not None:
            events.append(cur)
            cur = None
        elif cur is not None and name == "BEGIN" and value.upper() == "VALARM":
            alarm = []
        elif cur is not None and name == "END" and value.upper() == "VALARM":
            cur["alarms"].append(alarm)
            alarm = None
        elif alarm is not None:
            alarm.append((name, prm, value))
        elif cur is not None:
            cur["props"].append((name, prm, value))
    item.cache["ics"] = events
    return events


def _tz(name: str | None, default):
    from zoneinfo import ZoneInfo

    if not name:
        return default
    try:
        return ZoneInfo(name.strip('"'))
    except Exception:
        return default


def _moment(value: str, prm: dict, default_tz):
    value = value.strip()
    if re.fullmatch(r"\d{8}", value):
        return dt.datetime.strptime(value, "%Y%m%d").replace(tzinfo=default_tz)
    stamp = dt.datetime.strptime(value.rstrip("Z"), "%Y%m%dT%H%M%S")
    if value.endswith("Z"):
        return stamp.replace(tzinfo=dt.timezone.utc)
    return stamp.replace(tzinfo=_tz(prm.get("TZID"), default_tz))


def occurrences(ctx, item, tz) -> list:
    """(summary, start, end) of every occurrence, RRULE/RDATE/EXDATE expanded, RECURRENCE-ID overrides applied."""
    events = ics_events(ctx, item)
    base, overrides = [], {}
    for ev in events:
        props = {}
        for name, prm, value in ev["props"]:
            props.setdefault(name, []).append((prm, value))
        if "DTSTART" not in props:
            continue
        prm, value = props["DTSTART"][0]
        start = _moment(value, prm, tz)
        if "DTEND" in props:
            end = _moment(props["DTEND"][0][1], props["DTEND"][0][0], tz)
        elif "DURATION" in props:
            end = start + _duration(props["DURATION"][0][1])
        else:
            end = start
        summary = props.get("SUMMARY", [({}, "")])[0][1]
        uid = props.get("UID", [({}, "")])[0][1]
        if "RECURRENCE-ID" in props:
            rid = _moment(props["RECURRENCE-ID"][0][1], props["RECURRENCE-ID"][0][0], tz)
            overrides[(uid, rid)] = (summary, start, end)
            continue
        starts = [start]
        if "RRULE" in props:
            starts = _expand(props["RRULE"][0][1], start)
        for prm2, value2 in props.get("RDATE", []):
            starts += [_moment(v, prm2, tz) for v in value2.split(",") if v]
        excluded = set()
        for prm2, value2 in props.get("EXDATE", []):
            excluded |= {_moment(v, prm2, tz) for v in value2.split(",") if v}
        for s in starts:
            if s in excluded:
                continue
            base.append((uid, s, (summary, s, s + (end - start))))
    out = []
    for uid, s, occ in base:
        out.append(overrides.pop((uid, s), occ))
    out += list(overrides.values())
    return out


def _expand(rule: str, start) -> list:
    """RRULE occurrences in the event's own wall clock (DST-safe), as aware datetimes."""
    from dateutil.rrule import rrulestr

    tz = start.tzinfo

    def local_until(m):
        moment = dt.datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=dt.timezone.utc).astimezone(tz)
        return "UNTIL=" + moment.strftime("%Y%m%dT%H%M%S")

    rule = re.sub(r"UNTIL=(\d{8}T\d{6})Z", local_until, rule)
    rule = re.sub(r"UNTIL=(\d{8})(?=;|$)", r"UNTIL=\1T235959", rule)
    naive = start.replace(tzinfo=None)
    try:
        expanded = rrulestr(rule, dtstart=naive)
        moments = list(expanded.between(naive - dt.timedelta(seconds=1), dt.datetime(2030, 1, 1), inc=True))
    except (ValueError, TypeError) as e:
        raise CheckError(f"RRULE {rule}: {e}") from e
    return [m.replace(tzinfo=tz) for m in moments]


def _duration(value: str) -> dt.timedelta:
    m = re.fullmatch(r"(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", value.strip())
    if not m:
        raise CheckError(f"DURATION {value}")
    sign = -1 if m.group(1) else 1
    w, d, h, mi, s = (int(x or 0) for x in m.groups()[1:])
    return sign * dt.timedelta(weeks=w, days=d, hours=h, minutes=mi, seconds=s)


@check("ics_parse", "ics")
def ics_parse(ctx, params, item):
    raw = item.path.read_bytes()
    if b"BEGIN:VCALENDAR" not in raw:
        return failed("нет BEGIN:VCALENDAR")
    if not ics_events(ctx, item):
        return failed("нет событий")
    if params.get("fold_75"):
        lines = raw.split(b"\r\n")
        if raw.count(b"\n") != raw.count(b"\r\n"):
            return failed("строки не через CRLF")
        long_ = [l for l in lines if len(l) > 75]
        if long_:
            return failed(f"строка длиннее 75 октетов: {long_[0][:40]!r}")
    return passed(f"{len(ics_events(ctx, item))} событий")


def _msk(ctx, params):
    from zoneinfo import ZoneInfo

    return ZoneInfo(params.get("tz", "Europe/Moscow"))


@check("ics_occurrences", "ics")
def ics_occurrences(ctx, params, item):
    tz = _msk(ctx, params)
    start = dt.date.fromisoformat(params["start"])
    if params.get("start_not_before_run"):
        start = max(start, ctx.run_day)
    end = dt.date.fromisoformat(params["end"])
    occ = [o for o in occurrences(ctx, item, tz) if start <= o[1].astimezone(tz).date() <= end]
    truth = ctx.truth_doc("raspisanie_Lyovy.json")["occurrences"]
    expected = [o for o in truth if start <= dt.datetime.fromisoformat(o["start"]).date() <= end]
    want_total = len(expected) if params.get("start_not_before_run") else params["total"]
    problems = []
    if len(occ) != want_total:
        problems.append(f"всего {len(occ)}, нужно {want_total}")
    for pattern, count in params.get("by_summary_regex", {}).items():
        if params.get("start_not_before_run"):
            count = sum(1 for o in expected if re.search(pattern, o["summary"]))
        got = sum(1 for o in occ if re.search(pattern, o[0]))
        if got != count:
            problems.append(f"{pattern}: {got}, нужно {count}")
    if problems:
        return failed(f"с {start:%d.%m}: " + "; ".join(problems))
    return passed(f"с {start:%d.%m}: {len(occ)} вхождений")


@check("ics_none_between", "ics")
def ics_none_between(ctx, params, item):
    tz = _msk(ctx, params)
    occ = occurrences(ctx, item, tz)
    for a, b in params["ranges"]:
        lo, hi = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
        bad = [o for o in occ if lo <= o[1].astimezone(tz).date() <= hi]
        if bad:
            return failed(f"{bad[0][0]} {bad[0][1].astimezone(tz):%d.%m %H:%M} в {a}–{b}")
    return passed("в каникулы и праздники занятий нет")


@check("ics_has_event", "ics")
def ics_has_event(ctx, params, item):
    tz = _msk(ctx, params)
    start, end = dt.datetime.fromisoformat(params["start"]), dt.datetime.fromisoformat(params["end"])
    for summary, s, e in occurrences(ctx, item, tz):
        if re.search(params["summary_regex"], summary) and s == start and e == end:
            return passed(f"{summary} {s.astimezone(tz):%d.%m %H:%M}–{e.astimezone(tz):%H:%M}")
    return failed(f"нет события {params['start']}–{params['end']}")


@check("ics_all_events", "ics")
def ics_all_events(ctx, params, item):
    for ev in ics_events(ctx, item):
        props = {n: v for n, _, v in ev["props"]}
        title = props.get("SUMMARY", "?")
        if params.get("location_required") and not props.get("LOCATION", "").strip():
            return failed(f"«{title}» без LOCATION")
        if params.get("alarm"):
            triggers = [v for a in ev["alarms"] for n, _, v in a if n == "TRIGGER"]
            if not any(t.strip().upper() in (params["alarm"], params["alarm"].replace("-PT1H", "-PT60M")) for t in triggers):
                return failed(f"«{title}»: напоминание {triggers or 'нет'}")
        for name, prm, value in ev["props"]:
            if name == "DTSTART" and not (value.endswith("Z") or prm.get("TZID") or re.fullmatch(r"\d{8}", value)):
                return failed(f"«{title}»: время без часового пояса")
    return passed(f"{len(ics_events(ctx, item))} событий с напоминанием и адресом")


# ------------------------------------------------------------------ vcf
def vcards(ctx, item) -> list:
    if "vcf" in item.cache:
        return item.cache["vcf"]
    try:
        text = item.path.read_bytes().decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise CheckError("VCF не в UTF-8") from e
    cards, cur = [], None
    for line in _unfold(text):
        name, prm, value = _prop(line)
        if name == "BEGIN" and value.upper() == "VCARD":
            cur = []
        elif name == "END" and value.upper() == "VCARD" and cur is not None:
            cards.append(cur)
            cur = None
        elif cur is not None:
            cur.append((name.split(".")[-1], prm, value))
    item.cache["vcf"] = cards
    return cards


def _fn(card) -> str:
    for name, _, value in card:
        if name == "FN":
            return value
    for name, _, value in card:
        if name == "N":
            return " ".join(p for p in value.split(";") if p)
    return ""


def _phones(card) -> list:
    return [value.strip() for name, _, value in card if name == "TEL"]


def _e164(value: str) -> str:
    value = re.sub(r"^tel:", "", value.strip(), flags=re.I)
    m = re.match(r"\s*(\+?[\d\s()\-]+)(.*)$", value)
    if not m:
        return value
    return ("+" if m.group(1).strip().startswith("+") else "") + re.sub(r"\D", "", m.group(1)) + m.group(2).strip()


def _words(s: str) -> list:
    return sorted(w.lower().replace("ё", "е") for w in re.findall(r"\w+", s))


def find_card(cards, key: str, phone: str | None):
    for card in cards:
        if _words(_fn(card)) == _words(key):
            return card
    if phone:
        base = phone.split(";")[0]
        for card in cards:
            if any(_e164(p).startswith(base) for p in _phones(card)):
                return card
    return None


@check("vcf_parse", "vcf")
def vcf_parse(ctx, params, item):
    cards = vcards(ctx, item)
    bad = [i for i, c in enumerate(cards) if not any(n == "FN" for n, _, _ in c) or not any(n == "N" for n, _, _ in c)]
    if bad:
        return failed(f"без N или FN: {len(bad)} карточек")
    want, tol = params.get("count"), int(params.get("count_tol", 0))
    if want is not None and abs(len(cards) - want) > tol:
        return failed(f"карточек {len(cards)}, нужно {want}±{tol}")
    return passed(f"карточек {len(cards)}")


def _phone_ok(got: list, want: str, variants: list) -> bool:
    base, _, ext = want.partition(";ext=")
    for g in got:
        e = _e164(g)
        if not e.startswith(base):
            continue
        if not ext:
            if e == base:
                return True
            continue
        if any(e == base + v.replace("123", ext).strip() or e.replace(" ", "") == (base + v.replace("123", ext)).replace(" ", "")
               for v in variants):
            return True
    return False


@check("vcf_phones", "vcf")
def vcf_phones(ctx, params, item):
    cards = vcards(ctx, item)
    variants = params.get("ext_variants", [";ext=123"])
    problems = []
    for key, phones in params["expected"].items():
        real = [p for p in phones if p]
        card = find_card(cards, key, real[0] if real else None)
        if card is None:
            problems.append(f"нет карточки {key}")
            continue
        got = _phones(card)
        if not real:
            digits = [re.sub(r"\D", "", g) for g in got]
            if not any(d.endswith("0001234") for d in digits) or any(len(d) >= 11 for d in digits):
                problems.append(f"{key}: {got} (нужен номер без выдуманного кода)")
            continue
        for p in real:
            if not _phone_ok(got, p, variants):
                problems.append(f"{key}: нет {p} в {got}")
    if problems:
        return failed("; ".join(problems[:5]))
    return passed(f"{len(params['expected'])} контактов с номерами в E.164")


@check("vcf_merged", "vcf")
def vcf_merged(ctx, params, item):
    cards = vcards(ctx, item)
    for pattern, phones in params.get("must_contain_phones", {}).items():
        card = next((c for c in cards if re.search(pattern, _fn(c))), None) or find_card(cards, "", phones[0])
        if card is None:
            return failed(f"нет карточки {pattern}")
        missing = [p for p in phones if not _phone_ok(_phones(card), p, [])]
        if missing:
            return failed(f"«{_fn(card)}»: нет {missing}")
    if params.get("merge_groups_from_truth"):
        for group in ctx.truth_doc("kontakty.json")["merge_groups"]:
            first = group["phones"][0]
            holders = [c for c in cards if _phone_ok(_phones(c), first, [])]
            if len(holders) != 1:
                return failed(f"{group['names']}: номер {first} в {len(holders)} карточках")
            missing = [p for p in group["phones"] if not _phone_ok(_phones(holders[0]), p, [])]
            if missing:
                return failed(f"{group['names']}: в «{_fn(holders[0])}» нет {missing}")
    return passed("дубли слиты")


@check("vcf_bday", "vcf")
def vcf_bday(ctx, params, item):
    cards = vcards(ctx, item)
    for pattern, values in params["expected"].items():
        card = next((c for c in cards if re.search(pattern, _fn(c))), None)
        if card is None and params.get("phones", {}).get(pattern):
            card = find_card(cards, "", params["phones"][pattern])
        if card is None:
            return failed(f"нет карточки {pattern}")
        days = [value for name, _, value in card if name == "BDAY"]
        if not any(v.strip() in values or v.strip().replace("-", "") in [x.replace("-", "") for x in values] for v in days):
            return failed(f"«{_fn(card)}»: BDAY {days}")
    return passed("дни рождения в порядке")


# ------------------------------------------------------------------ discrepancies
def _numbers_in_text(text: str) -> list:
    text = text.replace(" ", " ").replace(" ", " ")
    out = []
    for m in re.finditer(r"\d{1,3}(?:[ ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?", text):
        s = m.group(0).replace(" ", "")
        try:
            out.append(float(s.replace(",", ".")))
        except ValueError:
            continue
    return out


@check("discrepancies")
def discrepancies(ctx, params):
    from .behavior import bro_texts
    from .office import _cells, _number, grids
    from .select import group_of, is_preview

    numbers = []
    where = params.get("where", ["reply", "xlsx", "pdf"])
    if "reply" in where:
        for text in bro_texts(ctx, {}):
            numbers += _numbers_in_text(text)
    for item in ctx.received:
        if item.turn is None or is_preview(item):
            continue
        group = group_of(item)
        try:
            if group == "xlsx" and "xlsx" in where:
                numbers += [n for _, rows in grids(ctx, item.path) for _, _, v in _cells(rows)
                            for n in [_number(v)] if n is not None]
            elif group == "pdf" and "pdf" in where:
                numbers += _numbers_in_text(ctx.text(item.path))
        except CheckError:
            continue
    missing = [a for a in [*params["amounts"], params["total"]] if not any(abs(abs(n) - a) <= 0.01 for n in numbers)]
    if missing:
        return failed("не названы расхождения: " + ", ".join(f"{m:,.2f}".replace(",", " ") for m in missing))
    return passed("три расхождения и итог названы")
