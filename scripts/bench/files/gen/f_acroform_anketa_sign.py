"""Fixtures for f-acroform-anketa-sign.

anketa_sekciya.pdf — 2-page AcroForm (reportlab page art + pypdf widgets) whose
/DR holds only Helvetica (WinAnsi), so naive appearance regeneration cannot show
Cyrillic. podpis_smirnova.jpg — signature photo on squared notebook paper
(SIG_RECIPE, seed=101, letter «С»).

truth/anketa_sekciya.json      field rects, radio/checkbox states, clean zones
truth/podpis_smirnova.json     ink bbox / aspect / mirror hints
truth/podpis_smirnova_mask.png ground-truth ink coverage (8-bit, 3000×1600)
"""

from __future__ import annotations

import io
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import common as C  # noqa: E402

PAGE_W, PAGE_H = C.FF_A4
TINT = (0.93, 0.95, 1.0)          # light field background, L≈241 (not "paper" for raster checks)
WM_GRAY = 0.90                    # 10 % gray watermark

FIELDS = [
    # page 1 — parent
    dict(name="parent_fio", page=1, type="text", rect=[170, 700, 545, 718], tooltip="ФИО родителя (законного представителя)"),
    dict(name="parent_birth_date", page=1, type="text", rect=[170, 676, 270, 694], tooltip="Дата рождения родителя"),
    dict(name="parent_passport", page=1, type="comb", rect=[170, 652, 330, 670], maxlen=10, fontsize=11,
         tooltip="Паспорт: серия и номер, 10 цифр"),
    dict(name="parent_phone", page=1, type="text", rect=[170, 628, 330, 646], tooltip="Телефон"),
    dict(name="parent_email", page=1, type="text", rect=[370, 628, 545, 646], tooltip="Электронная почта"),
    dict(name="address", page=1, type="text", rect=[170, 604, 545, 622], tooltip="Адрес проживания"),
    # page 1 — child
    dict(name="child_fio", page=1, type="text", rect=[170, 556, 545, 574], tooltip="ФИО ребёнка"),
    dict(name="child_birth_date", page=1, type="text", rect=[170, 532, 270, 550], tooltip="Дата рождения ребёнка"),
    dict(name="child_gender", page=1, type="radio", options={"/M": [180, 508, 192, 520], "/F": [240, 508, 252, 520]},
         tooltip="Пол ребёнка"),
    dict(name="school", page=1, type="text", rect=[170, 484, 545, 502], tooltip="Школа"),
    dict(name="pay_method", page=1, type="radio",
         options={"/cash": [180, 460, 192, 472], "/card": [260, 460, 272, 472], "/transfer": [340, 460, 352, 472]},
         tooltip="Способ оплаты"),
    dict(name="chk_pd_consent", page=1, type="checkbox", rect=[60, 400, 72, 412], on="/Yes",
         tooltip="Согласие на обработку персональных данных"),
    dict(name="chk_med", page=1, type="checkbox", rect=[60, 376, 72, 388], on="/Yes",
         tooltip="Медицинская справка прилагается"),
    dict(name="chk_photo", page=1, type="checkbox", rect=[60, 352, 72, 364], on="/Yes",
         tooltip="Согласие на фото- и видеосъёмку"),
    dict(name="fill_date", page=1, type="text", rect=[120, 300, 220, 318], tooltip="Дата заполнения"),
    dict(name="signature", page=1, type="sig", rect=[300, 296, 430, 330], tooltip="Подпись"),
    dict(name="sign_decoding", page=1, type="text", rect=[440, 300, 560, 318], tooltip="Расшифровка подписи"),
    # page 2
    dict(name="fill_date_2", page=2, type="text", rect=[120, 200, 220, 218], tooltip="Дата"),
    dict(name="signature_2", page=2, type="sig", rect=[300, 196, 430, 230], tooltip="Подпись"),
    dict(name="sign_decoding_2", page=2, type="text", rect=[440, 200, 560, 218], tooltip="Расшифровка подписи"),
]

