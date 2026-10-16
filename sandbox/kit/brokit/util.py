"""Shared plumbing of the kit: JSON output, refusals, page specs, limits.

Group-specific helpers live in their own groups (PDF geometry in
brokit/pdf/geom.py); keep this module small so every command can import it.
"""

import argparse
import json
import os
import subprocess
import sys

LIST_CAP = 200


class KitError(Exception):
    """A refusal or bad input: exit 2 with a code the caller can act on."""

    def __init__(self, code, error, hint=None, **extra):
        super().__init__(error)
        self.code = code
        self.error = error
        self.hint = hint
        self.extra = extra


def _capped(value):
    if isinstance(value, dict):
        return {key: _capped(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        items = [_capped(item) for item in value[:LIST_CAP]]
        if len(value) > LIST_CAP:
            items.append({"more": len(value) - LIST_CAP})
        return items
    return value


def emit(payload):
    sys.stdout.write(json.dumps(_capped(payload), ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def failure(error, code=2):
    payload = {"ok": False, "code": error.code, "error": error.error}
    if error.hint:
        payload["hint"] = error.hint
    payload.update(error.extra)
    emit(payload)
    sys.stderr.write("brokit: " + error.error + "\n")
    return code


class Parser(argparse.ArgumentParser):
    """argparse that refuses with a KitError instead of printing usage."""

    def error(self, message):
        raise KitError("bad_args", message, self.format_usage().strip())


def parser(prog):
    return Parser(prog="brokit " + prog, add_help=True)


def parse_pages(spec, total):
    """1-based page numbers of "1-3,5", "4-" or None (all), within 1..total."""
    if spec is None or spec == "":
        return list(range(1, total + 1))
    pages = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            if "-" in part:
                start_text, end_text = part.split("-", 1)
                start = int(start_text) if start_text else 1
                end = int(end_text) if end_text else total
            else:
                start = end = int(part)
        except ValueError:
            raise KitError("bad_pages", "bad page spec: " + spec, 'like "1-3,5" or "4-"')
        if start < 1 or end > total or start > end:
            raise KitError("bad_pages", "pages %s are outside 1-%d" % (part, total))
        pages.extend(range(start, end + 1))
    return pages


def need_file(path):
    if not os.path.isfile(path):
        directory = os.path.dirname(path) or "."
        siblings = sorted(os.listdir(directory))[:10] if os.path.isdir(directory) else []
        raise KitError("not_found", "no such file: " + path, "files there: " + ", ".join(siblings) if siblings else None)
    return path


def out_path(output, *inputs):
    """Refuses to overwrite an input and makes the parent directory."""
    real = os.path.realpath(output)
    for source in inputs:
        if source and os.path.realpath(source) == real:
            raise KitError("bad_output", "the output must differ from the input: " + output)
    parent = os.path.dirname(real)
    if parent:
        os.makedirs(parent, exist_ok=True)
    return output


def run(command, timeout=60, input_bytes=None):
    """A subprocess with a timeout; returns CompletedProcess (bytes)."""
    try:
        return subprocess.run(command, input=input_bytes, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise KitError("timeout", "%s took longer than %d s" % (command[0], timeout))
    except FileNotFoundError:
        raise KitError("unavailable", command[0] + " is not installed in this sandbox")


STREAM_CAP = 64 * 1024 * 1024


def limits():
    """Bounds for hostile input (W2 spec §5.0): memory and pypdf stream caps.

    pypdf 6 reads its caps from `overwrite_configuration`; the old constants
    of pypdf.filters are deprecated. A cap hit raises inside pypdf, and the
    command reports the file `unreadable`.
    """
    try:
        import resource

        cap = 768 * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (cap, cap))
    except (ImportError, ValueError, OSError):
        pass  # gVisor may refuse; the sandbox's own memory bound stays
    try:
        import pypdf
    except ImportError:
        return
    pypdf.overwrite_configuration(
        maximum_declared_stream_length=STREAM_CAP,
        array_based_stream_maximum_output_length=STREAM_CAP,
        jbig2_maximum_output_length=STREAM_CAP,
        lzw_maximum_output_length=STREAM_CAP,
        run_length_maximum_output_length=STREAM_CAP,
        zlib_maximum_output_length=STREAM_CAP,
        image_maximum_buffer_size=STREAM_CAP,
    )


def read_json(path):
    need_file(path)
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (ValueError, UnicodeDecodeError) as error:
        raise KitError("bad_json", "%s is not valid JSON: %s" % (path, error))


def cache_root():
    """The kit's cache: /workspace/.bro/cache, or BROKIT_CACHE (tests)."""
    return os.environ.get("BROKIT_CACHE") or "/workspace/.bro/cache"


def cache_dir(kind):
    """One kind of the cache (render, layout), made if missing."""
    path = os.path.join(cache_root(), kind)
    os.makedirs(path, exist_ok=True)
    return path


def prune_cache(limit=50 * 1024 * 1024):
    """Keeps the whole cache under `limit` bytes, the oldest files going first."""
    entries = []
    for directory, _, names in os.walk(cache_root()):
        for name in names:
            path = os.path.join(directory, name)
            try:
                info = os.stat(path)
            except OSError:
                continue
            entries.append((info.st_mtime, info.st_size, path))
    total = sum(size for _, size, _ in entries)
    for _, size, path in sorted(entries):
        if total <= limit:
            break
        try:
            os.remove(path)
            total -= size
        except OSError:
            pass
