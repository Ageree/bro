"""Object Storage and manifests for the db-*.sh ops scripts (scripts/cloudru-app-host/README.md, «База»).

Python stdlib only, on the VM as bro. The signing is the stand's s3.py (scripts/cloudru-sandbox-probe), which
`host.py build` copies next to this file; the key is the app's own from /etc/bro/env: S3_ENDPOINT, S3_REGION,
S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (Selectel), else CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET and
CLOUDRU_S3_TENANT_ID; the bucket BACKUP_BUCKET (bucket-ac164a by default). Only keys under
backups/ are read, written or deleted.

  store.py put KEY FILE | get KEY FILE      one object
  store.py latest PREFIX                    the newest nightly dump under PREFIX that has its manifest
  store.py prune PREFIX DAYS KEEP           nightly backups older than DAYS, the newest KEEP stay; halves go
  store.py manifest --out F --key K ...     the JSON next to a dump: sha256s, size, row counts per table, signed
  store.py verify --manifest F [--key K] [--file F | --dump F | --counts F]

A nightly dump is PREFIX/<UTC YYYYMMDDTHHMMSSZ>.dump.enc and its manifest PREFIX/<same>.json, uploaded after
the dump: a dump without one is not a backup. A copy made by db-copy.sh or before a restore carries a suffix
(<time>-neon.dump.enc, <time>-preapp.dump.enc) and is never pruned.

The manifest is signed: an HMAC-SHA256 of its fields with a key derived from BACKUP_ENCRYPTION_KEY (read from
the environment, never from a command line), and `keyId` names the key (an HMAC of a constant). Anyone who
can write to the bucket (the app's S3 key is in /etc/bro/env, which the app and the model's tools run with)
could put a dump and a manifest there; without BACKUP_ENCRYPTION_KEY they cannot sign one, and a signed
manifest of another key (an older dump moved to a newer name) is refused, since it names its own key.
"""

import argparse
import datetime
import hashlib
import hmac
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
NIGHTLY_OBJECT = re.compile(r"([0-9]{8}T[0-9]{6}Z)\.(dump\.enc|json)")
SINGLE_PUT_LIMIT = 5 * 1024 ** 3  # S3's limit for one PUT; past it a multipart upload is needed


def checked_key(key):
    if not KEY.fullmatch(key):
        sys.exit(f"not a backup key: {key[:120]!r}")
    return key


def checked_prefix(prefix):
    prefix = prefix.rstrip("/")
    if not PREFIX.fullmatch(prefix):
        sys.exit(f"not a backup prefix: {prefix[:120]!r}")
    return prefix


def retried(what, attempt_once, attempts=5):
    """One S3 call, again on a dropped connection or a 5xx (Object Storage answers 503 now and then)."""
    for attempt in range(attempts):
        try:
            return attempt_once()
        except urllib.error.HTTPError as error:
            if error.code < 500 or attempt == attempts - 1:
                sys.exit(f"{what}: {error.code}")
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if attempt == attempts - 1:
                raise
        time.sleep(2 ** attempt)


def stored_size(key):
    return next((size for found, size in s3.listing(key) if found == key), None)


def put(key, path):
    """Streamed from the file (a dump may outgrow memory), then its size in the bucket is checked."""
    size = os.path.getsize(path)
    if size > SINGLE_PUT_LIMIT:
        sys.exit(f"put {key}: {size} bytes, past one PUT's 5 GiB: store.py needs a multipart upload now")
    url = s3.presign("PUT", checked_key(key), 3600)

    def once():
        with open(path, "rb") as data:
            request = urllib.request.Request(url, data, {"Content-Length": str(size)}, method="PUT")
            with urllib.request.urlopen(request, timeout=600) as response:
                response.read()

    retried(f"put {key}", once)
    if stored_size(key) != size:
        sys.exit(f"put {key}: the bucket does not hold {size} bytes under it")
    print(f"uploaded {key} ({size} bytes)", flush=True)


def get(key, path):
    url = s3.presign("GET", checked_key(key), 3600)

    def once():
        with urllib.request.urlopen(url, timeout=300) as response, open(path, "wb") as out:
            while block := response.read(1 << 20):
                out.write(block)

    retried(f"get {key}", once)


def nightly(prefix):
    """[(time, key)] of the nightly dumps under the prefix whose manifest is there too (it is uploaded last),
    oldest first."""
    keys = {key for key, _ in s3.listing(prefix + "/")}
    found = []
    for key in keys:
        match = NIGHTLY.fullmatch(key[len(prefix) + 1:])
        if not match:
            continue
        if key[: -len(".dump.enc")] + ".json" not in keys:
            print(f"skipped {key}: no manifest (an upload cut short)", file=sys.stderr, flush=True)
            continue
        found.append((match.group(1), key))
    return sorted(found)


