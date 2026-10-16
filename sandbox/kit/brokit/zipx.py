"""brokit zip unpack / pack: archives people send, unpacked safely.

unpack: Windows and old Russian archivers write names in cp866 without the
UTF-8 flag (bit 11), so Python shows them as cp437 mojibake; those names are
re-decoded (UTF-8 when valid, else cp866 when it gives Cyrillic). Nested zips
unpack into a folder named like the archive («старое.zip/»), three levels deep.
Absolute and «..» paths and symlinks are refused; encrypted entries are listed
and left. The ACTUAL unpacked size is capped (the inbound check saw only the
declared sizes). RAR and 7z are refused: the sandbox cannot open them. An
entry the file system refuses (a file where the archive also has a folder) is
listed in `skipped` and the rest still unpacks; names over 255 bytes (long
Cyrillic names from Windows) are shortened, the extension kept.

pack: UTF-8 names (bit 11), sorted, deflated — opens on every system.
"""

import os
import posixpath
import shutil
import stat
import time

from brokit.util import KitError, need_file, out_path, parser

MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 5000
MAX_DEPTH = 3
# NAME_MAX is 255 bytes; «name (12).ext» needs a few more.
NAME_BYTES = 240
CHUNK = 1024 * 1024
UTF8_FLAG = 0x800
ENCRYPTED_FLAG = 0x1
RAR_MAGIC = (b"Rar!\x1a\x07",)
SEVEN_ZIP_MAGIC = b"7z\xbc\xaf\x27\x1c"


def unpack(argv):
    p = parser("zip unpack")
    p.add_argument("archive")
    p.add_argument("-o", "--output", required=True)
    args = p.parse_args(argv)
    need_file(args.archive)
    if os.path.realpath(args.output) == os.path.realpath(args.archive) or os.path.isfile(args.output):
        raise KitError("bad_output", "the output must be a directory, not a file")
    os.makedirs(args.output, exist_ok=True)
    job = Unpack(args.output)
    try:
        job.archive(args.archive, "", 1)
    except KitError:
        job.undo()
        raise
    return {
        "output": args.output,
        "files": job.files,
        "nested": job.nested,
        "encrypted": job.encrypted,
        "skipped": job.skipped,
        "renamed_encoding": job.encoding,
        "bytes": job.total,
    }


def check_magic(path):
    with open(path, "rb") as handle:
        head = handle.read(8)
    if head.startswith(RAR_MAGIC) or head.startswith(SEVEN_ZIP_MAGIC):
        raise KitError(
            "unsupported",
            "RAR and 7z archives cannot be opened here",
            "ask for a ZIP: in WinRAR or 7-Zip choose «Add to archive» and the ZIP format",
        )


TYPOGRAPHY = set("№«»—–…“”„‘’·")


def plausible(text):
    """Every non-ASCII character is Cyrillic, a Latin letter or typography."""
    return all(
        char.isascii() or "\u0400" <= char <= "\u04ff" or "\u00c0" <= char <= "\u024f" or char in TYPOGRAPHY
        for char in text
    )


def decoded_name(info):
    """(name, encoding) of a zip entry: utf-8, cp866 or as stored.

    cp866 bytes are sometimes valid UTF-8 too («чек» reads as «祪»), so a
    decoding counts only when it gives letters a person would write.
    """
    if info.flag_bits & UTF8_FLAG:
        return info.filename, None
    try:
        raw = info.filename.encode("cp437")
    except UnicodeEncodeError:
        return info.filename, None
    if raw.isascii():
        return info.filename, None
    try:
        utf8 = raw.decode("utf-8")
    except UnicodeDecodeError:
        utf8 = None
    if utf8 is not None and plausible(utf8):
        return utf8, "utf-8"
    cp866 = raw.decode("cp866", errors="replace")
    if plausible(cp866):
        return cp866, "cp866"
    return info.filename, None


