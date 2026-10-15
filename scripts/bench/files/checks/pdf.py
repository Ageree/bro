"""PDF kinds: form values, text in rects, images on pages, rasters, OCR, page order and templates, signing marks."""

from __future__ import annotations

import re

from . import CheckError, check, errored, failed, passed
from .context import area, expand, inside, intersection_area
from .signed import components, dilate, placements, share_inside

SIG_FIELD = re.compile(r"^bro_sign_(signature|initials|date)_\d+$")
SIGNED_KEYWORDS = re.compile(r"signed-by-bro [0-9a-f-]{36}")
BACKGROUND_SHARE = 0.5  # an image covering half the page is the page itself (a scan), not a placed mark


# ------------------------------------------------------------------ text helpers
def norm_text(text: str) -> str:
    text = text.replace("­", "").replace(" ", " ").replace(" ", " ").replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def norm_quotes(text: str) -> str:
    return text.replace("«", '"').replace("»", '"').replace("„", '"').replace("“", '"').replace("”", '"')


def levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(got: str, want: str) -> float:
    got, want = norm_text(got).lower(), norm_text(want).lower()
    if not want:
        return 0.0 if not got else 1.0
    return levenshtein(got, want) / len(want)


def best_window_cer(text: str, want: str) -> float:
    """Smallest CER of `want` against any substring of `text` of a similar length."""
    text, want = norm_text(text).lower(), norm_text(want).lower()
    if not want:
        return 0.0
    if len(text) <= len(want):
        return levenshtein(text, want) / len(want)
    best = 1.0
    n = len(want)
    for size in range(max(1, int(n * 0.8)), int(n * 1.2) + 1):
        for start in range(0, len(text) - size + 1):
            best = min(best, levenshtein(text[start:start + size], want) / n)
            if best == 0:
                return 0.0
    return best


def words_in_rect(ctx, pdf, page: int, rect) -> str:
    words = [w for w in ctx.words(pdf, page) if inside(w.center, rect)]
    words.sort(key=lambda w: (-round(w.rect[3] / 3), w.rect[0]))
    return norm_text(" ".join(w.text for w in words))


def page_texts(ctx, pdf) -> list:
    return [norm_text(ctx.text(pdf, n)) for n in range(1, ctx.page_count(pdf) + 1)]


def select_pages(ctx, pdf, params) -> list:
    """1-based page numbers named by `page`, `pages`, `last_pages` or `page_text_regex` (default: every page)."""
    count = ctx.page_count(pdf)
    if isinstance(params.get("page"), int):
        pages = [params["page"]]
    elif params.get("pages"):
        pages = list(params["pages"])
    elif params.get("last_pages"):
        pages = list(range(max(1, count - int(params["last_pages"]) + 1), count + 1))
    elif params.get("page_text_regex"):
        texts = page_texts(ctx, pdf)
        pages = [i + 1 for i, t in enumerate(texts) if re.search(params["page_text_regex"], t)]
    else:
        pages = list(range(1, count + 1))
    return [p for p in pages if 1 <= p <= count] if pages else []


# ------------------------------------------------------------------ raster helpers
def crop_rect(ctx, pdf, page: int, rect, dpi: int, *, gray: bool = False):
    """The part of the page render that shows a user-space rect."""
    img = ctx.render(pdf, page, dpi, gray=gray)
    geom = ctx.geometry(pdf, page)
    vx0, vy0, vx1, vy1 = geom.rect_to_view(rect)
    k = dpi / 72.0
    box = (max(0, int(round(vx0 * k))), max(0, int(round(vy0 * k))), min(img.width, int(round(vx1 * k))),
           min(img.height, int(round(vy1 * k))))
    if box[2] <= box[0] or box[3] <= box[1]:
        raise CheckError(f"прямоугольник {rect} вне страницы {page}")
    return img.crop(box)


def luma(img):
    import numpy as np

    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    return a, 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]


def new_ink_share(ctx, pdf, page: int, rect, *, blank: str | None, dpi: int = 200, threshold: int = 128,
                  halo_px: int = 2) -> float:
    """Share of the rect that is dark in the answer; with a blank fixture only the pixels that are not dark (within
    halo_px) on the blank page rendered at the same dpi."""
    import numpy as np

    _, out = luma(crop_rect(ctx, pdf, page, rect, dpi))
    dark = out < threshold
    if blank:
        blank_pdf = ctx.fixture_path(blank)
        _, base = luma(crop_rect(ctx, blank_pdf, page, rect, dpi))
        h, w = min(dark.shape[0], base.shape[0]), min(dark.shape[1], base.shape[1])
        dark, base_dark = dark[:h, :w], dilate(base[:h, :w] < threshold, halo_px)
        dark = dark & ~base_dark
    return float(np.mean(dark)) if dark.size else 0.0


def ocr(ctx, img, *, psm: int = 7, lang: str = "rus") -> str:
    import uuid

    path = ctx.scratch("ocr") / f"{uuid.uuid4().hex}.png"
    img.save(path)
    out = ctx.run_tool("tesseract", [str(path), "stdout", "-l", lang, "--psm", str(psm)], timeout=120)
    return out.decode("utf-8", "replace")


def page_area(ctx, pdf, page: int) -> float:
    b = ctx.geometry(pdf, page).box
    return area(b)


def marks_on_page(ctx, pdf, page: int) -> list:
    """Image placements on a page that are not page backgrounds."""
    full = page_area(ctx, pdf, page)
    return [p for p in placements(ctx, pdf) if p["page"] == page and area(p["rect"]) < BACKGROUND_SHARE * full]


def backgrounds_on_page(ctx, pdf, page: int) -> list:
    full = page_area(ctx, pdf, page)
    return [p for p in placements(ctx, pdf) if p["page"] == page and area(p["rect"]) >= BACKGROUND_SHARE * full]


def rect_param(ctx, params, key_rect="rect") -> list:
    name = params.get("rect_from_truth")
    if isinstance(name, str):
        return ctx.field_rect(name)
    if params.get(key_rect):
        return list(params[key_rect])
    if name is True and params.get("field"):
        return ctx.field_rect(params["field"])
    raise CheckError("нужен rect или rect_from_truth")


# ------------------------------------------------------------------ AcroForm
def live_fields(ctx, pdf) -> dict:
    key = ("fields", str(pdf))
    if key not in ctx._cache:
        try:
            fields = ctx.pdf_reader(pdf).get_fields() or {}
        except Exception:
            fields = {}
        out = {}
        for full, f in fields.items():
            out[full] = f
            out.setdefault(full.split(".")[-1], f)
        ctx._cache[key] = out
    return ctx._cache[key]


def live_value(ctx, pdf, name: str):
    f = live_fields(ctx, pdf).get(name)
    if f is None:
        return None
    v = f.get("/V")
    if v is None:
        return None
    return str(v)


def _expected(spec) -> tuple:
    """(mode, value) from a check value: {"equals"}, {"regex"} or a bare string (regex when it starts with ^)."""
    if isinstance(spec, dict):
        if "regex" in spec:
            return "regex", spec["regex"]
        return "equals", spec.get("equals", "")
    if isinstance(spec, str) and spec.startswith("^"):
        return "regex", spec
    return "equals", spec


def _value_ok(value: str, mode: str, want: str) -> bool:
    if mode == "regex":
        return re.search(want, value) is not None
    return norm_text(value) == norm_text(want)


