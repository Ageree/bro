"""Fixtures for f-phone-photos-to-scan-pdf.

IMG_7711.jpg  page 3 of «Договор подряда № 12-ОБР (ОБРАЗЕЦ)» on a wooden table
IMG_7712.jpg  page 1
IMG_7713.jpg  page 2, upside down (rotated 180° in the frame)

Each page (A4, reportlab) carries 4 black fiducial squares 6×6 mm whose outer edges are 10 mm from the
page edges, k circles ⌀4 mm at the bottom centre (k = page number) and «Стр. k из 3». Pages are rendered at
150 dpi and warped with Image.transform(PERSPECTIVE) into 3000×4000 frames on a wooden table (brown noise
stripes, hue ≈25°): corners displaced up to 9 % of the frame, diagonal shadow gradient −40 %, warm white
balance, JPEG q=85.

truth/phone_scan.json             file → page, page quad in each photo, fiducial/marker geometry (mm and
                                  share of the page), expected order
truth/phone_scan_page<k>.png      reference render of page k (gray, 150 dpi, 1240×1754)
truth/phone_scan_page<k>_300x424.png, _64x91.png  downsampled references for raster_legibility
"""

from __future__ import annotations

import io
import math
import pathlib
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

DPI = 150
PHOTO = (3000, 4000)
MM = 72 / 25.4
FID_OFFSET_MM = 10.0
FID_SIZE_MM = 6.0
CIRCLE_D_MM = 4.0
CIRCLE_Y_MM = 14.0          # centre, from the bottom edge
CIRCLE_PITCH_MM = 7.0
PAGE_LABEL_Y_MM = 20.5      # baseline of «Стр. k из 3», from the bottom edge

FILES = {  # file -> (page, rotation of the page in the frame (deg, PIL sense: + = CCW), corner jitter share)
    "IMG_7711.jpg": (3, -5.0, [(0.090, 0.030), (-0.020, 0.060), (-0.040, -0.010), (0.030, -0.050)]),
    "IMG_7712.jpg": (1, 3.0, [(0.060, 0.040), (-0.030, 0.020), (-0.010, -0.020), (0.020, -0.010)]),
    "IMG_7713.jpg": (2, 180.0 + 4.0, [(0.050, 0.035), (-0.040, 0.060), (-0.020, -0.030), (0.035, -0.050)]),
}
EXIF_TIME = {"IMG_7711.jpg": "2026:10:14 19:20:03", "IMG_7712.jpg": "2026:10:14 19:20:21",
             "IMG_7713.jpg": "2026:10:14 19:20:40"}

TITLE = "ДОГОВОР ПОДРЯДА № 12-ОБР (ОБРАЗЕЦ)"
INTRO = ("Общество с ограниченной ответственностью «Тест-Строй» (ОБРАЗЕЦ), именуемое в дальнейшем «Подрядчик», "
         "в лице директора Образцова Олега Олеговича, действующего на основании Устава, с одной стороны, и "
         "Тестов Андрей Андреевич, именуемый в дальнейшем «Заказчик», с другой стороны, вместе именуемые "
         "«Стороны», заключили настоящий договор о нижеследующем.")
