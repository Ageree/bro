"""brokit render: a PDF or an office file as page pictures (W2 spec §5.1, §6.1).

Also the poppler and LibreOffice plumbing `look` shares: what pdfinfo says of
a PDF, and an office file converted to PDF once per content, under one lock
for every soffice of the sandbox (LibreOffice's profile takes one instance).
Pages are rendered from the CropBox (`-cropbox`: poppler draws the MediaBox
otherwise), after /Rotate, so their pixels match the kit's view points.
"""

import contextlib
import fcntl
import hashlib
import os
import re
import shutil
import tempfile
import time

from brokit.util import KitError, cache_dir, need_file, parse_pages, parser, prune_cache, run

OFFICE_EXTENSIONS = frozenset(("docx", "xlsx", "pptx", "odt", "ods", "odp", "doc", "xls", "ppt", "rtf"))
SOFFICE_LOCK = "/tmp/brokit-soffice.lock"
SOFFICE_SECONDS = 120
POPPLER_SECONDS = 60
RENDER_PAGES = 200


def extension(path):
    return os.path.splitext(path)[1].lower().lstrip(".")


def is_pdf(path):
    with open(path, "rb") as handle:
        return b"%PDF-" in handle.read(1024)


def is_office(path):
    return extension(path) in OFFICE_EXTENSIONS


def pdf_info(path, first=None, last=None):
    """{pages, encrypted, sizes: {page: (width, height, rotate)}} of pdfinfo; sizes are the CropBox, unrotated."""
    command = ["pdfinfo"]
    if first is not None:
        command += ["-f", str(first), "-l", str(last)]
    result = run(command + [path], timeout=POPPLER_SECONDS)
    output = result.stdout.decode("utf-8", "replace")
    if result.returncode != 0:
        if b"Incorrect password" in result.stderr:
            raise KitError(
                "encrypted",
                path + " is protected by a password",
                "brokit pdf decrypt FILE --password P -o OUT, then look at OUT",
            )
        raise KitError("unreadable", path + " is not a readable PDF")
    pages = re.search(r"^Pages:\s+(\d+)", output, re.M)
    if pages is None:
        raise KitError("unreadable", path + " is not a readable PDF")
    sizes = {}
    for match in re.finditer(r"^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)", output, re.M):
        sizes[int(match.group(1))] = [float(match.group(2)), float(match.group(3)), 0]
    for match in re.finditer(r"^Page\s+(\d+) rot:\s+(-?\d+)", output, re.M):
        page = int(match.group(1))
        if page in sizes:
            sizes[page][2] = int(match.group(2)) % 360
    encrypted = re.search(r"^Encrypted:\s+yes", output, re.M) is not None
    return {"pages": int(pages.group(1)), "encrypted": encrypted, "sizes": {page: tuple(size) for page, size in sizes.items()}}


def view_size(size):
    """The page as displayed: the CropBox, turned by /Rotate."""
    width, height, rotate = size
    return (height, width) if rotate in (90, 270) else (width, height)


@contextlib.contextmanager
def locked(path, seconds):
    with open(path, "a") as handle:
        deadline = time.monotonic() + seconds
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise KitError("busy", "LibreOffice is busy with another file", "try again in a minute")
                time.sleep(0.2)
        yield


def file_sha1(path):
    digest = hashlib.sha1()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def office_pdf(path):
    """The office file as PDF, converted once per content (cache render/<sha1>.pdf)."""
    cached = os.path.join(cache_dir("render"), file_sha1(path) + ".pdf")
    if os.path.isfile(cached):
        os.utime(cached)
        return cached
    work = tempfile.mkdtemp(prefix="brokit-soffice-")
    try:
        # soffice names its output after the input: a plain name keeps it known.
        source = os.path.join(work, "source." + extension(path))
        shutil.copyfile(path, source)
        with locked(SOFFICE_LOCK, SOFFICE_SECONDS + 30):
            result = run(
                ["soffice", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", work, source],
                timeout=SOFFICE_SECONDS,
            )
        produced = os.path.join(work, "source.pdf")
        if result.returncode != 0 or not os.path.isfile(produced):
            raise KitError("unreadable", "LibreOffice could not open " + path)
        temporary = cached + ".tmp.%d" % os.getpid()
        shutil.copyfile(produced, temporary)
        os.replace(temporary, cached)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    prune_cache()
    return cached


def render_page(pdf, page, prefix, image_format="png", dpi=None, scale_to=None, crop=None):
    """One page through pdftoppm; returns the file written. `crop` is (x, y, w, h) in pixels of that render."""
    command = ["pdftoppm", "-cropbox", "-f", str(page), "-l", str(page), "-singlefile"]
    if dpi is not None:
        command += ["-r", "%.3f" % dpi]
    if scale_to is not None:
        command += ["-scale-to", str(scale_to)]
    if crop is not None:
        command += ["-x", str(crop[0]), "-y", str(crop[1]), "-W", str(crop[2]), "-H", str(crop[3])]
    command += ["-jpeg", "-jpegopt", "quality=90"] if image_format == "jpg" else ["-png"]
    result = run(command + [pdf, prefix], timeout=POPPLER_SECONDS)
    path = prefix + "." + image_format
    if result.returncode != 0 or not os.path.isfile(path):
        raise KitError("unreadable", "page %d of %s could not be drawn" % (page, pdf))
    return path


def main(argv):
    p = parser("render")
    p.add_argument("file")
    p.add_argument("-o", "--out", required=True)
    p.add_argument("--pages")
    p.add_argument("--dpi", type=int, default=110)
    p.add_argument("--format", choices=("png", "jpg"), default="png")
    args = p.parse_args(argv)
    need_file(args.file)
    if not 30 <= args.dpi <= 600:
        raise KitError("bad_args", "--dpi must be 30-600")
    os.makedirs(args.out, exist_ok=True)
    stem = re.sub(r"[^\w.-]+", "_", os.path.splitext(os.path.basename(args.file))[0]) or "page"
    converted = None
    source = args.file
    if is_office(args.file):
        converted = os.path.join(args.out, stem + ".pdf")
        shutil.copyfile(office_pdf(args.file), converted)
        source = converted
    elif not is_pdf(args.file):
        raise KitError("unsupported", args.file + " is not a PDF or an office file", "images: brokit img convert")
    pages = parse_pages(args.pages, pdf_info(source)["pages"])
    if len(pages) > RENDER_PAGES:
        raise KitError("too_many_pages", "%d pages at once; render at most %d" % (len(pages), RENDER_PAGES))
    from PIL import Image

    files = []
    for page in pages:
        path = render_page(source, page, os.path.join(args.out, "%s-%d" % (stem, page)), args.format, dpi=args.dpi)
        with Image.open(path) as image:
            files.append({"page": page, "path": path, "width": image.width, "height": image.height})
    return {"pdf": converted, "files": files}
