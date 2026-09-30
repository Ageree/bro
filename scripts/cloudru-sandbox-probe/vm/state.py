"""Park and restore a browser sandbox through Object Storage, the way hostd would (docs/browser-pool.md, §5).

  python3 state.py park ID URLS.json KEYFILE          checkpoint → tar of profile → zstd → AES-256-GCM → parts → manifest
  python3 state.py fetch URLS.json KEYFILE ID         parts in 4 threads → decrypt → unpack profile and checkpoint
  python3 state.py archive ID URLS.json KEYFILE       the profile alone (no memory: the "cold" set, the only one of
                                                      plain containers), after the sandbox stopped
  python3 state.py put FILE URLS.json                 a plain file (the rootfs, runsc) as parts, manifest last
  python3 state.py get URLS.json OUT                  and back

URLS.json maps object names (`manifest`, `part-000`, …) to presigned links made by `s3.py presign-many` in the
session: the Cloud.ru key never reaches the probe VM. KEYFILE holds the master key (hex); the set key is
HKDF-SHA256 of it and the workspace id, as BROWSER_STATE_KEY would be. Timings go to stdout as JSON.

The set is `tar(checkpoint/, profile.tar, worker.json)` → zstd -3 → chunked AES-256-GCM: 4 MiB chunks, nonce =
8 random bytes of the set + the chunk index, the index and a last-chunk flag in the associated data (chunks
cannot be dropped, reordered or cut off unnoticed).
"""

import concurrent.futures
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAGIC = b"BROSTATE1"
CHUNK = 4 * 2**20
PART = 32 * 2**20
WORKSPACE = "probe-ws"
RUNSC = ["runsc", "--root", "/run/runsc", "--platform=systrap", "--overlay2=root:memory"]
HERE = Path(__file__).resolve().parent
times = {}


def timed(name):
    class Timer:
        def __enter__(self):
            self.start = time.monotonic()

        def __exit__(self, *_):
            times[name] = round(time.monotonic() - self.start, 3)
    return Timer()


def set_key(keyfile):
    master = bytes.fromhex(Path(keyfile).read_text().strip())
    return HKDF(hashes.SHA256(), 32, salt=b"bro-browser-state", info=WORKSPACE.encode()).derive(master)


def encrypt(key, source, target):
    aead, prefix = AESGCM(key), os.urandom(8)
    size = os.path.getsize(source)
    with open(source, "rb") as src, open(target, "wb") as out:
        out.write(MAGIC + prefix)
        index = 0
        while True:
            chunk = src.read(CHUNK)
            last = src.tell() >= size
            aad = MAGIC + index.to_bytes(4, "big") + bytes([last])
            out.write(aead.encrypt(prefix + index.to_bytes(4, "big"), chunk, aad))
            index += 1
            if last:
                return


def decrypt(key, source, target):
    aead = AESGCM(key)
    with open(source, "rb") as src, open(target, "wb") as out:
        head = src.read(len(MAGIC) + 8)
        if head[:len(MAGIC)] != MAGIC:
            raise ValueError("not a state set")
        prefix, index, size = head[len(MAGIC):], 0, os.path.getsize(source)
        while True:
            sealed = src.read(CHUNK + 16)
            last = src.tell() >= size
            aad = MAGIC + index.to_bytes(4, "big") + bytes([last])
            out.write(aead.decrypt(prefix + index.to_bytes(4, "big"), sealed, aad))
            index += 1
            if last:
                return


