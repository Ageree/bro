"""Page surgery: merge, split, extract, reorder, rotate, delete, insert-blank, from-images,
to-images, images (embedded pictures in their original quality) and `pages --analyze`
(blank pages and duplicates) — W2 spec §5.1, §6.8.

Pages are copied with pypdf (text, fonts and form fields stay as they are). Signature fields
and Bro's sign marks are never touched.
"""

import io
import os

from brokit.pdf import crypt, geom
from brokit.util import KitError, need_file, out_path, parse_pages, parser, run

A4 = (595.276, 841.89)
IMAGE_TYPES = (".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".gif", ".bmp")
HEIC_TYPES = (".heic", ".heif")


def _stem(path):
    return os.path.splitext(os.path.basename(path))[0] or "page"


def _save(writer, output):
    size = crypt.write_pdf(writer, output)
    return {"output": output, "pages": len(writer.pages), "bytes": size}


def _copy(reader, numbers):
    """A new PDF of these pages in this order; form fields of the kept pages come along."""
    from pypdf import PdfWriter

    writer = PdfWriter()
    try:
        writer.append(reader, pages=[number - 1 for number in numbers])
    except crypt.PDF_ERRORS as error:
        raise crypt.unreadable(error)
    return writer


def _open(path, warnings):
    return crypt.open_pdf(path, warnings=warnings)


# --- images to pages ----------------------------------------------------------------------


def _image_page(canvas, path, paper):
    """Draws one image as a page; JPEG files without EXIF rotation go in byte for byte."""
    from PIL import Image, ImageOps
    from reportlab.lib.utils import ImageReader

    lower = path.lower()
    if lower.endswith(HEIC_TYPES):
        raise KitError("unsupported", "HEIC cannot be read here: " + os.path.basename(path), "пришли JPEG")
    try:
        with Image.open(path) as probe:
            orientation = probe.getexif().get(0x0112, 1)
            image_format, mode, size = probe.format, probe.mode, probe.size
            dpi = probe.info.get("dpi", (150, 150))[0] or 150
    except (OSError, ValueError):
        raise KitError("unreadable", "not an image: " + os.path.basename(path))
    if image_format == "JPEG" and orientation in (0, 1) and mode in ("RGB", "L", "CMYK"):
        source = path
        width, height = size
    else:
        with Image.open(path) as opened:
            opened.seek(0)
            picture = ImageOps.exif_transpose(opened)
            if picture.mode not in ("RGB", "L"):
                background = Image.new("RGB", picture.size, "white")
                rgba = picture.convert("RGBA")
                background.paste(rgba, mask=rgba.split()[3])
                picture = background
            width, height = picture.size
            source = ImageReader(picture.copy())
    if paper == "fit":
        scale = 72.0 / float(dpi if 30 <= float(dpi) <= 1200 else 150)
        page_w, page_h = width * scale, height * scale
        canvas.setPageSize((page_w, page_h))
        canvas.drawImage(source, 0, 0, page_w, page_h)
    else:
        page_w, page_h = A4 if height >= width else (A4[1], A4[0])
        ratio = (width / height) / (page_w / page_h)
        margin = 0 if 0.97 <= ratio <= 1.03 else 18
        scale = min((page_w - 2 * margin) / width, (page_h - 2 * margin) / height)
        w, h = width * scale, height * scale
        canvas.setPageSize((page_w, page_h))
        canvas.drawImage(source, (page_w - w) / 2, (page_h - h) / 2, w, h)
    canvas.showPage()


def _images_pdf(paths, paper):
    from pypdf import PdfReader
    from reportlab.pdfgen import canvas as rl_canvas

    buffer = io.BytesIO()
    canvas = rl_canvas.Canvas(buffer, invariant=1)
    for path in paths:
        _image_page(canvas, need_file(path), paper)
    canvas.save()
    return PdfReader(io.BytesIO(buffer.getvalue()))


def from_images(argv):
    args = parser("pdf from-images")
    args.add_argument("images", nargs="+")
    args.add_argument("-o", "--output", required=True)
    args.add_argument("--paper", choices=("a4", "fit"), default="a4")
    options = args.parse_args(argv)
    output = out_path(options.output, *options.images)
    reader = _images_pdf(options.images, options.paper)
    return _save(_copy(reader, range(1, len(reader.pages) + 1)), output)


def merge(argv):
    args = parser("pdf merge")
    args.add_argument("inputs", nargs="+")
    args.add_argument("-o", "--output", required=True)
    args.add_argument("--paper", choices=("a4", "fit"), default="a4")
    options = args.parse_args(argv)
    output = out_path(options.output, *options.inputs)
    from pypdf import PdfWriter

    warnings = []
    writer = PdfWriter()
    for path in options.inputs:
        need_file(path)
        lower = path.lower()
        if lower.endswith(IMAGE_TYPES + HEIC_TYPES):
            reader = _images_pdf([path], options.paper)
        elif lower.endswith(".pdf"):
            reader = _open(path, warnings)
        else:
            raise KitError("unsupported", "merge takes PDFs and images: " + os.path.basename(path), "office files: brokit render FILE -o DIR first")
        try:
            writer.append(reader)
        except crypt.PDF_ERRORS as error:
            raise crypt.unreadable(error)
    return dict(_save(writer, output), warnings=warnings)


# --- page selection -----------------------------------------------------------------------


def extract(argv):
    args = parser("pdf extract")
    args.add_argument("file")
    args.add_argument("--pages", required=True)
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    output = out_path(options.output, options.file)
    warnings = []
    reader = _open(options.file, warnings)
    numbers = parse_pages(options.pages, len(reader.pages))
    return dict(_save(_copy(reader, numbers), output), warnings=warnings)


def reorder(argv):
    args = parser("pdf reorder")
    args.add_argument("file")
    args.add_argument("--order", required=True)
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    output = out_path(options.output, options.file)
    warnings = []
    reader = _open(options.file, warnings)
    numbers = parse_pages(options.order, len(reader.pages))
    if sorted(numbers) != list(range(1, len(reader.pages) + 1)):
        raise KitError("bad_pages", "--order must name every page once", "to drop or repeat pages use brokit pdf extract --pages")
    return dict(_save(_copy(reader, numbers), output), warnings=warnings)


def delete(argv):
    args = parser("pdf delete")
    args.add_argument("file")
    args.add_argument("--pages", required=True)
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    output = out_path(options.output, options.file)
    warnings = []
    reader = _open(options.file, warnings)
    gone = set(parse_pages(options.pages, len(reader.pages)))
    keep = [n for n in range(1, len(reader.pages) + 1) if n not in gone]
    if not keep:
        raise KitError("bad_pages", "that would delete every page")
    return dict(_save(_copy(reader, keep), output), deleted=sorted(gone), warnings=warnings)


def rotate(argv):
    args = parser("pdf rotate")
    args.add_argument("file")
    args.add_argument("--pages")
    args.add_argument("--angle", type=int, required=True, choices=(90, 180, 270, -90))
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    output = out_path(options.output, options.file)
    warnings = []
    reader = _open(options.file, warnings)
    numbers = set(parse_pages(options.pages, len(reader.pages)))
    writer = crypt.writer_from(reader)
    for number, page in enumerate(writer.pages, start=1):
        if number in numbers:
            page.rotate(options.angle % 360)
    return dict(_save(writer, output), rotated=sorted(numbers), warnings=warnings)


def insert_blank(argv):
    args = parser("pdf insert-blank")
    args.add_argument("file")
    args.add_argument("--after", type=int, required=True)
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    output = out_path(options.output, options.file)
    warnings = []
    reader = _open(options.file, warnings)
    if not 0 <= options.after <= len(reader.pages):
        raise KitError("bad_pages", "--after must be 0-%d" % len(reader.pages))
    writer = crypt.writer_from(reader)
    model = reader.pages[max(options.after, 1) - 1]
    x0, y0, x1, y1 = geom.rect(model.mediabox)
    writer.insert_blank_page(width=x1 - x0, height=y1 - y0, index=options.after)
    return dict(_save(writer, output), warnings=warnings)


def split(argv):
    args = parser("pdf split")
    args.add_argument("file")
    args.add_argument("-o", "--output", required=True, help="directory")
    group = args.add_mutually_exclusive_group()
    group.add_argument("--every", type=int)
    group.add_argument("--ranges")
    options = args.parse_args(argv)
    warnings = []
    reader = _open(options.file, warnings)
    total = len(reader.pages)
    if options.ranges:
        groups = [parse_pages(part, total) for part in options.ranges.split(",") if part.strip()]
    else:
        every = options.every or 1
        if every < 1:
            raise KitError("bad_args", "--every must be ≥ 1")
        groups = [list(range(start, min(start + every, total + 1))) for start in range(1, total + 1, every)]
    os.makedirs(options.output, exist_ok=True)
    outputs = []
    for group in groups:
        name = "%s-p%d.pdf" % (_stem(options.file), group[0]) if len(group) == 1 else "%s-p%d-%d.pdf" % (_stem(options.file), group[0], group[-1])
        path = os.path.join(options.output, name)
        if os.path.realpath(path) == os.path.realpath(options.file):
            raise KitError("bad_output", "the output must differ from the input")
        crypt.write_pdf(_copy(reader, group), path)
        outputs.append({"path": path, "pages": group})
    return {"outputs": outputs, "warnings": warnings}


# --- rendering and pictures ---------------------------------------------------------------


def to_images(argv):
    args = parser("pdf to-images")
    args.add_argument("file")
    args.add_argument("-o", "--output", required=True, help="directory")
    args.add_argument("--pages")
    args.add_argument("--dpi", type=int, default=150)
    args.add_argument("--format", choices=("jpg", "png"), default="jpg")
    options = args.parse_args(argv)
    from PIL import Image

    if not 30 <= options.dpi <= 600:
        raise KitError("bad_args", "--dpi must be 30-600")
    warnings = []
    reader = _open(options.file, warnings)
    numbers = parse_pages(options.pages, len(reader.pages))
    os.makedirs(options.output, exist_ok=True)
    stem = os.path.join(options.output, _stem(options.file))
    files = []
    for number in numbers:
        width, height = geom.view_size(reader.pages[number - 1])
        dpi = min(options.dpi, 10000 * 72 / max(width, height, 1))
        target = "%s-%d" % (stem, number)
        kind = ["-jpeg", "-jpegopt", "quality=90"] if options.format == "jpg" else ["-png"]
        command = ["pdftoppm", "-cropbox", *kind, "-r", "%.2f" % dpi, "-f", str(number), "-l", str(number), "-singlefile"]
        result = run(command + [options.file, target], timeout=60)
        path = target + "." + options.format
        if result.returncode != 0 or not os.path.exists(path):
            raise KitError("unreadable", "poppler could not render page %d" % number)
        with Image.open(path) as image:
            files.append({"page": number, "path": path, "width": image.width, "height": image.height})
    return {"files": files, "warnings": warnings}


def _original_bytes(stream):
    """(bytes, extension) of a JPEG or JPEG 2000 picture exactly as embedded, or None.

    Wrapper filters (ASCII85, hex, Flate) are undone; the picture itself is not re-encoded.
    A picture with a soft mask needs its alpha, so it goes through pypdf (PNG) instead.
    """
    from pypdf.filters import ASCII85Decode, ASCIIHexDecode, FlateDecode

    if stream is None or "/SMask" in stream or "/Mask" in stream:
        return None
    filters = stream.get("/Filter")
    if filters is None:
        return None
    filters = filters.get_object()
    names = [str(f) for f in (filters if isinstance(filters, list) else [filters])]
    if names[-1] not in ("/DCTDecode", "/JPXDecode"):
        return None
    data = stream._data
    wrappers = {"/ASCII85Decode": ASCII85Decode, "/ASCIIHexDecode": ASCIIHexDecode, "/FlateDecode": FlateDecode}
    for name in names[:-1]:
        if name not in wrappers:
            return None
        data = wrappers[name].decode(data)
    return data, ".jpg" if names[-1] == "/DCTDecode" else ".jp2"


def images(argv):
    args = parser("pdf images")
    args.add_argument("file")
    args.add_argument("-o", "--output", required=True, help="directory")
    options = args.parse_args(argv)
    warnings = []
    reader = _open(options.file, warnings)
    os.makedirs(options.output, exist_ok=True)
    seen, files, skipped = set(), [], 0
    for number, page in enumerate(reader.pages, start=1):
        try:
            found = list(page.images)
        except crypt.PDF_ERRORS + (OSError,) as error:
            warnings.append("page %d: an image could not be decoded (%s)" % (number, type(error).__name__))
            continue
        for index, image in enumerate(found, start=1):
            key = image.indirect_reference.idnum if image.indirect_reference is not None else ("inline", number, index)
            if key in seen:
                continue
            seen.add(key)
            picture = image.image
            if picture is None or min(picture.size) < 16:
                skipped += 1
                continue
            original = _original_bytes(image.indirect_reference.get_object() if image.indirect_reference is not None else None)
            data, extension = original or (image.data, os.path.splitext(image.name)[1].lower() or ".png")
            path = os.path.join(options.output, "%s-p%d-%d%s" % (_stem(options.file), number, index, extension))
            with open(path, "wb") as handle:
                handle.write(data)
            files.append(
                {
                    "page": number,
                    "path": path,
                    "width": picture.width,
                    "height": picture.height,
                    "bytes": len(data),
                    "format": extension[1:],
                    "original": original is not None,
                }
            )
    return {"files": files, "skipped_small": skipped, "warnings": warnings}


# --- analyze ------------------------------------------------------------------------------


def dhash(gray):
    """64-bit difference hash of a gray PIL image."""
    small = gray.resize((9, 8))
    pixels = list(small.getdata())
    bits = 0
    for row in range(8):
        for column in range(8):
            bits = (bits << 1) | (1 if pixels[row * 9 + column] > pixels[row * 9 + column + 1] else 0)
    return bits


def analyze(argv):
    args = parser("pdf pages")
    args.add_argument("file")
    args.add_argument("--analyze", action="store_true", required=True)
    options = args.parse_args(argv)
    import tempfile

    import numpy
    from PIL import Image

    warnings = []
    reader = _open(options.file, warnings)
    pages, hashes = [], {}
    with tempfile.TemporaryDirectory(prefix="brokit-pages-") as directory:
        result = run(["pdftoppm", "-cropbox", "-gray", "-r", "50", options.file, os.path.join(directory, "p")], timeout=300)
        if result.returncode != 0:
            raise KitError("unreadable", "poppler could not render the PDF")
        rendered = sorted(os.listdir(directory), key=lambda name: int(name.rsplit("-", 1)[1].split(".")[0]))
        for number, name in enumerate(rendered, start=1):
            with Image.open(os.path.join(directory, name)) as image:
                gray = image.convert("L")
                ink = float((numpy.asarray(gray) < 160).mean())
                value = dhash(gray)
            width, height = geom.view_size(reader.pages[number - 1])
            blank = ink < 0.002
            size = [round(width, 1), round(height, 1)]
            pages.append({"page": number, "size": size, "ink_ratio": round(ink, 4), "blank": blank, "dhash": "%016x" % value})
            if not blank:
                hashes[number] = value
    groups, used = [], set()
    numbers = sorted(hashes)
    for i, first in enumerate(numbers):
        if first in used:
            continue
        group = [first] + [n for n in numbers[i + 1 :] if n not in used and bin(hashes[first] ^ hashes[n]).count("1") <= 6]
        if len(group) > 1:
            groups.append(group)
            used.update(group)
    return {"pages": pages, "blank": [p["page"] for p in pages if p["blank"]], "duplicates": groups, "warnings": warnings}