@check("form_value", "pdf")
def form_value(ctx, params, item):
    pdf = item.path
    if isinstance(params.get("fields"), dict):
        wanted = [(name, *_expected(spec)) for name, spec in params["fields"].items()]
    else:
        names = params.get("fields") or [params.get("field")]
        mode, want = ("regex", params["regex"]) if "regex" in params else ("equals", params.get("equals", ""))
        wanted = [(name, mode, want) for name in names if name]
    if not wanted:
        raise CheckError("нужен field или fields")
    problems, seen = [], []
    for name, mode, want in wanted:
        truth = ctx.fields.get(name, {})
        comb = bool(params.get("comb") or truth.get("comb"))
        value = live_value(ctx, pdf, name)
        source = "поле"
        if value is not None and params.get("strict_field_equals") is not None and value != params["strict_field_equals"]:
            problems.append(f"{name}: в поле «{value}», нужно «{params['strict_field_equals']}»")
            continue
        if not value:
            rect = params["rect"] if params.get("rect") and len(wanted) == 1 else truth.get("rect")
            if rect is None:
                raise CheckError(f"нет rect для {name}")
            page = params.get("page") or truth.get("page") or 1
            if page > ctx.page_count(pdf):
                problems.append(f"{name}: нет стр. {page}")
                continue
            value = words_in_rect(ctx, pdf, page, rect)
            source = "текст"
        shown = re.sub(r"\s+", "", value) if comb else value
        if not _value_ok(shown, mode, want):
            problems.append(f"{name}: {source} «{value}»")
        else:
            seen.append(f"{name}={shown}")
    if problems:
        return failed("; ".join(problems))
    return passed("; ".join(seen))


def _checkbox_state(ctx, pdf, name: str):
    f = live_fields(ctx, pdf).get(name)
    if f is None:
        return None
    v = f.get("/V")
    return str(v) if v is not None else "/Off"


@check("pdf_checkbox", "pdf")
def pdf_checkbox(ctx, params, item):
    pdf = item.path
    name, state = params.get("field"), params.get("state")
    live = _checkbox_state(ctx, pdf, name)
    rect = params.get("or_mark_in_rect") or params.get("or_no_mark_in_rect")
    page = ctx.fields.get(name, {}).get("page", 1)
    want_mark = state != "/Off"
    share = None
    if rect:
        share = new_ink_share(ctx, pdf, page, rect, blank=params.get("blank"))
    if want_mark:
        if live == state:
            return passed(f"поле {name} = {live}")
        if share is not None and share >= float(params.get("min_ink", 0.1)):
            return passed(f"отметка нарисована: новые чернила {share:.2f}")
        return failed(f"поле {name} = {live}, новые чернила {share if share is None else round(share, 3)}")
    on = live not in (None, "/Off")
    if on:
        return failed(f"поле {name} = {live}")
    if share is not None and share > float(params.get("max_ink", 0.03)):
        return failed(f"в квадрате нарисована отметка: новые чернила {share:.2f}")
    return passed(f"поле {name} = {live}, новые чернила {0 if share is None else round(share, 3)}")


# ------------------------------------------------------------------ text kinds
@check("pdf_text_at", "pdf")
def pdf_text_at(ctx, params, item):
    pdf = item.path
    if isinstance(params.get("fields"), dict):
        wanted = list(params["fields"].items())
    else:
        wanted = [(params.get("field"), params.get("regex"))]
    problems, seen = [], []
    for name, pattern in wanted:
        truth = ctx.fields.get(name)
        if not truth:
            raise CheckError(f"в эталоне нет поля {name}")
        page = int(truth.get("page", 1))
        if page > ctx.page_count(pdf):
            problems.append(f"{name}: нет стр. {page}")
            continue
        text = words_in_rect(ctx, pdf, page, truth["rect"])
        if re.search(pattern, text):
            seen.append(f"{name}=«{text}»")
        else:
            problems.append(f"{name}: «{text}»")
    if problems:
        return failed("; ".join(problems))
    return passed("; ".join(seen))


def _contains(text: str, needle: str, ci: bool) -> bool:
    text, needle = norm_text(text), norm_text(needle)
    if ci:
        return needle.lower() in text.lower()
    return needle in text


@check("pdf_text_contains", "pdf")
def pdf_text_contains(ctx, params, item):
    pdf = item.path
    pages = select_pages(ctx, pdf, params)
    if not pages:
        return failed("нет подходящих страниц" + (f" ({params['page_text_regex']})" if params.get("page_text_regex") else ""))
    text = " ".join(norm_text(ctx.text(pdf, p)) for p in pages)
    ci = bool(params.get("case_insensitive"))
    missing = [s for s in params.get("all_of", []) if not _contains(text, s, ci)]
    missing += [p for p in params.get("regex_all", []) if not re.search(p, text, re.I if ci else 0)]
    if params.get("any_of") and not any(_contains(text, s, ci) for s in params["any_of"]):
        missing.append("одно из " + ", ".join(params["any_of"]))
    if missing:
        return failed("нет: " + "; ".join(missing[:6]))
    return passed(f"стр. {pages[0]}–{pages[-1]}")


@check("pdf_text_not_contains", "pdf")
def pdf_text_not_contains(ctx, params, item):
    text = norm_text(ctx.text(item.path))
    m = re.search(params["forbid_regex"], text)
    if m:
        return failed(f"найдено «{m.group(0)}»")
    return passed("запрещённого нет")


@check("pdf_text_count", "pdf")
def pdf_text_count(ctx, params, item):
    n = len(re.findall(params["regex"], norm_text(ctx.text(item.path))))
    if "max" in params and n > params["max"]:
        return failed(f"{n} раз > {params['max']}")
    if "min" in params and n < params["min"]:
        return failed(f"{n} раз < {params['min']}")
    return passed(f"{n} раз")


@check("pdf_text_cyrillic_ratio", "pdf")
def pdf_text_cyrillic_ratio(ctx, params, item):
    letters = [ch for ch in ctx.text(item.path) if ch.isalpha()]
    if not letters:
        return failed("в PDF нет текстового слоя")
    ratio = sum("а" <= ch.lower() <= "я" or ch.lower() == "ё" for ch in letters) / len(letters)
    if ratio > float(params["max_ratio"]):
        return failed(f"кириллицы {ratio:.1%}")
    return passed(f"кириллицы {ratio:.1%}")


@check("pdf_page_count", "pdf")
def pdf_page_count(ctx, params, item):
    n = ctx.page_count(item.path)
    if "equals" in params and n != params["equals"]:
        return failed(f"{n} стр., нужно {params['equals']}")
    if "min" in params and n < params["min"]:
        return failed(f"{n} стр. < {params['min']}")
    if "max" in params and n > params["max"]:
        return failed(f"{n} стр. > {params['max']}")
    if params.get("each_page_has_image"):
        pages = {p["page"] for p in placements(ctx, item.path)}
        bare = [i for i in range(1, n + 1) if i not in pages]
        if bare:
            return failed(f"{n} стр., без картинки: {bare[:6]}")
    return passed(f"{n} стр.")


# ------------------------------------------------------------------ images on pages
def _rects_by_page(ctx, params) -> list:
    """[(page, rect)] from page/pages + rect/rects/rect_from_truth."""
    if params.get("rects"):
        rects = [list(r) for r in params["rects"]]
    else:
        rects = [rect_param(ctx, params)]
    if params.get("pages"):
        pages = list(params["pages"])
    elif isinstance(params.get("page"), int):
        pages = [params["page"]]
    elif isinstance(params.get("rect_from_truth"), str):
        pages = [int(ctx.fields[params["rect_from_truth"]].get("page", 1))]
    else:
        pages = [1]
    return [(p, r) for p in pages for r in rects]


