"""PDFs the pdf tests build for themselves (no committed binaries) and a runner of the kit.

`kit(*args, home=…)` runs `brokit` in a child process exactly as the sandbox does (one JSON
line on stdout), so the hostile-input limits of `pdf info` stay out of the test process.
"""

import io
import json
import math
import os
import re
import subprocess
import sys

KIT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEJAVU_SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"
A4 = (595.276, 841.89)
TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90"


def kit(*args, home=None, cache=None):
    """(exit code, JSON of the last stdout line) of `brokit args…`."""
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home or "/nonexistent"}
    env["BROKIT_HOME"] = home or os.path.join(KIT_ROOT, "no-home")
    if cache:
        env["BROKIT_CACHE"] = cache
    code = "import sys;sys.path.insert(0, %r);from brokit.cli import main;sys.exit(main(sys.argv[1:]))" % KIT_ROOT
    done = subprocess.run([sys.executable, "-I", "-c", code, *[str(a) for a in args]], capture_output=True, timeout=300, env=env)
    lines = [line for line in done.stdout.decode("utf-8").splitlines() if line.strip()]
    if len(lines) != 1:
        raise AssertionError("expected one JSON line, got %r; stderr %s" % (lines, done.stderr.decode("utf-8", "replace")[-2000:]))
    return done.returncode, json.loads(lines[0])


def fonts():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    if "TestSans" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("TestSans", DEJAVU))
        pdfmetrics.registerFont(TTFont("TestSerif", DEJAVU_SERIF))


def write_json(path, value):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)
    return path


def pdftotext(path, *extra):
    return subprocess.run(["pdftotext", *extra, path, "-"], capture_output=True, check=True).stdout.decode("utf-8")


def render(path, page, dpi=72, gray=False):
    """The displayed page as a numpy array (RGB, or gray)."""
    import tempfile

    import numpy
    from PIL import Image

    with tempfile.TemporaryDirectory() as directory:
        stem = os.path.join(directory, "p")
        subprocess.run(["pdftoppm", "-cropbox", "-r", str(dpi), "-f", str(page), "-l", str(page), "-singlefile", "-png", path, stem], check=True, capture_output=True)
        with Image.open(stem + ".png") as image:
            return numpy.asarray(image.convert("L" if gray else "RGB")).astype(int)


