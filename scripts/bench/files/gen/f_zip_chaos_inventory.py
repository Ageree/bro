"""Fixture for f-zip-chaos-inventory: razobrat.zip — a mess from an old Windows computer.

The archive is written «as Windows Explorer does»: entry names in cp866 (OEM code page) with the UTF-8 flag
(general purpose bit 11) cleared, create_system 0 (MS-DOS), DOS attributes (archive; hidden+system for
Thumbs.db / desktop.ini / the Word lock file), Deflate, every entry dated 2024-09-01 12:00:00. A naive reader
(Python zipfile, unzip without -O cp866) shows cp437 mojibake. The nested «старое.zip» is built the same way.

38 files outside the container + the nested archive itself (39 entries counted with it):
  receipts as phone photos (IMG_2391, IMG_2392 + byte duplicate, старое.zip/IMG_0001), text PDF rent contract
  (scan0001.pdf, byte duplicate inside старое.zip), image-only PDF acceptance act (scan0002.pdf), DOCX service
  contract and a claim letter, XLSX card statement (Feb 2024), BIFF8 .xls estimate and Word 97 .doc contract
  (LibreOffice conversions, cached by input hash in cache/zipchaos/), cp1251 and UTF-8 .txt, specimen passport and
  SNILS-like card images, 8 holiday photos with EXIF DateTimeOriginal 2023:07:11…18 (+ «DSC_0004 копия.JPG»),
  a JPEG cut after 2 KB, Thumbs.db / desktop.ini / «~$кумент (3).docx» junk, PDFs (income certificate, e-receipt,
  OSAGO-like policy, hosting invoice), a résumé DOCX, a 5-slide PPTX, a QR PNG and a 3-card VCF.
OOXML core dates are 2024-09-01 like the ZIP mtimes; PDFs have reportlab's invariant date — the date for a new
name comes only from the content or EXIF. Every document and image carries «ОБРАЗЕЦ / SPECIMEN».

truth/zip_manifest.json: one record per entry (path as used by the checks, raw cp866 name bytes, cp437 mojibake,
sha256, size, kind, category, expected folder, date for the name, duplicate_of), the check parameters derived from
it and a self-check of the archive layout.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import math
import pathlib
import random
import shutil
import subprocess
import sys
import tempfile
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import common as C  # noqa: E402

FIXTURE = "razobrat.zip"
ZIP_TIME = (2024, 9, 1, 12, 0, 0)
OOXML_TIME = (2024, 9, 1, 12, 0, 0)
CACHE = HERE.parent / "cache" / "zipchaos"
SEED = 3891
SPEC = "ОБРАЗЕЦ / SPECIMEN"

ATTR_ARCHIVE = 0x20
ATTR_HIDDEN_SYSTEM = 0x20 | 0x02 | 0x04
ATTR_HIDDEN = 0x20 | 0x02


# ============================================================================ ZIP writing (cp866, no UTF-8 flag)

class _Cp866ZipInfo(zipfile.ZipInfo):
    """ZipInfo whose name is stored in cp866 with bit 11 cleared, as the Windows shell writes it."""

    def _encodeFilenameFlags(self):  # noqa: N802 (zipfile API)
        return self.filename.encode("cp866"), self.flag_bits & ~0x800


def _write_zip_cp866(entries):
    """entries: list of (name, bytes, dos_attr). Returns ZIP bytes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data, attr in entries:
            zi = _Cp866ZipInfo(name, date_time=ZIP_TIME)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.create_system = 0
            zi.create_version = 20
            zi.extract_version = 20
            zi.external_attr = attr
            z.writestr(zi, data, compresslevel=6)
    return buf.getvalue()


# ============================================================================ small generic helpers

def _sha(b):
    return hashlib.sha256(b).hexdigest()


def _hash_stream(n, label):
    out, i = b"", 0
    while len(out) < n:
        out += hashlib.sha256(f"zipchaos:{label}:{i}".encode()).digest()
        i += 1
    return out[:n]


def _exif(when, *, make="SpecimenPhone", model="SP-1 (SPECIMEN)", orientation=1):
    ex = Image.Exif()
    ex[0x010F] = make
    ex[0x0110] = model
    ex[0x0112] = orientation
    ex[0x0132] = when
    sub = ex.get_ifd(0x8769)
    sub[0x9003] = when          # DateTimeOriginal
    sub[0x9004] = when          # DateTimeDigitized
    return ex.tobytes()


def _soffice_cached(src_bytes, src_suffix, target, out_suffix):
    """Convert with headless LibreOffice; the result is cached by the input hash so reruns are byte-stable."""
    CACHE.mkdir(parents=True, exist_ok=True)
    key = _sha(src_bytes + target.encode())
    cached = CACHE / f"{key}{out_suffix}"
    if cached.exists():
        return cached.read_bytes()
    with tempfile.TemporaryDirectory() as td:
        td = pathlib.Path(td)
        src = td / f"in{src_suffix}"
        src.write_bytes(src_bytes)
        subprocess.run([C.require_tool("soffice"), f"-env:UserInstallation=file://{td / 'profile'}", "--headless", "--convert-to",
                        target, "--outdir", str(td / "out"), str(src)], check=True, capture_output=True, timeout=300)
        data = (td / "out" / f"in{out_suffix}").read_bytes()
    cached.write_bytes(data)
    return data


def _save_docx(document, when=OOXML_TIME, author="ОБРАЗЕЦ"):
    stamp = dt.datetime(*when)
    cp = document.core_properties
    cp.author = author
    cp.last_modified_by = author
    cp.created = stamp
    cp.modified = stamp
    cp.revision = 3
    with tempfile.TemporaryDirectory() as td:
        p = pathlib.Path(td) / "d.docx"
        document.save(str(p))
        C.ff_zip_fix_timestamps(p, date_time=when)
        return p.read_bytes()


def _docx_base():
    import docx

    d = docx.Document()
    C.od_docx_base_style(d, font="Times New Roman", size_pt=12)
    C.od_docx_specimen_header(d.sections[0], SPEC + " — документ вымышлен")
    return d


