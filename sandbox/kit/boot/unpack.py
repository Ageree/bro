"""Boot: write Bro's kit into the task sandbox (`ensureKit`, agent/lib/sandbox/kit.ts).

Runs as `python3 -I -c "import os;exec(os.environ['BROKIT_BOOT'])"` with
BROKIT_HOME (/workspace/.bro), BROKIT_EXPECT (the kit version) and
BROKIT_MANIFEST, the JSON file Bro just wrote: {"version", "files": [[path,
text], …]}. Under an exclusive lock on kit.lock it hashes the kit on disk
again (a parallel call may have written it meanwhile), else checks the
manifest against its own hash and the expected version, writes it to
kit.new.<nonce>/ with VERSION last, swaps the directories by rename and
rewrites bin/brokit. The manifest is deleted either way. Prints one JSON
line, {"state": "current" | "written"}; any failure exits 1 with the reason
on stderr.
"""

import errno
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import time

SAFE_PATH = re.compile(r"^/[\w/.-]+$")
KIT_FILE = re.compile(r"^brokit/[a-z0-9_/]+\.py$")
LOCK_SECONDS = 20


def kit_hash(kit):
    """16 hex of sha256 over `relpath \\0 content \\0` of kit/brokit/**.py, sorted; None if unreadable."""
    root = os.path.join(kit, "brokit")
    if not os.path.isdir(root) or os.path.islink(root):
        return None
    files = []
    for directory, subdirectories, names in os.walk(root):
        subdirectories[:] = [name for name in subdirectories if name != "__pycache__"]
        for name in subdirectories + names:
            if os.path.islink(os.path.join(directory, name)):
                return None
        for name in names:
            if name.endswith(".py"):
                path = os.path.join(directory, name)
                files.append(("brokit/" + os.path.relpath(path, root).replace(os.sep, "/"), path))
    digest = hashlib.sha256()
    for relative, path in sorted(files):
        with open(path, "rb") as handle:
            digest.update(relative.encode("utf-8") + b"\0" + handle.read() + b"\0")
    return digest.hexdigest()[:16]


def manifest_hash(files):
    digest = hashlib.sha256()
    for relative, text in sorted(files):
        digest.update(relative.encode("utf-8") + b"\0" + text.encode("utf-8") + b"\0")
    return digest.hexdigest()[:16]


def is_current(home, expect):
    kit = os.path.join(home, "kit")
    try:
        with open(os.path.join(kit, "VERSION"), encoding="utf-8") as handle:
            version = handle.read().strip()
    except OSError:
        return False
    wrapper = os.path.join(home, "bin", "brokit")
    return version == expect and os.access(wrapper, os.X_OK) and kit_hash(kit) == expect


def read_manifest(path, expect):
    with open(path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, list):
        raise SystemExit("unpack: the manifest has no file list")
    seen = set()
    for entry in files:
        if not (isinstance(entry, list) and len(entry) == 2 and isinstance(entry[1], str)):
            raise SystemExit("unpack: a manifest entry is not [path, text]")
        if not (isinstance(entry[0], str) and KIT_FILE.match(entry[0])) or "//" in entry[0] or entry[0] in seen:
            raise SystemExit("unpack: refused path %r" % (entry[0],))
        seen.add(entry[0])
    pairs = [(entry[0], entry[1]) for entry in files]
    if manifest.get("version") != expect or manifest_hash(pairs) != expect:
        raise SystemExit("unpack: the manifest does not hash to version %s" % expect)
    return pairs


def wrapper_text(kit):
    code = 'import sys;sys.path.insert(0,%s);from brokit.cli import main;sys.exit(main(sys.argv[1:]))' % json.dumps(kit)
    return '#!/bin/sh\nP=/opt/py/bin/python3; [ -x "$P" ] || P=python3\nexec "$P" -I -c \'%s\' "$@"\n' % code


def install(home, files, expect):
    nonce = secrets.token_hex(6)
    kit = os.path.join(home, "kit")
    fresh = os.path.join(home, "kit.new." + nonce)
    old = os.path.join(home, "kit.old." + nonce)
    for relative, text in files:
        path = os.path.join(fresh, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
    with open(os.path.join(fresh, "VERSION"), "w", encoding="utf-8") as handle:
        handle.write(expect + "\n")
    if os.path.lexists(kit):
        os.rename(kit, old)
    os.rename(fresh, kit)
    shutil.rmtree(old, ignore_errors=True)
    bin_dir = os.path.join(home, "bin")
    os.makedirs(bin_dir, exist_ok=True)
    wrapper = os.path.join(bin_dir, "brokit")
    temporary = "%s.tmp.%s" % (wrapper, nonce)
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(wrapper_text(kit))
    os.chmod(temporary, 0o755)
    os.replace(temporary, wrapper)


def sweep(home):
    """Directories a call that died midway left behind; only ever touched under the lock."""
    for name in os.listdir(home):
        if name.startswith(("kit.new.", "kit.old.")):
            shutil.rmtree(os.path.join(home, name), ignore_errors=True)


def lock(home):
    handle = open(os.path.join(home, "kit.lock"), "a")
    deadline = time.monotonic() + LOCK_SECONDS
    while True:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except OSError as error:
            if error.errno not in (errno.EAGAIN, errno.EACCES) or time.monotonic() > deadline:
                handle.close()
                raise SystemExit("unpack: the kit lock stayed busy")
            time.sleep(0.05)


def main():
    home = os.environ["BROKIT_HOME"]
    manifest = os.environ["BROKIT_MANIFEST"]
    expect = os.environ["BROKIT_EXPECT"]
    if not (SAFE_PATH.match(home) and SAFE_PATH.match(manifest)):
        raise SystemExit("unpack: paths must be plain absolute paths")
    try:
        os.makedirs(home, exist_ok=True)
        held = lock(home)
        try:
            sweep(home)
            if is_current(home, expect):
                state = "current"
            else:
                install(home, read_manifest(manifest, expect), expect)
                state = "written"
        finally:
            held.close()
    finally:
        try:
            os.remove(manifest)
        except OSError:
            pass
    print(json.dumps({"state": state}))


if __name__ == "__main__":
    main()
