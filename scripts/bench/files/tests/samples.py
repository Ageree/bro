"""Small documents built inside tests: signature cut-outs, PDFs with placed images and form fields, a context."""

from __future__ import annotations

import io
import json
import pathlib
import sys
import tempfile

import numpy as np
from PIL import Image

FILES = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FILES / "gen"))
import common  # noqa: E402

from checks.context import Context  # noqa: E402

INK = (24, 36, 102)


def ink_alpha(seed: int, initial: str):
    alpha, _ = common.sig_ink_alpha(seed, initial, (1500, 800))
    return alpha


def cutout(seed: int, initial: str, height: int = 120) -> Image.Image:
    """The signature as W2's extractor leaves it: ink-coloured RGBA, transparent background, cropped to the ink."""
    alpha = ink_alpha(seed, initial)
    ys, xs = np.nonzero(alpha >= 0.5)
    alpha = alpha[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    rgba = np.zeros(alpha.shape + (4,), np.uint8)
    rgba[..., :3] = INK
    rgba[..., 3] = np.rint(alpha * 255).astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA")
    return img.resize((int(img.width * height / img.height), height), Image.LANCZOS)


def write_truth_mask(truth_dir: pathlib.Path, stem: str, seed: int, initial: str) -> None:
    alpha = ink_alpha(seed, initial)
    truth_dir.mkdir(parents=True, exist_ok=True)
    common.sig_save_mask(alpha, truth_dir / f"{stem}_mask.png")
    (truth_dir / f"{stem}.json").write_text(json.dumps(common.sig_truth(alpha, f"{stem}_mask.png")), encoding="utf-8")


def png_bytes(img: Image.Image) -> bytes:
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def pdf(images=(), *, texts=(), size=(595.28, 841.89), in_form=False, form_matrix=None, rotate=0, cropbox=None,
        keywords=None, producer=None, widgets=()) -> bytes:
    """One page. images: (PIL image, [x0, y0, x1, y1]) drawn at those user-space rects (inside a Form XObject whose
    /Matrix is form_matrix when in_form); texts: (x, y, ascii text); widgets: (name, rect, field type, value or None)."""
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, NumberObject, TextStringObject
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=size, invariant=1)
    dx, dy = (form_matrix[4], form_matrix[5]) if form_matrix else (0, 0)
    for n, (img, rect) in enumerate(images):
        w, h = rect[2] - rect[0], rect[3] - rect[1]
        if in_form:
            name = f"f{n}"
            c.beginForm(name)
            c.drawImage(ImageReader(img), 0, 0, w, h, mask="auto")
            c.endForm()
            c.saveState()
            c.translate(rect[0] - dx, rect[1] - dy)
            c.doForm(name)
            c.restoreState()
        else:
            c.drawImage(ImageReader(img), rect[0], rect[1], w, h, mask="auto")
    c.setFont("Helvetica", 12)
    for x, y, s in texts:
        c.drawString(x, y, s)
    c.showPage()
    c.save()
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(buf.getvalue())))
    page = writer.pages[0]
    if form_matrix:
        xobjects = page["/Resources"]["/XObject"]
        for key in xobjects:
            xo = xobjects[key].get_object()
            if xo.get("/Subtype") == "/Form":
                xo[NameObject("/Matrix")] = ArrayObject([FloatObject(v) for v in form_matrix])
    if rotate:
        page.rotate(rotate)
    if cropbox:
        from pypdf.generic import RectangleObject

        page.cropbox = RectangleObject(cropbox)
    if widgets:
        annots = ArrayObject()
        fields = ArrayObject()
        for name, rect, ftype, value in widgets:
            w = DictionaryObject({
                NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"),
                NameObject("/FT"): NameObject(ftype), NameObject("/T"): TextStringObject(name),
                NameObject("/Rect"): ArrayObject([FloatObject(v) for v in rect]), NameObject("/F"): NumberObject(4),
            })
            if value is not None:
                w[NameObject("/V")] = TextStringObject(value)
            ref = writer._add_object(w)
            annots.append(ref)
            fields.append(ref)
        page[NameObject("/Annots")] = annots
        writer._root_object[NameObject("/AcroForm")] = DictionaryObject({NameObject("/Fields"): fields})
    meta = {}
    if keywords:
        meta["/Keywords"] = keywords
    if producer:
        meta["/Producer"] = producer
    if meta:
        writer.add_metadata(meta)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def context(case: dict, case_dir: pathlib.Path, fixtures_dir: pathlib.Path | None = None) -> Context:
    run = json.loads((case_dir / "files-run.json").read_text(encoding="utf-8"))
    return Context(case=case, run=run, case_dir=case_dir, fixtures_dir=fixtures_dir or pathlib.Path(tempfile.mkdtemp()))


SUITE = FILES.parents[2] / "docs" / "benchmarks" / "files" / "cases.json"


def suite_check(case_id: str, description_start: str) -> tuple:
    """(case, check) of the committed suite: the check whose description starts with description_start."""
    case = next(c for c in json.loads(SUITE.read_text(encoding="utf-8")) if c["id"] == case_id)
    return case, next(c for c in case["checks"] if c["description"].startswith(description_start))
