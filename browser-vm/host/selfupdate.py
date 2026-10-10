"""hostd's self-update (`POST /v1/admin/update`): new host code without a new OS install or an SSH login.

The caller (an operator with a token signed for scope `update`) names a host bundle (the tarball `boot.py bundle`
makes) by an https URL and its SHA-256. hostd downloads it (at most `update_max_bytes`), checks the hash, unpacks
it into <host_dir>.new and answers 202; after the answer it waits until no sandbox is starting, restoring or
parking (new ones are refused meanwhile, `Host.apply_update`), swaps the directories, runs update.sh from the new
code (the idempotent parts of provision.sh a code update needs: a check that the new code compiles, imports and
loads this host's settings, the venv when the wheels changed, units, binaries; and the rollback guard, rollback.sh
on a systemd timer) and restarts bro-hostd. If update.sh fails the old directory comes back and nothing restarts;
if hostd does not come up on the new code the guard puts the old directory back. Running sandboxes survive the
restart (hostd reads them back from the runtime on start). The outcome of the last update is in
<root>/update.json: GET /v1/admin/update (the operator's) shows all of it, GET /v1/health only its state, version
and time.

The hash only holds the download together: whoever holds an `update` token runs code as root on the host. That is
the point of the endpoint, and why the scope is a claim of its own, signed with a key of its own (`updateKey` of
host.json, derived from a signing key only the operator has; Bro holds the host key and must not reach root): Bro's
ordinary tokens have no scope and are refused here, and an `update` token is refused everywhere else.
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
import tarfile
import time
from pathlib import Path

from yarl import URL

log = logging.getLogger("bro-hostd")
SHA256 = re.compile(r"[0-9a-f]{64}")
REQUIRED = ("hostd.py", "provision.sh", "update.sh", "requirements.txt")
VERSION = re.compile(r'(?m)^VERSION = "([^"]+)"')


class UpdateRefused(Exception):
    def __init__(self, status, error):
        super().__init__(error)
        self.status, self.error = status, error


def valid_request(body, schemes):
    if not isinstance(body, dict):
        raise UpdateRefused(400, "body must be an object")
    url, digest = body.get("url"), body.get("sha256")
    parsed = URL(url) if isinstance(url, str) and len(url) < 4096 else None
    if parsed is None or parsed.scheme not in schemes or not parsed.host:
        raise UpdateRefused(400, "url must be an https URL")
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        raise UpdateRefused(400, "sha256 must be 64 lower-case hex characters")
    return url, digest


def status_path(config):
    return Path(config.root) / "update.json"


def read_status(config):
    with contextlib.suppress(OSError, ValueError):
        return json.loads(status_path(config).read_text())
    return None


def public_status(status):
    """What /v1/health shows of an update without a token: no error text, no hash of the bundle."""
    return None if status is None else {key: status[key] for key in ("state", "version", "at") if key in status}


def write_status(config, **fields):
    path = status_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields}))
    temporary.replace(path)


def only_files(member, target):
    """The bundle holds regular files and directories only; anything else is refused, not skipped."""
    if not (member.isreg() or member.isdir()):
        raise UpdateRefused(422, f"the bundle holds {member.name!r}, which is not a plain file")
    return tarfile.data_filter(member, target)


def unpack(archive, target):
    """Blocking (run it in a thread)."""
    shutil.rmtree(target, ignore_errors=True)
    Path(target).mkdir(parents=True)
    try:
        with tarfile.open(archive, mode="r:gz") as tar:
            tar.extractall(target, filter=only_files)
    except (tarfile.TarError, OSError, EOFError) as error:
        raise UpdateRefused(422, f"the bundle does not unpack: {type(error).__name__}") from None
    missing = [name for name in REQUIRED if not (Path(target) / name).is_file()]
    if missing:
        raise UpdateRefused(422, f"the bundle lacks {', '.join(missing)}")
    (Path(target) / "update.sh").chmod(0o755)
    (Path(target) / "provision.sh").chmod(0o755)
    match = VERSION.search((Path(target) / "hostd.py").read_text())
    return match.group(1) if match else None


async def download(http, url, expected, target, max_bytes):
    """Stream the bundle to `target`, refusing more than `max_bytes`, and check its hash."""
    import aiohttp

    digest, size = hashlib.sha256(), 0
    try:
        async with http.get(URL(url, encoded=True), timeout=aiohttp.ClientTimeout(total=600, sock_read=60),
                            allow_redirects=False) as response:
            if response.status != 200:
                raise UpdateRefused(502, f"the bundle URL answered {response.status}")
            if (response.content_length or 0) > max_bytes:
                raise UpdateRefused(413, "the bundle is larger than the limit")
            with open(target, "wb") as file:
                async for block in response.content.iter_chunked(1 << 20):
                    size += len(block)
                    if size > max_bytes:
                        raise UpdateRefused(413, "the bundle is larger than the limit")
                    digest.update(block)
                    file.write(block)
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as error:
        raise UpdateRefused(502, f"the bundle could not be downloaded: {type(error).__name__}") from None
    if digest.hexdigest() != expected:
        raise UpdateRefused(422, "sha256 of the download does not match")
    return size


async def prepare(http, config, url, expected):
    """Download, check and unpack into <host_dir>.new; the version found there."""
    work = Path(config.root) / "update"
    work.mkdir(parents=True, exist_ok=True)
    archive = work / "bundle.tgz"
    try:
        await download(http, url, expected, archive, config.update_max_bytes)
        return await asyncio.to_thread(unpack, archive, config.host_dir + ".new")
    finally:
        archive.unlink(missing_ok=True)


def try_status(config, **fields):
    """write_status where a failure to write must not hide the outcome (a full disk is no reason to leave the
    update half done and hostd thinking it still runs)."""
    try:
        write_status(config, **fields)
    except OSError as error:
        log.error("update.json could not be written: %s", error)


def mark_started(config, version):
    """On hostd's start: an update that restarted it is done."""
    status = read_status(config)
    if status and status.get("state") == "restarting":
        write_status(config, state="done", sha256=status.get("sha256"), version=status.get("version"),
                     running=version)