@check("pdf_image_in_bbox", "pdf")
def pdf_image_in_bbox(ctx, params, item):
    pdf = item.path
    grow = float(params.get("expand_pt", 0))
    need = float(params.get("min_inside", 0.8))
    problems, seen = [], []
    for page, rect in _rects_by_page(ctx, params):
        if page > ctx.page_count(pdf):
            problems.append(f"нет стр. {page}")
            continue
        box = expand(rect, grow)
        best = 0.0
        for p in marks_on_page(ctx, pdf, page):
            cx, cy = (p["rect"][0] + p["rect"][2]) / 2, (p["rect"][1] + p["rect"][3]) / 2
            if inside((cx, cy), box):
                best = max(best, share_inside(p["rect"], box))
        if best >= need:
            seen.append(f"стр. {page}: {best:.0%} внутри")
        else:
            problems.append(f"стр. {page}: картинки в {rect} нет" if best == 0 else f"стр. {page}: внутри {best:.0%}")
    if problems:
        return failed("; ".join(problems))
    return passed("; ".join(seen))


@check("pdf_no_image_in_bbox", "pdf", negative=True)
def pdf_no_image_in_bbox(ctx, params, item):
    pdf = item.path
    grow = float(params.get("expand_pt", 0))
    count = ctx.page_count(pdf)
    pages = params.get("pages") or ([params["page"]] if isinstance(params.get("page"), int) else list(range(1, count + 1)))
    for page in pages:
        if page > count:
            continue
        for rect in params.get("rects") or [params.get("rect")]:
            box = expand(rect, grow)
            for p in marks_on_page(ctx, pdf, page):
                inter = intersection_area(p["rect"], box)
                if inter > 0.2 * area(p["rect"]) or inter > 0.2 * area(box):
                    return failed(f"стр. {page}: картинка {p['rect']} в {rect}")
            if backgrounds_on_page(ctx, pdf, page):
                if not params.get("blank"):
                    return errored(f"стр. {page} — картинка целиком, сравнить не с чем (нет blank)")
                share = new_ink_share(ctx, pdf, page, box, blank=params["blank"], dpi=100)
                if share > float(params.get("max_new_ink", 0.02)):
                    return failed(f"стр. {page} (картинкой): в {rect} новые чернила {share:.2f}")
    return passed("мест чужой подписи никто не тронул")


@check("pdf_image_near_text", "pdf")
def pdf_image_near_text(ctx, params, item):
    pdf = item.path
    pages = select_pages(ctx, pdf, params)
    if not pages:
        return failed(f"нет страницы с «{params.get('page_text_regex')}»")
    limit = float(params.get("max_distance_pt", 160))
    best = None
    for page in pages:
        anchors = [w for w in ctx.words(pdf, page) if params["anchor"].lower() in w.text.lower()]
        for p in marks_on_page(ctx, pdf, page):
            for w in anchors:
                d = _rect_distance(p["rect"], w.rect)
                best = d if best is None else min(best, d)
    if best is None:
        return failed("на странице нет картинки или слова «" + params["anchor"] + "»")
    if best > limit:
        return failed(f"ближайшая картинка в {best:.0f} pt от «{params['anchor']}»")
    return passed(f"{best:.0f} pt от «{params['anchor']}»")


def _rect_distance(a, b) -> float:
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return (dx * dx + dy * dy) ** 0.5


@check("pdf_image_present", "pdf")
def pdf_image_present(ctx, params, item):
    n = len(placements(ctx, item.path))
    if n < int(params.get("min_images", 1)):
        return failed(f"картинок {n}")
    return passed(f"картинок {n}")


@check("pdf_images_positions", "pdf")
def pdf_images_positions(ctx, params, item):
    from .context import area as _area

    found = [p["rect"] for p in placements(ctx, item.path) if p["page"] == 1]
    need = float(params.get("min_iou", 0.5))
    problems = []
    for rect in params["expected"]:
        best = 0.0
        for r in found:
            inter = intersection_area(r, rect)
            union = _area(r) + _area(rect) - inter
            best = max(best, inter / union if union else 0.0)
        if best < need:
            problems.append(f"{rect}: IoU {best:.2f}")
    if problems:
        return failed("; ".join(problems))
    return passed(f"{len(params['expected'])} картинки на местах")


# ------------------------------------------------------------------ rasters
def _blue_ink(rgb, lum):
    return (lum < 110) & (rgb[..., 2] > rgb[..., 0] + 25)


@check("raster_region", "pdf")
def raster_region(ctx, params, item):
    pdf = item.path
    if params.get("min_long_side_px"):
        count = ctx.page_count(pdf)
        problems = []
        for page in range(max(1, count - int(params.get("last_pages", 1)) + 1), count + 1):
            imgs = [p for p in placements(ctx, pdf) if p["page"] == page]
            side = max((max(p["px"]) for p in imgs), default=0)
            if side < params["min_long_side_px"]:
                problems.append(f"стр. {page}: {side} px")
        if problems:
            return failed("; ".join(problems))
        return passed("картинки достаточного размера")
    dpi = int(params.get("dpi", 200))
    names = params.get("rect_from_truth")
    names = [names] if isinstance(names, str) else (names or [])
    if not names:
        raise CheckError("нужен rect_from_truth")
    pages = params.get("pages")
    halo = int(params.get("paper_exclude_ink_halo_px", 0))
    problems, seen = [], []
    for name in names:
        page = int(ctx.fields[name].get("page", 1))
        if pages and page not in pages:
            continue
        if page > ctx.page_count(pdf):
            problems.append(f"{name}: нет стр. {page}")
            continue
        rgb, lum = luma(crop_rect(ctx, pdf, page, ctx.field_rect(name), dpi))
        ink = _blue_ink(rgb, lum)
        near = dilate(ink, halo) if halo else ink
        paper = (lum >= 110) & (lum < 238) & ~near
        ink_share, paper_share = float(ink.mean()), float(paper.mean())
        note = f"{name}: чернила {ink_share:.4f}, бумага {paper_share:.4f}"
        if ink_share < float(params.get("ink_min", 0)) or paper_share > float(params.get("paper_max", 1)):
            problems.append(note)
        else:
            seen.append(note)
    if problems:
        return failed("; ".join(problems))
    if not seen:
        return failed("нет мест для проверки")
    return passed("; ".join(seen))


def _pearson(a, b) -> float:
    import numpy as np

    a = a.astype(np.float64).ravel() - a.mean()
    b = b.astype(np.float64).ravel() - b.mean()
    d = np.linalg.norm(a) * np.linalg.norm(b)
    return float((a * b).sum() / d) if d else 0.0


def pearson(a, b) -> float:
    return _pearson(a, b)