def _para(d, text, *, bold=False, align=None, size=None, space_after=6):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    p = d.add_paragraph()
    r = p.add_run(text)
    r.bold = bold
    if size:
        r.font.size = Pt(size)
    if align:
        p.alignment = {"center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT,
                       "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}[align]
    p.paragraph_format.space_after = Pt(space_after)
    return p


# ============================================================================ PDFs (reportlab)

def _pdf_doc(title, story_fn, *, pagesize=C.FF_A4):
    C.ff_register_rl_fonts("DejaVuSans", "DejaVuSans-Bold", "DejaVuSerif", "DejaVuSerif-Bold")
    buf = io.BytesIO()
    c = C.ff_rl_canvas(buf, title=title, pagesize=pagesize)
    story_fn(c)
    c.save()
    return buf.getvalue()


def _spec_mark(c, w, h, *, size=54, alpha=0.12, angle=35):
    c.saveState()
    c.setFillColorRGB(0.8, 0.15, 0.15)
    c.setFillAlpha(alpha)
    c.translate(w / 2, h / 2)
    c.rotate(angle)
    c.setFont("DejaVuSans-Bold", size)
    c.drawCentredString(0, 0, SPEC)
    c.restoreState()
    c.setFont("DejaVuSans", 7.5)
    c.setFillColorRGB(0.45, 0.45, 0.45)
    c.drawCentredString(w / 2, 18, SPEC + " — учебный документ, все данные вымышлены")
    c.setFillColorRGB(0, 0, 0)


def _wrap(text, font, size, width):
    from reportlab.pdfbase.pdfmetrics import stringWidth

    out = []
    for para in text.split("\n"):
        words, cur = para.split(), ""
        for w in words:
            t = (cur + " " + w).strip()
            if stringWidth(t, font, size) <= width:
                cur = t
            else:
                out.append(cur)
                cur = w
        out.append(cur)
    return out


def _write_block(c, x, y, text, *, font="DejaVuSerif", size=10.5, width=480, leading=None):
    leading = leading or size * 1.42
    c.setFont(font, size)
    for ln in _wrap(text, font, size, width):
        c.drawString(x, y, ln)
        y -= leading
    return y


RENT_CLAUSES = [
    ("1. ПРЕДМЕТ ДОГОВОРА", "1.1. Арендодатель передаёт Арендатору во временное владение и пользование для проживания "
     "квартиру по адресу: г. Москва, ул. Примерная, д. 5, кв. 18 (ОБРАЗЕЦ), общей площадью 38,2 кв. м.\n"
     "1.2. Квартира принадлежит Арендодателю на праве собственности (выписка ЕГРН — ОБРАЗЕЦ)."),
    ("2. СРОК АРЕНДЫ", "2.1. Срок аренды — 11 месяцев с 14.03.2024 по 13.02.2025.\n2.2. Квартира передаётся по акту "
     "приёма-передачи, который является неотъемлемой частью договора."),
    ("3. ПЛАТА И ПОРЯДОК РАСЧЁТОВ", "3.1. Арендная плата — 45 000 (сорок пять тысяч) рублей в месяц, вносится до 14 "
     "числа каждого месяца.\n3.2. Обеспечительный платёж — 45 000 рублей, вносится при подписании договора.\n3.3. "
     "Коммунальные платежи по счётчикам оплачивает Арендатор."),
    ("4. ПРАВА И ОБЯЗАННОСТИ СТОРОН", "4.1. Арендатор обязан использовать квартиру по назначению, содержать её в "
     "исправном состоянии, не производить перепланировку и не сдавать квартиру в субаренду.\n4.2. Арендодатель вправе "
     "один раз в месяц осматривать квартиру, предупредив Арендатора за сутки."),
    ("5. ОТВЕТСТВЕННОСТЬ СТОРОН", "5.1. За просрочку арендной платы Арендатор уплачивает пени 0,1 % от суммы за каждый "
     "день просрочки.\n5.2. Ущерб, причинённый имуществу Арендодателя, возмещается Арендатором в полном объёме."),
    ("6. ЗАКЛЮЧИТЕЛЬНЫЕ ПОЛОЖЕНИЯ", "6.1. Договор составлен в двух экземплярах, по одному для каждой из сторон.\n6.2. "
     "Документ является учебным образцом и не порождает прав и обязанностей."),
]


def _rent_contract_pdf():
    w, h = C.FF_A4

    def story(c):
        page = 1
        _spec_mark(c, w, h)
        c.setFont("DejaVuSerif-Bold", 14)
        c.drawCentredString(w / 2, 780, "ДОГОВОР АРЕНДЫ КВАРТИРЫ № 14/03-24")
        c.setFont("DejaVuSerif", 11)
        c.drawString(60, 752, "г. Москва")
        c.drawRightString(w - 60, 752, "14.03.2024")
        y = _write_block(c, 60, 722, "Образцов Олег Олегович (паспорт 00 00 000000, ОБРАЗЕЦ), именуемый в дальнейшем "
                         "«Арендодатель», и Тестова Мария Ивановна (паспорт 00 00 000001, ОБРАЗЕЦ), именуемая в "
                         "дальнейшем «Арендатор», заключили настоящий договор о нижеследующем:")
        y -= 8
        for head, body in RENT_CLAUSES:
            if y < 140:
                c.showPage()
                page += 1
                _spec_mark(c, w, h)
                y = 790
            c.setFont("DejaVuSerif-Bold", 11)
            c.drawString(60, y, head)
            y = _write_block(c, 60, y - 17, body) - 8
        y -= 10
        c.setFont("DejaVuSerif-Bold", 11)
        c.drawString(60, y, "ПОДПИСИ СТОРОН")
        c.setFont("DejaVuSerif", 10.5)
        c.drawString(60, y - 30, "Арендодатель: ____________ / Образцов О. О. /")
        c.drawString(60, y - 55, "Арендатор: ____________ / Тестова М. И. /")

    return _pdf_doc("Договор аренды квартиры № 14/03-24 от 14.03.2024 (ОБРАЗЕЦ)", story)


def _act_scan_pdf():
    """Acceptance act rendered, rasterised and degraded like a 150 dpi grey scan (no text layer)."""
    w, h = C.FF_A4

    def story(c):
        _spec_mark(c, w, h, alpha=0.18)
        c.setFont("DejaVuSerif-Bold", 13)
        c.drawCentredString(w / 2, 770, "АКТ ПРИЁМА-ПЕРЕДАЧИ КВАРТИРЫ")
        c.setFont("DejaVuSerif", 11)
        c.drawCentredString(w / 2, 752, "к договору аренды квартиры № 14/03-24 от 14.03.2024")
        c.drawString(60, 722, "г. Москва")
        c.drawRightString(w - 60, 722, "14 марта 2024 г.")
        y = _write_block(c, 60, 692, "Арендодатель Образцов Олег Олегович передал, а Арендатор Тестова Мария Ивановна "
                         "приняла квартиру по адресу: г. Москва, ул. Примерная, д. 5, кв. 18 (ОБРАЗЕЦ) в состоянии, "
                         "пригодном для проживания. Вместе с квартирой переданы:")
        rows = [("1", "Ключи от входной двери", "2 комплекта"), ("2", "Ключ от почтового ящика", "1 шт."),
                ("3", "Холодильник «Образец»", "1 шт., исправен"), ("4", "Стиральная машина «Тест»", "1 шт., исправна"),
                ("5", "Диван, шкаф, стол, 2 стула", "без повреждений")]
        y -= 10
        c.setLineWidth(0.6)
        for i, (n, a, b) in enumerate([("№", "Наименование", "Количество / состояние")] + rows):
            yy = y - i * 22
            c.rect(60, yy - 6, 475, 22, stroke=1, fill=0)
            c.setFont("DejaVuSerif-Bold" if i == 0 else "DejaVuSerif", 10.5)
            c.drawString(68, yy + 1, n)
            c.drawString(100, yy + 1, a)
            c.drawString(350, yy + 1, b)
        y = y - len(rows) * 22 - 50
        y = _write_block(c, 60, y, "Показания счётчиков на дату передачи: ХВС 00123, ГВС 00087, электроэнергия Т1 "
                         "04512, Т2 01893. Претензий к состоянию квартиры стороны не имеют.")
        c.setFont("DejaVuSerif", 11)
        c.drawString(60, y - 40, "Передал: ____________ / Образцов О. О. /")
        c.drawString(60, y - 70, "Принял: ____________ / Тестова М. И. /")

    clean = _pdf_doc("act", story)
    page = C.px_pdf_to_pil(clean, 150, gray=True)[0]
    rng = np.random.default_rng(SEED + 2)
    img = page.rotate(0.7, resample=Image.BICUBIC, fillcolor=255, expand=False).filter(ImageFilter.GaussianBlur(0.7))
    a = np.asarray(img, np.float32) * 0.93 + 8
    a += C.px_smooth_noise(a.shape, 180, SEED + 3) * 6
    a += rng.normal(0, 4, a.shape).astype(np.float32)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "L")
    jb = C.ff_jpeg_bytes(img, 72, dpi=(150, 150))

    def story2(c):
        C.ff_rl_draw_jpeg(c, jb, 0, 0, w, h)

    return _pdf_doc("scan0002", story2)


def _ndfl_pdf():
    w, h = C.FF_A4

    def story(c):
        _spec_mark(c, w, h)
        c.setFont("DejaVuSans-Bold", 12)
        c.drawCentredString(w / 2, 785, "СПРАВКА О ДОХОДАХ И СУММАХ НАЛОГА ФИЗИЧЕСКОГО ЛИЦА")
        c.drawCentredString(w / 2, 768, "за 2023 год (учебная форма, ОБРАЗЕЦ)")
        c.setFont("DejaVuSans", 9.5)
        rows = [("Налоговый агент", "ООО «Образец-Софт», ИНН 0000000000, КПП 000000000"),
                ("Получатель дохода", "Образцов Олег Олегович, ИНН 000000000000"),
                ("Ставка налога", "13 %"), ("Дата выдачи справки", "15.01.2024")]
        y = 735
        for a, b in rows:
            c.drawString(50, y, a + ":")
            c.drawString(200, y, b)
            y -= 16
        y -= 10
        c.setFont("DejaVuSans-Bold", 10)
        c.drawString(50, y, "Раздел 2. Доходы по месяцам (код дохода 2000)")
        y -= 18
        c.setFont("DejaVuSans", 9.5)
        total = 0
        months = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь",
                  "ноябрь", "декабрь"]
        for i, m in enumerate(months):
            amt = 150000 + (i % 3) * 5000
            total += amt
            c.rect(50, y - 5, 495, 16, stroke=1, fill=0)
            c.drawString(56, y, f"{i + 1:02d}")
            c.drawString(90, y, m + " 2023")
            c.drawString(250, y, "2000")
            c.drawRightString(535, y, f"{amt:,.2f}".replace(",", " ").replace(".", ","))
            y -= 16
        y -= 14
        tax = round(total * 0.13)
        for a, b in [("Общая сумма дохода", total), ("Налоговая база", total), ("Сумма налога исчисленная", tax),
                     ("Сумма налога удержанная", tax)]:
            c.drawString(50, y, a)
            c.drawRightString(535, y, f"{b:,.2f}".replace(",", " ").replace(".", ","))
            y -= 16
        c.drawString(50, y - 30, "Налоговый агент: ____________ / Иванов-Образец И. И. /")

    return _pdf_doc("Справка о доходах за 2023 год (ОБРАЗЕЦ)", story)


def _ozon_receipt_pdf():
    w, h = 226.77, 560.0      # 80 mm wide e-receipt

    def story(c):
        c.setFont("DejaVuSans-Bold", 9)
        c.drawCentredString(w / 2, h - 30, "КАССОВЫЙ ЧЕК / ПРИХОД")
        c.setFont("DejaVuSans", 7.5)
        lines = ["ООО «Образец-Маркетплейс» (ОБРАЗЕЦ)", "ИНН 0000000000", "Интернет-заказ № 0000000-0001",
                 "Дата: 21.01.2024 14:07", "Место расчётов: example.com/specimen", "-" * 40,
                 "Наушники беспроводные  1 x 1 990,00", "Чехол для телефона     1 x   499,00", "-" * 40,
                 "ИТОГО:                    2 489,00", "Безналичными:             2 489,00", "НДС 20 %:                   414,83",
                 "-" * 40, "ФН 0000000000000000  ФД 00000", "ФП 0000000000   СНО: ОСН", "Кассир: Автомат (ОБРАЗЕЦ)"]
        y = h - 52
        for ln in lines:
            c.drawString(14, y, ln)
            y -= 12
        c.saveState()
        c.setFillColorRGB(0.8, 0.15, 0.15)
        c.setFillAlpha(0.25)
        c.translate(w / 2, 170)
        c.rotate(30)
        c.setFont("DejaVuSans-Bold", 22)
        c.drawCentredString(0, 0, "ОБРАЗЕЦ")
        c.drawCentredString(0, -26, "SPECIMEN")
        c.restoreState()

    return _pdf_doc("Кассовый чек 21.01.2024 (ОБРАЗЕЦ)", story, pagesize=(w, h))


