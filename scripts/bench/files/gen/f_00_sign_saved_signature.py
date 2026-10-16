"""Fixtures for f-00-sign-saved-signature (save a signature, then sign with it in a new conversation).

podpis_vladelec.jpg     — the owner's signature on squared notebook paper (SIG_RECIPE, seed=137, letter «В»).
zayavlenie_spravka.pdf  — a flat one-page request form «о выдаче справки с места работы» (no AcroForm):
                          ФИО, отдел, «Дата ____», «Подпись ____ (подпись)». LiberationSerif 12, SPECIMEN marks drawn
                          as outlines, so the text layer holds only the printed form.

truth/zayavlenie_spravka.json   field rects (pt, origin bottom-left), printed text boxes, expected values
truth/podpis_vladelec.json      ink bbox / aspect (signature_shape, signature_preview, signed-file detection)
truth/podpis_vladelec_mask.png  ground-truth ink coverage (8-bit, 3000×1600)

The sample uses its own seed and letter: Морозов's seed 131 would give the same wave (only the letter loop differs),
and the suite's signed-file detection must tell the owner's sample from the other suite signatures.
"""

from __future__ import annotations

import io
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common as C  # noqa: E402

CASE = "f-00-sign-saved-signature"
FORM = "zayavlenie_spravka.pdf"
PHOTO = "podpis_vladelec.jpg"
SEED = 137
INITIAL = "В"
PAGE_W, PAGE_H = C.FF_A4
BODY = "LiberationSerif"
BOLD = "LiberationSerif-Bold"
FS = 12
CLEAR_PT = 12

FIELDS = {
    "fio": {"rect": [170, 590, 545, 608], "caption": "(фамилия, имя, отчество)", "label": "Сотрудник"},
    "otdel": {"rect": [170, 560, 545, 578], "caption": "(подразделение)", "label": "Подразделение"},
    "date": {"rect": [100, 400, 200, 418], "caption": "(дд.мм.гггг)", "label": "Дата"},
    "signature": {"rect": [330, 396, 470, 430], "caption": "(подпись)", "label": "Подпись"},
}
REQUEST = (
    "Прошу выдать мне справку с места работы с указанием должности, стажа работы в организации и "
    "средней заработной платы за последние шесть месяцев для предъявления по месту требования."
)


def _expand(r, d):
    return [r[0] - d, r[1] - d, r[2] + d, r[3] + d]