@check("raster_legibility", "pdf", quantifier="all")
def raster_legibility(ctx, params, item):
    import numpy as np
    from PIL import Image

    pdf = item.path
    dpi = int(params.get("dpi", 150))
    need = float(params["min_corr"])
    if params.get("templates"):
        folder = ctx.truth_dir / params["templates"]
        refs = sorted(folder.glob("*.png"))
        size = tuple(params.get("size", [620, 877]))
    else:
        refs = _phone_refs(ctx)
        size = None
    if not refs:
        raise CheckError("нет эталонных страниц")
    count = ctx.page_count(pdf)
    if count != len(refs):
        return failed(f"{count} стр., эталонов {len(refs)}")
    worst = 1.0
    for page, ref in enumerate(refs, start=1):
        with Image.open(ref) as im:
            want = im.convert("L")
        target = size or want.size
        if want.size != target:
            want = want.resize(target, Image.LANCZOS)
        got = ctx.render(pdf, page, dpi, gray=True).resize(target, Image.LANCZOS)
        corr = _pearson(np.asarray(got, dtype=np.float32), np.asarray(want, dtype=np.float32))
        worst = min(worst, corr)
    if worst < need:
        return failed(f"мин. корреляция {worst:.3f} < {need}")
    return passed(f"мин. корреляция {worst:.3f}")


def _phone_refs(ctx) -> list:
    doc = ctx.truth.get("phone_scan.json")
    if not doc:
        return []
    return [p for n in range(1, 4) for p in [ctx.truth_dir / f"phone_scan_page{n}_300x424.png"] if p.exists()]


@check("ocr_region", "pdf")
def ocr_region(ctx, params, item):
    pdf = item.path
    dpi = int(params.get("dpi", 200))
    limit = float(params.get("max_cer", 0.1))
    expected = {}
    for doc in ctx.truth.values():
        if isinstance(doc, dict) and isinstance(doc.get("expected_values"), dict):
            expected.update(doc["expected_values"])
    problems, seen = [], []
    for name in params["fields"]:
        want = expected.get(name)
        if not isinstance(want, str):
            raise CheckError(f"нет ожидаемого значения {name}")
        truth = ctx.fields[name]
        page = int(truth.get("page", 1))
        img = crop_rect(ctx, pdf, page, expand(truth["rect"], 2), dpi)
        got = ocr(ctx, img.convert("L"), psm=7)
        value = cer(got, want)
        (problems if value > limit else seen).append(f"{name}: CER {value:.2f} «{norm_text(got)}»")
    if problems:
        return failed("; ".join(problems))
    return passed("; ".join(seen))


# ------------------------------------------------------------------ marks drawn on flat forms
def _mark_share(ctx, params, item) -> tuple:
    name = params["field"]
    truth = ctx.fields.get(name)
    if not truth:
        raise CheckError(f"в эталоне нет поля {name}")
    rect = truth.get("inner_rect") if params.get("inner") else truth.get("rect")
    if rect is None:
        raise CheckError(f"в эталоне нет inner_rect у {name}")
    page = int(truth.get("page", 1))
    blank = params.get("blank") if params.get("new_ink") else None
    return new_ink_share(ctx, item.path, page, rect, blank=blank), name


@check("mark_in_rect", "pdf")
def mark_in_rect(ctx, params, item):
    share, name = _mark_share(ctx, params, item)
    need = float(params.get("min_ink", 0.15))
    if share < need:
        return failed(f"{name}: новые чернила {share:.3f} < {need}")
    return passed(f"{name}: новые чернила {share:.3f}")


@check("no_mark_in_rect", "pdf")
def no_mark_in_rect(ctx, params, item):
    share, name = _mark_share(ctx, params, item)
    limit = float(params.get("max_ink", 0.03))
    if share > limit:
        return failed(f"{name}: новые чернила {share:.3f} > {limit}")
    return passed(f"{name}: новые чернила {share:.3f}")


@check("text_fits_line", "pdf")
def text_fits_line(ctx, params, item):
    doc = next((d for d in ctx.truth.values() if isinstance(d, dict) and d.get("printed_text_boxes")), None)
    if doc is None:
        raise CheckError("в эталоне нет printed_text_boxes")
    pitch = float(doc.get("line_pitch_pt", 24))
    boxes = [b["rect"] for b in doc["printed_text_boxes"]]
    words = ctx.words(item.path, 1)
    if not words:
        return failed("на странице нет текстового слоя (вписанный текст не проверить)")
    limit = float(params.get("max_overlap", 0.05))
    for w in words:
        h = w.rect[3] - w.rect[1]
        if h > 1.1 * pitch:
            return failed(f"«{w.text}» высотой {h:.1f} pt > 1.1 × {pitch}")
        a = area(w.rect)
        for b in boxes:
            if a and intersection_area(w.rect, b) / a > limit:
                return failed(f"«{w.text}» налезает на «{_box_text(doc, b)}»")
    return passed(f"{len(words)} слов в своих строках")


def _box_text(doc, rect) -> str:
    for b in doc["printed_text_boxes"]:
        if b["rect"] == rect:
            return b["text"][:40]
    return ""


# ------------------------------------------------------------------ page structure
def _is_image_page(ctx, pdf, page: int, max_chars: int) -> bool:
    text = norm_text(ctx.text(pdf, page))
    if len(text) > max_chars:
        return False
    full = page_area(ctx, pdf, page)
    return any(area(p["rect"]) >= 0.2 * full for p in placements(ctx, pdf) if p["page"] == page)


@check("page_order", "pdf")
def page_order(ctx, params, item):
    pdf = item.path
    count = ctx.page_count(pdf)
    max_chars = int(params.get("image_page_max_chars", 0))
    texts = page_texts(ctx, pdf)
    at = 0
    path = []
    for token in params["sequence_regex"]:
        found = None
        for page in range(at, count):
            if token == "__image_page__":
                ok = _is_image_page(ctx, pdf, page + 1, max_chars)
            else:
                ok = re.search(token, texts[page]) is not None
            if ok:
                found = page
                break
        if found is None:
            return failed(f"после стр. {at} нет «{token}» (найдено: {path})")
        path.append(found + 1)
        at = found + 1
    return passed(f"страницы {path}")


@check("page_aspect", "pdf", quantifier="all")
def page_aspect(ctx, params, item):
    want, tol = float(params["ratio"]), float(params.get("tol", 0.02))
    for page in range(1, ctx.page_count(item.path) + 1):
        w, h = ctx.geometry(item.path, page).view_size
        ratio = min(w, h) / max(w, h)
        if abs(ratio - want) > tol * want:
            return failed(f"стр. {page}: {w:.0f}×{h:.0f} pt")
    return passed("все страницы A4")


# ------------------------------------------------------------------ redaction (image or PDF)
def as_image(ctx, item):
    """The picture a person sees: an image file, or the largest image of a one-page PDF (else its render)."""
    from PIL import Image, ImageOps

    from .select import group_of

    group = group_of(item)
    if group == "image":
        with Image.open(item.path) as im:
            return ImageOps.exif_transpose(im).convert("RGB")
    if group == "pdf":
        best = None
        for p in placements(ctx, item.path):
            if p["xobj"] is not None and (best is None or area(p["rect"]) > area(best["rect"])):
                best = p
        if best is not None and best["page"] == 1:
            try:
                return best["xobj"].decode_as_image().convert("RGB")
            except Exception:
                pass
        return ctx.render(item.path, 1, 150)
    raise CheckError("не картинка и не PDF")


