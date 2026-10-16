"""Boot: is the kit in the task sandbox the one Bro ships? (`ensureKit`, agent/lib/sandbox/kit.ts)

Runs as `python3 -I -c "import os;exec(os.environ['BROKIT_BOOT'])"` with
BROKIT_HOME (/workspace/.bro), BROKIT_EXPECT (the kit version: 16 hex of the
content hash) and, from the task agent's hook, BROKIT_TOKEN (the workspace's
sign-mark token). The files of kit/brokit are hashed again from disk: VERSION
alone is not trusted, since the task agent can write anything under
/workspace. Prints one JSON line, {"state": "current" | "stale"}.

On the way it writes mark-token (0600) when given and different, and keeps
~/.bash_profile reading ~/.profile and putting the kit's bin/ first on PATH:
the sandbox's home is not part of its snapshot, /workspace is.
"""

import hashlib
import json
import os
import re

SAFE_PATH = re.compile(r"^/[\w/.-]+$")
TOKEN = re.compile(r"^[0-9a-f]{32}$")


def kit_hash(kit):
    """16 hex of sha256 over `relpath \\0 content \\0` of kit/brokit/**.py, sorted.

    None when the kit cannot be what Bro wrote: missing, a symlink in it, or a
    file other than a .py source outside __pycache__ (a compiled module such
    as util.cpython-310-x86_64-linux-gnu.so is imported before util.py).
    """
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
            if not name.endswith(".py"):
                return None
            path = os.path.join(directory, name)
            files.append(("brokit/" + os.path.relpath(path, root).replace(os.sep, "/"), path))
    digest = hashlib.sha256()
    for relative, path in sorted(files):
        with open(path, "rb") as handle:
            digest.update(relative.encode("utf-8") + b"\0" + handle.read() + b"\0")
    return digest.hexdigest()[:16]


def replace_file(path, data, mode):
    temporary = "%s.tmp.%d" % (path, os.getpid())
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def keep_token(home, token):
    if not TOKEN.match(token):
        raise SystemExit("check: the mark token is not 32 hex")
    path = os.path.join(home, "mark-token")
    try:
        with open(path, encoding="utf-8") as handle:
            if handle.read().strip() == token:
                return
    except OSError:
        pass
    replace_file(path, (token + "\n").encode("utf-8"), 0o600)


def keep_profile(home):
    user_home = os.environ.get("HOME") or "/home/sandbox"
    path = os.path.join(user_home, ".bash_profile")
    wanted = ["[ -f ~/.profile ] && . ~/.profile", 'export PATH="%s/bin:$PATH"' % home]
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except OSError:
        text = ""
    lines = text.splitlines()
    missing = [line for line in wanted if line not in lines]
    if not missing:
        return
    if text and not text.endswith("\n"):
        text += "\n"
    replace_file(path, (text + "\n".join(missing) + "\n").encode("utf-8"), 0o644)


def is_current(home, expect):
    kit = os.path.join(home, "kit")
    try:
        with open(os.path.join(kit, "VERSION"), encoding="utf-8") as handle:
            version = handle.read().strip()
    except OSError:
        return False
    wrapper = os.path.join(home, "bin", "brokit")
    return version == expect and os.access(wrapper, os.X_OK) and kit_hash(kit) == expect


def main():
    home = os.environ["BROKIT_HOME"]
    if not SAFE_PATH.match(home):
        raise SystemExit("check: BROKIT_HOME must be a plain absolute path")
    os.makedirs(home, exist_ok=True)
    token = os.environ.get("BROKIT_TOKEN", "")
    if token:
        keep_token(home, token)
    keep_profile(home)
    state = "current" if is_current(home, os.environ["BROKIT_EXPECT"]) else "stale"
    print(json.dumps({"state": state}))


if __name__ == "__main__":
    main()
