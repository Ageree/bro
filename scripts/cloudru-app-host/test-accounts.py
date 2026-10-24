#!/usr/bin/env python3
"""Sign in to production's test accounts (ops/test-accounts.ts), one cookie file each, with nobody's code.

  python test-accounts.py NAME [--dir DIR]
  python test-accounts.py NAME --state [--since ISO]

Runs ops/test-accounts.sh ensure, which makes the web-only test accounts once and puts a one-time sign-in link
for each under operator/test-accounts/ in Object Storage, never in the job's log; reads them, deletes them and
hands each to `pnpm bench link --cookie-file DIR/<account>.txt` on stdin (~/.bro-bench/test-accounts by default).
Prints the accounts' names and workspace ids, and how many phone number requests and numbers they hold: none.

--state prints, as JSON, what Bro ↔ Bro holds of them since --since (a day back by default): ops/test-accounts.sh
state puts it to Object Storage, since a job's log cuts long lines.
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


def run_ops(name, command, *args):
    """ops/test-accounts.sh COMMAND with a PUT URL for its result, and the result, deleted from the bucket."""
    key = f"operator/test-accounts/{command}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    try:
        subprocess.run([sys.executable, str(HERE / "host.py"), "ops", name, "test-accounts.sh", command,
                        f"s3put:{key}", *args], check=True, stdout=sys.stderr)
        code, body = s3.send(urllib.request.Request(s3.presign("GET", key, 600)))
        if code != 200:
            sys.exit(f"no {command} result ({code})")
        return json.loads(body)
    finally:
        s3.delete_prefix(key)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("name")
    parser.add_argument("--dir", default=str(Path.home() / ".bro-bench" / "test-accounts"))
    parser.add_argument("--state", action="store_true")
    parser.add_argument("--since")
    args = parser.parse_args()
    if args.state:
        print(json.dumps(run_ops(args.name, "state", *([args.since] if args.since else [])), ensure_ascii=False,
                         indent=1))
        return
    accounts = run_ops(args.name, "ensure")["accounts"]
    folder = Path(args.dir)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    for account in accounts:
        cookie = folder / f"{account['key']}.txt"
        subprocess.run(["pnpm", "--silent", "bench", "link", "--cookie-file", str(cookie)],
                       input=account["link"] + "\n", text=True, check=True, cwd=HERE.parent.parent)
        print(f"{account['key']}: {cookie}")


main()
