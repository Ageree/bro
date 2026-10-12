#!/usr/bin/env python3
"""Run ops/yandex-probe.sh on the VM with a spec from a local file and print its result.

  python yandex-probe.py NAME SPEC.json [OUT.json]

The spec and the result go through Object Storage under operator/yandex-probe/ (an ops argument
cannot hold JSON, and the result holds the person's data, so it is not in the job's log); both
objects are deleted afterwards. The spec's shape is in ops/yandex-probe.ts.
"""
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "cloudru-sandbox-probe"))
import s3  # noqa: E402


def main():
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    name, spec = sys.argv[1], Path(sys.argv[2]).read_bytes()
    prefix = f"operator/yandex-probe/{time.strftime('%Y%m%d-%H%M%S')}"
    code, _ = s3.send(urllib.request.Request(s3.presign("PUT", f"{prefix}/spec.json", 600), spec, method="PUT"))
    if code != 200:
        sys.exit(f"spec upload {code}")
    try:
        subprocess.run([sys.executable, str(HERE / "host.py"), "ops", name, os.environ.get("YANDEX_PROBE_SCRIPT", "yandex-probe.sh"),
                        f"s3get:{prefix}/spec.json", f"s3put:{prefix}/result.json"], check=True)
        code, body = s3.send(urllib.request.Request(s3.presign("GET", f"{prefix}/result.json", 600)))
        if code != 200:
            sys.exit(f"no result ({code})")
        if len(sys.argv) == 4:
            Path(sys.argv[3]).write_bytes(body)
        else:
            sys.stdout.write(body.decode())
    finally:
        s3.delete_prefix(prefix + "/")


main()
