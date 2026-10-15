"""Boot: run one kit command from a fresh copy (`runFreshKit`, agent/lib/sandbox/kit.ts).

Bro's own sandbox signs documents through the kit (the signing commands of
brokit/pdf/sign.py and brokit/img/signature.py), and it never trusts a copy
left on disk: every call writes the manifest to BROKIT_DIR/kit.json, a
directory made for this call alone, and this script unpacks it into
BROKIT_DIR/kit, which must not exist yet. Runs as `python3 -I -c "import
os;exec(os.environ['BROKIT_BOOT'])"` with BROKIT_DIR, BROKIT_EXPECT (the kit
version) and BROKIT_ARGS (a JSON list of the command's words). A boot
failure — no manifest, a hash other than expected, kit/ already there —
exits 3, so the caller tells it from a refusal of the document (exit 2).
The hostile-input limits (`brokit.util.limits`) hold for the whole command.
"""

import hashlib
import json
import os
import re
import sys

SAFE_PATH = re.compile(r"^/[\w/.-]+$")
KIT_FILE = re.compile(r"^brokit/[a-z0-9_/]+\.py$")


def boot_failure(reason):
    sys.stderr.write("brokit boot: " + reason + "\n")
    sys.exit(3)


def manifest_hash(files):
    digest = hashlib.sha256()
    for relative, text in sorted(files):
        digest.update(relative.encode("utf-8") + b"\0" + text.encode("utf-8") + b"\0")
    return digest.hexdigest()[:16]


def read_manifest(path, expect):
    try:
        with open(path, encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError):
        boot_failure("no readable manifest at " + path)
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, list):
        boot_failure("the manifest has no file list")
    pairs = []
    for entry in files:
        if not (isinstance(entry, list) and len(entry) == 2 and all(isinstance(part, str) for part in entry)):
            boot_failure("a manifest entry is not [path, text]")
        if not KIT_FILE.match(entry[0]) or "//" in entry[0]:
            boot_failure("refused path %r" % (entry[0],))
        pairs.append((entry[0], entry[1]))
    if len({relative for relative, _ in pairs}) != len(pairs):
        boot_failure("the manifest names a file twice")
    if manifest.get("version") != expect or manifest_hash(pairs) != expect:
        boot_failure("the manifest does not hash to version " + expect)
    return pairs


def main():
    directory = os.environ["BROKIT_DIR"]
    expect = os.environ["BROKIT_EXPECT"]
    if not SAFE_PATH.match(directory):
        boot_failure("BROKIT_DIR must be a plain absolute path")
    args = json.loads(os.environ["BROKIT_ARGS"])
    if not (isinstance(args, list) and all(isinstance(arg, str) for arg in args)):
        boot_failure("BROKIT_ARGS is not a list of strings")
    files = read_manifest(os.path.join(directory, "kit.json"), expect)
    kit = os.path.join(directory, "kit")
    try:
        os.mkdir(kit)
    except OSError:
        boot_failure(kit + " already exists or cannot be made")
    for relative, text in files:
        path = os.path.join(kit, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
    sys.dont_write_bytecode = True
    sys.path.insert(0, kit)
    from brokit.util import limits
    from brokit.cli import main as brokit

    limits()
    sys.exit(brokit(args))


if __name__ == "__main__":
    main()