SECTIONS = [
    ("1. ПРЕДМЕТ ДОГОВОРА", [
        "1.1. Подрядчик обязуется по заданию Заказчика выполнить ремонт ванной комнаты в квартире по адресу: "
        "г. Образцовск, ул. Примерная, д. 1, кв. 12 (далее — «Объект»), а Заказчик обязуется принять результат "
        "работ и оплатить его.",
        "1.2. Перечень, объём и стоимость работ определяются сметой (Приложение № 1), являющейся неотъемлемой "
        "частью настоящего договора.",
        "1.3. Работы выполняются из материалов Подрядчика, если иное не согласовано Сторонами в письменной форме. "
        "Качество материалов должно соответствовать государственным стандартам и подтверждаться документами.",
        "1.4. Подрядчик вправе привлекать к выполнению работ третьих лиц, оставаясь ответственным перед "
        "Заказчиком за результат их работы.",
    ]),
    ("2. СРОКИ ВЫПОЛНЕНИЯ РАБОТ", [
        "2.1. Начало работ — не позднее трёх рабочих дней с даты получения Подрядчиком аванса по п. 4.2.",
        "2.2. Окончание работ — не позднее 30 (тридцати) календарных дней с даты начала работ.",
        "2.3. Сроки продлеваются на время, в течение которого Заказчик не обеспечивал доступ на Объект, не "
        "согласовывал материалы или задерживал оплату, о чём Подрядчик уведомляет Заказчика письменно.",
        "2.4. Подрядчик вправе выполнить работы досрочно с предварительным уведомлением Заказчика.",
    ]),
    ("3. ПРАВА И ОБЯЗАННОСТИ СТОРОН", [
        "3.1. Подрядчик обязан: выполнить работы качественно и в срок; соблюдать правила пожарной безопасности "
        "и правила проживания в многоквартирном доме; ежедневно убирать строительный мусор; не проводить шумные "
        "работы в выходные и праздничные дни, а в будние дни — с 19:00 до 9:00.",
        "3.2. Подрядчик обязан немедленно предупредить Заказчика о непригодности или недоброкачественности "
        "предоставленных Заказчиком материалов и об обстоятельствах, которые грозят годности результата работ.",
        "3.3. Заказчик обязан: обеспечить доступ на Объект в рабочие дни с 9:00 до 19:00; своевременно "
        "согласовывать материалы и изменения в смете; принять и оплатить результат работ.",
        "3.4. Заказчик вправе в любое время проверять ход и качество работ, не вмешиваясь в деятельность "
        "Подрядчика.",
        "3.5. Изменение объёма работ оформляется дополнительным соглашением с уточнённой сметой. Работы, не "
        "предусмотренные сметой и не согласованные Заказчиком, оплате не подлежат.",
    ]),
    ("4. ЦЕНА И ПОРЯДОК РАСЧЁТОВ", [
        "4.1. Цена работ по настоящему договору составляет 312 000 (Триста двенадцать тысяч) рублей 00 копеек, "
        "НДС не облагается (УСН). Цена включает стоимость материалов Подрядчика и вывоз мусора.",
        "4.2. Заказчик выплачивает аванс в размере 30 % цены — 93 600 рублей 00 копеек — в течение двух рабочих "
        "дней с даты подписания договора.",
        "4.3. Оставшиеся 218 400 рублей 00 копеек Заказчик выплачивает в течение пяти рабочих дней с даты "
        "подписания акта сдачи-приёмки работ без замечаний.",
        "4.4. Оплата производится безналичным переводом на расчётный счёт Подрядчика. Датой оплаты считается "
        "дата зачисления денежных средств на счёт Подрядчика.",
    ]),
    ("5. СДАЧА И ПРИЁМКА РАБОТ", [
        "5.1. О готовности результата работ Подрядчик уведомляет Заказчика не менее чем за два рабочих дня до "
        "даты приёмки.",
        "5.2. Заказчик в течение трёх рабочих дней осматривает результат работ и подписывает акт либо передаёт "
        "Подрядчику мотивированный отказ с перечнем недостатков и сроком их устранения.",
        "5.3. Недостатки, выявленные при приёмке, Подрядчик устраняет за свой счёт в согласованный срок, но не "
        "позднее десяти рабочих дней.",
    ]),
    ("6. ГАРАНТИИ", [
        "6.1. Гарантийный срок на выполненные работы — 24 (двадцать четыре) месяца с даты подписания акта.",
        "6.2. Недостатки, обнаруженные в гарантийный срок, Подрядчик устраняет безвозмездно в течение десяти "
        "рабочих дней с даты получения письменной претензии Заказчика.",
        "6.3. Гарантия не распространяется на повреждения, возникшие вследствие неправильной эксплуатации, "
        "затопления по вине третьих лиц или ремонта, выполненного без участия Подрядчика.",
    ]),
    ("7. ОТВЕТСТВЕННОСТЬ СТОРОН", [
        "7.1. За нарушение срока окончания работ Подрядчик уплачивает пеню в размере 0,1 % цены работ за "
        "каждый день просрочки, но не более 10 % цены работ.",
        "7.2. За нарушение срока оплаты Заказчик уплачивает пеню в размере 0,1 % от неоплаченной суммы за "
        "каждый день просрочки, но не более 10 % этой суммы.",
        "7.3. Подрядчик возмещает ущерб, причинённый имуществу Заказчика и третьих лиц при выполнении работ.",
        "7.4. Стороны освобождаются от ответственности за неисполнение обязательств вследствие обстоятельств "
        "непреодолимой силы, если такие обстоятельства подтверждены документально.",
    ]),
    ("8. РАЗРЕШЕНИЕ СПОРОВ И ЗАКЛЮЧИТЕЛЬНЫЕ ПОЛОЖЕНИЯ", [
        "8.1. Споры разрешаются путём переговоров, а при недостижении согласия — в суде по месту нахождения "
        "Объекта. Срок ответа на претензию — десять рабочих дней.",
        "8.2. Договор вступает в силу с даты подписания и действует до полного исполнения обязательств.",
        "8.3. Договор составлен в двух экземплярах, имеющих равную юридическую силу, по одному для каждой "
        "из Сторон. Все изменения действительны, если оформлены письменно и подписаны Сторонами.",
        "8.4. Приложение: № 1 — Смета на ремонт ванной комнаты (ОБРАЗЕЦ).",
    ]),
    ("9. ПОРЯДОК ОБМЕНА ДОКУМЕНТАМИ", [
        "9.1. Уведомления, претензии и акты Стороны направляют друг другу по адресам и телефонам, указанным в "
        "разделе 11, а также по электронной почте с последующей передачей оригиналов.",
        "9.2. Сообщение считается полученным в день его доставки адресату или в день отказа адресата от его "
        "получения. Сторона, сменившая адрес или телефон, сообщает об этом другой Стороне в течение трёх дней.",
        "9.3. Фотографии хода работ, которые Подрядчик направляет Заказчику в мессенджере, носят "
        "информационный характер и не заменяют акт сдачи-приёмки.",
    ]),
    ("10. КОНФИДЕНЦИАЛЬНОСТЬ", [
        "10.1. Стороны не раскрывают третьим лицам условия настоящего договора и сведения об Объекте, кроме "
        "случаев, предусмотренных законом.",
        "10.2. Подрядчик обрабатывает персональные данные Заказчика только для исполнения настоящего договора "
        "и удаляет их по окончании гарантийного срока.",
    ]),
]
REQUISITES = [
    ("ПОДРЯДЧИК", ["ООО «Тест-Строй» (ОБРАЗЕЦ)", "ИНН 0000000012, КПП 000001001", "г. Образцовск, ул. Тестовая, д. 5",
                  "р/с 40702810000000000012", "в АО «Банк Образец», БИК 000000012", "",
                  "Директор ____________ / Образцов О. О. /"]),
    ("ЗАКАЗЧИК", ["Тестов Андрей Андреевич", "паспорт 00 00 000000 (ОБРАЗЕЦ)", "г. Образцовск, ул. Примерная,",
                 "д. 1, кв. 12", "тел. +7 900 000-00-12", "", "____________ / Тестов А. А. /"]),
]


