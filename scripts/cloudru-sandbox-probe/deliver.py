"""Deliver the stand to a probe VM through Object Storage (the serial console carries a kilobyte per command).

  python deliver.py NAME            browser-vm/ and vm/ as /root/stand/, the RouterAI key as /root/.routerai
                                    and the state master key as /root/.state-key (both 600)
  python deliver.py NAME --code     only the code (after a change)
  python deliver.py NAME --links set=put:probe/stage1/set-pk:16     presigned links for state.py as
                                    /root/links-set.json (parts part-000… and manifest; get: of what is there)

Files go up to probe/stage1/deliver/ from the session, the VM fetches them by presigned links, then the objects
are deleted. The master key is made once in $PROBE_STATE_DIR/state-key (the restore VM needs the same one);
the Cloud.ru key never leaves the session.
"""

import argparse
import io
import json
import os
import secrets
import tarfile
import urllib.request
from pathlib import Path

import cloudru
import console
import s3

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
PREFIX = "probe/stage1/deliver"


def put(key, data):
    code, body = s3.send(urllib.request.Request(s3.presign("PUT", key), data, method="PUT"))
    if code != 200:
        raise SystemExit(f"put {key}: {code} {body[:200]!r}")
    return s3.presign("GET", key, 900)


def bundle():
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        tar.add(REPO / "browser-vm", "browser-vm", filter=lambda t: None if "__pycache__" in t.name else t)
        tar.add(HERE / "vm", "vm", filter=lambda t: None if "__pycache__" in t.name else t)
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("name")
    parser.add_argument("--code", action="store_true")
    parser.add_argument("--links", action="append", default=[], metavar="NAME=get|put:PREFIX[:COUNT]")
    args = parser.parse_args()
    if args.links:
        commands = []
        for spec in args.links:
            name, rest = spec.split("=", 1)
            method, prefix, *count = rest.split(":")
            if method == "put":
                keys = [f"part-{i:03d}" for i in range(int(count[0]))] + ["manifest"]
            else:
                keys = [key.rsplit("/", 1)[1] for key, _ in s3.listing(prefix + "/")]
            links = {key: s3.presign(method.upper(), f"{prefix}/{key}", 6 * 3600) for key in keys}
            url = put(f"{PREFIX}/links-{name}.json", json.dumps(links).encode())
            commands.append(f"(umask 077; curl -fsS -o /root/links-{name}.json '{url}') && echo {name} {len(keys)}")
    else:
        commands = [f"mkdir -p /root/stand && curl -fsS -o /root/stand.tgz '{put(PREFIX + '/stand.tgz', bundle())}' "
                "&& tar -C /root/stand -xzf /root/stand.tgz && rm /root/stand.tgz && ls /root/stand"]
    if not args.code and not args.links:
        state_key = cloudru.STATE_DIR / "state-key"
        if not state_key.exists():
            cloudru.write_private(state_key, secrets.token_hex(32))
        routerai = s3.clean(os.environ["ROUTERAI_API_KEY"]).encode()
        for name, data in (("routerai", routerai), ("state-key", state_key.read_bytes())):
            commands.append(f"(umask 077; curl -fsS -o /root/.{name} '{put(PREFIX + '/' + name, data)}') "
                            f"&& wc -c < /root/.{name}")
    session = console.Console(args.name)
    session.login()
    try:
        for command in commands:
            output, status = session.run(command, 300)
            print(status, output[-400:])
    finally:
        print("deleted", s3.delete_prefix(PREFIX + "/"))


if __name__ == "__main__":
    main()
