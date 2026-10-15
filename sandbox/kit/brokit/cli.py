"""Entry point of `brokit <group> <cmd> …` (sandbox/kit/README.md).

Every command prints exactly one JSON line on stdout. Exit codes: 0 — done
(`{"ok": true, …}`), 2 — a refusal or bad input (`{"ok": false, "code", "error",
"hint"}`), 1 — a bug (same shape, code "bug"), 3 — reserved for the boot
scripts (a stale or missing kit).

Commands are looked up in COMMANDS and imported lazily, so one broken module
never breaks the others and `brokit pdf info` does not import Pillow.
"""

import importlib
import sys

from brokit.util import KitError, emit, failure

# (group, command) -> (module, function, one-line usage). A function takes the
# command's argv (after the group and command words) and returns the result
# fields as a dict, or raises KitError for a refusal.
COMMANDS = {
    ("look", ""): ("brokit.look", "main", "look FILE… --out DIR [--pages S] [--grid] [--region x0,y0,x1,y1]"),
    ("render", ""): ("brokit.render", "main", "render FILE -o DIR [--pages S] [--dpi 110] [--format png|jpg]"),
    ("pdf", "info"): ("brokit.pdf.info", "main", "pdf info FILE [--password P]"),
    ("pdf", "text"): ("brokit.pdf.info", "text", "pdf text FILE [--pages S] [--layout] [-o TXT]"),
    ("pdf", "fill"): ("brokit.pdf.form", "main", "pdf fill FILE VALUES.json -o OUT [--keep-fields]"),
    ("pdf", "layout"): ("brokit.pdf.layout", "main", "pdf layout FILE [--pages S] [--marks DIR]"),
    ("pdf", "write"): ("brokit.pdf.write", "main", "pdf write FILE SPEC.json -o OUT"),
    ("pdf", "lines"): ("brokit.pdf.lines", "lines", "pdf lines FILE [--pages S]"),
    ("pdf", "retext"): ("brokit.pdf.lines", "retext", "pdf retext FILE MAP.json -o OUT"),
    ("pdf", "merge"): ("brokit.pdf.pages", "merge", "pdf merge IN… -o OUT"),
    ("pdf", "split"): ("brokit.pdf.pages", "split", "pdf split FILE -o DIR [--every N | --ranges S]"),
    ("pdf", "extract"): ("brokit.pdf.pages", "extract", "pdf extract FILE --pages S -o OUT"),
    ("pdf", "reorder"): ("brokit.pdf.pages", "reorder", "pdf reorder FILE --order 3,1,2 -o OUT"),
    ("pdf", "rotate"): ("brokit.pdf.pages", "rotate", "pdf rotate FILE --pages S --angle 90|180|270 -o OUT"),
    ("pdf", "delete"): ("brokit.pdf.pages", "delete", "pdf delete FILE --pages S -o OUT"),
    ("pdf", "insert-blank"): ("brokit.pdf.pages", "insert_blank", "pdf insert-blank FILE --after N -o OUT"),
    ("pdf", "from-images"): ("brokit.pdf.pages", "from_images", "pdf from-images IMG… -o OUT [--paper a4|fit]"),
    ("pdf", "to-images"): ("brokit.pdf.pages", "to_images", "pdf to-images FILE -o DIR [--pages S] [--dpi 150] [--format jpg|png]"),
    ("pdf", "images"): ("brokit.pdf.pages", "images", "pdf images FILE -o DIR"),
    ("pdf", "pages"): ("brokit.pdf.pages", "analyze", "pdf pages FILE --analyze"),
    ("pdf", "compress"): ("brokit.pdf.compress", "main", "pdf compress FILE -o OUT [--dpi 150] [--quality 70]"),
    ("pdf", "decrypt"): ("brokit.pdf.crypt", "decrypt", "pdf decrypt FILE [--password P] -o OUT"),
    ("pdf", "encrypt"): ("brokit.pdf.crypt", "encrypt", "pdf encrypt FILE --password P [--owner P2] [--aes 256|128] -o OUT"),
    ("pdf", "sign-spots"): ("brokit.pdf.sign", "spots", "pdf sign-spots FILE [--pages S]"),
    ("pdf", "sign-mark"): ("brokit.pdf.sign", "mark", "pdf sign-mark FILE (SPEC.json | --page N --box x0 y0 x1 y1 --role R | --adopt NAME) -o OUT"),
    ("pdf", "sign-places"): ("brokit.pdf.sign", "places", "pdf sign-places FILE [--mark-token HEX]"),
    ("pdf", "stamp-sign"): ("brokit.pdf.sign", "stamp", "pdf stamp-sign FILE PLAN.json -o OUT"),
    ("img", "signature"): ("brokit.img.signature", "main", "img signature PHOTO -o PNG [--preview PNG] [--height 240]"),
    ("img", "scan"): ("brokit.img.scan", "main", "img scan PHOTO… -o OUT.pdf|png [--corners x,y,x,y,x,y,x,y] [--mode color|gray|bw] [--paper a4|auto]"),
    ("img", "idphoto"): ("brokit.img.idphoto", "main", "img idphoto PHOTO [--eyes x1,y1,x2,y2] [--chin y] [--size 35x45] [--sheet 10x15] -o OUT"),
    ("img", "convert"): ("brokit.img.basic", "convert", "img convert IN -o OUT"),
    ("img", "resize"): ("brokit.img.basic", "resize", "img resize IN -o OUT (--max PX | --width W | --height H)"),
    ("img", "rotate"): ("brokit.img.basic", "rotate", "img rotate IN --angle DEG -o OUT"),
    ("img", "crop"): ("brokit.img.basic", "crop", "img crop IN --box x0,y0,x1,y1 -o OUT"),
    ("docx", "fill"): ("brokit.office.word", "fill", "docx fill TPL VALUES.json -o OUT"),
    ("docx", "edit"): ("brokit.office.word", "edit", "docx edit FILE EDITS.json -o OUT [--author Бро] [--date ISO]"),
    ("docx", "compare"): ("brokit.office.word", "compare", "docx compare A B -o REDLINE [--author Бро]"),
    ("docx", "text"): ("brokit.office.word", "text", "docx text FILE [--changes accept|reject]"),
    ("xlsx", "inspect"): ("brokit.office.sheet", "inspect", "xlsx inspect FILE"),
    ("xlsx", "recalc"): ("brokit.office.sheet", "recalc", "xlsx recalc FILE -o OUT [--check]"),
    ("csv", "sniff"): ("brokit.office.sheet", "sniff", "csv sniff FILE"),
    ("zip", "unpack"): ("brokit.zipx", "unpack", "zip unpack ARCHIVE -o DIR"),
    ("zip", "pack"): ("brokit.zipx", "pack", "zip pack DIR -o OUT.zip"),
    ("files", "survey"): ("brokit.survey", "main", "files survey DIR"),
    ("ru", "decline"): ("brokit.ru.decline", "main", 'ru decline "Фамилия Имя [Отчество]" --case gen|dat|acc|ins|pre [--gender auto|m|f] [--order fio|if] [--file NAMES.txt]'),
    ("ru", "amount"): ("brokit.ru.amount", "main", "ru amount N [--kop K] [--currency rub|none]"),
    ("qr", ""): ("brokit.qr", "main", "qr (--gost FIELDS.json | --text T) -o OUT.png|pdf [--size-mm 30]"),
}

