#!/usr/bin/env python3
"""Sign `pnpm bench` in to the owner's account on the VM, with no code from the owner.

  python owner-login.py NAME [--cookie-file PATH]

Runs ops/owner-login.sh, which puts a one-time sign-in link (the bot's, ten minutes, once) for the
account on ADMIN_USER_IDS under operator/owner-login/ in Object Storage, never in the job's log;
reads it, deletes it and hands it to `pnpm bench link` on stdin, which saves the session cookie
(~/.bro-bench/cookies.txt by default).
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "cloudru-sandbox-probe"))
import s3  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("name")
    parser.add_argument("--cookie-file")
    args = parser.parse_args()
    key = f"operator/owner-login/{time.strftime('%Y%m%d-%H%M%S')}.json"
    try:
        subprocess.run([sys.executable, str(HERE / "host.py"), "ops", args.name, "owner-login.sh", f"s3put:{key}"],
                       check=True)
        code, body = s3.send(urllib.request.Request(s3.presign("GET", key, 600)))
        if code != 200:
            sys.exit(f"no link ({code})")
        link = json.loads(body)["link"]
    finally:
        s3.delete_prefix(key)
    bench = ["pnpm", "--silent", "bench", "link", *(["--cookie-file", args.cookie_file] if args.cookie_file else [])]
    subprocess.run(bench, input=link + "\n", text=True, check=True, cwd=HERE.parent.parent)


main()