def doomed(dumps, days, keep, now):
    """The keys to drop: older than `days`, never one of the newest `keep`."""
    cutoff = (now - datetime.timedelta(days=days)).strftime("%Y%m%dT%H%M%SZ")
    return [key for stamp, key in dumps[:max(len(dumps) - keep, 0)] if stamp < cutoff]


def to_prune(keys, prefix, days, keep, now):
    """The objects to delete, each manifest before its dump (a dump without one is no backup): the nightly
    backups older than `days` but the newest `keep` whole ones, and halves of one (an upload or a delete cut
    short) once a day old, when no run can still be uploading the other half. A half never takes one of the
    `keep` places, so failed nights cannot push out the backups that restore."""
    found = {}
    for key in keys:
        match = NIGHTLY_OBJECT.fullmatch(key[len(prefix) + 1:])
        if match:
            found.setdefault(match.group(1), []).append(key)
    whole = sorted((stamp, f"{prefix}/{stamp}") for stamp, objects in found.items() if len(objects) == 2)
    stale = (now - datetime.timedelta(days=1)).strftime("%Y%m%dT%H%M%SZ")
    gone = doomed(whole, days, keep, now) + [
        f"{prefix}/{stamp}" for stamp, objects in found.items() if len(objects) == 1 and stamp < stale]
    return [key for base in sorted(gone) for key in (f"{base}.json", f"{base}.dump.enc") if key in keys]


def delete(key):
    """Like a PUT or GET: a 5xx is tried again (a delete of a key that is gone already answers 204)."""
    def once():
        code, body = s3.signed("DELETE", checked_key(key))
        if code >= 500:
            raise urllib.error.HTTPError(key, code, "", None, None)
        if code not in (200, 204):
            sys.exit(f"delete {key}: {code} {body[:200]!r}")

    retried(f"delete {key}", once)


def prune(prefix, days, keep):
    keys = {key for key, _ in s3.listing(prefix + "/")}
    doomed_keys = to_prune(keys, prefix, days, keep, datetime.datetime.now(datetime.timezone.utc))
    for key in doomed_keys:
        delete(key)
        print(f"dropped {key}", flush=True)
    return doomed_keys


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


def backup_key():
    key = os.environ.get("BACKUP_ENCRYPTION_KEY", "")
    if not key:
        sys.exit("no BACKUP_ENCRYPTION_KEY in the environment")
    return key.encode()


def key_id(key):
    """Names the key without giving it away: a restore with another key says so before it decrypts."""
    return hmac.new(key, b"bro backup key id", hashlib.sha256).hexdigest()[:16]


def signature(manifest, key):
    fields = {name: value for name, value in manifest.items() if name != "hmac"}
    mac_key = hmac.new(key, b"bro backup manifest", hashlib.sha256).digest()
    return hmac.new(mac_key, json.dumps(fields, sort_keys=True).encode(), hashlib.sha256).hexdigest()


def sign(manifest, key):
    manifest = {**manifest, "keyId": key_id(key)}
    return {**manifest, "hmac": signature(manifest, key)}


def authenticate(manifest, key, wanted=None):
    """The manifest made with this key and for this object key, or exit."""
    if "hmac" not in manifest:
        sys.exit("the manifest is not signed: not a backup this key made")
    if manifest.get("keyId") != key_id(key):
        sys.exit("the backup was made with another BACKUP_ENCRYPTION_KEY (keyId differs)")
    if not hmac.compare_digest(str(manifest["hmac"]), signature(manifest, key)):
        sys.exit("the manifest's signature is wrong: it was changed, or someone else wrote it")
    if wanted is not None and manifest.get("key") != wanted:
        sys.exit(f"the manifest is that of {str(manifest.get('key'))[:120]!r}, not of {wanted[:120]!r}")


def cmd_manifest(args):
    excluded = Path(args.excluded).read_text().split() if args.excluded and Path(args.excluded).exists() else []
    manifest = {
        "key": checked_key(args.key), "source": args.source,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cipher": "openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256",
        "sha256": args.sha256, "size": args.size, "dumpSha256": args.dump_sha256, "pgDump": args.pg_dump,
        "tables": read_counts(args.counts), "excludedTables": excluded,
    }
    Path(args.out).write_text(json.dumps(sign(manifest, backup_key()), indent=1, sort_keys=True) + "\n")


def cmd_verify(args):
    manifest = json.loads(Path(args.manifest).read_text())
    authenticate(manifest, backup_key(), args.key)
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
    manifest.add_argument("--excluded")
    manifest.add_argument("--size", type=int, required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--manifest", required=True)
    verify.add_argument("--key")
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
