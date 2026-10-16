"""LibreOffice conversions for the kit, one at a time.

Every kit call that needs soffice holds an exclusive flock on LOCK, so two
conversions never share a profile, and runs with its own copy of the profile
the image ships (~/.config/libreoffice/4, made warm by the image smoke test):
the task agent's own soffice runs cannot hand our conversion to their process.
"""

import fcntl
import os
import shutil
import signal
import subprocess
import time

from brokit.util import KitError

LOCK = "/tmp/brokit-soffice.lock"
PROFILE = "/tmp/brokit-soffice-profile"
SHIPPED_PROFILE = os.path.expanduser("~/.config/libreoffice/4")
TIMEOUT = 120
LOCK_WAIT = 180


def profile_url():
    if not os.path.isdir(PROFILE) and os.path.isdir(SHIPPED_PROFILE):
        staging = "%s.%d" % (PROFILE, os.getpid())
        shutil.copytree(SHIPPED_PROFILE, staging, symlinks=True, ignore=shutil.ignore_patterns(".lock"))
        try:
            os.rename(staging, PROFILE)
        except OSError:
            shutil.rmtree(staging, ignore_errors=True)
    return "file://" + PROFILE


def binary():
    for name in ("soffice", "libreoffice"):
        path = shutil.which(name)
        if path:
            return path
    raise KitError("unavailable", "LibreOffice is not installed in this sandbox")


def convert(sources, target, outdir, timeout=TIMEOUT):
    """Converts files with `soffice --convert-to target`; returns the output paths.

    `target` is a LibreOffice filter spec ("pdf", "txt:Text", "csv",
    'xlsx:"Calc MS Excel 2007 XML"'); outputs are named after the sources with
    the target's extension. A source LibreOffice cannot open has no output.
    """
    program = binary()
    os.makedirs(outdir, exist_ok=True)
    extension = target.split(":", 1)[0]
    with open(LOCK, "a") as lock:
        deadline = time.monotonic() + LOCK_WAIT
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise KitError(
                        "timeout", "another LibreOffice conversion is still running", "try again in a minute"
                    )
                time.sleep(0.2)
        command = [
            program,
            "-env:UserInstallation=" + profile_url(),
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--convert-to",
            target,
            "--outdir",
            outdir,
        ] + list(sources)
        process = subprocess.Popen(
            command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True
        )
        try:
            _, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise KitError("timeout", "LibreOffice took longer than %d s" % timeout)
    outputs = []
    for source in sources:
        stem = os.path.splitext(os.path.basename(source))[0]
        path = os.path.join(outdir, stem + "." + extension)
        outputs.append(path if os.path.isfile(path) else None)
    if not any(outputs):
        raise KitError(
            "unreadable",
            "LibreOffice could not convert the file",
            (stderr or b"").decode("utf-8", "replace").strip()[-200:] or None,
        )
    return outputs
