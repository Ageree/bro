#!/usr/bin/env python3
"""Sign in to production's test accounts (ops/test-accounts.ts), one cookie file each, with nobody's code.

  python test-accounts.py NAME [--dir DIR]

Runs ops/test-accounts.sh ensure, which makes the web-only test accounts once and puts a one-time sign-in link
for each under operator/test-accounts/ in Object Storage, never in the job's log; reads them, deletes them and
hands each to `pnpm bench link --cookie-file DIR/<account>.txt` on stdin (~/.bro-bench/test-accounts by default).
Prints the accounts' names and workspace ids, and how many phone number requests and numbers they hold: none.
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
    parser.add_argument("--dir", default=str(Path.home() / ".bro-bench" / "test-accounts"))
    args = parser.parse_args()
    key = f"operator/test-accounts/{time.strftime('%Y%m%d-%H%M%S')}.json"
    try:
        subprocess.run([sys.executable, str(HERE / "host.py"), "ops", args.name, "test-accounts.sh", "ensure",
                        f"s3put:{key}"], check=True)
        code, body = s3.send(urllib.request.Request(s3.presign("GET", key, 600)))
        if code != 200:
            sys.exit(f"no links ({code})")
        accounts = json.loads(body)["accounts"]
    finally:
        s3.delete_prefix(key)
    folder = Path(args.dir)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    for account in accounts:
        cookie = folder / f"{account['key']}.txt"
        subprocess.run(["pnpm", "--silent", "bench", "link", "--cookie-file", str(cookie)],
                       input=account["link"] + "\n", text=True, check=True, cwd=HERE.parent.parent)
        print(f"{account['key']}: {cookie}")


main()