async def apply(runner, config, version, expected):
    """After the answer: swap the code in, run update.sh from it, restart hostd. Any failure puts the old
    code back and leaves hostd running."""
    host, new, old = Path(config.host_dir), Path(config.host_dir + ".new"), Path(config.host_dir + ".old")
    write_status(config, state="applying", sha256=expected, version=version)
    try:
        await asyncio.sleep(config.update_delay_s)  # the 202 is on the wire
        shutil.rmtree(old, ignore_errors=True)
        host.rename(old)
        new.rename(host)
    except OSError as error:
        try_status(config, state="failed", sha256=expected, error=f"swap: {error}")
        return False
    code, output = await runner.run([config.bash, str(host / "update.sh")], timeout=900)
    if code != 0:
        log.error("update.sh failed (%s): %s", code, output[-500:])
        shutil.rmtree(new, ignore_errors=True)
        host.rename(new)
        old.rename(host)
        try_status(config, state="failed", sha256=expected, version=version,
                   error=f"update.sh exited {code}: {output[-300:]}")
        return False
    write_status(config, state="restarting", sha256=expected, version=version)
    code, output = await runner.run([config.systemctl, "--no-block", "restart", "bro-hostd"])
    if code != 0:
        try_status(config, state="failed", sha256=expected, version=version,
                   error=f"systemctl restart exited {code}: {output[-300:]}")
        return False
    return True


# --- update.sh's helper (run from the new tree with the venv's Python) ---------------------------------------


def enroll_update_key(key_file, identity_file):
    """update.sh of a bundle made with `boot.py bundle --enroll-update-key`: the operator's key for scope
    `update`, carried in the bundle as enroll/update-key (64 hex), goes into host.json (0600, replaced
    atomically) and the copy in the bundle's tree is deleted. This is how a host made before the key existed
    (or one whose key is rotated) gets it: the update that brings it is signed with the key the host has.
    False when the bundle carries none."""
    key_file = Path(key_file)
    if not key_file.is_file():
        return False
    key = key_file.read_text().strip()
    if not SHA256.fullmatch(key):
        raise ValueError("enroll/update-key is not 64 lower-case hex characters")
    identity = Path(identity_file)
    data = json.loads(identity.read_text())
    data["updateKey"] = key
    temporary = identity.with_name(identity.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(json.dumps(data))
    os.replace(temporary, identity)
    key_file.unlink()
    with contextlib.suppress(OSError):
        key_file.parent.rmdir()
    return True


if __name__ == "__main__":
    import sys

    if len(sys.argv) == 4 and sys.argv[1] == "enroll":
        print("selfupdate: update key enrolled" if enroll_update_key(sys.argv[2], sys.argv[3])
              else "selfupdate: no update key in the bundle")
    else:
        sys.exit("usage: selfupdate.py enroll KEY_FILE HOST_JSON")