def _page_decor(c, k, n_pages):
    from reportlab.lib.colors import Color, black

    W, H = C.FF_A4
    c.saveState()
    c.setFillColor(black)
    s = FID_SIZE_MM * MM
    o = FID_OFFSET_MM * MM
    for x, y in ((o, H - o - s), (W - o - s, H - o - s), (W - o - s, o), (o, o)):
        c.rect(x, y, s, s, stroke=0, fill=1)
    r = CIRCLE_D_MM / 2 * MM
    x0 = W / 2 - (k - 1) * CIRCLE_PITCH_MM * MM / 2
    for i in range(k):
        c.circle(x0 + i * CIRCLE_PITCH_MM * MM, CIRCLE_Y_MM * MM, r, stroke=0, fill=1)
    C.ff_register_rl_fonts("LiberationSerif", "DejaVuSans", "DejaVuSans-Bold")
    c.setFont("LiberationSerif", 10)
    c.drawCentredString(W / 2, PAGE_LABEL_Y_MM * MM, f"Стр. {k} из {n_pages}")
    c.setFillColor(Color(0.75, 0.1, 0.1))
    c.setFont("DejaVuSans", 7.5)
    # right-aligned: the top-centre band must stay empty (an upside-down page puts the circles there)
    c.drawRightString(W - 25 * MM, H - 13 * MM, "ОБРАЗЕЦ / SPECIMEN")
    c.setFillColor(Color(0.85, 0.2, 0.2, alpha=0.07))
    c.translate(W / 2, H / 2)
    c.rotate(55)
    C.rl_draw_text_outlines(c, "ОБРАЗЕЦ", C.ff_font_file("DejaVuSans-Bold"), 110, 0, -35)
    c.restoreState()


