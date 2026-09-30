"""Publish a worker for Bro to roll out to the browser VMs (operator script, stdlib only).

A VM keeps the worker of the image it was made from, and its disk is the person's profile, so it is never
re-created for a code change. Bro rolls a published worker out itself instead (agent/lib/browser-vm/
rollout.ts): before an errand on an idle VM whose worker reports another version, it fetches the file from
BROWSER_STATE_BUCKET, checks its SHA-256 and sends it to the worker's POST /v1/admin/worker. That route
takes exactly one file, worker.py (jev_segment.py and the rest of the image stay as they are), so only
worker.py is published, and its VERSION must be new: Bro compares it with /v1/health.

  python publish.py
      prints the version, the SHA-256, the object key and the BROWSER_VM_WORKER value

  python publish.py --put-url "$(python ../../scripts/cloudru-sandbox-probe/s3.py presign put KEY)"
      also uploads the file to that presigned PUT URL (the key the first form printed)

Then set BROWSER_VM_WORKER in Vercel to the printed value and redeploy (an env change applies from the next
deployment). The next errand on each VM brings its worker up to the version.
"""

import argparse
import hashlib
import re
import sys
import urllib.request
from pathlib import Path

WORKER = Path(__file__).with_name("worker.py")
# As BROWSER_VM_WORKER in shared/environment/env.ts wants it.
VERSION_PATTERN = re.compile(r"[A-Za-z\d][\w.-]{0,63}")


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
    """PUT the exact bytes to a presigned URL (only the host header is signed: any client will do)."""
    request = urllib.request.Request(put_url, data=source, method="PUT",
                                     headers={"Content-Type": "application/octet-stream"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f"Object Storage answered {response.status}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--file", type=Path, default=WORKER, help="the worker.py to publish")
    parser.add_argument("--prefix", default="workers/", help="key prefix in BROWSER_STATE_BUCKET")
    parser.add_argument("--put-url", help="a presigned PUT URL for the printed key")
    args = parser.parse_args(argv)
    source = args.file.read_bytes()
    try:
        published = describe(source, args.prefix)
    except ValueError as error:
        print(f"publish.py: {error}", file=sys.stderr)
        return 2
    for name in ("version", "sha256", "key"):
        print(f"{name}: {published[name]}")
    if args.put_url:
        upload(source, args.put_url)
        print(f"uploaded {len(source)} bytes")
    print(f"BROWSER_VM_WORKER={published['env']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
