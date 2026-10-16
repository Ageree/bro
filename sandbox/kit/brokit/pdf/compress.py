"""`pdf compress`: smaller pictures, shared duplicates, compressed streams (W2 spec §6.8).

A JPEG or Flate picture (RGB or gray) of ≥ 50 KB is resized when it has more pixels than
`--dpi` over the page needs, and re-encoded as JPEG at `--quality`; a heavy JPEG that is not
oversized is only re-encoded, and kept as it was when that does not make it smaller. JBIG2,
CCITT, pictures with a soft mask and CMYK pictures stay untouched, as do signatures' fields.
Then identical objects are merged and content streams compressed.
"""

import io
import os

from brokit.pdf import crypt, geom
from brokit.util import KitError, out_path, parser

MIN_BYTES = 50 * 1024


def _filters(stream):
    filters = stream.get("/Filter")
    if filters is None:
        return []
    filters = filters.get_object()
    return [str(f) for f in (filters if isinstance(filters, list) else [filters])]


def _skip_reason(stream):
    names = _filters(stream)
    if any(name in ("/JBIG2Decode", "/CCITTFaxDecode", "/JPXDecode") for name in names):
        return "codec"
    if "/SMask" in stream or "/Mask" in stream:
        return "mask"
    colour_space = stream.get("/ColorSpace")
    target = colour_space.get_object() if colour_space is not None else None
    if target == "/DeviceCMYK":
        return "cmyk"
    if isinstance(target, list) and target and target[0] == "/ICCBased" and int(target[1].get_object().get("/N", 3)) == 4:
        return "cmyk"
    if int(stream.get("/BitsPerComponent", 8) or 8) != 8:
        return "bits"
    if not set(names) <= {"/DCTDecode", "/FlateDecode", "/ASCII85Decode", "/ASCIIHexDecode"}:
        return "codec"
    return None


def main(argv):
    args = parser("pdf compress")
    args.add_argument("file")
    args.add_argument("-o", "--output", required=True)
    args.add_argument("--dpi", type=int, default=150)
    args.add_argument("--quality", type=int, default=70)
    options = args.parse_args(argv)
    if not 50 <= options.dpi <= 600 or not 20 <= options.quality <= 95:
        raise KitError("bad_args", "--dpi 50-600, --quality 20-95")
    output = out_path(options.output, options.file)
    warnings = []
    reader = crypt.open_pdf(options.file, warnings=warnings)
    writer = crypt.writer_from(reader)
    recompressed, skipped, seen = 0, 0, set()
    for page in writer.pages:
        width, height = geom.view_size(page)
        limit = (max(width, height) / 72 * options.dpi, min(width, height) / 72 * options.dpi)
        try:
            found = list(page.images)
        except crypt.pdf_errors() + (OSError,):
            warnings.append("an image could not be decoded; left as it was")
            continue
        for image in found:
            reference = image.indirect_reference
            if reference is None or reference.idnum in seen:
                continue
            seen.add(reference.idnum)
            changed = _shrink(image, reference.get_object(), limit, options.quality)
            if changed is None:
                skipped += 1
            elif changed:
                recompressed += 1
    writer.compress_identical_objects(remove_duplicates=True, remove_unreferenced=True)
    for page in writer.pages:
        page.compress_content_streams()
    crypt.write_pdf(writer, output)
    before, after = os.path.getsize(options.file), os.path.getsize(output)
    if after >= before:
        warnings.append("no_gain: the PDF did not get smaller; try --dpi 110 --quality 55")
    return {"output": output, "before": before, "after": after, "images_recompressed": recompressed, "skipped": skipped, "warnings": warnings}


def _shrink(image, stream, limit, quality):
    """True when replaced, False when left (small or no gain), None when the kind is skipped."""
    from PIL import Image

    raw = len(stream._data) if hasattr(stream, "_data") and stream._data is not None else 0
    if raw < MIN_BYTES:
        return False
    if _skip_reason(stream):
        return None
    picture = image.image
    if picture is None or picture.mode not in ("RGB", "L"):
        return None
    long_limit, short_limit = limit
    long_side, short_side = max(picture.size), min(picture.size)
    scale = min(1.0, long_limit / long_side, short_limit / short_side)
    jpeg = "/DCTDecode" in _filters(stream)
    if scale >= 0.98 and jpeg and raw / (picture.width * picture.height) < 0.35:
        return False
    if scale < 0.98:
        picture = picture.resize((max(1, round(picture.width * scale)), max(1, round(picture.height * scale))), Image.LANCZOS)
    probe = io.BytesIO()
    picture.save(probe, "JPEG", quality=quality, optimize=True)
    if probe.tell() >= raw * 0.95:
        return False
    image.replace(picture, quality=quality)
    return True
