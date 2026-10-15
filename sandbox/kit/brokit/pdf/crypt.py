"""Opening and writing PDFs (every pdf command goes through here), `pdf decrypt`, `pdf encrypt`.

Opening installs the kit's AES (brokit/aes.py) first, refuses what is not a PDF, and opens a
PDF whose user password is empty without asking (with a warning: the output is not
encrypted). Passwords never appear in the JSON or in errors.
"""

import contextlib
import os

from brokit.util import KitError, need_file, out_path, parser

PDF_ERRORS = (ValueError, KeyError, IndexError, TypeError, AttributeError, RecursionError, AssertionError)


def kit_version():
    """The kit's content hash from the VERSION file the delivery writes beside the package."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "VERSION")
    try:
        with open(path, encoding="ascii") as handle:
            return handle.read().strip()[:16] or "dev"
    except OSError:
        return "dev"


def _pdf_errors():
    from pypdf.errors import PyPdfError

    return PDF_ERRORS + (PyPdfError,)


def unreadable(error):
    return KitError("unreadable", "the PDF cannot be read: %s" % (type(error).__name__,), "re-save it (print to PDF) or render it")


@contextlib.contextmanager
def parsing():
    """Inside it, a parse error of a broken PDF becomes the `unreadable` refusal (exit 2), not a bug."""
    try:
        yield
    except _pdf_errors() as error:
        raise unreadable(error)


def open_pdf(path, password=None, warnings=None, max_pages=None, decrypt=True):
    """A PdfReader of `path`.

    decrypt=False returns an encrypted reader as it is (the caller reports it); otherwise an
    empty user password opens transparently (warning `encrypted_empty_password`), `password`
    is tried when given, and anything else refuses with `encrypted` / `bad_password`.
    """
    from brokit import aes

    need_file(path)
    with open(path, "rb") as handle:
        head = handle.read(1024)
    if b"%PDF-" not in head:
        raise KitError("not_pdf", "not a PDF: " + os.path.basename(path), "for images use img commands; office files: brokit render")
    aes.install()
    from pypdf import PdfReader

    try:
        reader = PdfReader(path, strict=False)
        encrypted = reader.is_encrypted
        if encrypted and decrypt:
            opened = reader.decrypt(password) if password else 0
            if not opened and reader.decrypt(""):
                if warnings is not None:
                    warnings.append("encrypted_empty_password: opened without a password; outputs are not encrypted")
            elif not opened and password:
                raise KitError("bad_password", "the password does not open this PDF", "check it with the person")
            elif not opened:
                raise KitError(
                    "encrypted",
                    "the PDF needs a password",
                    "ask the person for it, then brokit pdf decrypt FILE --password P -o OUT",
                )
        count = len(reader.pages) if not encrypted or decrypt else None
    except KitError:
        raise
    except MemoryError:
        raise KitError("unreadable", "the PDF needs more memory than the kit allows")
    except _pdf_errors() as error:
        raise unreadable(error)
    if max_pages is not None and count is not None and count > max_pages:
        raise KitError("unreadable", "the PDF has %d pages, more than %d" % (count, max_pages), "split it first")
    return reader


def writer_from(reader):
    from pypdf import PdfWriter

    try:
        return PdfWriter(clone_from=reader)
    except _pdf_errors() as error:
        raise unreadable(error)


def write_pdf(writer, output, producer=None):
    """Writes atomically (temp file + rename) with /Producer; returns the size in bytes."""
    writer.add_metadata({"/Producer": producer or "brokit " + kit_version()})
    temporary = "%s.tmp-%d" % (output, os.getpid())
    try:
        with open(temporary, "wb") as handle:
            writer.write(handle)
        os.replace(temporary, output)
    except _pdf_errors() as error:
        raise unreadable(error)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return os.path.getsize(output)


def algorithm(reader):
    """'RC4-40', 'RC4-128', 'AES-128', 'AES-256' or None for an unencrypted PDF."""
    if not reader.is_encrypted:
        return None
    try:
        encrypt = reader.trailer["/Encrypt"].get_object()
        version = int(encrypt.get("/V", 0))
        if version >= 5:
            return "AES-256"
        if version == 4:
            filters = encrypt.get("/CF", {}).get_object()
            method = filters.get(encrypt.get("/StmF", "/StdCF"), {}).get_object().get("/CFM")
            return "AES-128" if method == "/AESV2" else "RC4-128"
        if version in (2, 3):
            return "RC4-%d" % int(encrypt.get("/Length", 40))
        return "RC4-40"
    except (KeyError, AttributeError, TypeError, ValueError):
        return "unknown"


def decrypt(argv):
    args = parser("pdf decrypt")
    args.add_argument("file")
    args.add_argument("--password")
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    output = out_path(options.output, options.file)
    warnings = []
    reader = open_pdf(options.file, password=options.password, warnings=warnings)
    method = algorithm(reader)
    if method is None:
        warnings.append("not_encrypted: the PDF had no password; copied as it is")
    write_pdf(writer_from(reader), output)
    return {"output": output, "algorithm": method, "pages": len(reader.pages), "warnings": warnings}


def encrypt(argv):
    args = parser("pdf encrypt")
    args.add_argument("file")
    args.add_argument("--password", required=True)
    args.add_argument("--owner")
    args.add_argument("--aes", choices=("256", "128"), default="256")
    args.add_argument("-o", "--output", required=True)
    options = args.parse_args(argv)
    if not options.password:
        raise KitError("bad_args", "an empty password protects nothing", "pass --password with the password to set")
    output = out_path(options.output, options.file)
    warnings = []
    reader = open_pdf(options.file, warnings=warnings)
    writer = writer_from(reader)
    method = "AES-" + options.aes
    writer.encrypt(user_password=options.password, owner_password=options.owner or None, algorithm=method)
    write_pdf(writer, output)
    return {"output": output, "algorithm": method, "pages": len(reader.pages), "warnings": warnings}