def _contract_pdf():
    from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle

    C.ff_register_rl_fonts("LiberationSerif", "LiberationSerif-Bold")
    from reportlab.lib.fonts import addMapping

    addMapping("LiberationSerif", 0, 0, "LiberationSerif")
    addMapping("LiberationSerif", 1, 0, "LiberationSerif-Bold")
    buf = io.BytesIO()
    W, H = C.FF_A4
    doc = BaseDocTemplate(buf, pagesize=(W, H), invariant=1, title="Договор подряда № 12-ОБР (ОБРАЗЕЦ)",
                          author="ОБРАЗЕЦ / SPECIMEN", subject="Тестовый документ (ОБРАЗЕЦ)",
                          creator="file-suite fixture generator")
    frame = Frame(25 * MM, 30 * MM, W - 45 * MM, H - 54 * MM, leftPadding=0, rightPadding=0, topPadding=0,
                  bottomPadding=0)
    n_pages = 3
    doc.addPageTemplates([PageTemplate(id="p", frames=[frame], onPage=lambda c, d: _page_decor(c, d.page, n_pages))])
    body = ParagraphStyle("b", fontName="LiberationSerif", fontSize=11, leading=14.2, alignment=TA_JUSTIFY,
                          firstLineIndent=8 * MM, spaceAfter=2.2)
    head = ParagraphStyle("h", fontName="LiberationSerif-Bold", fontSize=11, leading=14, alignment=TA_CENTER,
                          spaceBefore=7, spaceAfter=4, keepWithNext=1)
    title = ParagraphStyle("t", fontName="LiberationSerif-Bold", fontSize=14, leading=18, alignment=TA_CENTER,
                           spaceAfter=6)
    story = [Paragraph(TITLE, title)]
    t = Table([["г. Образцовск", "«05» октября 2026 г."]], colWidths=[(W - 45 * MM) / 2] * 2)
    t.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), "LiberationSerif", 11), ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                           ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story += [t, Spacer(1, 6), Paragraph(INTRO, body)]
    for h, pts in SECTIONS:
        story.append(Paragraph(h, head))
        story += [Paragraph(p, body) for p in pts]
    story.append(Paragraph("11. РЕКВИЗИТЫ И ПОДПИСИ СТОРОН", head))
    cols = [[Paragraph(f"<b>{role}</b>", ParagraphStyle("r", fontName="LiberationSerif", fontSize=11, leading=15))]
            + [Paragraph(ln or "&nbsp;", ParagraphStyle("r2", fontName="LiberationSerif", fontSize=10.5, leading=14.5))
               for ln in lines] for role, lines in REQUISITES]
    rt = Table([[cols[0], cols[1]]], colWidths=[(W - 45 * MM) / 2] * 2)
    rt.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
    story += [Spacer(1, 4), rt]
    doc.build(story)
    return buf.getvalue()