CONSENT_TEXT = (
    "Я, родитель (законный представитель) ребёнка, сведения о котором указаны на странице 1 настоящего "
    "заявления-анкеты, в соответствии со статьёй 9 Федерального закона от 27.07.2006 № 152-ФЗ "
    "«О персональных данных» даю согласие спортивной секции «Образец» (вымышленная организация, "
    "г. Москва, ул. Примерная, д. 0) на обработку моих персональных данных и персональных данных моего "
    "ребёнка: фамилия, имя, отчество; дата рождения; паспортные данные; адрес проживания; номер телефона; "
    "адрес электронной почты; сведения об образовательной организации; сведения о состоянии здоровья в "
    "объёме медицинской справки о допуске к занятиям. Цель обработки: зачисление ребёнка в секцию, ведение "
    "журнала посещаемости, расчёты за занятия, информирование об изменениях расписания и о соревнованиях. "
    "Перечень действий: сбор, запись, систематизация, накопление, хранение, уточнение (обновление, изменение), "
    "извлечение, использование, обезличивание, блокирование, удаление и уничтожение персональных данных, "
    "с использованием средств автоматизации и без них. Передача персональных данных третьим лицам не "
    "допускается, за исключением случаев, предусмотренных законодательством Российской Федерации. "
    "Согласие на фото- и видеосъёмку даётся отдельно на странице 1 и в настоящее согласие не входит. "
    "Согласие действует с даты подписания до окончания обучения ребёнка в секции и в течение одного года "
    "после него. Согласие может быть отозвано письменным заявлением, переданным администратору секции. "
    "Мне разъяснено, что при отзыве согласия секция вправе продолжить обработку персональных данных при "
    "наличии оснований, указанных в законе. С правилами секции и положением о защите персональных данных "
    "ознакомлен(а)."
)

# Rects that must stay free of any page art so that raster/ink checks measure only the answer.
SIG_RECTS = {1: [300, 296, 430, 330], 2: [300, 196, 430, 230]}
SIG_CLEAR_PT = 12   # the pdf_image_in_bbox check expands the rect by 12 pt


def _rot_text_bbox(cx, cy, w, h, angle_deg):
    a = math.radians(angle_deg)
    hw = abs(w / 2 * math.cos(a)) + abs(h / 2 * math.sin(a))
    hh = abs(w / 2 * math.sin(a)) + abs(h / 2 * math.cos(a))
    return [cx - hw, cy - hh, cx + hw, cy + hh]