def _scan_pair(ctx, item):
    """(original, answer) grayscale arrays on the original's pixel grid."""
    import numpy as np
    from PIL import Image

    original_path = ctx.fixture_path(_input_image(ctx))
    with Image.open(original_path) as im:
        original = im.convert("L")
    got = as_image(ctx, item).convert("L")
    if got.width < got.height and original.width > original.height:
        got = got.rotate(90, expand=True)
    ratio_o = original.width / original.height
    ratio_g = got.width / got.height
    if abs(ratio_o - ratio_g) / ratio_o > 0.03:
        raise CheckError(f"кадр {got.width}×{got.height} не совпадает по пропорциям с оригиналом {original.size}")
    got = got.resize(original.size, Image.BILINEAR)
    return np.asarray(original, dtype=np.float32), np.asarray(got, dtype=np.float32)


def _input_image(ctx) -> str:
    for t in ctx.case.get("turns", []):
        for name in t.get("files", []):
            if name.lower().endswith((".jpg", ".jpeg", ".png")):
                return name
    raise CheckError("у кейса нет исходной картинки")


def _regions(ctx) -> dict:
    for doc in ctx.truth.values():
        if isinstance(doc, dict) and isinstance(doc.get("regions"), dict):
            return doc["regions"]
    raise CheckError("в эталоне нет regions")


def _region(arr, box, erode: int = 0):
    x0, y0, x1, y1 = box
    return arr[y0 + erode:y1 - erode, x0 + erode:x1 - erode]


@check("redaction_solid", "any")
def redaction_solid(ctx, params, item):
    original, got = _scan_pair(ctx, item)
    regions = _regions(ctx)
    erode = params.get("erode_px") or {}
    problems, seen = [], []
    for name in params["regions"]:
        e = int(erode.get(name, 0)) if isinstance(erode, dict) else int(erode)
        a, b = _region(original, regions[name], e), _region(got, regions[name], e)
        corr = 0.0 if b.std() < 1e-6 or a.std() < 1e-6 else _pearson(a, b)
        note = f"{name}: корр. {corr:.2f}, σ {b.std():.1f}"
        if corr >= float(params["max_corr"]) or b.std() > float(params["max_std"]):
            problems.append(note)
        else:
            seen.append(note)
    if problems:
        return failed("; ".join(problems))
    return passed("; ".join(seen))


@check("redaction_keeps", "any")
def redaction_keeps(ctx, params, item):
    original, got = _scan_pair(ctx, item)
    regions = _regions(ctx)
    problems, seen = [], []
    for name in params["regions"]:
        a, b = _region(original, regions[name]), _region(got, regions[name])
        corr = 0.0 if b.std() < 1e-6 else _pearson(a, b)
        (problems if corr < float(params["min_corr"]) else seen).append(f"{name}: корр. {corr:.2f}")
    if problems:
        return failed("; ".join(problems))
    return passed("; ".join(seen))


@check("pdf_hidden_original")
def pdf_hidden_original(ctx, params):
    import numpy as np
    from PIL import Image

    from .select import group_of

    turn = params.get("turn")
    pdfs = [r for r in ctx.received if r.turn is not None and group_of(r) == "pdf"
            and (not isinstance(turn, int) or r.turn == turn)]
    if not pdfs:
        return passed("PDF не выдан")
    original_path = ctx.fixture_path(_input_image(ctx))
    with Image.open(original_path) as im:
        original = im.convert("L")
    regions = _regions(ctx)
    keys = [k for k in ("number_digits_1_6_vertical", "number_digits_1_6_horizontal", "registration_block") if k in regions]
    base = np.asarray(original, dtype=np.float32)
    for item in pdfs:
        for p in placements(ctx, item.path):
            if p["xobj"] is None:
                continue
            try:
                img = p["xobj"].decode_as_image().convert("L")
            except Exception:
                continue
            if abs(img.width / img.height - original.width / original.height) > 0.05:
                continue
            arr = np.asarray(img.resize(original.size, Image.BILINEAR), dtype=np.float32)
            for k in keys:
                a, b = _region(base, regions[k]), _region(arr, regions[k])
                if b.std() > 1e-6 and _pearson(a, b) > 0.5:
                    return failed(f"{item.label}: внутри PDF картинка с открытым {k}")
    return passed("в PDF только закрашенные картинки")


@check("watermark_present", "any")
def watermark_present(ctx, params, item):
    from .select import group_of

    want = params["text"]
    limit = float(params.get("max_cer", 0.2))
    if group_of(item) == "pdf":
        layer = norm_text(ctx.text(item.path))
        if layer and best_window_cer(layer, want) <= limit:
            return passed("надпись в текстовом слое")
    img = as_image(ctx, item).convert("L")
    if max(img.size) > 2400:
        img.thumbnail((2400, 2400))
    best = 1.0
    for angle in (0, 20, -20, 35, -35, 45, -45):
        view = img.rotate(angle, expand=True, fillcolor=255) if angle else img
        text = ocr(ctx, view, psm=11)
        best = min(best, best_window_cer(text, want))
        if best <= limit:
            return passed(f"OCR: CER {best:.2f} (поворот {angle}°)")
    return failed(f"надпись не найдена (лучший CER {best:.2f})")


# ------------------------------------------------------------------ signed by Bro (W3)
def _widget_fields(ctx, pdf) -> list:
    """(page, name, field type, has value, rect) of every widget annotation."""
    out = []
    reader = ctx.pdf_reader(pdf)
    for n, page in enumerate(reader.pages, start=1):
        for ref in page.get("/Annots") or []:
            try:
                annot = ref.get_object()
            except Exception:
                continue
            if annot.get("/Subtype") != "/Widget":
                continue
            node, name_parts, ftype, value = annot, [], None, None
            depth = 0
            while node is not None and depth < 16:
                if node.get("/T") is not None and not name_parts:
                    name_parts.append(str(node.get("/T")))
                ftype = ftype or node.get("/FT")
                value = value if value is not None else node.get("/V")
                parent = node.get("/Parent")
                node = parent.get_object() if parent is not None else None
                depth += 1
            rect = [float(v) for v in annot.get("/Rect", [0, 0, 0, 0])]
            rect = [min(rect[0], rect[2]), min(rect[1], rect[3]), max(rect[0], rect[2]), max(rect[1], rect[3])]
            out.append((n, name_parts[0] if name_parts else "", str(ftype or ""), value is not None, rect))
    return out


@check("pdf_signed_by_bro", "pdf")
def pdf_signed_by_bro(ctx, params, item):
    pdf = item.path
    meta = ctx.pdf_reader(pdf).metadata or {}
    keywords = str(meta.get("/Keywords") or "")
    producer = str(meta.get("/Producer") or "")
    problems = []
    if not SIGNED_KEYWORDS.search(keywords):
        problems.append(f"/Keywords «{keywords[:60]}» без signed-by-bro <id>")
    if producer != "Бро":
        problems.append(f"/Producer «{producer[:40]}»")
    widgets = _widget_fields(ctx, pdf)
    left = sorted({name for _, name, _, _, _ in widgets if SIG_FIELD.match(name)})
    try:
        for name in (ctx.pdf_reader(pdf).get_fields() or {}):
            if SIG_FIELD.match(name.split(".")[-1]):
                left.append(name)
    except Exception:
        pass
    if left:
        problems.append("остались поля " + ", ".join(sorted(set(left))[:4]))
    images = [p for p in placements(ctx, pdf) if p["smask"]]
    for page, name, ftype, has_value, rect in widgets:
        if ftype != "/Sig" or has_value:
            continue
        for p in images:
            if p["page"] == page and area(p["rect"]) and intersection_area(p["rect"], rect) / area(p["rect"]) > 0.5:
                problems.append(f"пустое поле /Sig «{name}» поверх подписи на стр. {page}")
                break
    if problems:
        return failed("; ".join(problems))
    return passed(f"«{keywords[:60]}», Producer «Бро»")