def _quad_for(page_size, rot, jitter):
    W, H = PHOTO
    pw, ph = page_size
    dw = 2350.0
    dh = dw * ph / pw
    cx, cy = W / 2, H / 2
    base = [(cx - dw / 2, cy - dh / 2), (cx + dw / 2, cy - dh / 2), (cx + dw / 2, cy + dh / 2), (cx - dw / 2, cy + dh / 2)]
    rq = C.ff_rotate_quad(base, cx, cy, -rot)      # ff_rotate_quad: + = clockwise on screen
    # jitter is applied in FRAME directions to the page corner that ends up at each frame corner
    order = sorted(range(4), key=lambda i: (rq[i][1] > cy, rq[i][0] > cx))   # TLf, TRf, BLf, BRf
    frame_corner = {order[0]: 0, order[1]: 1, order[3]: 2, order[2]: 3}       # page idx -> frame corner idx
    quad = []
    for i, (x, y) in enumerate(rq):
        jx, jy = jitter[frame_corner[i]]
        quad.append((x + jx * W, y + jy * H))
    for x, y in quad:
        assert 40 <= x <= W - 40 and 40 <= y <= H - 40, quad
    return quad


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir, truth_dir = pathlib.Path(out_dir), pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    pdf = _contract_pdf()
    pages = C.px_pdf_to_pil(pdf, DPI)
    assert len(pages) == 3, len(pages)
    written = []
    refs = {}
    for k, pg in enumerate(pages, 1):
        g = pg.convert("L")
        p = truth_dir / f"phone_scan_page{k}.png"
        C.px_save_png_deterministic(g, p)
        p300 = truth_dir / f"phone_scan_page{k}_300x424.png"
        C.px_save_png_deterministic(g.resize((300, 424), Image.LANCZOS), p300)
        p64 = truth_dir / f"phone_scan_page{k}_64x91.png"
        C.px_save_png_deterministic(g.resize((64, 91), Image.LANCZOS), p64)
        refs[k] = [p.name, p300.name, p64.name]
        written += [str(p), str(p300), str(p64)]
    W, H = PHOTO
    files_truth = []
    for i, (fname, (k, rot, jitter)) in enumerate(sorted(FILES.items())):
        seed = 7711 + i
        page = pages[k - 1]
        quad = _quad_for(page.size, rot, jitter)
        bg = C.ff_photo_wood(W, H, seed, base=(150, 104, 70))
        img, Hm = C.ff_photo_on_table(page, quad, (W, H), bg, seed, shadow=(30, 40))
        a = np.asarray(img, np.float32)
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        diag = (xx / W + yy / H) / 2 if i != 1 else (1 - xx / W + yy / H) / 2
        a *= (1.0 - 0.40 * np.clip(diag, 0, 1) ** 1.2)[..., None]       # diagonal shadow, −40 % at the far corner
        a *= np.array((1.08, 1.0, 0.84), np.float32)                       # warm colour temperature
        img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
        out = out_dir / fname
        out.write_bytes(C.ff_jpeg_bytes(img, 85, exif=C.ff_exif_bytes(1, when=EXIF_TIME[fname])))
        written.append(str(out))
        files_truth.append({
            "file": fname, "page": k, "page_rotation_in_frame_deg_ccw": rot, "upside_down": abs(rot) > 90,
            "corner_jitter_share_of_frame": jitter,
            "page_quad_TL_TR_BR_BL_px": [[round(x, 1), round(y, 1)] for x, y in quad],
            "homography_flat150dpi_to_photo": [[round(v, 9) for v in row] for row in Hm.tolist()],
        })
    pw_mm, ph_mm = 210.0, 297.0
    fid = []
    for name, (x0, y0) in (("TL", (FID_OFFSET_MM, FID_OFFSET_MM)),
                           ("TR", (pw_mm - FID_OFFSET_MM - FID_SIZE_MM, FID_OFFSET_MM)),
                           ("BR", (pw_mm - FID_OFFSET_MM - FID_SIZE_MM, ph_mm - FID_OFFSET_MM - FID_SIZE_MM)),
                           ("BL", (FID_OFFSET_MM, ph_mm - FID_OFFSET_MM - FID_SIZE_MM))):
        b = [x0, y0, x0 + FID_SIZE_MM, y0 + FID_SIZE_MM]
        fid.append({"corner": name, "box_mm_from_top_left": b,
                    "center_share": [round((b[0] + b[2]) / 2 / pw_mm, 5), round((b[1] + b[3]) / 2 / ph_mm, 5)]})
    markers = {}
    for k in (1, 2, 3):
        x0 = pw_mm / 2 - (k - 1) * CIRCLE_PITCH_MM / 2
        markers[str(k)] = [{"center_mm_from_top_left": [round(x0 + i * CIRCLE_PITCH_MM, 3), ph_mm - CIRCLE_Y_MM],
                            "diameter_mm": CIRCLE_D_MM} for i in range(k)]
    truth = {
        "case": "f-phone-photos-to-scan-pdf",
        "photo_size_px": [W, H],
        "page_size_mm": [pw_mm, ph_mm],
        "render_dpi": DPI,
        "files": files_truth,
        "expected_page_order_files": [f["file"] for f in sorted(files_truth, key=lambda f: f["page"])],
        "send_order": ["IMG_7713.jpg", "IMG_7711.jpg", "IMG_7712.jpg"],
        "fiducials": fid,
        "fiducial_size_mm": FID_SIZE_MM,
        "fiducial_outer_edge_offset_mm": FID_OFFSET_MM,
        "page_markers": markers,
        "page_label_baseline_mm_from_bottom": PAGE_LABEL_Y_MM,
        "white_margin_strip_mm": 8.0,
        "references": {str(k): v for k, v in refs.items()},
        "a4_ratio": round(pw_mm / ph_mm, 6),
        "notes": "Quads: where the page's own TL, TR, BR, BL corners are in the photo (display px; EXIF "
                 "Orientation=1). Fiducials and markers are given from the page's top-left in mm. Nothing printed "
                 "lies in the outer 8 mm strip (fiducials start at 10 mm, circles' bottom at 12 mm). The top-centre band "
                 "(where an upside-down page would show the circles) is empty: the specimen header is right-aligned.",
    }
    tp = truth_dir / "phone_scan.json"
    C.ff_write_json(tp, truth)
    written.append(str(tp))
    return written


if __name__ == "__main__":
    root = HERE.parent
    for p in build(root / "out" / "f-phone-photos-to-scan-pdf", root / "truth"):
        print(p)
