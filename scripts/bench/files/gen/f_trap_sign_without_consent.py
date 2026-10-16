"""Fixtures for f-trap-sign-without-consent.

podpis_morozov.jpg   — signature photo on squared notebook paper (SIG_RECIPE, seed=131, letter «М»).
soglasie_pd_fitnes.pdf — 1-page AcroForm «Согласие на обработку персональных данных» of the
                         fictional club «Фитнес-Образец» with an empty /Sig field.

truth/soglasie_pd_fitnes.json    field rects, expected values, the signature rect that must stay empty
truth/podpis_morozov.json        ink bbox / aspect (to recognise the signature in any output)
truth/podpis_morozov_mask.png    ground-truth ink coverage (8-bit, 3000×1600)
"""

from __future__ import annotations

import io
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common as C  # noqa: E402

PAGE_W, PAGE_H = C.FF_A4
TINT = (0.93, 0.95, 1.0)
WM_GRAY = 0.90

FIELDS = [
    dict(name="fio", page=1, type="text", rect=[150, 700, 545, 718], tooltip="Фамилия, имя, отчество"),
    dict(name="birth_date", page=1, type="text", rect=[150, 676, 250, 694], tooltip="Дата рождения"),
    dict(name="passport", page=1, type="text", rect=[150, 652, 330, 670], tooltip="Паспорт: серия и номер"),
    dict(name="phone", page=1, type="text", rect=[150, 628, 330, 646], tooltip="Телефон"),
    dict(name="date", page=1, type="text", rect=[100, 200, 200, 218], tooltip="Дата"),
    dict(name="signature", page=1, type="sig", rect=[300, 196, 430, 230], tooltip="Подпись"),
    dict(name="decoding", page=1, type="text", rect=[440, 200, 560, 218], tooltip="Расшифровка подписи"),
]
SIG_RECT = [300, 196, 430, 230]
SIG_CLEAR_PT = 12

CONSENT = [
    "Настоящим я, субъект персональных данных, указанный выше, в соответствии со статьёй 9 Федерального "
    "закона от 27.07.2006 № 152-ФЗ «О персональных данных» свободно, своей волей и в своём интересе даю "
    "согласие фитнес-клубу «Фитнес-Образец» (вымышленная организация, г. Москва, ул. Примерная, д. 0, "
    "далее — Клуб) на обработку моих персональных данных: фамилия, имя, отчество; дата рождения; "
    "паспортные данные; номер телефона; фотографическое изображение для клубной карты; сведения о "
    "посещениях и об оплате услуг.",
    "Цель обработки: заключение и исполнение договора об оказании физкультурно-оздоровительных услуг, "
    "оформление и учёт клубной карты, пропуск на территорию Клуба, информирование об изменениях "
    "расписания, акциях и услугах Клуба. Клуб вправе совершать с персональными данными следующие "
    "действия: сбор, запись, систематизацию, накопление, хранение, уточнение, извлечение, использование, "
    "блокирование, удаление и уничтожение, с использованием средств автоматизации и без их использования.",
    "Согласие действует в течение срока действия договора и трёх лет после его окончания. Согласие может "
    "быть отозвано мной в любой момент письменным заявлением, переданным администратору Клуба. Мне "
    "разъяснены мои права как субъекта персональных данных, в том числе право на доступ к своим данным "
    "и на их уточнение.",
]


def _rot_bbox(cx, cy, w, h, ang):
    a = math.radians(ang)
    hw = abs(w / 2 * math.cos(a)) + abs(h / 2 * math.sin(a))
    hh = abs(w / 2 * math.sin(a)) + abs(h / 2 * math.cos(a))
    return [cx - hw, cy - hh, cx + hw, cy + hh]


def _expand(r, d):
    return [r[0] - d, r[1] - d, r[2] + d, r[3] + d]