def _osago_pdf():
    w, h = C.FF_A4[1], C.FF_A4[0]

    def story(c):
        _spec_mark(c, w, h, size=70)
        c.setFillColorRGB(0.15, 0.35, 0.65)
        c.rect(30, h - 80, w - 60, 50, stroke=0, fill=1)
        c.setFillColorRGB(1, 1, 1)
        c.setFont("DejaVuSans-Bold", 15)
        c.drawString(45, h - 55, "ПОЛИС ОСАГО — учебный образец (ОБРАЗЕЦ / SPECIMEN)")
        c.setFont("DejaVuSans", 9)
        c.drawString(45, h - 70, "АО «Образец-Страхование» · не является страховым полисом")
        c.setFillColorRGB(0, 0, 0)
        rows = [("Номер полиса", "XXX 0000000000 (ОБРАЗЕЦ)"), ("Срок страхования", "с 12.06.2024 по 11.06.2025"),
                ("Страхователь", "Образцов Олег Олегович"), ("Собственник ТС", "Образцов Олег Олегович"),
                ("Транспортное средство", "«Образец-Авто 3», 2019 г. в., VIN 00000000000000000"),
                ("Госномер", "О 000 ОО 00"), ("Лица, допущенные к управлению", "Образцов О. О., ВУ 00 00 000000"),
                ("Страховая премия", "7 845,12 руб."), ("Дата заключения", "11.06.2024")]
        y = h - 115
        for a, b in rows:
            c.rect(40, y - 8, w - 80, 24, stroke=1, fill=0)
            c.setFont("DejaVuSans-Bold", 10)
            c.drawString(50, y, a)
            c.setFont("DejaVuSans", 10)
            c.drawString(300, y, b)
            y -= 24

    return _pdf_doc("Полис ОСАГО 12.06.2024–11.06.2025 (ОБРАЗЕЦ)", story, pagesize=(w, h))


def _invoice_pdf():
    w, h = C.FF_A4

    def story(c):
        _spec_mark(c, w, h)
        c.setFont("DejaVuSans", 9)
        c.drawString(50, 790, "ООО «Хостинг-Образец» (ОБРАЗЕЦ), ИНН 0000000000, КПП 000000000")
        c.drawString(50, 776, "Р/с 40702810000000000000 в АО «Банк Образец», БИК 000000000")
        c.setFont("DejaVuSans-Bold", 14)
        c.drawString(50, 740, "СЧЁТ № 15 от 03.02.2024")
        c.setFont("DejaVuSans", 10)
        c.drawString(50, 715, "Покупатель: Образцов Олег Олегович")
        c.drawString(50, 700, "Основание: договор-оферта на услуги хостинга (ОБРАЗЕЦ)")
        heads = [("№", 50), ("Наименование", 75), ("Кол-во", 330), ("Цена", 390), ("Сумма", 470)]
        y = 670
        c.setFont("DejaVuSans-Bold", 9.5)
        for t, x in heads:
            c.drawString(x, y, t)
        rows = [("1", "Виртуальный хостинг «Старт», 12 мес.", "12", "250,00", "3 000,00"),
                ("2", "Продление домена example.com (ОБРАЗЕЦ)", "1", "600,00", "600,00")]
        c.setFont("DejaVuSans", 9.5)
        for i, r in enumerate(rows):
            yy = y - 18 * (i + 1)
            for (t, x), v in zip(heads, r):
                c.drawString(x, yy, v)
        c.setFont("DejaVuSans-Bold", 10)
        c.drawString(330, y - 70, "Итого: 3 600,00 руб.")
        c.setFont("DejaVuSans", 10)
        c.drawString(330, y - 86, "Без НДС (УСН)")
        c.drawString(50, y - 120, "Всего к оплате: три тысячи шестьсот рублей 00 копеек.")
        c.drawString(50, y - 136, "Оплатить до 10.02.2024.")
        c.drawString(50, y - 180, "Руководитель ____________ / Хостингов Х. Х. /")

    return _pdf_doc("Счёт № 15 от 03.02.2024 (ОБРАЗЕЦ)", story)


def _diploma_pdf():
    w, h = C.FF_A4[1], C.FF_A4[0]

    def story(c):
        c.setStrokeColorRGB(0.55, 0.4, 0.1)
        c.setLineWidth(6)
        c.rect(25, 25, w - 50, h - 50, stroke=1, fill=0)
        c.setLineWidth(1.5)
        c.rect(38, 38, w - 76, h - 76, stroke=1, fill=0)
        _spec_mark(c, w, h, size=64, alpha=0.15, angle=20)
        c.setFillColorRGB(0.2, 0.15, 0.05)
        c.setFont("DejaVuSerif-Bold", 30)
        c.drawCentredString(w / 2, h - 120, "ДИПЛОМ (ОБРАЗЕЦ)")
        c.setFont("DejaVuSerif", 14)
        lines = ["Образцовский государственный университет (вымышленный)",
                 "Настоящий диплом свидетельствует о том, что",
                 "Образцов Олег Олегович",
                 "освоил программу бакалавриата по направлению «Прикладная информатика»",
                 "и успешно прошёл государственную итоговую аттестацию.",
                 "Решением комиссии присвоена квалификация «Бакалавр».",
                 "Регистрационный номер 000000 · Дата выдачи 28.06.2019 · Образцовск, 2019"]
        y = h - 170
        for i, ln in enumerate(lines):
            c.setFont("DejaVuSerif-Bold" if i == 2 else "DejaVuSerif", 18 if i == 2 else 13)
            c.drawCentredString(w / 2, y, ln)
            y -= 34
        c.setFont("DejaVuSerif", 12)
        c.drawString(90, 90, "Ректор ____________ / Ректоров Р. Р. /")

    return _pdf_doc("Диплом 2019 (ОБРАЗЕЦ)", story, pagesize=(w, h))


# ============================================================================ DOCX / DOC / XLSX / XLS / PPTX

def _service_contract_docx():
    d = _docx_base()
    _para(d, "ДОГОВОР ОКАЗАНИЯ УСЛУГ № 7", bold=True, align="center", size=14)
    _para(d, "г. Москва\t\t\t\t\t\t\t«01» сентября 2023 г.")
    body = [
        "Индивидуальный предприниматель Тестов Тимофей Тимурович (ОГРНИП 000000000000000, ОБРАЗЕЦ), именуемый в "
        "дальнейшем «Исполнитель», и Образцов Олег Олегович, именуемый в дальнейшем «Заказчик», заключили настоящий "
        "договор о нижеследующем.",
        "1. Исполнитель обязуется оказать услуги по генеральной уборке квартиры Заказчика по адресу: г. Москва, "
        "ул. Примерная, д. 5, кв. 18 (ОБРАЗЕЦ), а Заказчик обязуется принять и оплатить услуги.",
        "2. Срок оказания услуг — с 01.09.2023 по 30.09.2023, четыре выезда по графику Заказчика.",
        "3. Стоимость услуг — 16 000 (шестнадцать тысяч) рублей, оплата по факту каждого выезда по 4 000 рублей.",
        "4. Приёмка услуг оформляется актом. Претензии по качеству принимаются в течение 3 дней после выезда.",
        "5. Договор составлен в двух экземплярах. Документ является учебным образцом (ОБРАЗЕЦ / SPECIMEN).",
    ]
    for t in body:
        _para(d, t, align="justify")
    _para(d, "Исполнитель: ____________ / Тестов Т. Т. /")
    _para(d, "Заказчик: ____________ / Образцов О. О. /")
    return _save_docx(d)


def _claim_docx():
    d = _docx_base()
    for t in ["ООО «Образец-Мебель» (ОБРАЗЕЦ)", "ИНН 0000000000, г. Москва, ул. Мебельная, д. 3",
              "Исх. № 45 от 10.11.2023"]:
        _para(d, t, space_after=0)
    _para(d, "")
    for t in ["Образцову Олегу Олеговичу", "г. Москва, ул. Примерная, д. 5, кв. 18"]:
        _para(d, t, align="right", space_after=0)
    _para(d, "")
    _para(d, "ПРЕТЕНЗИЯ", bold=True, align="center", size=14)
    _para(d, "о погашении задолженности по договору поставки мебели № 112 от 05.09.2023", align="center")
    for t in [
        "05.09.2023 между ООО «Образец-Мебель» и Вами заключён договор поставки кухонного гарнитура. Обязательства по "
        "поставке и сборке выполнены 20.10.2023, что подтверждается подписанным Вами актом.",
        "Оплата второй части стоимости в размере 38 500 (тридцать восемь тысяч пятьсот) рублей должна была поступить "
        "до 31.10.2023, однако на дату настоящей претензии не поступила.",
        "Просим погасить задолженность в течение 10 календарных дней с даты получения претензии. В противном случае "
        "мы будем вынуждены обратиться в суд с требованием о взыскании долга и неустойки.",
        "Документ является учебным образцом (ОБРАЗЕЦ / SPECIMEN), все данные вымышлены.",
    ]:
        _para(d, t, align="justify")
    _para(d, "Генеральный директор ООО «Образец-Мебель» ____________ / Мебелев М. М. /")
    return _save_docx(d)


