"""Runs brokit commands in the test process, as the sandbox wrapper does."""

import contextlib
import io
import json
import shutil

from brokit.cli import main


def kit(*args):
    """(exit code, the JSON line) of `brokit ARGS`; fails unless exactly one line is printed."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = main([str(arg) for arg in args])
    lines = out.getvalue().splitlines()
    if len(lines) != 1:
        raise AssertionError("brokit printed %d lines: %r" % (len(lines), out.getvalue()[:500]))
    return code, json.loads(lines[0])


def has(program):
    return shutil.which(program) is not None