def add_field(writer, page_index, field):
    """Adds a merged field+widget dict to a page and to /AcroForm /Fields."""
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject

    page = writer.pages[page_index]
    field.update({NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"), NameObject("/P"): page.indirect_reference})
    field.setdefault(NameObject("/F"), NumberObject(4))
    reference = writer._add_object(field)
    if "/Annots" in page:
        page["/Annots"].get_object().append(reference)
    else:
        page[NameObject("/Annots")] = ArrayObject([reference])
    root = writer._root_object
    if "/AcroForm" not in root:
        root[NameObject("/AcroForm")] = writer._add_object(DictionaryObject({NameObject("/Fields"): ArrayObject()}))
    root["/AcroForm"]["/Fields"].append(reference)
    return reference


def sig_field(name, rect, signed=False):
    from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, TextStringObject

    field = DictionaryObject(
        {
            NameObject("/FT"): NameObject("/Sig"),
            NameObject("/T"): TextStringObject(name),
            NameObject("/Rect"): ArrayObject([FloatObject(v) for v in rect]),
        }
    )
    if signed:
        field[NameObject("/V")] = DictionaryObject({NameObject("/Type"): NameObject("/Sig"), NameObject("/Filter"): NameObject("/Adobe.PPKLite")})
    return field


def text_field(name, rect, value=None):
    from pypdf.generic import ArrayObject, DictionaryObject, FloatObject, NameObject, TextStringObject

    field = DictionaryObject(
        {
            NameObject("/FT"): NameObject("/Tx"),
            NameObject("/T"): TextStringObject(name),
            NameObject("/Rect"): ArrayObject([FloatObject(v) for v in rect]),
            NameObject("/DA"): TextStringObject("/Helv 10 Tf 0 g"),
        }
    )
    if value is not None:
        field[NameObject("/V")] = TextStringObject(value)
    return field


def form_pdf(path):
    """Page 1: text, comb (10), multiline, checkbox, radio, choice, a native /Sig and a bro mark;
    page 2 (/Rotate 90): one text field."""
    from pypdf import PdfWriter
    from pypdf.generic import ArrayObject, NameObject, NumberObject, TextStringObject
    from reportlab.lib.colors import black, white
    from reportlab.pdfgen import canvas

    from brokit.pdf.sign import seal

    fonts()
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4)
    c.setFont("TestSans", 10)
    c.drawString(180, 593, "Согласен с условиями")
    c.drawString(180, 563, "мужской")
    c.drawString(240, 563, "женский")
    c.setFont("Helvetica", 10)
    form = c.acroForm
    form.textfield(name="fio", x=160, y=782, width=300, height=20, fontName="Helvetica", fontSize=0, borderColor=black, fillColor=white)
    form.textfield(name="note", x=160, y=740, width=120, height=18, fontName="Helvetica", fontSize=10, borderColor=black, fillColor=white)
    form.textfield(name="passport", x=160, y=700, width=160, height=20, fontName="Helvetica", fontSize=11, maxlen=10, fieldFlags="comb")
    form.textfield(name="address", x=160, y=620, width=300, height=60, fontName="Helvetica", fontSize=10, fieldFlags="multiline")
    form.checkbox(name="agree", x=160, y=590, size=14, buttonStyle="check", checked=False)
    form.radio(name="gender", value="male", x=160, y=560, size=14, selected=False)
    form.radio(name="gender", value="female", x=220, y=560, size=14, selected=False)
    form.choice(name="city", value="Moscow", options=["Moscow", "Kazan"], x=160, y=520, width=150, height=20, fontName="Helvetica", fontSize=10)
    c.showPage()
    c.setFont("Helvetica", 10)
    c.drawString(40, 790, "Page 2")
    c.acroForm.textfield(name="comment", x=160, y=600, width=300, height=20, fontName="Helvetica", fontSize=10)
    c.showPage()
    c.save()
    buffer.seek(0)
    writer = PdfWriter(clone_from=buffer)
    writer.pages[1][NameObject("/Rotate")] = NumberObject(90)
    add_field(writer, 0, sig_field("Подпись заявителя", [160, 110, 330, 140]))
    mark = sig_field("bro_sign_signature_1", [360, 110, 520, 140])
    mark[NameObject("/BroMark")] = TextStringObject(seal(TOKEN, "bro_sign_signature_1", 0, mark))
    add_field(writer, 0, mark)
    writer._root_object["/AcroForm"][NameObject("/SigFlags")] = NumberObject(1)
    for widget in writer.pages[0]["/Annots"]:
        widget = widget.get_object()
        if widget.get("/T") == "city":
            widget[NameObject("/Opt")] = ArrayObject([TextStringObject("Москва"), TextStringObject("Казань")])
    writer.write(path)
    return path


def contract_pdf(path, rotate=0, crop_offset=0, native_sig=None):
    """A contract page: a two-column signature block «НАЙМОДАТЕЛЬ:» / «НАНИМАТЕЛЬ:» with rules
    and «(подпись)» captions, «Дата:____», and «М.П.». Returns the view boxes of the two
    signature rules' places and of the date blank (for /Rotate 0 without offset)."""
    from pypdf import PdfWriter
    from pypdf.generic import ArrayObject, FloatObject, NameObject, NumberObject
    from reportlab.pdfgen import canvas

    fonts()
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4)
    c.setFont("TestSerif", 11)
    c.drawString(60, 760, "Договор найма жилого помещения: стороны подписывают договор ниже.")
    c.setFont("TestSerif", 11)
    c.drawString(60, 230, "НАЙМОДАТЕЛЬ:")
    c.drawString(330, 230, "НАНИМАТЕЛЬ:")
    c.setLineWidth(0.8)
    c.line(60, 182, 180, 182)
    c.line(330, 182, 450, 182)
    c.setFont("TestSerif", 7)
    c.drawCentredString(120, 174, "(подпись)")
    c.drawCentredString(390, 174, "(подпись)")
    c.setFont("TestSerif", 11)
    c.drawString(330, 140, "Дата:____________")
    c.drawString(60, 140, "М.П.")
    c.showPage()
    c.save()
    buffer.seek(0)
    writer = PdfWriter(clone_from=buffer)
    page = writer.pages[0]
    if crop_offset:
        page[NameObject("/CropBox")] = ArrayObject([FloatObject(v) for v in (crop_offset, crop_offset, A4[0] - crop_offset / 2, A4[1] - crop_offset / 2)])
    if rotate:
        page[NameObject("/Rotate")] = NumberObject(rotate)
    if native_sig:
        add_field(writer, 0, sig_field("signature", native_sig))
        writer._root_object["/AcroForm"][NameObject("/SigFlags")] = NumberObject(1)
    writer.write(path)
    height = A4[1]
    return {
        "landlord": [60, height - 210, 180, height - 182],
        "tenant": [330, height - 210, 450, height - 182],
    }