def _resume_docx():
    d = _docx_base()
    _para(d, "Образцов Олег Олегович", bold=True, size=16)
    _para(d, "Резюме (ОБРАЗЕЦ / SPECIMEN) · инженер-программист · г. Москва · obrazec@example.com")
    _para(d, "Опыт работы", bold=True, size=13)
    for t in ["2019 — н. в. ООО «Образец-Софт», ведущий инженер: backend-сервисы, базы данных, наставничество.",
              "2016 — 2019 ООО «Тест-Лаб», инженер-программист: внутренние системы учёта.",
              "2015 — 2016 Стажёр, ООО «Пример-Групп»."]:
        _para(d, t)
    _para(d, "Образование", bold=True, size=13)
    _para(d, "2015 — 2019 Образцовский государственный университет (вымышленный), «Прикладная информатика».")
    _para(d, "Навыки", bold=True, size=13)
    _para(d, "Python, SQL, Linux, Git; английский — B2.")
    return _save_docx(d)


def _old_contract_doc():
    d = _docx_base()
    _para(d, "ДОГОВОР ПОДРЯДА № 3", bold=True, align="center", size=14)
    _para(d, "г. Образцовск\t\t\t\t\t\t«12» мая 2018 г.")
    for t in [
        "Образцов Олег Олегович, именуемый в дальнейшем «Заказчик», и Подрядов Пётр Петрович (ОБРАЗЕЦ), именуемый в "
        "дальнейшем «Подрядчик», заключили настоящий договор о нижеследующем.",
        "1. Подрядчик обязуется выполнить работы по замене забора на дачном участке Заказчика (СНТ «Образец», "
        "участок 17), а Заказчик обязуется принять и оплатить работы.",
        "2. Срок выполнения работ — с 14.05.2018 по 31.05.2018.",
        "3. Цена работ — 62 000 (шестьдесят две тысячи) рублей, включая материалы.",
        "4. Документ является учебным образцом (ОБРАЗЕЦ / SPECIMEN).",
    ]:
        _para(d, t, align="justify")
    _para(d, "Заказчик: ____________ / Образцов О. О. /      Подрядчик: ____________ / Подрядов П. П. /")
    docx_bytes = _save_docx(d, when=OOXML_TIME)
    return _soffice_cached(docx_bytes, ".docx", "doc:MS Word 97", ".doc")


def _card_statement_xlsx():
    import openpyxl
    from openpyxl.styles import Font, PatternFill

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Выписка (ОБРАЗЕЦ)"
    ws["A1"] = "Банк «Образец» — выписка по карте **** 0000 за февраль 2024 г. (ОБРАЗЕЦ / SPECIMEN)"
    ws["A1"].font = Font(bold=True, size=12)
    ws["A2"] = "Владелец: Образцов О. О.   Период: 01.02.2024 — 29.02.2024   Валюта: RUB"
    heads = ["Дата операции", "Описание", "Категория", "Сумма, ₽"]
    for i, t in enumerate(heads, 1):
        cell = ws.cell(row=4, column=i, value=t)
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="D9E1F2")
    rnd = random.Random(SEED + 11)
    shops = [("Супермаркет «Образец»", "Продукты"), ("АЗС «Образец»", "Транспорт"), ("Кафе «Тестовое»", "Кафе"),
             ("Аптека «Специмен»", "Здоровье"), ("Перевод от Тестовой М. И.", "Переводы"),
             ("Хостинг-Образец, счёт № 15", "Связь"), ("Кинотеатр «Пример»", "Развлечения")]
    row = 5
    for day in sorted(rnd.sample(range(1, 30), 22)):
        name, cat = shops[rnd.randrange(len(shops))]
        amt = rnd.randrange(150, 6000) + rnd.randrange(0, 100) / 100
        if cat == "Переводы":
            amt = 45000.0
        elif name.startswith("Хостинг"):
            amt = -3600.0
        else:
            amt = -amt
        ws.cell(row=row, column=1, value=dt.datetime(2024, 2, day, 9 + rnd.randrange(12), rnd.randrange(60)))
        ws.cell(row=row, column=1).number_format = "DD.MM.YYYY HH:MM"
        ws.cell(row=row, column=2, value=name)
        ws.cell(row=row, column=3, value=cat)
        ws.cell(row=row, column=4, value=round(amt, 2)).number_format = "#,##0.00"
        row += 1
    ws.cell(row=row + 1, column=2, value="Итого за период").font = Font(bold=True)
    ws.cell(row=row + 1, column=4, value=f"=SUM(D5:D{row - 1})").number_format = "#,##0.00"
    for col, wdt in zip("ABCD", (18, 34, 14, 14)):
        ws.column_dimensions[col].width = wdt
    ws.oddHeader.center.text = SPEC
    wb.properties.creator = "ОБРАЗЕЦ"
    wb.properties.created = dt.datetime(*OOXML_TIME)
    with tempfile.TemporaryDirectory() as td:
        p = pathlib.Path(td) / "f.xlsx"
        wb.save(p)
        C.ooxml_fix_core_dates(p, OOXML_TIME)
        return p.read_bytes()


def _estimate_xls():
    import openpyxl
    from openpyxl.styles import Font

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Смета"
    ws["A1"] = "СМЕТА на ремонт ванной комнаты от 05.05.2024 (ОБРАЗЕЦ / SPECIMEN)"
    ws["A1"].font = Font(bold=True, size=12)
    ws["A2"] = "Объект: г. Москва, ул. Примерная, д. 5, кв. 18 (ОБРАЗЕЦ). Подрядчик: ИП Плиточкин П. П. (ОБРАЗЕЦ)"
    heads = ["№", "Наименование работ и материалов", "Ед.", "Кол-во", "Цена, ₽", "Сумма, ₽"]
    for i, t in enumerate(heads, 1):
        ws.cell(row=4, column=i, value=t).font = Font(bold=True)
    items = [("Демонтаж старой плитки", "м²", 24, 450), ("Гидроизоляция пола", "м²", 4.5, 900),
             ("Укладка плитки на стены", "м²", 19.5, 1800), ("Укладка плитки на пол", "м²", 4.5, 2000),
             ("Установка ванны", "шт.", 1, 6500), ("Установка смесителя", "шт.", 2, 2200),
             ("Плитка керамическая", "м²", 26, 1450), ("Клей плиточный, 25 кг", "меш.", 12, 520),
             ("Затирка, 2 кг", "уп.", 4, 690)]
    for i, (name, unit, q, price) in enumerate(items, 1):
        r = 4 + i
        ws.cell(row=r, column=1, value=i)
        ws.cell(row=r, column=2, value=name)
        ws.cell(row=r, column=3, value=unit)
        ws.cell(row=r, column=4, value=q)
        ws.cell(row=r, column=5, value=price)
        ws.cell(row=r, column=6, value=f"=D{r}*E{r}")
    last = 4 + len(items)
    ws.cell(row=last + 1, column=2, value="ИТОГО").font = Font(bold=True)
    ws.cell(row=last + 1, column=6, value=f"=SUM(F5:F{last})").font = Font(bold=True)
    ws.cell(row=last + 3, column=2, value="Смету составил: ____________ / Плиточкин П. П. /   05.05.2024")
    for col, wdt in zip("ABCDEF", (5, 38, 7, 9, 11, 13)):
        ws.column_dimensions[col].width = wdt
    wb.properties.creator = "ОБРАЗЕЦ"
    wb.properties.created = dt.datetime(*OOXML_TIME)
    with tempfile.TemporaryDirectory() as td:
        p = pathlib.Path(td) / "s.xlsx"
        wb.save(p)
        C.ooxml_fix_core_dates(p, OOXML_TIME)
        xlsx_bytes = p.read_bytes()
    total = sum(q * p for _n, _u, q, p in items)
    return _soffice_cached(xlsx_bytes, ".xlsx", "xls:MS Excel 97", ".xls"), total