def _intersects(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _form_pdf() -> tuple[bytes, list]:
    from reportlab.lib.enums import TA_JUSTIFY
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from reportlab.platypus import Frame, Paragraph

    C.ff_register_rl_fonts(BODY, BOLD, "DejaVuSans-Bold")
    buf = io.BytesIO()
    c = C.ff_rl_canvas(buf, title="Заявление о выдаче справки с места работы (ОБРАЗЕЦ)",
                       subject="Вымышленный бланк для тестов (ОБРАЗЕЦ / SPECIMEN)")
    printed = []

    def text(x, y, s, font=BODY, size=FS, align="left", gray=0.0):
        w = stringWidth(s, font, size)
        if align == "right":
            x -= w
        elif align == "center":
            x -= w / 2
        c.setFillGray(gray)
        c.setFont(font, size)
        c.drawString(x, y, s)
        c.setFillGray(0)
        printed.append({"text": s, "rect": [round(x, 2), round(y - 0.22 * size, 2), round(x + w, 2),
                                             round(y + 0.70 * size, 2)]})

    def blank(rect, dy=-2.0):
        c.setLineWidth(0.6)
        c.setStrokeGray(0)
        c.line(rect[0], rect[1] + dy, rect[2], rect[1] + dy)

    # SPECIMEN frame, top-left, as outlines (never in the text layer of an answer built on this form)
    c.saveState()
    c.setStrokeColorRGB(0.78, 0.1, 0.1)
    c.setFillColorRGB(0.78, 0.1, 0.1)
    c.setLineWidth(1.2)
    c.rect(40, 792, 178, 24, stroke=1, fill=0)
    C.rl_draw_text_outlines(c, "ОБРАЗЕЦ / SPECIMEN", C.ff_font_file("DejaVuSans-Bold"), 11, 129, 799)
    c.restoreState()

    for i, line in enumerate(["Генеральному директору", "ООО «Образец»", "Петрову П. П."]):
        text(330, 772 - 16 * i, line)
    text(PAGE_W / 2, 668, "ЗАЯВЛЕНИЕ", font=BOLD, size=13, align="center")
    text(PAGE_W / 2, 650, "о выдаче справки с места работы", align="center")

    for key in ("fio", "otdel"):
        f = FIELDS[key]
        r = f["rect"]
        text(60, r[1] + 3.5, f["label"] + ":")
        blank(r)
        text((r[0] + r[2]) / 2, r[1] - 11, f["caption"], size=7, align="center", gray=0.35)

    style = ParagraphStyle("b", fontName=BODY, fontSize=FS, leading=17, alignment=TA_JUSTIFY, firstLineIndent=35)
    frame = Frame(60, 470, PAGE_W - 120, 70, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    story = [Paragraph(REQUEST, style)]
    frame.addFromList(story, c)
    assert not story, "request text does not fit"
    printed.append({"text": REQUEST, "rect": [60, 470, PAGE_W - 60, 540]})

    d = FIELDS["date"]["rect"]
    text(d[0] - 6, d[1] + 3.5, "Дата", align="right")
    blank(d)
    text((d[0] + d[2]) / 2, d[1] - 11, FIELDS["date"]["caption"], size=7, align="center", gray=0.35)
    s = FIELDS["signature"]["rect"]
    text(s[0] - 6, s[1] + 3.5, "Подпись", align="right")
    blank(s)
    text((s[0] + s[2]) / 2, s[1] - 11, FIELDS["signature"]["caption"], size=7, align="center", gray=0.35)

    # big diagonal mark in the empty lower part, clear of every field
    wm_box = [110, 150, 490, 330]
    assert not any(_intersects(wm_box, _expand(f["rect"], CLEAR_PT)) for f in FIELDS.values())
    C.bk_rl_watermark(c, cx=300, cy=240, size=42, angle=18)
    text(PAGE_W / 2, 40, "Бланк вымышленной организации. Все данные — образец для тестов.", size=7, align="center",
         gray=0.3)
    c.showPage()
    c.save()
    return buf.getvalue(), printed


def _truth(printed) -> dict:
    return {
        "case": CASE,
        "file": FORM,
        "pages": 1,
        "page_size_pt": [PAGE_W, PAGE_H],
        "coords": "pt, origin bottom-left, rect = [x0, y0, x1, y1]",
        "font": f"{BODY} {FS}",
        "acroform": None,
        "fields": {k: {"page": 1, "type": "sig" if k == "signature" else "text", "rect": f["rect"],
                       "label": f["label"]} for k, f in FIELDS.items()},
        "printed_text_boxes": printed,
        "expected_values": {
            "fio": "Образцов Илья Викторович",
            "otdel": "отдел продаж",
            # The person asks for yesterday's date (owner 16.10: a request to sign is the consent, no question).
            "date": "{yesterday:%d.%m.%Y}",
            "signature": "the saved sample podpis_vladelec, at once on the request to sign",
        },
    }


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    written = []

    img, info, alpha = C.sig_notebook_photo(SEED, INITIAL)
    jpg = out_dir / PHOTO
    C.sig_save_jpeg(img, jpg, quality=82)
    written.append(str(jpg))
    mask_png = truth_dir / "podpis_vladelec_mask.png"
    C.sig_save_mask(alpha, mask_png)
    written.append(str(mask_png))
    written.append(C.ff_write_json(truth_dir / "podpis_vladelec.json", {
        "file": PHOTO, **info, **C.sig_truth(alpha, mask_png.name),
        "used_by": "signature_preview / signature_shape: aspect of the ink bbox; signed-file detection by NCC"}))

    pdf_bytes, printed = _form_pdf()
    pdf = out_dir / FORM
    pdf.write_bytes(pdf_bytes)
    written.append(str(pdf))
    written.append(C.ff_write_json(truth_dir / "zayavlenie_spravka.json", _truth(printed)))
    return written


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parent.parent
    for p in build(root / "out" / CASE, root / "truth"):
        print(p)
