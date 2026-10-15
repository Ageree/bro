"""brokit img convert / resize / rotate / crop.

Pillow with the EXIF orientation applied first, so «up» is what the person saw.
The output format follows the extension; JPEG gets RGB on white. HEIC is not
readable here (no decoder in the sandbox): `unsupported` asks for a JPEG.
"""

import os

from brokit import producer
from brokit.img.raster import MAX_PIXELS, refuse_heic
from brokit.util import KitError, need_file, out_path, parser

FORMATS = {
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".png": "PNG",
    ".webp": "WEBP",
    ".tif": "TIFF",
    ".tiff": "TIFF",
    ".bmp": "BMP",
    ".gif": "GIF",
    ".pdf": "PDF",
}


def load(path):
    from PIL import Image, ImageOps

    need_file(path)
    refuse_heic(path)
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        image = Image.open(path)
        image.load()
        return ImageOps.exif_transpose(image)
    except Exception as error:  # noqa: BLE001 — Pillow raises many types on a broken or hostile file
        raise KitError("unreadable", "cannot read the image: %s: %s" % (type(error).__name__, str(error)[:120]))


def target_format(output):
    ext = os.path.splitext(output)[1].lower()
    if ext not in FORMATS:
        raise KitError("bad_output", "unknown image type: " + (ext or output), ", ".join(sorted(FORMATS)))
    return FORMATS[ext]


def write(image, output, quality):
    from PIL import Image

    fmt = target_format(output)
    options = {}
    if fmt in ("JPEG", "PDF") and image.mode not in ("RGB", "L"):
        if image.mode in ("RGBA", "LA", "P"):
            rgba = image.convert("RGBA")
            flat = Image.new("RGB", rgba.size, (255, 255, 255))
            flat.paste(rgba, mask=rgba.split()[3])
            image = flat
        else:
            image = image.convert("RGB")
    if fmt in ("JPEG", "WEBP"):
        options["quality"] = quality
    if fmt == "JPEG":
        options["optimize"] = True
    if fmt == "PNG":
        options["optimize"] = True
    dpi = image.info.get("dpi")
    if dpi and fmt in ("JPEG", "PNG", "TIFF"):
        options["dpi"] = dpi
    if fmt == "PDF":
        options["resolution"] = float(dpi[0]) if dpi else 150.0
        options["producer"] = producer()
    image.save(output, fmt, **options)
    return {"output": output, "width": image.width, "height": image.height, "bytes": os.path.getsize(output)}


def common(prog):
    p = parser(prog)
    p.add_argument("input")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--quality", type=int, default=88)
    return p


def convert(argv):
    args = common("img convert").parse_args(argv)
    out_path(args.output, args.input)
    return write(load(args.input), args.output, args.quality)


def resize(argv):
    from PIL import Image

    p = common("img resize")
    p.add_argument("--max", type=int, help="longest side in px")
    p.add_argument("--width", type=int)
    p.add_argument("--height", type=int)
    args = p.parse_args(argv)
    out_path(args.output, args.input)
    image = load(args.input)
    if args.max:
        scale = min(1.0, args.max / max(image.size))
        size = (round(image.width * scale), round(image.height * scale))
    elif args.width and args.height:
        size = (args.width, args.height)
    elif args.width:
        size = (args.width, round(image.height * args.width / image.width))
    elif args.height:
        size = (round(image.width * args.height / image.height), args.height)
    else:
        raise KitError("bad_args", "give --max, --width or --height")
    if min(size) < 1 or max(size) > 20000:
        raise KitError("bad_args", "the size is out of range")
    if size != image.size:
        image = image.resize(size, Image.LANCZOS)
    return write(image, args.output, args.quality)


def rotate(argv):
    from PIL import Image

    p = common("img rotate")
    p.add_argument("--angle", type=float, required=True, help="degrees counter-clockwise")
    args = p.parse_args(argv)
    out_path(args.output, args.input)
    image = load(args.input)
    turns = {90: Image.ROTATE_90, 180: Image.ROTATE_180, 270: Image.ROTATE_270}
    angle = args.angle % 360 if args.angle % 90 == 0 else args.angle
    if angle in turns:
        image = image.transpose(turns[angle])
    elif angle:
        fill = (255, 255, 255) if image.mode == "RGB" else None
        image = image.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=fill)
    return write(image, args.output, args.quality)


def crop(argv):
    p = common("img crop")
    p.add_argument("--box", required=True, help="x0,y0,x1,y1 in pixels (as look shows them)")
    args = p.parse_args(argv)
    out_path(args.output, args.input)
    image = load(args.input)
    try:
        x0, y0, x1, y1 = (round(float(v)) for v in args.box.split(","))
    except ValueError:
        raise KitError("bad_args", "--box is x0,y0,x1,y1")
    x0, x1 = sorted((max(0, x0), min(image.width, x1)))
    y0, y1 = sorted((max(0, y0), min(image.height, y1)))
    if x1 - x0 < 1 or y1 - y0 < 1:
        raise KitError("bad_box", "the box is outside the image (%dx%d)" % image.size)
    return write(image.crop((x0, y0, x1, y1)), args.output, args.quality)