def _presentation_pptx():
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Emu, Inches, Pt

    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    slides = [
        ("Итоги 2023", "Отдел разработки ООО «Образец-Софт» (ОБРАЗЕЦ / SPECIMEN)"),
        ("Главное за год", "• Выпустили 4 релиза платформы\n• Время ответа API −35 %\n• Команда выросла с 9 до 14"),
        ("Релизы по кварталам", None),
        ("Что не получилось", "• Перенос мобильного клиента на 2024\n• Два крупных инцидента в мае"),
        ("Планы на 2024", "• Мобильный клиент\n• Отказоустойчивость 99,95 %\n• Новый онбординг"),
    ]
    for i, (title, body) in enumerate(slides):
        layout = prs.slide_layouts[0 if i == 0 else 5]
        s = prs.slides.add_slide(layout)
        s.shapes.title.text = title
        if i == 0:
            s.placeholders[1].text = body
        elif body:
            tb = s.shapes.add_textbox(Inches(1), Inches(1.8), Inches(11), Inches(4.5))
            tb.text_frame.text = body
            for p in tb.text_frame.paragraphs:
                for r in p.runs:
                    r.font.size = Pt(26)
        else:
            cd = CategoryChartData()
            cd.categories = ["I кв.", "II кв.", "III кв.", "IV кв."]
            cd.add_series("Релизы", (1, 1, 0, 2))
            s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1.5), Inches(1.8), Inches(10), Inches(5), cd)
        ft = s.shapes.add_textbox(Inches(0.4), Emu(prs.slide_height - Inches(0.6)), Inches(8), Inches(0.4))
        ft.text_frame.text = SPEC + f" · слайд {i + 1} из 5"
        ft.text_frame.paragraphs[0].runs[0].font.size = Pt(12)
    prs.core_properties.author = "ОБРАЗЕЦ"
    prs.core_properties.last_modified_by = "ОБРАЗЕЦ"  # python-pptx's template names its maintainer here
    prs.core_properties.title = "Итоги 2023 (ОБРАЗЕЦ)"
    prs.core_properties.revision = 2
    with tempfile.TemporaryDirectory() as td:
        p = pathlib.Path(td) / "p.pptx"
        prs.save(p)
        # the chart's embedded workbook (XlsxWriter) carries now() in its core.xml: pin it too
        with zipfile.ZipFile(p) as zin:
            parts = [(i.filename, zin.read(i.filename)) for i in zin.infolist()]
        fixed = []
        for name, data in parts:
            if name.startswith("ppt/embeddings/") and name.endswith(".xlsx"):
                emb = pathlib.Path(td) / "emb.xlsx"
                emb.write_bytes(data)
                C.ooxml_fix_core_dates(emb, OOXML_TIME)
                data = emb.read_bytes()
            fixed.append((name, data))
        with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as zout:
            for name, data in fixed:
                zout.writestr(name, data)
        C.ooxml_fix_core_dates(p, OOXML_TIME)
        return p.read_bytes()


# ============================================================================ images

def _receipt_paper(lines, seed, width=560):
    f = C.ff_pil_font("DejaVuSansMono", 21)
    fb = C.ff_pil_font("DejaVuSansMono-Bold", 23)
    lh = 31
    h = 90 + lh * len(lines) + 120
    img = Image.new("L", (width, h), 246)
    d = ImageDraw.Draw(img)
    y = 50
    for ln in lines:
        bold = ln.startswith("**")
        t = ln.strip("*")
        font = fb if bold else f
        if t.startswith("^"):
            t = t[1:]
            d.text((width / 2, y), t, font=font, fill=38, anchor="ma")
        else:
            d.text((26, y), t, font=font, fill=38)
        y += lh
    # specimen stamp across the receipt
    layer = Image.new("L", (width, 140), 0)
    ImageDraw.Draw(layer).text((width / 2, 70), "ОБРАЗЕЦ", font=C.ff_pil_font("DejaVuSans-Bold", 72), fill=255,
                               anchor="mm")
    layer = layer.rotate(28, expand=False, resample=Image.BICUBIC)
    a = np.asarray(img, np.float32)
    m = np.asarray(layer, np.float32) / 255.0
    top = int(h * 0.42)
    a[top:top + 140] = a[top:top + 140] * (1 - 0.35 * m) + 150 * 0.35 * m
    # thermal fade + torn bottom edge
    rng = np.random.default_rng(seed)
    a += C.px_smooth_noise(a.shape, 60, seed) * 5 + rng.normal(0, 2.0, a.shape)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "L").convert("RGB")
    edge = Image.new("L", img.size, 255)
    ed = ImageDraw.Draw(edge)
    pts = [(0, h)]
    for x in range(0, width + 1, 14):
        pts.append((x, h - 6 - (x * 7919 + seed) % 11))
    pts.append((width, h))
    ed.polygon(pts, fill=0)
    return img, edge


def _receipt_photo(lines, seed, canvas=(1200, 1600), angle=-4.0):
    paper, edge = _receipt_paper(lines, seed)
    pw, ph = paper.size
    W, H = canvas
    scale = min(W * 0.62 / pw, H * 0.86 / ph)
    cx, cy = W / 2 + 20, H / 2
    hw, hh = pw * scale / 2, ph * scale / 2
    quad = [(cx - hw * 0.97, cy - hh), (cx + hw * 1.0, cy - hh * 1.01), (cx + hw * 1.04, cy + hh), (cx - hw * 1.02, cy + hh * 0.99)]
    quad = C.ff_rotate_quad(quad, cx, cy, angle)
    bg = C.ff_photo_wood(W, H, seed + 1)
    doc = Image.new("RGB", paper.size, (0, 0, 0))
    doc.paste(paper, (0, 0))
    img, _Hm = C.ff_photo_on_table(doc, quad, canvas, bg, seed + 2, glare=(W * 0.35, H * 0.3, 260, 200, 0.18))
    # the torn edge: re-warp the edge mask and blend wood back
    coeffs = C.ff_perspective_coeffs([(0, 0), (pw, 0), (pw, ph), (0, ph)], quad)
    em = edge.transform((W, H), Image.PERSPECTIVE, coeffs, resample=Image.BILINEAR, fillcolor=255)
    m = (1 - np.asarray(em, np.float32) / 255.0)[..., None]
    a = np.asarray(img, np.float32) * (1 - m) + bg * m
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")


RECEIPTS = {
    "IMG_2391.jpg": dict(date="14.03.2024", time="18:42", exif="2024:03:14 18:47:12", lines=[
        "**^ООО «Образец-Ритейл»", "^магазин «Продукты у дома»", "^ИНН 0000000000 (ОБРАЗЕЦ)", "^КАССОВЫЙ ЧЕК / ПРИХОД",
        "Чек № 0412      14.03.2024 18:42", "--------------------------------",
        "Молоко 2,5% 1 л", "   2 x 89,90           =179,80", "Хлеб бородинский", "   1 x 54,90            =54,90",
        "Сыр полутвёрдый 0,412 кг", "   1 x 412,30          =412,30", "Яблоки 1,2 кг", "   1 x 215,50          =215,50",
        "Кофе молотый 250 г", "   1 x 372,00          =372,00", "--------------------------------",
        "**ИТОГ              =1 234,50", "Безналичными        =1 234,50", "ФН 0000000000000000 ФД 00412",
        "ФП 0000000000", "^ОБРАЗЕЦ / SPECIMEN", "^Спасибо за покупку!"], total="1 234,50"),
    "IMG_2392.jpg": dict(date="02.04.2024", time="08:15", exif="2024:04:02 08:16:40", lines=[
        "**^АЗС «Образец» № 17", "^ООО «Образец-Топливо»", "^ИНН 0000000000 (ОБРАЗЕЦ)", "^КАССОВЫЙ ЧЕК / ПРИХОД",
        "Чек № 2207      02.04.2024 08:15", "--------------------------------", "АИ-95, колонка 3",
        "   50,000 л x 59,00   =2 950,00", "--------------------------------", "**ИТОГ              =2 950,00",
        "Безналичными        =2 950,00", "НДС 20%               =491,67", "ФН 0000000000000000 ФД 02207",
        "ФП 0000000000", "^ОБРАЗЕЦ / SPECIMEN", "^Счастливого пути!"], total="2 950,00"),
    "IMG_0001.jpg": dict(date="30.06.2019", time="12:05", exif="2019:06:30 12:09:31", lines=[
        "**^Магазин «Образец-Маркет»", "^ИП Маркетов М. М. (ОБРАЗЕЦ)", "^ИНН 000000000000", "^КАССОВЫЙ ЧЕК",
        "Чек № 0088      30.06.2019 12:05", "--------------------------------", "Вода питьевая 1,5 л",
        "   2 x 39,90            =79,80", "Печенье овсяное", "   1 x 112,60          =112,60", "Курица охлаждённая",
        "   1 x 654,00          =654,00", "--------------------------------", "**ИТОГ                =846,40",
        "Наличными             =1000,00", "Сдача                 =153,60", "ФН 0000000000000000 ФД 00088",
        "^ОБРАЗЕЦ / SPECIMEN"], total="846,40"),
}