# ------------------------------------------------------------------ pages against truth templates
def page_picture(ctx, pdf, page: int, dpi: int = 72):
    """What a page shows: the render cropped to its main picture (an image covering ≥ 20 % of the page), else to the
    non-white content."""
    import numpy as np

    img = ctx.render(pdf, page, dpi, gray=True)
    geom = ctx.geometry(pdf, page)
    full = area(geom.box)
    pics = [p for p in placements(ctx, pdf) if p["page"] == page and area(p["rect"]) >= 0.2 * full]
    k = dpi / 72.0
    if pics:
        best = max(pics, key=lambda p: area(p["rect"]))
        vx0, vy0, vx1, vy1 = geom.rect_to_view(best["rect"])
        box = (max(0, int(vx0 * k)), max(0, int(vy0 * k)), min(img.width, int(vx1 * k) + 1), min(img.height, int(vy1 * k) + 1))
        if box[2] - box[0] > 8 and box[3] - box[1] > 8:
            return img.crop(box)
    arr = np.asarray(img)
    ys, xs = np.nonzero(arr < 235)
    if len(xs) < 50:
        return img
    return img.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def corr_to_template(img, template, *, size=None, blur: float = 0.0) -> float:
    """Pearson correlation of a grayscale picture resized to the template's size (or `size`)."""
    import numpy as np
    from PIL import Image, ImageFilter

    target = size or template.size
    a = img.convert("L").resize(target, Image.LANCZOS)
    b = template.convert("L")
    if b.size != target:
        b = b.resize(target, Image.LANCZOS)
    if blur:
        a, b = a.filter(ImageFilter.GaussianBlur(blur)), b.filter(ImageFilter.GaussianBlur(blur))
    return _pearson(np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32))


def rotated(img, degrees_cw: int):
    from PIL import Image

    if degrees_cw % 360 == 0:
        return img
    return img.transpose({90: Image.ROTATE_270, 180: Image.ROTATE_180, 270: Image.ROTATE_90}[degrees_cw % 360])


def _templates(ctx, files) -> list:
    from PIL import Image

    out = []
    for name in files:
        with Image.open(ctx.truth_path(name)) as im:
            out.append(im.convert("L"))
    return out


@check("pdf_pages_match_templates", "pdf")
def pdf_pages_match_templates(ctx, params, item):
    """Page i matches template i best, at 0°, with correlation ≥ min_corr (method of truth skany_viza.json)."""
    doc = ctx.truth_doc("skany_viza.json")
    order = doc["expected_order"]
    labels = params.get("expected") or [o["label"] for o in order]
    files = {o["label"]: o["template"] for o in order}
    templates = dict(zip(labels, _templates(ctx, [files[l] for l in labels])))
    pdf = item.path
    count = ctx.page_count(pdf)
    if count != len(labels):
        return failed(f"{count} стр., ожидалось {len(labels)}")
    need = float(params.get("min_corr", 0.8))
    for page, label in enumerate(labels, start=1):
        img = ctx.render(pdf, page, 60, gray=True)
        best = (-2.0, None, None)
        for name, tpl in templates.items():
            for rot in (0, 90, 180, 270):
                c = corr_to_template(rotated(img, rot), tpl)
                if c > best[0]:
                    best = (c, name, rot)
        if best[1] != label or best[2] != 0 or best[0] < need:
            same_doc = templates[best[1]] is templates.get(label)
            if not (same_doc and best[2] == 0 and best[0] >= need):
                return failed(f"стр. {page}: лучше всего «{best[1]}» при {best[2]}° (корр. {best[0]:.2f}), нужно «{label}» при 0°")
    return passed(f"{count} стр. на местах и прямо")


@check("pdf_pages_upright", "pdf")
def pdf_pages_upright(ctx, params, item):
    doc = ctx.truth_doc("chek_receipts.json")
    names = sorted({r["template"] for r in doc["receipts"] if r.get("template")})
    templates = _templates(ctx, names)
    side = int(params.get("long_side_px", 128))
    need, margin = float(params.get("min_corr", 0.2)), float(params.get("min_margin", 0.08))
    pdf = item.path
    notes = []
    for page in range(1, ctx.page_count(pdf) + 1):
        pic = page_picture(ctx, pdf, page)
        scores = {}
        for rot in (0, 90, 180, 270):
            view = rotated(pic, rot)
            best = -2.0
            for tpl in templates:
                k = side / max(tpl.size)
                size = (max(8, int(tpl.width * k)), max(8, int(tpl.height * k)))
                best = max(best, corr_to_template(view, tpl, size=size))
            scores[rot] = best
        other = max(scores[r] for r in (90, 180, 270))
        if scores[0] < need or scores[0] - other < margin:
            return failed(f"стр. {page}: при 0° {scores[0]:.2f}, при повороте до {other:.2f}")
        notes.append(f"{scores[0]:.2f}")
    return passed("все страницы прямо (" + ", ".join(notes) + ")")


@check("pdf_page_order", "pdf")
def pdf_page_order(ctx, params, item):
    doc = ctx.truth_doc("chek_receipts.json")
    by_template = {}
    for r in doc["receipts"]:
        if r.get("template"):
            by_template.setdefault(r["template"], r["n"] if not r.get("duplicate_of") else r["duplicate_of"])
    names = sorted(by_template)
    templates = dict(zip(names, _templates(ctx, names)))
    pdf = item.path
    got = []
    for page in range(1, ctx.page_count(pdf) + 1):
        pic = page_picture(ctx, pdf, page)
        best = (-2.0, None)
        for name, tpl in templates.items():
            for rot in (0, 90, 180, 270):
                k = 128 / max(tpl.size)
                size = (max(8, int(tpl.width * k)), max(8, int(tpl.height * k)))
                c = corr_to_template(rotated(pic, rot), tpl, size=size)
                if c > best[0]:
                    best = (c, name)
        got.append(by_template[best[1]])
    want = list(params["expected_receipts"])
    if got != want:
        return failed(f"порядок чеков {got}, нужно {want}")
    return passed(f"порядок {got}")


def _template_search(img, tpl, *, width: int = 200, blur: float = 1.2) -> float:
    """Best NCC of a document template inside a picture over template widths 55–100 % of the picture's smaller side."""
    import numpy as np
    from PIL import Image, ImageFilter

    k = width / img.width
    pic = img.convert("L").resize((width, max(8, int(img.height * k))), Image.LANCZOS).filter(ImageFilter.GaussianBlur(blur))
    a = np.asarray(pic, dtype=np.float32)
    small = min(a.shape)
    best = -1.0
    for share in np.linspace(0.55, 1.0, 10):
        tw = int(small * share) if tpl.width <= tpl.height else int(small * share * tpl.width / tpl.height)
        th = int(tw * tpl.height / tpl.width)
        if tw < 8 or th < 8 or th > a.shape[0] or tw > a.shape[1]:
            continue
        t = np.asarray(tpl.convert("L").resize((tw, th), Image.LANCZOS).filter(ImageFilter.GaussianBlur(blur)),
                       dtype=np.float32)
        t = t - t.mean()
        tn = np.linalg.norm(t)
        if not tn:
            continue
        step = 2
        for y in range(0, a.shape[0] - th + 1, step):
            for x in range(0, a.shape[1] - tw + 1, step):
                w = a[y:y + th, x:x + tw]
                w = w - w.mean()
                wn = np.linalg.norm(w)
                if wn:
                    best = max(best, float((w * t).sum() / (wn * tn)))
    return best