GROUPS = sorted({group for group, _ in COMMANDS})


def usage(group=None):
    lines = [
        "brokit " + text
        for (g, _), (_, _, text) in sorted(COMMANDS.items())
        if group is None or g == group
    ]
    return "\n".join(lines)


def resolve(argv):
    """The command for argv and the argv left for it, or None."""
    if not argv:
        return None
    group = argv[0]
    if (group, "") in COMMANDS:
        return COMMANDS[(group, "")], argv[1:]
    if len(argv) > 1 and (group, argv[1]) in COMMANDS:
        return COMMANDS[(group, argv[1])], argv[2:]
    return None


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(usage())
        return 0
    if len(argv) >= 2 and argv[0] in GROUPS and argv[1] in ("-h", "--help"):
        print(usage(argv[0]))
        return 0
    found = resolve(argv)
    if found is None:
        group = argv[0] if argv[0] in GROUPS else None
        return failure(
            KitError(
                "unknown_command",
                "unknown command: " + " ".join(argv[:2]),
                usage(group).replace("\n", "; "),
            )
        )
    (module_name, function_name, _), rest = found
    try:
        function = getattr(importlib.import_module(module_name), function_name)
        result = function(rest)
    except KitError as error:
        return failure(error)
    except SystemExit as error:
        # argparse refusals (bad flags) exit with code 2 and print to stderr.
        if error.code in (0, None):
            return 0
        return failure(KitError("bad_args", "bad arguments", "brokit " + argv[0] + " --help"))
    except MemoryError:
        return failure(KitError("unreadable", "the file needs more memory than the kit allows"))
    except Exception as error:  # noqa: BLE001 — every bug still prints one JSON line
        return failure(KitError("bug", type(error).__name__ + ": " + str(error)[:300]), code=1)
    emit(dict({"ok": True}, **(result or {})))
    return 0