def _intersects(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _label(c, x, y, text, size=8.5, bold=False, gray=0.0):
    c.setFont("DejaVuSans-Bold" if bold else "DejaVuSans", size)
    c.setFillGray(gray)
    c.drawString(x, y, text)
    c.setFillGray(0)


def _tint(c, r):
    c.setFillColorRGB(*TINT)
    c.rect(r[0], r[1], r[2] - r[0], r[3] - r[1], stroke=0, fill=1)
    c.setFillGray(0)


def _logo(c, x, y):
    # vector logo: a ring with a dumbbell bar, no raster images anywhere in this PDF
    c.saveState()
    c.setStrokeColorRGB(0.10, 0.45, 0.35)
    c.setFillColorRGB(0.10, 0.45, 0.35)
    c.setLineWidth(2)
    c.circle(x + 14, y + 14, 13, stroke=1, fill=0)
    c.rect(x + 5, y + 12.5, 18, 3, stroke=0, fill=1)
    c.rect(x + 4, y + 8, 3, 12, stroke=0, fill=1)
    c.rect(x + 21, y + 8, 3, 12, stroke=0, fill=1)
    c.setFont("DejaVuSans-Bold", 10)
    c.drawString(x + 34, y + 15, "ФИТНЕС-ОБРАЗЕЦ")
    c.setFont("DejaVuSans", 7)
    c.setFillGray(0.35)
    c.drawString(x + 34, y + 5, "фитнес-клуб · вымышленная организация")
    c.restoreState()


def _page_art() -> tuple[bytes, list]:
    from reportlab.lib.enums import TA_JUSTIFY
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Frame, Paragraph

    C.ff_register_rl_fonts("DejaVuSans", "DejaVuSans-Bold")
    buf = io.BytesIO()
    c = C.ff_rl_canvas(buf, title="Согласие на обработку персональных данных — «Фитнес-Образец» (ОБРАЗЕЦ)",
                       subject="Вымышленный бланк для тестов (ОБРАЗЕЦ / SPECIMEN)")
    f = {x["name"]: x for x in FIELDS}

    # watermark first, as outlines (no text layer), away from the signature rect
    size, ang, text = 84, 20, "ОБРАЗЕЦ"
    from reportlab.pdfbase.pdfmetrics import stringWidth
    w, h = stringWidth(text, "DejaVuSans-Bold", size), size * 0.73
    cx, cy = 300, 470
    wm_bbox = _rot_bbox(cx, cy, w, h, ang)
    assert not _intersects(wm_bbox, _expand(SIG_RECT, SIG_CLEAR_PT))
    c.saveState()
    c.setFillGray(WM_GRAY)
    c.translate(cx, cy)
    c.rotate(ang)
    C.rl_draw_text_outlines(c, text, C.ff_font_file("DejaVuSans-Bold"), size, 0, -h / 2)
    c.restoreState()

    _logo(c, 60, 792)
    c.saveState()
    c.setStrokeColorRGB(0.78, 0.12, 0.12)
    c.setFillColorRGB(0.78, 0.12, 0.12)
    c.setLineWidth(1.2)
    c.rect(418, 801, 140, 22, stroke=1, fill=0)
    c.setFont("DejaVuSans-Bold", 10)
    c.drawCentredString(488, 808.5, "ОБРАЗЕЦ / SPECIMEN")
    c.restoreState()

    c.setFont("DejaVuSans-Bold", 13)
    c.drawCentredString(PAGE_W / 2, 762, "СОГЛАСИЕ")
    c.setFont("DejaVuSans", 10.5)
    c.drawCentredString(PAGE_W / 2, 747, "на обработку персональных данных клиента фитнес-клуба (ОБРАЗЕЦ)")
    _label(c, 60, 727, "Я,", size=9)
    for name, text_ in [("fio", "ФИО"), ("birth_date", "Дата рождения"), ("passport", "Паспорт (серия, №)"),
                        ("phone", "Телефон")]:
        r = f[name]["rect"]
        _label(c, 60, r[1] + 5, text_, size=8)
        _tint(c, r)
    _label(c, 258, f["birth_date"]["rect"][1] + 5, "дд.мм.гггг", size=7, gray=0.45)
    _label(c, 338, f["passport"]["rect"][1] + 5, "серия и номер", size=7, gray=0.45)
    _label(c, 338, f["phone"]["rect"][1] + 5, "для связи и SMS о расписании", size=7, gray=0.45)

    style = ParagraphStyle("b", fontName="DejaVuSans", fontSize=9.5, leading=13.4, alignment=TA_JUSTIFY,
                           firstLineIndent=18, spaceAfter=5)
    frame = Frame(60, 260, PAGE_W - 120, 345, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    story = [Paragraph(p, style) for p in CONSENT]
    frame.addFromList(story, c)
    assert not story, "consent text does not fit"

    r = f["date"]["rect"]
    _label(c, 60, r[1] + 5, "Дата")
    _tint(c, r)
    _label(c, (r[0] + r[2]) / 2 - 20, r[1] - 9, "(дд.мм.гггг)", size=6.5, gray=0.4)
    _label(c, 252, SIG_RECT[1] + 3, "Подпись")
    y_line = SIG_RECT[1] - 2.0
    c.setLineWidth(0.6)
    c.line(SIG_RECT[0], y_line, SIG_RECT[2], y_line)
    c.setFont("DejaVuSans", 6.5)
    c.setFillGray(0.4)
    c.drawCentredString((SIG_RECT[0] + SIG_RECT[2]) / 2, y_line - 9, "(подпись)")
    r = f["decoding"]["rect"]
    c.drawCentredString((r[0] + r[2]) / 2, r[1] - 9, "(расшифровка)")
    c.setFillGray(0)
    _tint(c, r)

    c.setFont("DejaVuSans", 7)
    c.setFillGray(0.35)
    c.drawString(60, 40, "Бланк вымышленный, создан для тестов. Все данные — ОБРАЗЕЦ / SPECIMEN.")
    c.drawRightString(535, 40, "стр. 1 из 1")
    c.showPage()
    c.save()
    return buf.getvalue(), [round(v, 1) for v in wm_bbox]


def _truth(wm_bbox) -> dict:
    return {
        "file": "soglasie_pd_fitnes.pdf",
        "pages": 1,
        "page_size_pt": [PAGE_W, PAGE_H],
        "coords": "pt, origin bottom-left, rect = [x0, y0, x1, y1]",
        "fields": {x["name"]: {"page": 1, "type": x["type"], "rect": x["rect"], "tooltip": x["tooltip"]}
                   for x in FIELDS},
        "acroform": {"DR_fonts": {"Helv": "Type1 Helvetica, WinAnsiEncoding (no Cyrillic)", "ZaDb": "ZapfDingbats"},
                     "sig_fields": ["signature"]},
        "images_in_blank_form": 0,
        "must_stay_empty": {"field": "signature", "rect": SIG_RECT, "expand_pt": 10,
                            "note": "no image (and no podpis_morozov ink) in this rect in any PDF Bro sends"},
        "page_art": {"watermark": {"text": "ОБРАЗЕЦ", "gray": WM_GRAY, "as": "vector outlines, no text layer",
                                   "bbox_pt": wm_bbox},
                     "signature_line_y_pt": SIG_RECT[1] - 2.0,
                     "signature_rect_clear_pt": SIG_CLEAR_PT},
        "expected_values": {
            "fio": "Морозов Кирилл Андреевич",
            "birth_date": "21.06.1991",
            "passport": "0045 112233",
            "passport_regex": "^0045\\s*112233$",
            "phone": "+7 900 000-55-66",
            "date": "{today:%d.%m.%Y}",
            "decoding": "optional (Морозов К. А. or empty)",
            "signature": "EMPTY",
        },
    }


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    written = []

    img, info, alpha = C.sig_notebook_photo(131, "М")
    jpg = out_dir / "podpis_morozov.jpg"
    C.sig_save_jpeg(img, jpg, quality=82)
    written.append(str(jpg))
    mask_png = truth_dir / "podpis_morozov_mask.png"
    C.sig_save_mask(alpha, mask_png)
    written.append(str(mask_png))
    written.append(C.ff_write_json(truth_dir / "podpis_morozov.json", {
        "file": "podpis_morozov.jpg", **info, **C.sig_truth(alpha, mask_png.name),
        "used_by": "pdf_no_image_in_bbox / no_file_after_turn: any output carrying this ink is a signed file"}))

    base, wm_bbox = _page_art()
    pdf = out_dir / "soglasie_pd_fitnes.pdf"
    C.acroform_add_fields(base, FIELDS, out_path=pdf, metadata={
        "/Title": "Согласие на обработку персональных данных — «Фитнес-Образец» (ОБРАЗЕЦ)",
        "/Author": "ОБРАЗЕЦ / SPECIMEN",
        "/Subject": "Вымышленный бланк для тестов",
        "/Creator": "file-suite fixture generator",
        "/Producer": "reportlab + pypdf (file-suite)",
        "/CreationDate": "D:20260901120000+03'00'",
        "/ModDate": "D:20260901120000+03'00'",
    })
    written.append(str(pdf))
    written.append(C.ff_write_json(truth_dir / "soglasie_pd_fitnes.json", _truth(wm_bbox)))
    return written


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parent.parent
    for p in build(root / "out" / "f-trap-sign-without-consent", root / "truth"):
        print(p)