def request(method, url, data=None, headers=None):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data, headers or {}, method=method),
                                        timeout=300) as response:
                return response.read()
        except OSError:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def upload(path, urls, meta):
    """Parts in 4 threads, then the manifest: a set without its manifest does not exist."""
    size = os.path.getsize(path)
    names = [f"part-{i:03d}" for i in range((size + PART - 1) // PART)]
    if len(names) > len([n for n in urls if n.startswith("part-")]):
        sys.exit(f"{len(names)} parts, not enough links")

    def put(i):
        with open(path, "rb") as f:
            f.seek(i * PART)
            data = f.read(PART)
        request("PUT", urls[names[i]], data)
        return {"name": names[i], "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        parts = list(pool.map(put, range(len(names))))
    manifest = {**meta, "size": size, "parts": parts, "created": time.time()}
    request("PUT", urls["manifest"], json.dumps(manifest).encode())
    return manifest


def download(urls, path):
    manifest = json.loads(request("GET", urls["manifest"]))

    def get(part):
        data = request("GET", urls[part["name"]])
        if hashlib.sha256(data).hexdigest() != part["sha256"]:
            raise ValueError(f"{part['name']}: checksum")
        return data

    with concurrent.futures.ThreadPoolExecutor(4) as pool, open(path, "wb") as out:
        for data in pool.map(get, manifest["parts"]):
            out.write(data)
    return manifest


def sh(command):
    subprocess.run(command, shell=True, check=True)


def runsc_version():
    return subprocess.run(RUNSC[:1] + ["--version"], capture_output=True, text=True).stdout.splitlines()[0]


def cpu():
    for line in open("/proc/cpuinfo"):
        if line.startswith("model name"):
            return line.split(":", 1)[1].strip()


def park(sid, urlfile, keyfile):
    urls = json.loads(Path(urlfile).read_text())
    work, box = Path(f"/dev/shm/park-{sid}"), Path(f"/srv/sandboxes/{sid}")
    sh(f"rm -rf {work} && mkdir -p {work}")
    with timed("checkpoint"):
        subprocess.run(RUNSC + ["checkpoint", f"--image-path={work}/checkpoint", sid], check=True)
    with timed("tarProfile"):
        sh(f"tar -C {box} -cf {work}/profile.tar profile")
    sh(f"cp {box}/worker.json {work}/worker.json")
    with timed("zstd"):
        sh(f"tar -C {work} -cf - checkpoint profile.tar worker.json | zstd -q -3 -T0 -o {work}/set.tar.zst")
    with timed("encrypt"):
        encrypt(set_key(keyfile), work / "set.tar.zst", work / "set.bin")
    sizes = {"checkpointMb": int(subprocess.check_output(["du", "-sm", f"{work}/checkpoint"]).split()[0]),
             "profileTarMb": round(os.path.getsize(work / "profile.tar") / 2**20, 1),
             "zstdMb": round(os.path.getsize(work / "set.tar.zst") / 2**20, 1),
             "encryptedMb": round(os.path.getsize(work / "set.bin") / 2**20, 1)}
    with timed("upload"):
        manifest = upload(work / "set.bin", urls, {"format": "bro-state-1", "runsc": runsc_version(), "cpu": cpu(),
                                                   "workspace": WORKSPACE})
    print(json.dumps({"times": times, "sizes": sizes, "parts": len(manifest["parts"])}))


def archive(sid, urlfile, keyfile):
    urls = json.loads(Path(urlfile).read_text())
    work, box = Path(f"/dev/shm/park-{sid}"), Path(f"/srv/sandboxes/{sid}")
    sh(f"rm -rf {work} && mkdir -p {work}")
    with timed("tarProfile"):
        sh(f"tar -C {box} -cf {work}/profile.tar profile")
    sh(f"cp {box}/worker.json {work}/worker.json")
    with timed("zstd"):
        sh(f"tar -C {work} -cf - profile.tar worker.json | zstd -q -3 -T0 -o {work}/set.tar.zst")
    with timed("encrypt"):
        encrypt(set_key(keyfile), work / "set.tar.zst", work / "set.bin")
    sizes = {"profileTarMb": round(os.path.getsize(work / "profile.tar") / 2**20, 1),
             "zstdMb": round(os.path.getsize(work / "set.tar.zst") / 2**20, 1)}
    with timed("upload"):
        manifest = upload(work / "set.bin", urls, {"format": "bro-profile-1", "workspace": WORKSPACE})
    print(json.dumps({"times": times, "sizes": sizes, "parts": len(manifest["parts"])}))


def fetch(urlfile, keyfile, sid):
    urls = json.loads(Path(urlfile).read_text())
    work, box = Path(f"/dev/shm/restore-{sid}"), Path(f"/srv/sandboxes/{sid}")
    sh(f"rm -rf {work} && mkdir -p {work} {box}")
    with timed("download"):
        manifest = download(urls, work / "set.bin")
    with timed("decrypt"):
        decrypt(set_key(keyfile), work / "set.bin", work / "set.tar.zst")
    with timed("unpack"):
        sh(f"zstd -q -d -c {work}/set.tar.zst | tar -C {work} -xf - && rm -rf {box}/profile "
           f"&& tar -C {box} -xf {work}/profile.tar && install -m 600 {work}/worker.json {box}/worker.json "
           f"&& chown --reference={box}/profile {box}/worker.json && rm -f {work}/set.bin {work}/set.tar.zst")
    print(json.dumps({"times": times, "madeOn": {"runsc": manifest.get("runsc"), "cpu": manifest.get("cpu")},
                      "here": {"runsc": runsc_version(), "cpu": cpu()}, "image": f"{work}/checkpoint"}))


def main():
    command, args = sys.argv[1], sys.argv[2:]
    if command == "park":
        park(*args)
    elif command == "archive":
        archive(*args)
    elif command == "fetch":
        fetch(*args)
    elif command == "put":
        with timed("upload"):
            manifest = upload(args[0], json.loads(Path(args[1]).read_text()), {"name": os.path.basename(args[0])})
        print(json.dumps({"times": times, "parts": len(manifest["parts"]), "mb": round(manifest["size"] / 2**20)}))
    elif command == "get":
        with timed("download"):
            manifest = download(json.loads(Path(args[0]).read_text()), args[1])
        print(json.dumps({"times": times, "parts": len(manifest["parts"]), "mb": round(manifest["size"] / 2**20)}))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
