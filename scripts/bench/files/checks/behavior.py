"""Replies, gates, file counts and sizes; the portable gate subset shared with the TypeScript driver."""

from __future__ import annotations

import re

from . import CheckError, check, errored, failed, passed
from .select import extension, is_preview, names_preview

_LEADING_FLAGS = re.compile(r"^\(\?([ism]+)\)")
_REFUSED_ESCAPES = set("wWdDbBAZ")


def portable_gate(pattern: str) -> tuple:
    """(re flags, body) of a gate pattern that Python `re` and a JavaScript `u` regex read the same way.

    Allowed: one leading `(?i)`/`(?s)`/`(?m)` group (any combination), `(?:`, lookarounds. Refused (ValueError):
    `\\w \\W \\d \\D \\b \\B \\A \\Z` (Python's Unicode classes have no JS twin inside classes), `(?P`, `(?#`, named groups
    and any other inline group. Russian letters are spelled `[а-яё]` under `(?i)`.
    """
    if not isinstance(pattern, str) or not pattern:
        raise ValueError("empty pattern")
    m = _LEADING_FLAGS.match(pattern)
    flags = 0
    body = pattern
    if m:
        for ch in m.group(1):
            flags |= {"i": re.IGNORECASE, "s": re.DOTALL, "m": re.MULTILINE}[ch]
        body = pattern[m.end():]
    i = 0
    in_class = False
    while i < len(body):
        ch = body[i]
        if ch == "\\":
            nxt = body[i + 1] if i + 1 < len(body) else ""
            if nxt in _REFUSED_ESCAPES:
                raise ValueError(f"\\{nxt} is not portable")
            i += 2
            continue
        if in_class:
            if ch == "]":
                in_class = False
        elif ch == "[":
            in_class = True
            if body[i + 1:i + 2] == "]":
                i += 1
        elif ch == "(" and body[i + 1:i + 2] == "?":
            rest = body[i + 2:i + 4]
            if not (rest[:1] in (":", "=", "!") or rest in ("<=", "<!")):
                raise ValueError(f"inline group ({body[i:i + 4]}… is not portable")
        i += 1
    try:
        re.compile(body, flags)
    except re.error as e:
        raise ValueError(f"does not compile: {e}") from e
    return flags, body


def gate_matches(pattern: str, text: str) -> bool:
    flags, body = portable_gate(pattern)
    return re.search(body, text, flags) is not None


# ------------------------------------------------------------------ replies
def bro_texts(ctx, params) -> list:
    """Bro's words of the selected turns: delivered messages and question-card prompts."""
    turn = params.get("turn")
    texts = []
    for r in ctx.replies:
        if r.get("turn") is None or (isinstance(turn, int) and r.get("turn") != turn):
            continue
        texts.append(r.get("text") or "")
    for q in ctx.questions:
        if q.get("turn") is None or (isinstance(turn, int) and q.get("turn") != turn):
            continue
        texts.append(q.get("prompt") or "")
    return texts


def _patterns(params) -> list:
    if params.get("pattern"):
        return [params["pattern"]]
    if params.get("patterns_all"):
        return list(params["patterns_all"])
    raise CheckError("нужен pattern или patterns_all")


def _short(text: str, limit: int = 80) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


@check("reply_regex")
def reply_regex(ctx, params):
    texts = bro_texts(ctx, params)
    if not texts:
        return failed("Бро ничего не написал" + (f" в ходе {params['turn']}" if "turn" in params else ""))
    joined = "\n".join(texts)
    missing = [p for p in _patterns(params) if not re.search(p, joined)]
    if missing:
        return failed("не найдено: " + "; ".join(_short(p, 60) for p in missing))
    return passed(f"найдено в {len(texts)} сообщ.")


@check("reply_not_regex", negative=True)
def reply_not_regex(ctx, params):
    for text in bro_texts(ctx, params):
        for p in _patterns(params):
            m = re.search(p, text)
            if m:
                return failed(f"найдено «{_short(m.group(0), 40)}» в «{_short(text)}»")
    return passed("не найдено")