def _holiday_scene(kind, size, seed):
    W, H = size
    rng = np.random.default_rng(seed)
    yy = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    xx = np.linspace(0, 1, W, dtype=np.float32)[None, :, None]

    def sky(top, bot):
        a = np.empty((H, W, 3), np.float32)
        a[:] = np.array(top, np.float32) * (1 - yy) + np.array(bot, np.float32) * yy
        return a

    a = sky((70, 140, 220), (200, 230, 250))
    Y, X = np.mgrid[0:H, 0:W].astype(np.float32)
    if kind in ("beach", "boat", "sunset", "palms"):
        horizon = int(H * (0.52 if kind != "sunset" else 0.6))
        if kind == "sunset":
            a = sky((250, 120, 70), (255, 210, 150))
            sun = (X - W * 0.5) ** 2 + (Y - H * 0.5) ** 2 < (H * 0.08) ** 2
            a[sun] = (255, 236, 180)
        sea = np.array((30, 110, 170) if kind != "sunset" else (120, 70, 90), np.float32)
        a[horizon:] = sea * (0.8 + 0.25 * (Y[horizon:, :, None] - horizon) / H)
        waves = (np.sin(X[horizon:] / 23.0 + np.sin(Y[horizon:] / 9.0) * 2) > 0.92)
        a[horizon:][waves] += 40
        if kind in ("beach", "palms"):
            sand = int(H * 0.78)
            a[sand:] = (225, 200, 150)
            for k in range(4):
                cx = W * (0.15 + 0.22 * k)
                um = ((X - cx) ** 2 / (W * 0.06) ** 2 + (Y - H * 0.72) ** 2 / (H * 0.04) ** 2 < 1) & (Y < H * 0.72)
                a[um] = [(220, 50, 50), (240, 200, 40), (40, 120, 200), (230, 120, 30)][k]
                a[int(H * 0.72):int(H * 0.85), int(cx) - 3:int(cx) + 3] = (80, 70, 60)
            if kind == "palms":
                for k in range(3):
                    cx = W * (0.2 + 0.3 * k)
                    a[int(H * 0.3):int(H * 0.8), int(cx) - 8:int(cx) + 8] = (110, 80, 50)
                    leaf = ((X - cx) ** 2 / (W * 0.09) ** 2 + (Y - H * 0.3) ** 2 / (H * 0.05) ** 2) < 1
                    a[leaf] = (40, 130, 60)
        if kind == "boat":
            hull = (Y > H * 0.56) & (Y < H * 0.62) & (X > W * 0.38 + (Y - H * 0.56) * 2) & (X < W * 0.66 - (Y - H * 0.56) * 2)
            a[hull] = (240, 240, 240)
            mast = (X > W * 0.515) & (X < W * 0.52) & (Y > H * 0.25) & (Y < H * 0.56)
            a[mast] = (60, 60, 60)
            sail = (Y > H * 0.27) & (Y < H * 0.54) & (X > W * 0.525) & (X < W * 0.525 + (Y - H * 0.27) * 0.8)
            a[sail] = (250, 250, 245)
    elif kind in ("mountains", "lake"):
        for k, (base, col) in enumerate([(0.55, (120, 130, 150)), (0.62, (90, 105, 120))]):
            ridge = H * base - H * 0.18 * np.abs(np.sin(X / (W * (0.11 + 0.05 * k)) + k)) \
                - H * 0.05 * np.sin(X / 37.0 + k)
            m = Y > ridge
            a[m] = col
            snow = m & (Y < ridge + H * 0.035) & (ridge < H * 0.48)
            a[snow] = (245, 245, 250)
        a[int(H * 0.68):] = (60, 120, 70) if kind == "mountains" else (50, 110, 160)
        if kind == "lake":
            a[int(H * 0.85):] = (70, 130, 70)
    elif kind == "oldtown":
        a[int(H * 0.8):] = (150, 140, 130)
        x = 0
        k = 0
        while x < W:
            bw = int(W * (0.10 + 0.06 * ((k * 37) % 5) / 5))
            top = int(H * (0.25 + 0.15 * ((k * 53) % 7) / 7))
            col = [(230, 180, 120), (210, 120, 100), (240, 220, 160), (170, 190, 210), (220, 150, 160)][k % 5]
            a[top:int(H * 0.8), x:x + bw] = col
            for r in range(top + 30, int(H * 0.75), 70):
                for c in range(x + 20, x + bw - 30, 50):
                    a[r:r + 36, c:c + 22] = (60, 70, 90)
            x += bw + 4
            k += 1
    elif kind == "forest":
        a[int(H * 0.6):] = (70, 110, 60)
        for k in range(40):
            cx = rng.uniform(0, W)
            base = rng.uniform(H * 0.55, H)
            hgt = rng.uniform(H * 0.25, H * 0.5)
            tri = (Y < base) & (Y > base - hgt) & (np.abs(X - cx) < (Y - (base - hgt)) * 0.35)
            a[tri] = (25 + rng.uniform(0, 30), 80 + rng.uniform(0, 40), 40)
        path = (Y > H * 0.7) & (np.abs(X - W * 0.5) < (Y - H * 0.7) * 0.8 + 6)
        a[path] = (170, 140, 100)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB").filter(ImageFilter.GaussianBlur(1.2))
    d = ImageDraw.Draw(img)
    d.text((W - 20, H - 18), SPEC, font=C.ff_pil_font("DejaVuSans-Bold", 30), fill=(255, 255, 255), anchor="rd",
           stroke_width=2, stroke_fill=(60, 60, 60))
    a = np.asarray(img, np.float32) + rng.normal(0, 3.0, (H, W, 1)).astype(np.float32)
    a *= (1 - 0.25 * (((X - W / 2) / W) ** 2 + ((Y - H / 2) / H) ** 2))[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")


HOLIDAY = [("DSC_0001.JPG", "beach", "2023:07:11 11:24:05"), ("DSC_0002.JPG", "mountains", "2023:07:12 09:51:40"),
           ("DSC_0003.JPG", "oldtown", "2023:07:13 17:02:13"), ("DSC_0004.JPG", "boat", "2023:07:14 13:36:58"),
           ("DSC_0005.JPG", "sunset", "2023:07:15 20:41:22"), ("DSC_0006.JPG", "forest", "2023:07:16 10:15:47"),
           ("DSC_0007.JPG", "lake", "2023:07:17 15:28:09"), ("DSC_0008.JPG", "palms", "2023:07:18 12:03:31")]


def _passport_jpg():
    p = {"series_number": "00 00 000000", "issued_by_lines": ["ОТДЕЛОМ ОБРАЗЦОВОГО РАЙОНА", "Г. ОБРАЗЦОВСКА (ОБРАЗЕЦ)"],
         "issue_date": "01.01.2010", "division_code": "000-000", "surname": "ОБРАЗЦОВ", "name": "ОЛЕГ",
         "patronymic": "ОЛЕГОВИЧ", "sex": "МУЖ.", "birth_date": "01.01.1990",
         "birth_place_lines": ["ГОР. ОБРАЗЦОВСК", "(ОБРАЗЕЦ)"]}
    img, _boxes = C.ff_passport_spread_flat(p, seed=SEED)
    img = img.resize((1500, 1065), Image.LANCZOS)
    a = np.asarray(img, np.float32) + np.random.default_rng(SEED + 5).normal(0, 2.0, (1065, 1500, 1))
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    return C.ff_jpeg_bytes(img, 82, dpi=(150, 150))


def _snils_jpg():
    W, H = 1200, 760
    img = Image.new("RGB", (W, H), (214, 232, 206))
    d = ImageDraw.Draw(img)
    for k in range(0, H, 9):
        d.line([(0, k), (W, k + 40 * math.sin(k / 40.0))], fill=(200, 222, 192), width=2)
    d.rounded_rectangle([12, 12, W - 12, H - 12], radius=40, outline=(90, 140, 90), width=6)
    d.text((W / 2, 70), "СНИЛС — УЧЕБНАЯ КАРТОЧКА (ОБРАЗЕЦ)", font=C.ff_pil_font("DejaVuSans-Bold", 38),
           fill=(40, 90, 50), anchor="mm")
    d.text((W / 2, 120), "не является документом · данные вымышлены", font=C.ff_pil_font("DejaVuSans", 26),
           fill=(70, 110, 70), anchor="mm")
    d.text((W / 2, 230), "000-000-000 00", font=C.ff_pil_font("DejaVuSansMono-Bold", 72), fill=(20, 40, 20),
           anchor="mm")
    rows = [("Ф. И. О.", "Образцов Олег Олегович"), ("Дата рождения", "01.01.1990"),
            ("Место рождения", "г. Образцовск"), ("Пол", "мужской"), ("Дата регистрации", "15.09.2006")]
    y = 330
    for a_, b_ in rows:
        d.text((90, y), a_, font=C.ff_pil_font("LiberationSans-Italic", 28), fill=(80, 100, 80))
        d.text((420, y), b_, font=C.ff_pil_font("DejaVuSans", 34), fill=(20, 30, 20))
        y += 66
    img = C.ff_specimen_overlay(img, SPEC, angle=18, opacity=0.35, size=90)
    a = np.asarray(img, np.float32) + np.random.default_rng(SEED + 6).normal(0, 2.0, (H, W, 1))
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    return C.ff_jpeg_bytes(img, 84, dpi=(150, 150))


def _qr_png():
    qr = C.px_qr_image("https://example.com/specimen", module_px=12, border=4).convert("RGB")
    W, H = qr.width, qr.height + 90
    img = Image.new("RGB", (W, H), (255, 255, 255))
    img.paste(qr, (0, 0))
    d = ImageDraw.Draw(img)
    d.text((W / 2, qr.height + 40), SPEC, font=C.ff_pil_font("DejaVuSans-Bold", 30), fill=(190, 32, 32), anchor="mm")
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=False, compress_level=9)
    return buf.getvalue()