@check("pdf_page_images", "pdf")
def pdf_page_images(ctx, params, item):
    """The last pages are the photos, upright: score(rot) = max(correlation with the full-frame template, best NCC of the
    document template over scales and shifts); score(0) ≥ min_corr and ≥ every other rotation + min_margin; every
    template set matched by a different page (issues/f-rent-contract-bundle.md)."""
    pdf = item.path
    count = ctx.page_count(pdf)
    n = int(params.get("last_pages", 2))
    stems = params.get("templates") or []
    sets = {}
    for stem in stems:
        doc = ctx.truth_doc(f"{stem}.json")
        names = doc["templates"]
        sets[stem] = _templates(ctx, [names["full_upright"], names["document_flat"]])
    need, margin = float(params.get("min_corr", 0.6)), float(params.get("min_margin", 0.1))
    used, notes = set(), []
    for page in range(max(1, count - n + 1), count + 1):
        pic = page_picture(ctx, pdf, page, dpi=60)
        best = None
        for stem, (full, flat) in sets.items():
            scores = {}
            for rot in (0, 90, 180, 270):
                view = rotated(pic, rot)
                scores[rot] = max(corr_to_template(view, full), _template_search(view, flat))
            other = max(scores[r] for r in (90, 180, 270))
            if best is None or scores[0] > best[1]:
                best = (stem, scores[0], other)
        stem, s0, other = best
        if s0 < need or s0 - other < margin:
            return failed(f"стр. {page}: {stem} при 0° {s0:.2f}, при повороте {other:.2f}")
        if stem in used:
            return failed(f"стр. {page}: снова {stem}, второй страницы паспорта нет")
        used.add(stem)
        notes.append(f"стр. {page} = {stem} ({s0:.2f})")
    return passed("; ".join(notes))


# ------------------------------------------------------------------ text of documents
@check("pdf_pages_text", "pdf")
def pdf_pages_text(ctx, params, item):
    def canon(s):
        return norm_quotes(norm_text(s)).replace("ё", "е").replace("Ё", "Е")

    pages = [canon(t) for t in page_texts(ctx, item.path)]
    free = set(range(len(pages)))
    missing = []
    for k, want in enumerate(params["expected"]):
        pattern = re.escape(canon(want["gender_word"])) + r"\b[\s\S]{0,200}?" + re.escape(canon(want["name"]))
        candidates_ = [i for i in (free if params.get("any_order") else [k]) if i < len(pages) and re.search(pattern, pages[i])]
        if not candidates_:
            missing.append(f"{want['gender_word']} … {want['name']}")
            continue
        free.discard(candidates_[0])
    if missing:
        return failed(f"нет {len(missing)}: " + "; ".join(missing[:5]))
    return passed(f"{len(params['expected'])} грамот")


@check("pdf_unencrypted", "pdf")
def pdf_unencrypted(ctx, params, item):
    import difflib

    reader = ctx.pdf_reader(item.path)
    if reader.is_encrypted:
        try:
            if not reader.decrypt(""):
                return failed("PDF зашифрован")
        except Exception:
            return failed("PDF зашифрован")
    n = len(reader.pages)
    if params.get("pages") and n != params["pages"]:
        return failed(f"{n} стр., нужно {params['pages']}")
    doc = ctx.truth_doc("buklet_ZhK.json")
    want = norm_text(doc["page_text_joined"])
    got = norm_text(ctx.text(item.path))
    ratio = difflib.SequenceMatcher(None, got, want, autojunk=False).ratio()
    if ratio < float(params.get("text_ratio", 0.99)):
        return failed(f"текст совпадает на {ratio:.3f}")
    return passed(f"{n} стр., текст {ratio:.3f}")


@check("pdf_render_text", "docx")
def pdf_render_text(ctx, params, item):
    pdf = ctx.as_pdf(item.path)
    text = norm_text(ctx.text(pdf))
    if re.search(params["regex"], text):
        return passed("найдено после рендера LibreOffice")
    return failed(f"после рендера нет «{params['regex']}»")


def _digits(s: str) -> str:
    return re.sub(r"[^\d]", "", s.split(",")[0].split(".")[0]) if s else ""


@check("pdf_table_shape", "pdf")
def pdf_table_shape(ctx, params, item):
    """Each expected number sits on its own layout line that splits into `cols` cells (runs of 2+ spaces)."""
    lines = [l for l in ctx.text(item.path, layout=True).splitlines() if l.strip()]
    want_rows, want_cols = int(params["rows"]), int(params["cols"])
    used, problems = set(), []
    for number in params["numbers"]:
        found = None
        for i, line in enumerate(lines):
            if i in used:
                continue
            cells = [c for c in re.split(r"\s{2,}", line.strip()) if c]
            nums = [_amount(c) for c in cells]
            if any(v is not None and abs(v - number) < 0.5 for v in nums) and len(cells) == want_cols:
                found = i
                break
        if found is None:
            problems.append(str(number))
        else:
            used.add(found)
    if problems:
        return failed("нет строки таблицы на " + ", ".join(problems))
    if len(used) != want_rows:
        return failed(f"строк {len(used)}, нужно {want_rows}")
    return passed(f"{want_rows}×{want_cols}")


def _amount(text: str):
    """A money amount written «178 000,00», «178,000.00», «178000» or «178 000 RUB»."""
    t = text.replace(" ", " ").replace(" ", " ")
    m = re.search(r"\d{1,3}(?:[ ,.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?", t)
    if not m:
        return None
    s = m.group(0)
    if re.search(r"[.,]\d{1,2}$", s):
        whole, frac = s[:-3 if s[-3] in ".," else -2], s[-2:] if s[-3] in ".," else s[-1:]
        return float(re.sub(r"[^\d]", "", whole) + "." + frac)
    return float(re.sub(r"[^\d]", "", s))


@check("cell_form", "pdf")
def cell_form(ctx, params, item):
    """Every character centred in its own cell, left-aligned; empty cells blank (or «-» when allowed)."""
    doc = ctx.truth_doc("list_vychety_cells.json")
    page = int(doc.get("page", 1))
    words = ctx.words(item.path, page)
    chars = []
    for w in words:
        n = len(w.text)
        if not n:
            continue
        step = (w.rect[2] - w.rect[0]) / n
        for i, ch in enumerate(w.text):
            chars.append((ch, (w.rect[0] + step * (i + 0.5), (w.rect[1] + w.rect[3]) / 2)))
    problems = []
    for key, value in params["rows"].items():
        row = doc["rows"][key]
        cells = row["cells"]
        if "int_cells" in row:
            whole, frac = value.split(".")
            expected = list(whole) + [""] * (len(row["int_cells"]) - len(whole)) + list(frac)
        else:
            expected = list(value) + [""] * (len(cells) - len(value))
        got = []
        for cell in cells:
            inside_ = [ch for ch, c in chars if inside(c, cell)]
            got.append("".join(inside_))
        bad = []
        for i, (g, e) in enumerate(zip(got, expected)):
            if e == "" and (g == "" or (params.get("allow_dashes_in_empty") and set(g) <= {"-", "–", "—"})):
                continue
            if g != e:
                bad.append(i + 1)
        if bad:
            problems.append(f"{key}: клетки {bad[:5]} = {[got[i - 1] for i in bad[:5]]}")
    if problems:
        return failed("; ".join(problems))
    return passed("все символы в своих клетках")