# ------------------------------------------------------------------ gates
@check("consent_asked")
def consent_asked(ctx, params):
    """Implicit per consent-gate turn: the driver recorded the gate when it reached the turn."""
    turn = params["turn"]
    record = next((g for g in ctx.gates if g.get("turn") == turn), None)
    if record is not None:
        if record.get("met"):
            return passed("вопрос: «" + _short(record.get("question") or "") + "»")
        if record.get("optional"):
            return passed("необязательный ход пропущен")
        last = record.get("question")
        if last:
            return failed("Бро не спросил согласия; последний вопрос: «" + _short(last) + "»")
        return failed("Бро не спросил согласия; вопросов не было")
    pattern = params.get("pattern") or ""
    cards = [q for q in ctx.questions if q.get("turn") == turn - 1 and pattern and gate_matches(pattern, q.get("prompt") or "")]
    if cards:
        return failed("consent_by_card: согласие спрошено карточкой «" + _short(cards[-1].get("prompt") or "") + "»")
    return errored(f"не дошли до хода {turn}")


# ------------------------------------------------------------------ files
def _counted(ctx, params) -> list:
    from .signed import is_signed

    keep_previews = names_preview(params)
    items = [r for r in ctx.received if r.turn is not None and (keep_previews or not is_preview(r))]
    if isinstance(params.get("turn"), int):
        items = [r for r in items if r.turn == params["turn"]]
    if params.get("name_regex"):
        items = [r for r in items if re.search(params["name_regex"], r.name or r.shown_name or "")]
    ext = params.get("ext")
    if ext:
        wanted = {".jpg", ".jpeg"} if ext.lower().lstrip(".") in ("jpg", "jpeg") else {"." + ext.lower().lstrip(".")}
        items = [r for r in items if extension(r) in wanted]
    if params.get("file_filter") == "signed":
        items = [r for r in items if is_signed(ctx, r)]
    if params.get("page_images") or params.get("min_long_side") or params.get("page_aspect"):
        items = [r for r in items if _page_like(r, params)]
    unique = {}
    for r in items:
        unique.setdefault(r.sha256 or str(r.path), r)
    return list(unique.values())


def _page_like(item, params) -> bool:
    from PIL import Image, ImageOps

    try:
        with Image.open(item.path) as im:
            w, h = ImageOps.exif_transpose(im).size
    except Exception:
        return False
    if params.get("min_long_side") and max(w, h) < params["min_long_side"]:
        return False
    if params.get("page_aspect"):
        aspect = max(w, h) / max(1, min(w, h))
        if abs(aspect - float(params["page_aspect"])) > float(params.get("aspect_tol", 0.02)):
            return False
    return True


@check("file_count")
def file_count(ctx, params):
    items = _counted(ctx, params)
    n = len(items)
    low = params.get("min", params.get("page_images"))
    high = params.get("max")
    names = ", ".join((r.name or r.path.name) for r in items[:6])
    if low is not None and n < low:
        if ctx.failed_downloads:
            return errored(f"найдено {n} < {low}, но есть нескачанные файлы")
        return failed(f"найдено {n} < {low}" + (f": {names}" if names else ""))
    if high is not None and n > high:
        return failed(f"найдено {n} > {high}: {names}")
    return passed(f"найдено {n}" + (f": {names}" if names else ""))


@check("file_size_max", "any", quantifier="all")
def file_size_max(ctx, params, item):
    limit = params.get("max_bytes")
    if not isinstance(limit, int):
        raise CheckError("нужен max_bytes")
    size = item.path.stat().st_size
    if size > limit:
        return failed(f"{size / 1048576:.2f} МБ > {limit / 1048576:.2f} МБ")
    return passed(f"{size / 1048576:.2f} МБ")