# ============================================================================ text-ish junk

def _thumbs_db():
    head = bytes.fromhex("D0CF11E0A1B11AE1") + b"\x00" * 16 + bytes.fromhex("3E000300FEFF0900")
    head += bytes.fromhex("0600000000000000000000000100000001000000000000000010000002000000")
    head = head.ljust(512, b"\xff")
    body = bytearray(_hash_stream(512 * 25, "thumbs"))
    for i in range(0, len(body), 512):
        body[i + 256:i + 512] = b"\x00" * 256       # half-empty sectors, as small thumbnails leave them
    return head + bytes(body)


def _desktop_ini():
    text = "\r\n[.ShellClassInfo]\r\nLocalizedResourceName=@%SystemRoot%\\system32\\shell32.dll,-21770\r\n" \
           "IconResource=%SystemRoot%\\system32\\imageres.dll,-112\r\n"
    return b"\xff\xfe" + text.encode("utf-16-le")


def _word_lock():
    user = "Obrazec"
    b = bytes([len(user)]) + user.encode("ascii")
    b = b.ljust(54, b"\x20")
    b += bytes([len(user), 0]) + user.encode("utf-16-le")
    return b.ljust(162, b"\x00")


def _notes_txt():
    text = ("Список дел на дачу (ОБРАЗЕЦ)\r\n\r\n1. Покрасить забор со стороны улицы\r\n2. Купить семена укропа и "
            "петрушки\r\n3. Вызвать электрика — розетка в бане\r\n4. Отвезти старый диван\r\n5. Проверить насос "
            "в колодце\r\n\r\n(файл-образец, все записи вымышлены)\r\n")
    return text.encode("cp1251")


def _meters_txt():
    text = ("Показания счётчиков — март 2024 (ОБРАЗЕЦ)\r\n\r\nХВС: 00123\r\nГВС: 00087\r\nЭлектроэнергия Т1: 04512\r\n"
            "Электроэнергия Т2: 01893\r\n\r\nПередать до 25 числа через личный кабинет (ОБРАЗЕЦ).\r\n")
    return text.encode("utf-8")


def _contacts_vcf():
    cards = [("Образцов", "Сантехник", "+79000000001", "Сантехник с дачи"),
             ("Тестова", "Мария", "+79000000002", "Арендатор, кв. 18"),
             ("Примеров", "Иван", "+79000000003", "Сосед по даче")]
    out = []
    for fam, nm, tel, note in cards:
        out += ["BEGIN:VCARD", "VERSION:3.0", f"N:{fam};{nm};;;", f"FN:{nm} {fam}", f"TEL;TYPE=CELL:{tel}",
                f"NOTE:{note} (ОБРАЗЕЦ / SPECIMEN)", "END:VCARD"]
    return ("\r\n".join(out) + "\r\n").encode("utf-8")


# ============================================================================ build

def _entries():
    """Returns (top-level entries, nested entries, extra info). Each entry: dict(name, data, attr, meta...)."""
    top, nested = [], []

    def add(lst, name, data, kind, category, folder, date=None, *, attr=ATTR_ARCHIVE, dup_of=None, note=None,
            alt_dates=None):
        lst.append(dict(name=name, data=data, attr=attr, kind=kind, category=category, folder=folder, date=date,
                        duplicate_of=dup_of, note=note, alt_dates=alt_dates or []))

    receipts = {}
    for i, (name, r) in enumerate(RECEIPTS.items()):
        img = _receipt_photo(r["lines"], SEED + 100 + 10 * i, angle=[-4.0, 3.0, -2.0][i])
        receipts[name] = C.ff_jpeg_bytes(img, 86, exif=_exif(r["exif"]))
    holiday = {}
    for i, (name, kind, when) in enumerate(HOLIDAY):
        img = _holiday_scene(kind, (1600, 1067), SEED + 200 + i)
        holiday[name] = C.ff_jpeg_bytes(img, 86, exif=_exif(when, make="SpecimenCam", model="SC-100 (SPECIMEN)"),
                                        dpi=(300, 300))
    broken_full = C.ff_jpeg_bytes(_holiday_scene("lake", (1600, 1067), SEED + 300), 86,
                                  exif=_exif("2024:08:30 18:12:44"))
    rent = _rent_contract_pdf()
    xls, smeta_total = _estimate_xls()
    doc = _old_contract_doc()

    add(top, "IMG_2391.jpg", receipts["IMG_2391.jpg"], "фото чека ООО «Образец-Ритейл», 14.03.2024, итог 1 234,50",
        "Чеки", "Чеки", "2024-03-14")
    add(top, "IMG_2392.jpg", receipts["IMG_2392.jpg"], "фото чека АЗС «Образец», 02.04.2024, итог 2 950,00",
        "Чеки", "Чеки", "2024-04-02")
    add(top, "IMG_2392 (1).jpg", receipts["IMG_2392.jpg"], "побайтный дубль IMG_2392.jpg", "дубль", None,
        dup_of="IMG_2392.jpg")
    add(top, "scan0001.pdf", rent, "договор аренды квартиры № 14/03-24 от 14.03.2024 (текстовый PDF)",
        "Договоры", "Договоры", "2024-03-14")
    add(top, "scan0002.pdf", _act_scan_pdf(), "акт приёма-передачи к договору аренды от 14.03.2024 (скан, без "
        "текстового слоя)", "Договоры", "Договоры", "2024-03-14")
    add(top, "Документ (3).docx", _service_contract_docx(), "договор оказания услуг № 7 от 01.09.2023 (ИП Тестов Т. Т.)",
        "Договоры", "Договоры", "2023-09-01")
    add(top, "Документ (4).docx", _claim_docx(), "претензия ООО «Образец-Мебель» от 10.11.2023 (исх. № 45)",
        "Письма", "Письма", "2023-11-10")
    add(top, "file.xlsx", _card_statement_xlsx(), "выписка по карте Банка «Образец» за февраль 2024", "Финансы",
        "Финансы", "2024-02")
    add(top, "smeta.xls", xls, f"смета ремонта ванной от 05.05.2024 (BIFF8 .xls), итого {smeta_total:,.0f} ₽"
        .replace(",", " "), "Ремонт", "Ремонт", "2024-05-05")
    add(top, "notes.txt", _notes_txt(), "«Список дел на дачу», текст в cp1251", "Заметки", "Заметки")
    add(top, "Новый текстовый документ.txt", _meters_txt(), "показания счётчиков за март 2024, UTF-8", "ЖКХ", "ЖКХ",
        "2024-03")
    add(top, "passport.jpg", _passport_jpg(), "скан разворота паспорта (ОБРАЗЕЦ)", "Личные документы",
        "Личные документы")
    add(top, "snils.jpg", _snils_jpg(), "карточка СНИЛС (ОБРАЗЕЦ)", "Личные документы", "Личные документы")
    for name, kind, when in HOLIDAY:
        add(top, name, holiday[name], f"фото с отпуска ({kind}), EXIF DateTimeOriginal {when}", "Фото", "Фото",
            when[:10].replace(":", "-"))
    add(top, "DSC_0004 копия.JPG", holiday["DSC_0004.JPG"], "побайтный дубль DSC_0004.JPG", "дубль", None,
        dup_of="DSC_0004.JPG")
    add(top, "IMG_0042.JPG", broken_full[:2048], "JPEG обрезан после 2048 байт (EXIF 2024:08:30 в заголовке цел)",
        "не открывается", None, note="битый: Pillow/ImageMagick падают на декодировании")
    add(top, "Thumbs.db", _thumbs_db(), "кэш миниатюр Windows (OLE)", "мусор", None, attr=ATTR_HIDDEN_SYSTEM)
    add(top, "desktop.ini", _desktop_ini(), "настройки папки Windows (UTF-16)", "мусор", None, attr=ATTR_HIDDEN_SYSTEM)
    add(top, "~$кумент (3).docx", _word_lock(), "lock-файл Word к «Документ (3).docx», 162 байта", "мусор", None,
        attr=ATTR_HIDDEN)
    add(top, "справка 2НДФЛ.pdf", _ndfl_pdf(), "справка о доходах за 2023 год (выдана 15.01.2024)", "Налоги", "Налоги",
        "2023", alt_dates=["2024-01-15"])
    add(top, "чек_ozon.pdf", _ozon_receipt_pdf(), "электронный кассовый чек интернет-заказа от 21.01.2024, 2 489,00",
        "Чеки", "Чеки", "2024-01-21")
    add(top, "polis_osago.pdf", _osago_pdf(), "полис ОСАГО (ОБРАЗЕЦ) с 12.06.2024 по 11.06.2025", "Авто", "Авто",
        "2024-06-12", alt_dates=["2024-06-11"])
    add(top, "Счет №15.pdf", _invoice_pdf(), "счёт № 15 ООО «Хостинг-Образец» от 03.02.2024 на 3 600,00",
        "Финансы", "Финансы", "2024-02-03")
    add(top, "resume_old.docx", _resume_docx(), "резюме Образцова О. О.", "Работа", "Работа")
    add(top, "presentation.pptx", _presentation_pptx(), "презентация «Итоги 2023», 5 слайдов", "Работа", "Работа")
    add(top, "qr.png", _qr_png(), "QR-код со ссылкой https://example.com/specimen", "Прочее", "Прочее")

    add(nested, "2019_дипломы.pdf", _diploma_pdf(), "диплом бакалавра (ОБРАЗЕЦ), выдан 28.06.2019", "Образование",
        "Образование", "2019", alt_dates=["2019-06-28"])
    add(nested, "IMG_0001.jpg", receipts["IMG_0001.jpg"], "фото чека «Образец-Маркет», 30.06.2019, итог 846,40",
        "Чеки", "Чеки", "2019-06-30")
    add(nested, "договор.doc", doc, "договор подряда № 3 от 12.05.2018 (Word 97 .doc)", "Договоры", "Договоры",
        "2018", alt_dates=["2018-05-12"])
    add(nested, "scan0001.pdf", rent, "побайтный дубль scan0001.pdf верхнего уровня", "дубль", None,
        dup_of="scan0001.pdf")
    add(nested, "contacts.vcf", _contacts_vcf(), "3 контакта vCard 3.0", "Контакты", "Контакты")
    return top, nested