def safe_parts(name):
    """Path components of an entry name, or None when it escapes the folder."""
    name = name.replace("\\", "/")
    if name.startswith("/") or (len(name) > 1 and name[1] == ":"):
        return None
    parts = [part for part in name.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        return None
    return [fit_name(part) for part in parts]


def fit_name(part):
    """A name Linux can store (255 bytes): Windows counts 255 characters, and Cyrillic takes two bytes each.

    The stem is cut, the extension kept, and room left for «(2)» of a repeated name.
    """
    if len(part.encode("utf-8")) <= NAME_BYTES:
        return part
    stem, ext = os.path.splitext(part)
    if len(ext.encode("utf-8")) > 16:
        stem, ext = part, ""
    while stem and len((stem + "…" + ext).encode("utf-8")) > NAME_BYTES:
        stem = stem[:-1]
    return stem + "…" + ext


def is_symlink(info):
    return stat.S_ISLNK(info.external_attr >> 16)


class Unpack:
    def __init__(self, root):
        self.root = root
        self.files = []
        self.nested = []
        self.encrypted = []
        self.skipped = []
        self.encodings = set()
        self.total = 0
        self.entries = 0
        self.created = []

    @property
    def encoding(self):
        if "cp866" in self.encodings:
            return "cp866"
        if "utf-8" in self.encodings:
            return "utf-8"
        return "none"

    def undo(self):
        for path in reversed(self.created):
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path, ignore_errors=True)
            elif os.path.lexists(path):
                os.remove(path)

    def target(self, prefix, parts):
        relative = posixpath.join(prefix, *parts) if prefix else posixpath.join(*parts)
        return os.path.join(self.root, relative)

    def free_target(self, prefix, parts):
        """A path for a file that does not overwrite anything: «name (2).ext»."""
        path = self.target(prefix, parts)
        base, ext = os.path.splitext(path)
        n = 2
        while os.path.lexists(path):
            path = "%s (%d)%s" % (base, n, ext)
            n += 1
        return path

    def archive(self, path, prefix, depth):
        import zipfile

        check_magic(path)
        try:
            archive = zipfile.ZipFile(path)
        except Exception as error:  # noqa: BLE001 — a damaged central directory fails in many ways
            raise KitError("unreadable", "not a readable ZIP archive: " + str(error)[:120])
        with archive:
            infos = archive.infolist()
            self.entries += len(infos)
            if self.entries > MAX_ENTRIES:
                raise KitError("too_big", "more than %d files in the archive" % MAX_ENTRIES)
            for info in infos:
                try:
                    self.entry(archive, info, prefix, depth)
                except OSError as error:
                    # A name the file system refuses, a file where the archive
                    # also has a folder: that entry is left, the rest unpacks.
                    name = decoded_name(info)[0]
                    self.skipped.append(
                        {
                            "name": posixpath.join(prefix, name) if prefix else name,
                            "why": "cannot write: " + (error.strerror or type(error).__name__),
                        }
                    )

    def entry(self, archive, info, prefix, depth):
        name, encoding = decoded_name(info)
        shown = posixpath.join(prefix, name) if prefix else name
        if encoding:
            self.encodings.add(encoding)
        parts = safe_parts(name)
        if parts is None:
            self.skipped.append({"name": shown, "why": "path leaves the folder"})
            return
        if not parts:
            return
        if is_symlink(info):
            self.skipped.append({"name": shown, "why": "symlink"})
            return
        if info.is_dir() or name.endswith(("/", "\\")):
            directory = self.target(prefix, parts)
            if not os.path.lexists(directory):
                os.makedirs(directory)
                self.created.append(directory)
            return
        if info.flag_bits & ENCRYPTED_FLAG:
            self.encrypted.append(shown)
            return
        destination = self.free_target(prefix, parts)
        parent = os.path.dirname(destination)
        if not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
            self.created.append(parent)
        written = self.copy(archive, info, destination, shown)
        if written is None:
            return
        relative = os.path.relpath(destination, self.root).replace(os.sep, "/")
        if depth < MAX_DEPTH and name.lower().endswith(".zip") and self.is_zip(destination):
            if self.nested_archive(destination, relative, depth, shown):
                self.total -= written
                return
        if info.date_time[0] >= 1980:
            try:
                mtime = time.mktime(info.date_time + (0, 0, -1))
                os.utime(destination, (mtime, mtime))
            except (OverflowError, ValueError):
                pass
        self.files.append({"from": shown, "to": relative, "bytes": written})

    def nested_archive(self, destination, relative, depth, shown):
        """Unpacks a zip inside the archive into a folder of its name; False leaves it a plain file."""
        import tempfile

        handle, packed = tempfile.mkstemp(prefix=".brokit-nested-", suffix=".zip", dir=os.path.dirname(destination))
        os.close(handle)
        os.replace(destination, packed)
        self.created.append(packed)
        os.makedirs(destination)
        self.created.append(destination)
        self.nested.append(relative)
        try:
            self.archive(packed, relative, depth + 1)
        except KitError as error:
            if error.code not in ("unreadable", "unsupported"):
                raise
            # It failed to open, so nothing was written into the folder yet.
            self.nested.remove(relative)
            os.rmdir(destination)
            os.replace(packed, destination)
            self.skipped.append({"name": shown, "why": "inner archive not unpacked: " + error.error})
            return False
        finally:
            if os.path.lexists(packed):
                os.remove(packed)
        return True

    @staticmethod
    def is_zip(path):
        import zipfile

        return zipfile.is_zipfile(path)

    def copy(self, archive, info, destination, shown):
        """Bytes written, or None when the entry is damaged (listed in skipped)."""
        import zipfile
        import zlib

        written = 0
        self.created.append(destination)
        try:
            with archive.open(info) as source, open(destination, "wb") as sink:
                while True:
                    chunk = source.read(CHUNK)
                    if not chunk:
                        break
                    written += len(chunk)
                    self.total += len(chunk)
                    if self.total > MAX_TOTAL_BYTES:
                        raise KitError(
                            "too_big", "the archive unpacks to more than %d MB" % (MAX_TOTAL_BYTES // 2**20)
                        )
                    sink.write(chunk)
        except (zipfile.BadZipFile, EOFError, NotImplementedError, zlib.error, OSError) as error:
            # A damaged entry, an unknown compression or a name the file
            # system refuses: the rest still unpacks.
            self.total -= written
            if os.path.lexists(destination):
                os.remove(destination)
            self.created.remove(destination)
            reason = error.strerror if isinstance(error, OSError) and error.strerror else str(error)[:80]
            self.skipped.append({"name": shown, "why": "not unpacked: " + reason})
            return None
        os.chmod(destination, 0o644)
        return written


def pack(argv):
    import zipfile

    p = parser("zip pack")
    p.add_argument("directory")
    p.add_argument("-o", "--output", required=True)
    args = p.parse_args(argv)
    if not os.path.isdir(args.directory):
        raise KitError("not_found", "no such directory: " + args.directory)
    out_path(args.output)
    output_real = os.path.realpath(args.output)
    names = []
    for folder, dirs, files in os.walk(args.directory):
        dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(folder, d)))
        for name in files:
            path = os.path.join(folder, name)
            # Only regular files: a symlink could pull in a file from outside
            # the folder, and reading a FIFO would hang.
            if os.path.islink(path) or not os.path.isfile(path) or os.path.realpath(path) == output_real:
                continue
            names.append(os.path.relpath(path, args.directory).replace(os.sep, "/"))
    names.sort()
    total = 0
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name in names:
            path = os.path.join(args.directory, name)
            # A file dated before 1980 (a copy that lost its date) gets 1980-01-01
            # instead of an error: ZIP has no earlier dates.
            info = zipfile.ZipInfo.from_file(path, name, strict_timestamps=False)
            info.compress_type = zipfile.ZIP_DEFLATED
            if not name.isascii():
                info.flag_bits |= UTF8_FLAG
            with open(path, "rb") as source, archive.open(info, "w") as sink:
                shutil.copyfileobj(source, sink, CHUNK)
            total += os.path.getsize(path)
    return {"output": args.output, "files": len(names), "bytes": total, "zip_bytes": os.path.getsize(args.output)}
