"""Publish a worker for Bro to roll out to the browser VMs (operator script, stdlib only).

A VM keeps the worker of the image it was made from, and its disk is the person's profile, so it is never
re-created for a code change. Bro rolls a published worker out itself instead (agent/lib/browser-vm/
rollout.ts): before an errand on an idle VM whose worker reports an older version, it fetches the file from
BROWSER_STATE_BUCKET, checks its SHA-256 and sends it to the worker's POST /v1/admin/worker. That route
takes exactly one file, worker.py (jev_segment.py and the rest of the image stay as they are), so only
worker.py is published, and its VERSION must be new: Bro compares it with /v1/health.

  python publish.py
      prints the version, the SHA-256, the object key and the BROWSER_VM_WORKER value

  python publish.py --put-url "$(python ../../scripts/cloudru-sandbox-probe/s3.py presign put KEY)"
      also uploads the file to that presigned PUT URL (the key the first form printed)

A version names one file for good: Bro compares only the version with /v1/health, so code changed under the
same VERSION would never reach a VM that already runs that version, and a file replaced under the pinned
SHA-256 would fail its check on every VM. So the upload asks Object Storage not to overwrite the key
(If-None-Match: *; a store that ignores it overwrites, so never reuse a key), and the script refuses to
upload a worker.py whose VERSION is the one committed in git HEAD while its code differs from it (--force
overrides that, for a file that is not what HEAD has on purpose).

Then set BROWSER_VM_WORKER in Vercel to the printed value and redeploy (an env change applies from the next
deployment). The next errand on each VM brings its worker up to the version.
"""

import argparse
import hashlib
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

WORKER = Path(__file__).with_name("worker.py")
# As BROWSER_VM_WORKER in shared/environment/env.ts wants it.
VERSION_PATTERN = re.compile(r"[A-Za-z\d][\w.-]{0,63}")


class AlreadyPublished(Exception):
    """Object Storage already has a file under the key: the version was published before."""


def describe(source: bytes, prefix: str = "workers/"):
    """The version the code reports in /v1/health, its SHA-256, its key and the env value."""
    match = re.search(rb'^VERSION = "([^"]+)"$', source, re.MULTILINE)
    if match is None:
        raise ValueError('the worker has no VERSION = "…" line')
    version = match.group(1).decode()
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError(f"the version {version!r} does not fit BROWSER_VM_WORKER")
    sha256 = hashlib.sha256(source).hexdigest()
    key = f"{prefix}worker-{version}.py"
    return {"version": version, "sha256": sha256, "key": key, "env": f"{version}:{key}:{sha256}"}


def upload(source: bytes, put_url: str, timeout: float = 60):
    """PUT the exact bytes to a presigned URL (only the host header is signed: any client will do), never
    over a file already there."""
    request = urllib.request.Request(put_url, data=source, method="PUT",
                                     headers={"Content-Type": "application/octet-stream", "If-None-Match": "*"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"Object Storage answered {response.status}")
    except urllib.error.HTTPError as error:
        if error.code in (409, 412):
            raise AlreadyPublished from error
        raise


def committed(path: Path):
    """The file as git HEAD has it, or None outside git or when HEAD has no such file."""
    try:
        shown = subprocess.run(["git", "show", f"HEAD:./{path.name}"], cwd=path.parent, capture_output=True,
                               check=False, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return shown.stdout if shown.returncode == 0 else None


def unbumped(source: bytes, path: Path):
    """Whether the code differs from git HEAD's while its VERSION is still HEAD's."""
    head = committed(path)
    if head is None or head == source:
        return False
    try:
        return describe(head)["version"] == describe(source)["version"]
    except ValueError:
        return False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--file", type=Path, default=WORKER, help="the worker.py to publish")
    parser.add_argument("--prefix", default="workers/", help="key prefix in BROWSER_STATE_BUCKET")
    parser.add_argument("--put-url", help="a presigned PUT URL for the printed key")
    parser.add_argument("--force", action="store_true", help="upload even though VERSION was not bumped")
    args = parser.parse_args(argv)
    source = args.file.read_bytes()
    try:
        published = describe(source, args.prefix)
    except ValueError as error:
        print(f"publish.py: {error}", file=sys.stderr)
        return 2
    for name in ("version", "sha256", "key"):
        print(f"{name}: {published[name]}")
    stale = unbumped(source, args.file.resolve())
    if stale:
        print(f"publish.py: the code differs from git HEAD, but VERSION is still {published['version']}: "
              "bump it, or Bro never rolls it out to a VM that runs that version", file=sys.stderr)
    if args.put_url:
        if stale and not args.force:
            return 2
        try:
            upload(source, args.put_url)
        except AlreadyPublished:
            print(f"publish.py: {published['key']} is already published; bump VERSION", file=sys.stderr)
            return 3
        print(f"uploaded {len(source)} bytes")
    print(f"BROWSER_VM_WORKER={published['env']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