@check("extracted_images")
def extracted_images(ctx, params):
    """Every source photo came back at its own size: same bytes as the truth JPEG, or PSNR ≥ min_psnr."""
    import hashlib

    import numpy as np
    from PIL import Image

    from .select import group_of, is_preview

    doc = ctx.truth_doc("buklet_ZhK.json")
    truth = {}
    for entry in doc["images"]:
        path = ctx.truth_dir / entry["file"] if entry.get("file") else None
        truth[tuple(entry["px"])] = path
    images = [r for r in ctx.received if r.turn is not None and not is_preview(r) and group_of(r) == "image"]
    problems = []
    for w, h in params["dims"]:
        ref = truth.get((w, h))
        match = None
        for r in images:
            try:
                with Image.open(r.path) as im:
                    if im.size != (w, h):
                        continue
                    if ref is not None and ref.exists():
                        if hashlib.sha256(r.path.read_bytes()).hexdigest() == hashlib.sha256(ref.read_bytes()).hexdigest():
                            match = (r, "байты те же")
                            break
                        with Image.open(ref) as rim:
                            a = np.asarray(im.convert("RGB"), dtype=np.float64)
                            b = np.asarray(rim.convert("RGB"), dtype=np.float64)
                        mse = float(((a - b) ** 2).mean())
                        psnr = 99.0 if mse == 0 else 10 * np.log10(255 ** 2 / mse)
                        if psnr >= float(params.get("min_psnr", 38)):
                            match = (r, f"PSNR {psnr:.1f}")
                            break
                    else:
                        match = (r, "размер совпал")
                        break
            except Exception:
                continue
        if match is None:
            problems.append(f"{w}×{h}")
    if problems:
        return failed("нет фото " + ", ".join(problems))
    return passed(f"{len(params['dims'])} фото в исходном размере")


@check("split_files")
def split_files(ctx, params):
    from .select import group_of, is_preview

    pdfs = [r for r in ctx.received if r.turn is not None and not is_preview(r) and group_of(r) == "pdf"]
    problems, seen = [], []
    for spec in params["files"]:
        hits = [r for r in pdfs if re.search(spec["name_regex"], r.name or r.shown_name or "")]
        good = [r for r in hits if ctx.page_count(r.path) == spec["pages"]]
        if good:
            seen.append(good[0].name)
        else:
            problems.append(f"{spec['name_regex']} ({spec['pages']} стр.)" + (f": есть {[r.name for r in hits][:2]}" if hits else ""))
    if problems:
        return failed("нет файлов: " + "; ".join(problems))
    return passed(", ".join(seen))


@check("qr_decode", "pdf")
def qr_decode(ctx, params, item):
    try:
        import zxingcpp
    except ImportError:
        raise CheckError("нет модуля zxing-cpp (pip install -r requirements.txt)") from None
    texts = []
    for page in range(1, ctx.page_count(item.path) + 1):
        img = ctx.render(item.path, page, 200)
        texts += [r.text for r in zxingcpp.read_barcodes(img)]
    payloads = [t for t in texts if any(t.startswith(p) for p in params.get("startswith_any", [""]))]
    if not payloads:
        return failed("QR не найден" if not texts else f"QR не по ГОСТ: «{texts[0][:40]}»")
    problems = []
    for payload in payloads:
        fields = dict(part.split("=", 1) for part in payload.split("|")[1:] if "=" in part)
        problems = [f"{k}={fields.get(k)!r}" for k, rx in params.get("fields", {}).items() if not re.search(rx, fields.get(k, ""))]
        if not problems:
            return passed("QR: " + ", ".join(f"{k}" for k in params.get("fields", {})))
    return failed("в QR не так: " + "; ".join(problems[:4]))


# ------------------------------------------------------------------ scans of photographed pages
def _mm_to_px(img_size, mm, page_mm=(210.0, 297.0)):
    return mm[0] * img_size[0] / page_mm[0], mm[1] * img_size[1] / page_mm[1]


def _dark_blobs(arr, threshold: int = 90):
    return components(arr < threshold, min_pixels=12)


@check("fiducials", "pdf", quantifier="all")
def fiducials(ctx, params, item):
    import math

    import numpy as np

    doc = ctx.truth_doc("phone_scan.json")
    marks = doc["fiducials"]
    size_mm = float(doc.get("fiducial_size_mm", 6.0))
    max_angle, max_pos = float(params.get("max_angle_dev", 1.5)), float(params.get("max_pos_dev", 0.03))
    for page in range(1, ctx.page_count(item.path) + 1):
        img = ctx.render(item.path, page, 100, gray=True)
        arr = np.asarray(img)
        h, w = arr.shape
        side = size_mm * w / 210.0
        centers = []
        for mark in marks:
            ex, ey = mark["center_share"][0] * w, mark["center_share"][1] * h
            r = 0.08 * max(w, h)
            x0, y0 = max(0, int(ex - r)), max(0, int(ey - r))
            sub = arr[y0:int(ey + r), x0:int(ex + r)]
            best = None
            for bx0, by0, bx1, by1 in _dark_blobs(sub):
                bw, bh = bx1 - bx0, by1 - by0
                if not (0.5 * side <= bw <= 1.6 * side and 0.5 * side <= bh <= 1.6 * side):
                    continue
                cx, cy = x0 + (bx0 + bx1) / 2, y0 + (by0 + by1) / 2
                d = math.hypot(cx - ex, cy - ey)
                if best is None or d < best[0]:
                    best = (d, cx, cy)
            if best is None:
                return failed(f"стр. {page}: нет квадрата {mark['corner']}")
            if best[0] > max_pos * max(w, h):
                return failed(f"стр. {page}: квадрат {mark['corner']} сдвинут на {best[0] / max(w, h):.1%}")
            centers.append((best[1], best[2]))
        tl, tr, br, bl = centers
        for (ax, ay), (bx, by), horizontal in ((tl, tr, True), (bl, br, True), (tl, bl, False), (tr, br, False)):
            angle = math.degrees(math.atan2(by - ay, bx - ax)) if horizontal else math.degrees(math.atan2(bx - ax, by - ay))
            if abs(angle) > max_angle:
                return failed(f"стр. {page}: сторона наклонена на {angle:.1f}°")
    return passed("квадраты по углам, страницы ровные")


@check("page_markers_order", "pdf")
def page_markers_order(ctx, params, item):
    import numpy as np

    got = []
    for page in range(1, ctx.page_count(item.path) + 1):
        img = ctx.render(item.path, page, 100, gray=True)
        arr = np.asarray(img)
        h, w = arr.shape
        y0, y1 = int(h * 272 / 297), int(h * 292 / 297)
        x0, x1 = int(w * 85 / 210), int(w * 125 / 210)
        d = 4.0 * w / 210.0
        n = 0
        for bx0, by0, bx1, by1 in _dark_blobs(arr[y0:y1, x0:x1]):
            bw, bh = bx1 - bx0, by1 - by0
            if 0.6 * d <= bw <= 1.5 * d and 0.6 * d <= bh <= 1.5 * d:
                n += 1
        got.append(n)
    want = list(params["expected"])
    if got != want:
        return failed(f"кружков внизу по страницам {got}, нужно {want}")
    return passed(f"кружки {got}")