def _intersects(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _expand(r, d):
    return [r[0] - d, r[1] - d, r[2] + d, r[3] + d]


def _watermark(c, cx, cy, protected):
    from reportlab.pdfbase.pdfmetrics import stringWidth

    size, angle, text = 84, 20, "ОБРАЗЕЦ"
    w = stringWidth(text, "DejaVuSans-Bold", size)
    # glyph box of DejaVu Bold caps: ~0.73 em high above baseline
    h = size * 0.73
    bbox = _rot_text_bbox(cx, cy, w, h, angle)
    for r in protected:
        assert not _intersects(bbox, r), (bbox, r)
    c.saveState()
    c.setFillGray(WM_GRAY)
    c.translate(cx, cy)
    c.rotate(angle)
    # outlines, not text: the watermark must not show up in text-in-rect extraction of the answer
    C.rl_draw_text_outlines(c, text, C.ff_font_file("DejaVuSans-Bold"), size, 0, -h / 2)
    c.restoreState()
    return [round(v, 1) for v in bbox]


def _stamp(c, page_no, total):
    c.saveState()
    c.setStrokeColorRGB(0.78, 0.12, 0.12)
    c.setFillColorRGB(0.78, 0.12, 0.12)
    c.setLineWidth(1.2)
    c.rect(418, 801, 140, 22, stroke=1, fill=0)
    c.setFont("DejaVuSans-Bold", 10)
    c.drawCentredString(488, 808.5, "ОБРАЗЕЦ / SPECIMEN")
    c.restoreState()
    c.setFont("DejaVuSans", 7)
    c.setFillGray(0.35)
    c.drawString(60, 812, "Спортивная секция «Образец» · вымышленная организация")
    c.drawString(60, 40, "Бланк вымышленный, создан для тестов. Все данные — ОБРАЗЕЦ / SPECIMEN.")
    c.drawRightString(535, 40, f"стр. {page_no} из {total}")
    c.setFillGray(0)


def _text_field_art(c, r):
    c.setFillColorRGB(*TINT)
    c.rect(r[0], r[1], r[2] - r[0], r[3] - r[1], stroke=0, fill=1)
    c.setFillGray(0)


def _comb_art(c, r, n):
    _text_field_art(c, r)
    c.setStrokeGray(0.62)
    c.setLineWidth(0.5)
    c.rect(r[0], r[1], r[2] - r[0], r[3] - r[1], stroke=1, fill=0)
    step = (r[2] - r[0]) / n
    for i in range(1, n):
        x = r[0] + i * step
        c.line(x, r[1], x, r[3])
    c.setStrokeGray(0)


def _checkbox_art(c, r):
    c.setLineWidth(0.7)
    c.setStrokeGray(0)
    c.rect(r[0], r[1], r[2] - r[0], r[3] - r[1], stroke=1, fill=0)


def _radio_art(c, r):
    c.setLineWidth(0.7)
    c.setStrokeGray(0)
    cx, cy = (r[0] + r[2]) / 2, (r[1] + r[3]) / 2
    c.circle(cx, cy, min(r[2] - r[0], r[3] - r[1]) / 2 - 0.4, stroke=1, fill=0)


def _label(c, x, y, text, size=8.5, bold=False, gray=0.0):
    c.setFont("DejaVuSans-Bold" if bold else "DejaVuSans", size)
    c.setFillGray(gray)
    c.drawString(x, y, text)
    c.setFillGray(0)


def _signature_block(c, sig_rect, date_rect, dec_rect, date_label):
    y_line = sig_rect[1] - 2.0                       # just below the field rect
    _label(c, 60, date_rect[1] + 5, date_label)
    _text_field_art(c, date_rect)
    _label(c, (date_rect[0] + date_rect[2]) / 2 - 20, date_rect[1] - 9, "(дд.мм.гггг)", size=6.5, gray=0.4)
    _label(c, 252, sig_rect[1] + 3, "Подпись")
    c.setLineWidth(0.6)
    c.line(sig_rect[0], y_line, sig_rect[2], y_line)
    c.setFont("DejaVuSans", 6.5)
    c.setFillGray(0.4)
    c.drawCentredString((sig_rect[0] + sig_rect[2]) / 2, y_line - 9, "(подпись)")
    c.drawCentredString((dec_rect[0] + dec_rect[2]) / 2, dec_rect[1] - 9, "(расшифровка)")
    c.setFillGray(0)
    _text_field_art(c, dec_rect)
    return y_line


def _page_art() -> tuple[bytes, dict]:
    from reportlab.lib.enums import TA_JUSTIFY
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Frame, Paragraph

    C.ff_register_rl_fonts("DejaVuSans", "DejaVuSans-Bold")
    buf = io.BytesIO()
    c = C.ff_rl_canvas(buf, title="Заявление-анкета в спортивную секцию «Образец» (ОБРАЗЕЦ)",
                       subject="Вымышленный бланк для тестов (ОБРАЗЕЦ / SPECIMEN)")
    f = {x["name"]: x for x in FIELDS}
    marks = [x["rect"] for x in FIELDS if x["type"] == "checkbox"]
    marks += [r for x in FIELDS if x["type"] == "radio" for r in x["options"].values()]
    art: dict = {"watermark_bbox_pt": {}, "signature_line_y_pt": {}}

    # ------------------------------------------------------------------ page 1
    _stamp(c, 1, 2)
    protected1 = [_expand(SIG_RECTS[1], SIG_CLEAR_PT)] + [_expand(r, 3) for r in marks]
    art["watermark_bbox_pt"]["1"] = _watermark(c, 330, 662, protected1)
    c.setFont("DejaVuSans-Bold", 13)
    c.drawCentredString(PAGE_W / 2, 781, "ЗАЯВЛЕНИЕ-АНКЕТА")
    c.setFont("DejaVuSans", 10.5)
    c.drawCentredString(PAGE_W / 2, 765, "на зачисление в спортивную секцию «Образец» (ОБРАЗЕЦ)")
    c.setFont("DejaVuSans", 8)
    c.setFillGray(0.3)
    c.drawCentredString(PAGE_W / 2, 752, "Заполняется родителем (законным представителем) печатными буквами или на компьютере")
    c.setFillGray(0)

    _label(c, 60, 727, "1. Сведения о родителе (законном представителе)", size=9.5, bold=True)
    rows = [("parent_fio", "Фамилия, имя, отчество"), ("parent_birth_date", "Дата рождения"),
            ("parent_passport", "Паспорт (серия, №)"), ("parent_phone", "Телефон"),
            ("address", "Адрес проживания")]
    for name, text in rows:
        r = f[name]["rect"]
        _label(c, 60, r[1] + 5, text, size=8)
        if f[name]["type"] == "comb":
            _comb_art(c, r, f[name]["maxlen"])
        else:
            _text_field_art(c, r)
    _label(c, 336, f["parent_passport"]["rect"][1] + 5, "10 цифр, без пробелов", size=7, gray=0.45)
    _label(c, 280, f["parent_birth_date"]["rect"][1] + 5, "дд.мм.гггг", size=7, gray=0.45)
    r = f["parent_email"]["rect"]
    _label(c, 337, r[1] + 5, "E-mail", size=8)
    _text_field_art(c, r)

    _label(c, 60, 583, "2. Сведения о ребёнке", size=9.5, bold=True)
    for name, text in [("child_fio", "Фамилия, имя, отчество"), ("child_birth_date", "Дата рождения"),
                       ("school", "Школа")]:
        r = f[name]["rect"]
        _label(c, 60, r[1] + 5, text, size=8)
        _text_field_art(c, r)
    _label(c, 280, f["child_birth_date"]["rect"][1] + 5, "дд.мм.гггг", size=7, gray=0.45)
    _label(c, 60, 511, "Пол", size=8)
    for state, text in [("/M", "мужской"), ("/F", "женский")]:
        r = f["child_gender"]["options"][state]
        _radio_art(c, r)
        _label(c, r[2] + 5, r[1] + 2.5, text, size=8.5)
    _label(c, 60, 463, "Способ оплаты", size=8)
    for state, text in [("/cash", "наличными"), ("/card", "картой"), ("/transfer", "переводом по счёту")]:
        r = f["pay_method"]["options"][state]
        _radio_art(c, r)
        _label(c, r[2] + 5, r[1] + 2.5, text, size=8.5)

    _label(c, 60, 428, "3. Согласия и документы (отметьте нужное)", size=9.5, bold=True)
    for name, text in [
        ("chk_pd_consent", "Даю согласие на обработку персональных данных (текст согласия — на стр. 2)"),
        ("chk_med", "Медицинская справка о допуске к занятиям прилагается"),
        ("chk_photo", "Согласен(на) на фото- и видеосъёмку ребёнка на занятиях и соревнованиях"),
    ]:
        r = f[name]["rect"]
        _checkbox_art(c, r)
        _label(c, 80, r[1] + 2.5, text, size=8.5)
    art["signature_line_y_pt"]["1"] = _signature_block(
        c, f["signature"]["rect"], f["fill_date"]["rect"], f["sign_decoding"]["rect"], "Дата")
    c.setFont("DejaVuSans", 7.5)
    c.setFillGray(0.3)
    c.drawString(60, 250, "Заполненное заявление-анкету передайте тренеру вместе с медицинской справкой.")
    c.drawString(60, 240, "Без подписи родителя (законного представителя) заявление не рассматривается.")
    c.setFillGray(0)
    c.showPage()

    # ------------------------------------------------------------------ page 2
    _stamp(c, 2, 2)
    protected2 = [_expand(SIG_RECTS[2], SIG_CLEAR_PT)]
    c.setFont("DejaVuSans-Bold", 12)
    c.drawCentredString(PAGE_W / 2, 781, "СОГЛАСИЕ НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ")
    c.setFont("DejaVuSans", 9)
    c.drawCentredString(PAGE_W / 2, 766, "(приложение к заявлению-анкете, ОБРАЗЕЦ)")
    art["watermark_bbox_pt"]["2"] = _watermark(c, 300, 560, protected2)
    style = ParagraphStyle("body", fontName="DejaVuSans", fontSize=9.5, leading=13.6, alignment=TA_JUSTIFY,
                           firstLineIndent=18)
    frame = Frame(60, 300, PAGE_W - 120, 450, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
                  showBoundary=0)
    story = [Paragraph(CONSENT_TEXT, style)]
    frame.addFromList(story, c)
    assert not story, "consent text does not fit"
    art["signature_line_y_pt"]["2"] = _signature_block(
        c, f["signature_2"]["rect"], f["fill_date_2"]["rect"], f["sign_decoding_2"]["rect"], "Дата")
    c.showPage()
    c.save()
    return buf.getvalue(), art


def _truth(art: dict) -> dict:
    fields = {}
    for x in FIELDS:
        d = {"page": x["page"], "type": x["type"], "tooltip": x.get("tooltip")}
        if x["type"] == "radio":
            d["options"] = x["options"]
            d["mark_inner_rects"] = {k: _expand(v, -2.5) for k, v in x["options"].items()}
        else:
            d["rect"] = x["rect"]
        if x["type"] == "comb":
            d.update(comb=True, maxlen=x["maxlen"], cell_width_pt=(x["rect"][2] - x["rect"][0]) / x["maxlen"])
        if x["type"] == "checkbox":
            d["on_state"] = x["on"]
            d["mark_inner_rect"] = _expand(x["rect"], -1.5)
        fields[x["name"]] = d
    return {
        "file": "anketa_sekciya.pdf",
        "pages": 2,
        "page_size_pt": [PAGE_W, PAGE_H],
        "coords": "pt, origin bottom-left, rect = [x0, y0, x1, y1]",
        "fields": fields,
        "acroform": {
            "DR_fonts": {"Helv": "Type1 Helvetica, WinAnsiEncoding (no Cyrillic)", "ZaDb": "ZapfDingbats"},
            "DA": "/Helv 10 Tf 0 g (comb: /Helv 11 Tf)",
            "NeedAppearances": "absent (false)",
            "empty_text_appearance": "/Tx BMC EMC",
            "checkbox_on_state": "/Yes; /Off appearance is empty, the box frame is page content",
            "radio_flags": "Radio|NoToggleToOff; dot appearance on the option state, circle is page content",
            "sig_fields": ["signature", "signature_2"],
            "trap": "pypdf update_page_form_field_values() writes /Helv appearances: Cyrillic comes out empty or as "
                    "WinAnsi garbage. A correct answer embeds a Cyrillic font (DejaVu) in the appearances or "
                    "flattens with an overlay.",
        },
        "page_art": {
            "text_field_tint_rgb": list(TINT),
            "checkbox_frame": "0.7 pt black on the rect edge — detect marks inside mark_inner_rect",
            "radio_circle": "0.7 pt black circle inscribed in the option rect — detect marks inside mark_inner_rects",
            "watermark": {"text": "ОБРАЗЕЦ", "gray": WM_GRAY, "angle_deg": 20, "bbox_pt": art["watermark_bbox_pt"]},
            "signature_line_y_pt": art["signature_line_y_pt"],
            "signature_rects_clear_pt": SIG_CLEAR_PT,
            "signature_rects_clear_note": "signature rects expanded by 12 pt contain no page art except the black "
                                          "signature line 2 pt below the rect and its gray caption; nothing is "
                                          "blue, so every 'ink' pixel there comes from the answer",
            "specimen_mark": "red frame «ОБРАЗЕЦ / SPECIMEN» at [418, 801, 558, 823] on both pages",
        },
        "expected_values": {
            "parent_fio": "Смирнова Анна Викторовна",
            "parent_birth_date": "14.03.1988",
            "parent_passport": "0015246813",
            "parent_phone": "+7 900 000-12-34",
            "parent_email": "anna.smirnova@example.com",
            "address": "г. Москва, ул. Примерная, д. 1, кв. 1",
            "child_fio": "Смирнов Лев Андреевич",
            "child_birth_date": "02.09.2016",
            "child_gender": "/M",
            "school": "ГБОУ Школа № 0001 (образец)",
            "pay_method": "/card",
            "chk_pd_consent": "/Yes",
            "chk_med": "/Yes",
            "chk_photo": "/Off",
            "fill_date": "{today:%d.%m.%Y}",
            "fill_date_2": "{today:%d.%m.%Y}",
            "sign_decoding": "Смирнова А. В.",
            "sign_decoding_2": "Смирнова А. В.",
            "signature": "image of podpis_smirnova ink, transparent background",
            "signature_2": "image of podpis_smirnova ink, transparent background",
        },
    }


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    written = []

    base, art = _page_art()
    pdf_path = out_dir / "anketa_sekciya.pdf"
    C.acroform_add_fields(base, FIELDS, out_path=pdf_path, metadata={
        "/Title": "Заявление-анкета в спортивную секцию «Образец» (ОБРАЗЕЦ)",
        "/Author": "ОБРАЗЕЦ / SPECIMEN",
        "/Subject": "Вымышленный бланк для тестов",
        "/Creator": "file-suite fixture generator",
        "/Producer": "reportlab + pypdf (file-suite)",
        "/CreationDate": "D:20260901120000+03'00'",
        "/ModDate": "D:20260901120000+03'00'",
    })
    written.append(str(pdf_path))
    written.append(C.ff_write_json(truth_dir / "anketa_sekciya.json", _truth(art)))

    img, info, alpha = C.sig_notebook_photo(101, "С")
    jpg = out_dir / "podpis_smirnova.jpg"
    C.sig_save_jpeg(img, jpg, quality=82)
    written.append(str(jpg))
    mask_png = truth_dir / "podpis_smirnova_mask.png"
    C.sig_save_mask(alpha, mask_png)
    written.append(str(mask_png))
    t = {"file": "podpis_smirnova.jpg", **info, **C.sig_truth(alpha, mask_png.name),
         "used_by": "signature_shape: aspect of the ink bbox on the page must be within ±15 % of ink_aspect_w_over_h"}
    written.append(C.ff_write_json(truth_dir / "podpis_smirnova.json", t))
    return written


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parent.parent
    for p in build(root / "out" / "f-acroform-anketa-sign", root / "truth"):
        print(p)