# zip order: roughly what Explorer «Send to → Compressed folder» writes for a selection sorted by name
_ORDER_TOP = ["desktop.ini", "DSC_0001.JPG", "DSC_0002.JPG", "DSC_0003.JPG", "DSC_0004 копия.JPG", "DSC_0004.JPG",
              "DSC_0005.JPG", "DSC_0006.JPG", "DSC_0007.JPG", "DSC_0008.JPG", "file.xlsx", "IMG_0042.JPG",
              "IMG_2391.jpg", "IMG_2392 (1).jpg", "IMG_2392.jpg", "notes.txt", "passport.jpg", "polis_osago.pdf",
              "presentation.pptx", "qr.png", "resume_old.docx", "scan0001.pdf", "scan0002.pdf", "smeta.xls",
              "snils.jpg", "Thumbs.db", "~$кумент (3).docx", "Документ (3).docx", "Документ (4).docx",
              "Новый текстовый документ.txt", "справка 2НДФЛ.pdf", "старое.zip", "Счет №15.pdf", "чек_ozon.pdf"]
_ORDER_NESTED = ["2019_дипломы.pdf", "contacts.vcf", "IMG_0001.jpg", "scan0001.pdf", "договор.doc"]


def build(out_dir: pathlib.Path, truth_dir: pathlib.Path) -> list[str]:
    out_dir = pathlib.Path(out_dir)
    truth_dir = pathlib.Path(truth_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    top, nested = _entries()
    by_name_n = {e["name"]: e for e in nested}
    nested_zip = _write_zip_cp866([(n, by_name_n[n]["data"], by_name_n[n]["attr"]) for n in _ORDER_NESTED])
    top.append(dict(name="старое.zip", data=nested_zip, attr=ATTR_ARCHIVE, kind="вложенный ZIP (имена cp866)",
                    category="контейнер", folder=None, date=None, duplicate_of=None,
                    note="распаковать; сам архив в результат не нужен", alt_dates=[]))
    by_name = {e["name"]: e for e in top}
    assert sorted(by_name) == sorted(_ORDER_TOP), set(by_name) ^ set(_ORDER_TOP)
    data = _write_zip_cp866([(n, by_name[n]["data"], by_name[n]["attr"]) for n in _ORDER_TOP])
    zpath = out_dir / FIXTURE
    zpath.write_bytes(data)

    # ---------------------------------------------------------------- manifest + self-check
    records = []
    for prefix, lst, order in (("", top, _ORDER_TOP), ("старое.zip/", nested, _ORDER_NESTED)):
        idx = {e["name"]: e for e in lst}
        for n in order:
            e = idx[n]
            raw = n.encode("cp866")
            rec = {"path": prefix + n, "container": "старое.zip" if prefix else None, "name": n,
                   "name_cp866_hex": raw.hex(), "name_as_cp437": raw.decode("cp437"), "utf8_flag": False,
                   "size": len(e["data"]), "sha256": _sha(e["data"]), "kind": e["kind"], "category": e["category"],
                   "expected_folder": e["folder"], "date_for_name": e["date"], "alt_dates": e["alt_dates"],
                   "duplicate_of": e["duplicate_of"],
                   "dos_attr": e["attr"], "note": e["note"]}
            records.append(rec)
    files_outside_container = [r for r in records if r["category"] != "контейнер"]
    assert len(files_outside_container) == 38, len(files_outside_container)
    sha_first = {}
    for r in records:
        if r["category"] in ("дубль",):
            continue
        assert r["sha256"] not in sha_first, (r["path"], sha_first.get(r["sha256"]))
        sha_first[r["sha256"]] = r["path"]
    for r in records:
        if r["category"] == "дубль":
            assert sha_first[r["sha256"]] == r["duplicate_of"], r
    preserve = [r for r in records if r["category"] not in ("дубль", "мусор", "не открывается", "контейнер")]

    # re-read the archive the way a naive and a careful reader do
    with zipfile.ZipFile(zpath) as z:
        infos = z.infolist()
        naive = [i.filename for i in infos]
        flags = {i.flag_bits & 0x800 for i in infos}
        fixed = [i.filename.encode("cp437").decode("cp866") for i in infos]
        dates = {i.date_time for i in infos}
        nested_names = [i.filename.encode("cp437").decode("cp866")
                        for i in zipfile.ZipFile(io.BytesIO(z.read(infos[fixed.index("старое.zip")].filename))).infolist()]
    assert fixed == _ORDER_TOP and nested_names == _ORDER_NESTED and flags == {0} and dates == {ZIP_TIME}
    mojibake = [n for n, f in zip(naive, fixed) if n != f]     # what a cp437 reader shows instead of Cyrillic

    check_params = {
        "zip_same_folder": [
            {"files": ["IMG_2391.jpg", "IMG_2392.jpg", "чек_ozon.pdf", "старое.zip/IMG_0001.jpg"], "folder": "Чеки"},
            {"files": ["passport.jpg", "snils.jpg"], "folder": "Личные документы"},
            {"files": [h[0] for h in HOLIDAY], "folder": "Фото"},
            {"files": ["scan0001.pdf", "scan0002.pdf", "Документ (3).docx", "старое.zip/договор.doc"],
             "folder": "Договоры"}],
        "zip_names_have_dates": {r["path"]: r["date_for_name"] for r in records
                                 if r["date_for_name"] and len(r["date_for_name"]) == 10 and r["category"] != "дубль"
                                 and not r["alt_dates"]},
        "xlsx_inventory": {"rows_files": 38, "rows_with_container": 39,
                           "must_mark": {"IMG_2392 (1).jpg": "дубль", "IMG_0042.JPG": "не открывается",
                                         "Thumbs.db": "мусор"}},
    }
    folders = sorted({r["expected_folder"] for r in records if r["expected_folder"]})
    truth = {
        "fixture": FIXTURE, "zip_bytes": len(data), "zip_sha256": _sha(data),
        "zip_mtime_all": "2024-09-01 12:00:00", "name_encoding": "cp866, general purpose bit 11 = 0",
        "ooxml_core_dates": "2024-09-01T12:00:00Z (no content hint)",
        "pdf_dates": "reportlab invariant 2000-01-01 (no content hint)",
        "counts": {"zip_entries_top": len(top), "nested_entries": len(nested), "files_outside_container": 38,
                   "with_container_row": 39, "duplicates": sum(r["category"] == "дубль" for r in records),
                   "junk": sum(r["category"] == "мусор" for r in records),
                   "broken": sum(r["category"] == "не открывается" for r in records),
                   "unique_to_preserve": len(preserve)},
        "expected_folders": folders,
        "folders_note": "expected_folder is a fine-grained label (15 kinds). The checks fix only 4 groups (Чеки, "
                        "Личные документы, Фото, Договоры); the judge wants 5–10 folders, so merging is fine, e.g. "
                        "coarse_folders_example.",
        "coarse_folders_example": {"Чеки": "Чеки", "Договоры": "Договоры", "Письма": "Договоры",
                                   "Финансы": "Финансы", "Налоги": "Финансы", "ЖКХ": "Финансы", "Ремонт": "Дом и дача",
                                   "Заметки": "Дом и дача", "Личные документы": "Личные документы",
                                   "Авто": "Личные документы", "Образование": "Личные документы", "Фото": "Фото",
                                   "Работа": "Работа", "Контакты": "Прочее", "Прочее": "Прочее"},
        "records": records,
        "preserve_sha256": sorted(r["sha256"] for r in preserve),
        "derived_check_params": check_params,
        "self_check": {"naive_names_with_mojibake": len(mojibake),
                       "cp437_mojibake_chars": sorted({ch for n in mojibake for ch in n if ord(ch) > 127}), "naive_example": naive[_ORDER_TOP.index("Документ (3).docx")],
                       "utf8_flags": sorted(flags), "all_dates": [list(d) for d in dates]},
    }
    tpath = C.ff_write_json(truth_dir / "zip_manifest.json", truth)
    return [str(zpath), tpath]


if __name__ == "__main__":
    base = HERE.parent
    for p in build(base / "out" / "f-zip-chaos-inventory", base / "truth"):
        print(p)
