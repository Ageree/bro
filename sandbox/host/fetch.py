"""Download one large object behind a presigned URL in parallel ranges and check its SHA-256 (stdlib only).

  python3 fetch.py --sha256 HEX [--parts 4] URL OUT

Object Storage of Cloud.ru serves a large object 3-4 times faster in 4 ranged streams than in one
(docs/browser-infra-notes.md). The file is written to OUT.part and renamed once its SHA-256 matches; a
range that breaks off is resumed from where it stopped, a few times. A server that ignores Range gets one
plain GET. Messages never carry the URL's query: it is a presigned capability.
"""

import argparse
import hashlib
import http.client
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request

CHUNK = 1 << 20
MIN_PART = 8 << 20
ATTEMPTS = 6


def redact(url):
    return url.split("?", 1)[0]


def size_of(url, timeout):
    """The object's size from a one-byte ranged GET, or None when the server ignores Range."""
    request = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status == 206:
            match = re.search(r"/(\d+)$", response.headers.get("Content-Range", ""))
            if match:
                return int(match.group(1))
        return None


def fetch_range(url, fd, start, end, timeout, progress):
    """Bytes start..end (inclusive) into fd at their offset, resuming after a break."""
    position, attempt = start, 0
    while position <= end:
        request = urllib.request.Request(url, headers={"Range": f"bytes={position}-{end}"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.status != 206:
                    raise OSError(f"range answered {response.status}")
                while position <= end:
                    data = response.read(min(CHUNK, end - position + 1))
                    if not data:
                        break
                    os.pwrite(fd, data, position)
                    position += len(data)
                    progress(len(data))
        except (OSError, http.client.HTTPException) as error:  # URLError and timeouts are OSErrors
            attempt += 1
            if attempt >= ATTEMPTS:
                raise OSError(f"bytes {position}-{end}: {error}") from None
            time.sleep(2 ** attempt)


def fetch_whole(url, fd, timeout):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        position = 0
        while True:
            data = response.read(CHUNK)
            if not data:
                return position
            os.pwrite(fd, data, position)
            position += len(data)


def fetch(url, out, sha256, parts=4, timeout=60):
    partial = out + ".part"
    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    started = time.monotonic()
    try:
        try:
            size = size_of(url, timeout)
        except urllib.error.HTTPError as error:
            raise SystemExit(f"fetch {redact(url)}: HTTP {error.code}") from None
        if size is None:
            size = fetch_whole(url, fd, timeout)
        else:
            os.ftruncate(fd, size)
            count = max(1, min(parts, size // MIN_PART))
            bounds = [(i * size // count, (i + 1) * size // count - 1) for i in range(count)]
            errors, lock, done = [], threading.Lock(), [0]

            def progress(n):
                with lock:
                    done[0] += n

            def worker(start, end):
                try:
                    fetch_range(url, fd, start, end, timeout, progress)
                except Exception as error:  # reported below, the other ranges finish or fail on their own
                    errors.append(error)

            threads = [threading.Thread(target=worker, args=bound) for bound in bounds if bound[0] <= bound[1]]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            if errors:
                raise SystemExit(f"fetch {redact(url)}: {errors[0]}")
    finally:
        os.close(fd)
    digest = hashlib.sha256()
    with open(partial, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            digest.update(block)
    if digest.hexdigest() != sha256.lower():
        os.unlink(partial)
        raise SystemExit(f"fetch {redact(url)}: sha256 mismatch")
    os.rename(partial, out)
    return size, time.monotonic() - started


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--parts", type=int, default=4)
    parser.add_argument("url")
    parser.add_argument("out")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[0-9a-fA-F]{64}", args.sha256):
        raise SystemExit("--sha256 must be 64 hex characters")
    size, seconds = fetch(args.url, args.out, args.sha256, args.parts)
    print(f"fetched {size} bytes in {seconds:.1f} s", file=sys.stderr)


if __name__ == "__main__":
    main()
