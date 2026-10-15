"""What one case run gives the checks: the case, files-run.json, received files, truth, dates and tool caches.

Coordinates: truth rects are PDF user space (pt, origin bottom-left of the MediaBox, before /Rotate). pdftotext
-bbox-layout and pdftoppm (without -cropbox) work in the MediaBox with /Rotate applied, origin top-left (verified with
poppler 24.02 on every rotation and a CropBox offset); `PageGeometry` converts between the two.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field

from . import CheckError

MONTHS_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября",
                   "ноября", "декабря"]
_TODAY = re.compile(r"\{today:([^{}]*)\}")
TOOL_TIMEOUT = 300


class MissingToolError(CheckError):
    def __init__(self, name: str):
        super().__init__(f"не установлен {name}")
        self.tool = name


def today_format(day: dt.date, fmt: str) -> str:
    """strftime plus the unpadded %-d / %-m (portable: not every libc knows them)."""
    fmt = fmt.replace("%-d", str(day.day)).replace("%-m", str(day.month))
    return day.strftime(fmt)


def substitute(text: str, day: dt.date) -> str:
    text = text.replace("{today_month_genitive}", MONTHS_GENITIVE[day.month - 1])
    return _TODAY.sub(lambda m: today_format(day, m.group(1)), text)


def substitute_params(value, day: dt.date):
    if isinstance(value, str):
        return substitute(value, day)
    if isinstance(value, list):
        return [substitute_params(v, day) for v in value]
    if isinstance(value, dict):
        return {substitute(k, day): substitute_params(v, day) for k, v in value.items()}
    return value


@dataclass
class Received:
    turn: int | None
    at: str | None
    name: str
    shown_name: str | None
    media_type: str
    size: int
    sha256: str
    path: pathlib.Path
    source: str
    url_path: str
    cache: dict = field(default_factory=dict, repr=False, compare=False)

    @property
    def label(self) -> str:
        return f"{self.name or self.path.name} (ход {self.turn})"


@dataclass(frozen=True)
class PageGeometry:
    """One PDF page: the MediaBox in user space and /Rotate (0, 90, 180, 270)."""

    box: tuple
    rotate: int

    @property
    def view_size(self) -> tuple:
        w, h = self.box[2] - self.box[0], self.box[3] - self.box[1]
        return (h, w) if self.rotate in (90, 270) else (w, h)

    def to_view(self, x: float, y: float) -> tuple:
        x0, y0, x1, y1 = self.box
        r = self.rotate
        if r == 90:
            return y - y0, x - x0
        if r == 180:
            return x1 - x, y - y0
        if r == 270:
            return y1 - y, x1 - x
        return x - x0, y1 - y

    def to_user(self, vx: float, vy: float) -> tuple:
        x0, y0, x1, y1 = self.box
        r = self.rotate
        if r == 90:
            return x0 + vy, y0 + vx
        if r == 180:
            return x1 - vx, y0 + vy
        if r == 270:
            return x1 - vy, y1 - vx
        return x0 + vx, y1 - vy

    def rect_to_view(self, rect) -> tuple:
        a = self.to_view(rect[0], rect[1])
        b = self.to_view(rect[2], rect[3])
        return min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])

    def rect_to_user(self, rect) -> tuple:
        a = self.to_user(rect[0], rect[1])
        b = self.to_user(rect[2], rect[3])
        return min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])


@dataclass(frozen=True)
class Word:
    text: str
    rect: tuple  # user space (x0, y0, x1, y1)
    line: int  # index of the pdftotext line on the page

    @property
    def center(self) -> tuple:
        return (self.rect[0] + self.rect[2]) / 2, (self.rect[1] + self.rect[3]) / 2


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def inside(point, rect) -> bool:
    return rect[0] <= point[0] <= rect[2] and rect[1] <= point[1] <= rect[3]


def expand(rect, d: float) -> list:
    return [rect[0] - d, rect[1] - d, rect[2] + d, rect[3] + d]


def intersection_area(a, b) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def area(r) -> float:
    return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])


class Context:
    def __init__(self, *, case: dict, run: dict, case_dir: pathlib.Path, fixtures_dir: pathlib.Path):
        self.case = case
        self.case_id = case["id"]
        self.run = run
        self.case_dir = pathlib.Path(case_dir).resolve()
        self.fixtures_dir = pathlib.Path(fixtures_dir).expanduser().resolve()
        self.truth_dir = self.fixtures_dir / "truth"
        try:
            from zoneinfo import ZoneInfo

            self.tz = ZoneInfo(run.get("timeZone") or "Europe/Moscow")
        except Exception as e:  # a broken tz database is an environment problem, not a check result
            raise SystemExit(f"time zone: {e}") from e
        self.started_at = run.get("startedAt") or ""
        self.replies = [r for r in run.get("replies", [])]
        self.questions = [q for q in run.get("questions", [])]
        self.gates = [g for g in run.get("gates", [])]
        # Files of the cleanup turns (turn null) are never checked, so neither are their lost downloads.
        self.failed_downloads = [f for f in run.get("failedDownloads", []) if f.get("turn") is not None]
        self.received = [self._received(item) for item in run.get("received", [])]
        self.tools: dict[str, str] = {}
        self._scratch: pathlib.Path | None = None
        self._cache: dict = {}
        self.manifest = self._load_manifest()
        self.truth = self._load_truth()
        self.fields = {}
        for doc in self.truth.values():
            if isinstance(doc, dict) and isinstance(doc.get("fields"), dict):
                for name, value in doc["fields"].items():
                    if isinstance(value, dict):
                        self.fields.setdefault(name, value)

    # ------------------------------------------------------------------ inputs
    def _received(self, item: dict) -> Received:
        rel = item.get("file") or ""
        path = (self.case_dir / rel).resolve()
        if self.case_dir not in path.parents:
            raise SystemExit(f"received file outside the case directory: {rel}")
        return Received(turn=item.get("turn"), at=item.get("at"), name=item.get("name") or "",
                        shown_name=item.get("shownName"), media_type=item.get("mediaType") or "",
                        size=int(item.get("bytes") or 0), sha256=item.get("sha256") or "", path=path,
                        source=item.get("source") or "", url_path=item.get("urlPath") or "")

    def _load_manifest(self) -> dict | None:
        path = self.fixtures_dir / "manifest.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def _case_input_names(self) -> set:
        names = set()
        for item in self.case.get("fixtures", []):
            names.update(item.get("outputs") or [item.get("name", "")])
        for t in self.case.get("turns", []):
            names.update(t.get("files", []))
        return names

    def _load_truth(self) -> dict:
        """Truth JSONs of this case: the manifest's list when fixtures.py wrote one, else every truth JSON that names the
        case or one of its input files."""
        docs = {}
        listed = None
        entry = (self.manifest or {}).get("cases", {}).get(self.case_id)
        if entry and entry.get("truth"):
            listed = [n for n in entry["truth"] if n.endswith(".json")]
        if listed is not None:
            for name in listed:
                path = self.truth_dir / name
                if path.exists():
                    docs[name] = json.loads(path.read_text(encoding="utf-8"))
            return docs
        names = self._case_input_names()
        if not self.truth_dir.is_dir():
            return docs
        for path in sorted(self.truth_dir.glob("*.json")):
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                continue
            if not isinstance(doc, dict):
                continue
            files = doc.get("files")
            listed_files = files.values() if isinstance(files, dict) else files if isinstance(files, list) else []
            mentioned = {doc.get("file"), doc.get("fixture")}
            mentioned |= {f if isinstance(f, str) else f.get("file") for f in listed_files if isinstance(f, (str, dict))}
            if doc.get("case") == self.case_id or mentioned & names:
                docs[path.name] = doc
        return docs

    def truth_doc(self, name: str) -> dict:
        doc = self.truth.get(name)
        if doc is None:
            path = self.truth_dir / name
            if not path.exists():
                raise CheckError(f"нет эталона truth/{name} (соберите фикстуры: fixtures.py)")
            doc = json.loads(path.read_text(encoding="utf-8"))
            self.truth[name] = doc
        return doc

    def truth_path(self, name: str) -> pathlib.Path:
        path = self.truth_dir / name
        if not path.exists():
            raise CheckError(f"нет эталона truth/{name} (соберите фикстуры: fixtures.py)")
        return path

    def fixture_path(self, name: str) -> pathlib.Path:
        path = self.fixtures_dir / self.case_id / name
        if not path.exists():
            raise CheckError(f"нет фикстуры {self.case_id}/{name} (соберите фикстуры: fixtures.py)")
        return path

    def field_rect(self, name: str) -> list:
        f = self.fields.get(name)
        if not f or "rect" not in f:
            raise CheckError(f"в эталоне нет поля {name}")
        return list(f["rect"])

    # ------------------------------------------------------------------ dates
    def day_of(self, at: str | None) -> dt.date:
        for value in (at, self.started_at):
            if value:
                try:
                    moment = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if moment.tzinfo is None:
                    moment = moment.replace(tzinfo=dt.timezone.utc)
                return moment.astimezone(self.tz).date()
        return dt.datetime.now(self.tz).date()

    @property
    def run_day(self) -> dt.date:
        return self.day_of(None)

    # ------------------------------------------------------------------ tools
    def tool(self, name: str) -> str:
        path = shutil.which(name)
        if path is None:
            raise MissingToolError(name)
        if name not in self.tools:
            self.tools[name] = _tool_version(name, path)
        return path

    def run_tool(self, name: str, args: list, *, timeout: int = TOOL_TIMEOUT, ok_codes=(0,)) -> bytes:
        exe = self.tool(name)
        try:
            res = subprocess.run([exe, *args], capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired as e:
            raise CheckError(f"{name}: не уложился в {timeout} с") from e
        if res.returncode not in ok_codes:
            tail = res.stderr.decode("utf-8", "replace").strip()[-300:]
            raise CheckError(f"{name} завершился с кодом {res.returncode}: {tail}")
        return res.stdout

    def scratch(self, name: str) -> pathlib.Path:
        if self._scratch is None:
            self._scratch = pathlib.Path(tempfile.mkdtemp(prefix="bench-check-"))
        path = self._scratch / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    def cleanup(self) -> None:
        if self._scratch is not None:
            shutil.rmtree(self._scratch, ignore_errors=True)
            self._scratch = None

    # ------------------------------------------------------------------ PDF helpers (cached)
    def pdf_reader(self, path):
        key = ("reader", str(path))
        if key not in self._cache:
            from pypdf import PdfReader

            try:
                reader = PdfReader(str(path))
                if reader.is_encrypted:
                    reader.decrypt("")
                _ = len(reader.pages)
            except Exception as e:
                raise CheckError(f"PDF не читается: {type(e).__name__}: {e}") from e
            self._cache[key] = reader
        return self._cache[key]

    def page_count(self, path) -> int:
        return len(self.pdf_reader(path).pages)

    def geometry(self, path, page: int) -> PageGeometry:
        key = ("geom", str(path), page)
        if key not in self._cache:
            p = self.pdf_reader(path).pages[page - 1]
            box = p.mediabox
            rotate = int(p.get("/Rotate", 0) or 0) % 360
            self._cache[key] = PageGeometry((float(box.left), float(box.bottom), float(box.right), float(box.top)), rotate)
        return self._cache[key]

    def words(self, path, page: int) -> list:
        """Words of one page with user-space rects, from pdftotext -bbox-layout."""
        key = ("words", str(path))
        if key not in self._cache:
            self._cache[key] = self._all_words(path)
        pages = self._cache[key]
        return pages[page - 1] if 0 < page <= len(pages) else []

    def _all_words(self, path) -> list:
        from xml.etree import ElementTree

        raw = self.run_tool("pdftotext", ["-bbox-layout", "-enc", "UTF-8", str(path), "-"])
        text = raw.decode("utf-8", "replace")
        text = re.sub(r"<!DOCTYPE[^>]*>", "", text)
        root = ElementTree.fromstring(text)
        ns = "{http://www.w3.org/1999/xhtml}"
        pages = []
        for n, page in enumerate(root.iter(f"{ns}page"), start=1):
            geom = self.geometry(path, n) if n <= self.page_count(path) else PageGeometry((0, 0, 1, 1), 0)
            words = []
            line_no = 0
            for line in page.iter(f"{ns}line"):
                line_no += 1
                for w in line.iter(f"{ns}word"):
                    vx0, vy0 = float(w.get("xMin")), float(w.get("yMin"))
                    vx1, vy1 = float(w.get("xMax")), float(w.get("yMax"))
                    words.append(Word(w.text or "", geom.rect_to_user((vx0, vy0, vx1, vy1)), line_no))
            pages.append(words)
        return pages

    def text(self, path, page: int | None = None, *, layout: bool = False) -> str:
        key = ("text", str(path), page, layout)
        if key not in self._cache:
            args = ["-enc", "UTF-8"]
            if layout:
                args.append("-layout")
            if page is not None:
                args += ["-f", str(page), "-l", str(page)]
            self._cache[key] = self.run_tool("pdftotext", [*args, str(path), "-"]).decode("utf-8", "replace")
        return self._cache[key]

    def render(self, path, page: int, dpi: int, *, gray: bool = False):
        """The page (MediaBox, /Rotate applied) as a PIL image."""
        from PIL import Image

        key = ("render", str(path), page, dpi, gray)
        if key not in self._cache:
            out = self.scratch("renders") / f"{hashlib.sha1(str(key).encode()).hexdigest()}"
            args = ["-r", str(dpi), "-f", str(page), "-l", str(page), "-singlefile", "-png"]
            if gray:
                args.append("-gray")
            self.run_tool("pdftoppm", [*args, str(path), str(out)])
            with Image.open(f"{out}.png") as im:
                self._cache[key] = im.convert("L" if gray else "RGB")
        return self._cache[key]

    def as_pdf(self, path) -> pathlib.Path:
        """An office document converted to PDF by LibreOffice (cached); a PDF is returned as is."""
        path = pathlib.Path(path)
        if path.suffix.lower() == ".pdf":
            return path
        key = ("pdf", str(path))
        if key not in self._cache:
            self._cache[key] = self._soffice(path, "pdf")
        return self._cache[key]

    def recalculated(self, path) -> pathlib.Path:
        """An XLSX copy recalculated by LibreOffice (formula results cached in the file)."""
        key = ("recalc", str(path))
        if key not in self._cache:
            self._cache[key] = self._soffice(pathlib.Path(path), "xlsx", "xlsx:Calc MS Excel 2007 XML")
        return self._cache[key]

    def _soffice(self, src: pathlib.Path, ext: str, target: str | None = None) -> pathlib.Path:
        work = self.scratch("soffice/" + hashlib.sha1(f"{src}:{ext}".encode()).hexdigest())
        profile = work / "profile"
        outdir = work / "out"
        outdir.mkdir(exist_ok=True)
        copy = work / ("in" + src.suffix.lower())
        shutil.copyfile(src, copy)
        self.run_tool("soffice", [f"-env:UserInstallation=file://{profile}", "--headless", "--convert-to",
                                  target or ext, "--outdir", str(outdir), str(copy)])
        out = outdir / f"in.{ext}"
        if not out.exists():
            raise CheckError(f"LibreOffice не сконвертировал {src.name} в {ext}")
        return out


def _tool_version(name: str, path: str) -> str:
    flag = {"pdftoppm": "-v", "pdftotext": "-v", "pdfimages": "-v", "tesseract": "--version", "soffice": "--version",
            "ffmpeg": "-version"}.get(name, "--version")
    try:
        res = subprocess.run([path, flag], capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    out = (res.stdout or res.stderr).decode("utf-8", "replace").strip().splitlines()
    return out[0][:80] if out else "unknown"
