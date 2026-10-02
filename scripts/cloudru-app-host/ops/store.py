"""Object Storage and manifests for the db-*.sh ops scripts (scripts/cloudru-app-host/README.md, «База»).

Python stdlib only, on the VM as bro. The signing is the stand's s3.py (scripts/cloudru-sandbox-probe), which
`host.py build` copies next to this file; the key is the app's own CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET and
CLOUDRU_S3_TENANT_ID from /etc/bro/env, the bucket BACKUP_BUCKET (bucket-ac164a by default). Only keys under
backups/ are read, written or deleted.

  store.py put KEY FILE | get KEY FILE      one object
  store.py latest PREFIX                    the newest nightly dump under PREFIX
  store.py prune PREFIX DAYS KEEP           nightly dumps (and manifests) older than DAYS, the newest KEEP stay
  store.py manifest --out F --key K ...     the JSON next to a dump: sha256s, size, row counts per table
  store.py verify --manifest F (--file F | --dump F | --counts F)

A nightly dump is PREFIX/<UTC YYYYMMDDTHHMMSSZ>.dump.enc and its manifest PREFIX/<same>.json; a copy made by
db-copy.sh carries a suffix (<time>-neon.dump.enc) and is never pruned.
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

os.environ["PROBE_BUCKET"] = (os.environ.get("BACKUP_BUCKET") or "bucket-ac164a").strip()
sys.path.insert(0, str(Path(__file__).resolve().parent))
import s3  # noqa: E402

PREFIX = re.compile(r"backups(/[a-z0-9][a-z0-9-]*)+")
KEY = re.compile(r"backups(/[a-z0-9][a-z0-9-]*)+/[0-9]{8}T[0-9]{6}Z(-[a-z0-9]+)?\.(dump\.enc|json)")
NIGHTLY = re.compile(r"([0-9]{8}T[0-9]{6}Z)\.dump\.enc")


def checked_key(key):
    if not KEY.fullmatch(key):
        sys.exit(f"not a backup key: {key[:120]!r}")
    return key


def checked_prefix(prefix):
    prefix = prefix.rstrip("/")
    if not PREFIX.fullmatch(prefix):
        sys.exit(f"not a backup prefix: {prefix[:120]!r}")
    return prefix


def put(key, path):
    data = Path(path).read_bytes()
    code, body = s3.send(urllib.request.Request(s3.presign("PUT", checked_key(key), 3600), data, method="PUT"))
    if code != 200:
        sys.exit(f"put {key}: {code} {body[:200]!r}")
    print(f"uploaded {key} ({len(data)} bytes)", flush=True)


def get(key, path):
    url = s3.presign("GET", checked_key(key), 3600)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=300) as response, open(path, "wb") as out:
                while block := response.read(1 << 20):
                    out.write(block)
            return
        except urllib.error.HTTPError as error:
            sys.exit(f"get {key}: {error.code}")
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def nightly(prefix):
    """[(time, key)] of the nightly dumps under the prefix, oldest first."""
    found = []
    for key, _ in s3.listing(prefix + "/"):
        name = key[len(prefix) + 1:]
        match = NIGHTLY.fullmatch(name)
        if match:
            found.append((match.group(1), key))
    return sorted(found)


def doomed(dumps, days, keep, now):
    """The keys to drop: older than `days`, never one of the newest `keep`."""
    cutoff = (now - datetime.timedelta(days=days)).strftime("%Y%m%dT%H%M%SZ")
    return [key for stamp, key in dumps[:max(len(dumps) - keep, 0)] if stamp < cutoff]


def prune(prefix, days, keep):
    keys = doomed(nightly(prefix), days, keep, datetime.datetime.now(datetime.timezone.utc))
    for key in keys:
        for one in (key, key[: -len(".dump.enc")] + ".json"):
            code, body = s3.signed("DELETE", checked_key(one))
            if code not in (200, 204):
                sys.exit(f"delete {one}: {code} {body[:200]!r}")
        print(f"dropped {key} (older than {days} days)", flush=True)
    return keys


def read_counts(path):
    counts = {}
    for line in Path(path).read_text().splitlines():
        name, _, rows = line.rpartition(" ")
        if name:
            counts[name] = int(rows)
    return counts


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def cmd_manifest(args):
    manifest = {
        "key": checked_key(args.key), "source": args.source,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cipher": "openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256",
        "sha256": args.sha256, "size": args.size, "dumpSha256": args.dump_sha256, "pgDump": args.pg_dump,
        "tables": read_counts(args.counts),
    }
    Path(args.out).write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")


def cmd_verify(args):
    manifest = json.loads(Path(args.manifest).read_text())
    if args.file:
        size = os.path.getsize(args.file)
        if size != manifest["size"] or sha256(args.file) != manifest["sha256"]:
            sys.exit("the object is not the one its manifest describes")
    if args.dump and sha256(args.dump) != manifest["dumpSha256"]:
        sys.exit("the decrypted dump is not the one that was encrypted")
    if args.counts and read_counts(args.counts) != manifest["tables"]:
        sys.exit("the dump's tables are not those of its manifest")
    if args.file:
        print(f"{manifest['key']}: made {manifest['createdAt']} from {manifest['source']}, "
              f"{len(manifest['tables'])} tables, {sum(manifest['tables'].values())} rows", flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("put", "get"):
        command = sub.add_parser(name)
        command.add_argument("key")
        command.add_argument("file")
    sub.add_parser("latest").add_argument("prefix")
    pruning = sub.add_parser("prune")
    pruning.add_argument("prefix")
    pruning.add_argument("days", type=int)
    pruning.add_argument("keep", type=int)
    manifest = sub.add_parser("manifest")
    for option in ("--out", "--key", "--source", "--counts", "--sha256", "--dump-sha256", "--pg-dump"):
        manifest.add_argument(option, required=True)
    manifest.add_argument("--size", type=int, required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--manifest", required=True)
    verify.add_argument("--file")
    verify.add_argument("--dump")
    verify.add_argument("--counts")
    args = parser.parse_args(argv)
    if args.cmd == "put":
        put(args.key, args.file)
    elif args.cmd == "get":
        get(args.key, args.file)
    elif args.cmd == "latest":
        dumps = nightly(checked_prefix(args.prefix))
        if not dumps:
            sys.exit(f"no nightly dump under {args.prefix}")
        print(dumps[-1][1])
    elif args.cmd == "prune":
        prune(checked_prefix(args.prefix), args.days, args.keep)
    elif args.cmd == "manifest":
        cmd_manifest(args)
    else:
        cmd_verify(args)


if __name__ == "__main__":
    main()
