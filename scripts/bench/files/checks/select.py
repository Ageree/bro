"""Which received files a check looks at (W5 §5.2).

- Previews of a saved signature («Подпись (образец).png|pdf») are left out of every set except `signature_preview` and a
  `file_count`/`file_regex` that names them.
- Positive kinds look at the latest version: the files of the check's group from the largest turn that has any (f-rent's
  signed PDF in turn 1, not the unsigned one of turn 0). `turn: N` takes exactly turn N, `all_files: true` every turn.
- Negative kinds look at every file of every turn. Files of the cleanup turns (turn null) are never checked.
"""

from __future__ import annotations

import pathlib
import re

from .context import Received

PREVIEW = re.compile(r"^Подпись \(образец\)\.(png|pdf)$")
PREVIEW_NAMES = ("Подпись (образец).png", "Подпись (образец).pdf")
EXT_GROUP = {
    ".pdf": "pdf", ".xlsx": "xlsx", ".xlsm": "xlsx", ".docx": "docx", ".pptx": "pptx", ".jpg": "image", ".jpeg": "image",
    ".png": "image", ".webp": "image", ".gif": "image", ".tif": "image", ".tiff": "image", ".bmp": "image", ".zip": "zip",
    ".ics": "ics", ".vcf": "vcf",
}
TYPE_GROUP = {
    "application/pdf": "pdf", "application/zip": "zip", "text/calendar": "ics", "text/vcard": "vcf", "text/x-vcard": "vcf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
}


def extension(item: Received) -> str:
    for name in (item.name, item.shown_name or "", item.path.name):
        suffix = pathlib.PurePosixPath(name).suffix.lower()
        if suffix:
            return suffix
    return ""


def group_of(item: Received) -> str | None:
    if "group" in item.cache:
        return item.cache["group"]
    group = EXT_GROUP.get(extension(item))
    if group is None:
        media = item.media_type.split(";")[0].strip().lower()
        group = TYPE_GROUP.get(media) or ("image" if media.startswith("image/") else None)
    if group is None:
        group = _sniff(item.path)
    item.cache["group"] = group
    return group


def _sniff(path: pathlib.Path) -> str | None:
    try:
        head = path.read_bytes()[:8]
    except OSError:
        return None
    if head.startswith(b"%PDF"):
        return "pdf"
    if head[:3] == b"\xff\xd8\xff" or head.startswith(b"\x89PNG"):
        return "image"
    if head.startswith(b"PK\x03\x04"):
        return "zip"
    return None


def is_preview(item: Received) -> bool:
    return bool(PREVIEW.match(item.name or item.shown_name or ""))


def _ext_matches(item: Received, wanted: str) -> bool:
    wanted = "." + wanted.lower().lstrip(".")
    ext = extension(item)
    if wanted in (".jpg", ".jpeg"):
        return ext in (".jpg", ".jpeg")
    return ext == wanted


def names_preview(params: dict) -> bool:
    for key in ("name_regex", "file_regex"):
        pattern = params.get(key)
        if pattern and any(re.search(pattern, n) for n in PREVIEW_NAMES):
            return True
    return False


def candidates(ctx, spec, params: dict, *, signed_test=None) -> tuple[list, str]:
    """(files, reason when empty). `signed_test(ctx, item) -> bool` backs `file_filter: signed`."""
    items = [r for r in ctx.received if r.turn is not None]
    if spec.group not in (None, "any"):
        items = [r for r in items if group_of(r) == spec.group]
    keep_previews = spec.kind == "signature_preview" or names_preview(params)
    if not keep_previews:
        items = [r for r in items if not is_preview(r)]
    elif spec.kind == "signature_preview":
        items = [r for r in items if is_preview(r)]
    ext = params.get("ext") or params.get("file_ext")
    if ext:
        items = [r for r in items if _ext_matches(r, ext)]
    if params.get("file_regex"):
        items = [r for r in items if re.search(params["file_regex"], r.name or r.shown_name or "")]
    if params.get("file_filter") == "signed":
        if signed_test is None:
            raise ValueError("file_filter signed needs a test")
        items = [r for r in items if signed_test(ctx, r)]
    if not spec.negative:
        if "turn" in params and isinstance(params["turn"], int):
            items = [r for r in items if r.turn == params["turn"]]
        elif not params.get("all_files") and items:
            latest = max(r.turn for r in items)
            items = [r for r in items if r.turn == latest]
    if params.get("pick") == "most_pages" and len(items) > 1:
        def pages(r):
            try:
                return ctx.page_count(r.path)
            except Exception:
                return -1

        top = max(items, key=pages)
        items = [top]
    if items:
        return items, ""
    if ctx.failed_downloads:
        return [], "файл не скачан"
    return [], "нет файла"