def signature_png(path, width=600, height=160):
    """An RGBA scribble on a transparent background, wide like a real signature."""
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    points = [(x, height / 2 + math.sin(x / 25) * height * 0.35) for x in range(10, width - 10, 4)]
    draw.line(points, fill=(20, 40, 160, 255), width=7)
    image.save(path)
    return path


def lines_pdf(path):
    """Two pages of Cyrillic lines (centred title, body, a right-aligned blue date) and one picture."""
    from PIL import Image
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    fonts()
    c = canvas.Canvas(path, pagesize=A4)
    c.setFont("TestSerif", 16)
    c.drawCentredString(A4[0] / 2, 760, "СПРАВКА")
    c.setFont("TestSans", 11)
    c.drawString(60, 720, "Дана Соколовой Марии Игоревне в том, что она работает")
    c.drawString(60, 704, "в ООО «Образец» с 01.03.2019 по настоящее время.")
    c.setFillColorRGB(0.1, 0.3, 0.6)
    c.drawRightString(535, 680, "15.10.2026")
    c.setFillColorRGB(0, 0, 0)
    picture = Image.new("RGB", (120, 60), (200, 30, 30))
    c.drawImage(ImageReader(picture), 60, 560, 120, 60)
    c.showPage()
    c.setFont("TestSans", 11)
    c.drawString(60, 760, "Справка выдана для предъявления в консульство.")
    c.showPage()
    c.save()
    return path


def scan_form(directory, angle=0.7, seed=7):
    """A flat form drawn by reportlab, rasterised at 200 dpi, rotated `angle`° counter-clockwise,
    noised and embedded as a JPEG page (no text layer). Returns (pdf path, truth) where truth
    maps names to the rule's ends in view pt after the rotation."""
    import subprocess as sp

    import numpy
    from PIL import Image
    from reportlab.pdfgen import canvas

    fonts()
    vector = os.path.join(directory, "scan-vector.pdf")
    c = canvas.Canvas(vector, pagesize=A4)
    c.setFont("TestSerif", 12)
    c.drawString(60, 700, "от")
    c.setLineWidth(0.8)
    rules = {"from": (80, 700, 320), "fio": (80, 676, 320)}
    for x0, y, x1 in rules.values():
        c.line(x0, y - 2, x1, y - 2)
    sentence = "Прошу предоставить отпуск с «__» ________ 20__ г."
    c.drawString(60, 620, sentence)
    c.showPage()
    c.save()
    from fontTools.ttLib import TTFont as FontFile
    from reportlab.pdfbase import pdfmetrics

    face = FontFile(DEJAVU_SERIF)
    glyph = face["glyf"]["underscore"]
    units = face["head"].unitsPerEm
    underline = A4[1] - 620 - (glyph.yMin + glyph.yMax) / 2 / units * 12
    truth = {name: [(x0, A4[1] - y + 2), (x1, A4[1] - y + 2)] for name, (x0, y, x1) in rules.items()}
    for index, match in enumerate(re.finditer(r"_+", sentence)):
        x0 = 60 + pdfmetrics.stringWidth(sentence[: match.start()], "TestSerif", 12)
        x1 = 60 + pdfmetrics.stringWidth(sentence[: match.end()], "TestSerif", 12)
        truth["blank%d" % index] = [(x0, underline), (x1, underline)]
    raster = os.path.join(directory, "scan-raster")
    sp.run(["pdftoppm", "-r", "200", "-gray", "-singlefile", vector, raster], check=True)
    with Image.open(raster + ".pgm") as image:
        page = image.convert("L")
    rotated = page.rotate(angle, resample=Image.BILINEAR, fillcolor=255)
    rng = numpy.random.default_rng(seed)
    pixels = numpy.asarray(rotated).astype(float) * 0.94 + rng.normal(0, 6, rotated.size[::-1])
    noisy = Image.fromarray(numpy.clip(pixels, 0, 255).astype(numpy.uint8))
    jpeg = os.path.join(directory, "scan.jpg")
    noisy.save(jpeg, quality=60)
    pdf = os.path.join(directory, "scan.pdf")
    c = canvas.Canvas(pdf, pagesize=A4)
    c.drawImage(jpeg, 0, 0, A4[0], A4[1])
    c.showPage()
    c.save()
    width, height = page.size
    cx, cy = width / 2, height / 2
    theta = math.radians(angle)
    scale = 72.0 / 200

    def turned(point):
        x, y = point[0] / scale, point[1] / scale
        dx, dy = x - cx, y - cy
        return ((cx + dx * math.cos(theta) + dy * math.sin(theta)) * scale, (cy - dx * math.sin(theta) + dy * math.cos(theta)) * scale)

    return pdf, {name: [turned(p) for p in ends] for name, ends in truth.items()}
