#!/usr/bin/env python3
"""Fails if vendored OptMem cannot note + wake a per-tenant store."""
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEMO = os.path.join(ROOT, "vendor", "optmem", "memo")


def run(env, *args):
    p = subprocess.run(
        ["python3", MEMO, *args],
        env=env,
        capture_output=True,
        text=True,
    )
    if p.returncode != 0:
        sys.stderr.write(p.stdout + p.stderr)
        sys.exit(p.returncode)
    return p.stdout


def main():
    d = tempfile.mkdtemp(prefix="optmem-check-")
    try:
        env = {**os.environ, "MEMORY_DIR": d}
        run(env, "init")
        run(env, "note", "Saveliy wears shoe size 42")
        out = run(env, "wake")
        if "42" not in out:
            sys.stderr.write(out)
            sys.exit("wake missing the note")
        if "You are awake." not in out:
            sys.stderr.write(out)
            sys.exit("wake did not finish")
        print("optmem-check ok")
    finally:
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    main()
