"""State sets: a parked sandbox as encrypted chunks in Object Storage, written and read over presigned URLs.

A set has parts — `profile` (a tar of the sandbox's profile directory) and, unless it is a cold set,
`image` (a tar of the `runsc checkpoint` image) — each compressed with zstd by the caller and cut here
into chunks of `chunk_bytes`. Chunks are numbered across the whole set (the profile first), and chunk i
goes to `chunk_urls[i]`. The manifest is written last, only after every chunk is in: a set without a
manifest does not exist.

The host holds no storage credentials: Bro presigns every PUT and GET and passes the URLs in the request
(the Cloud.ru key never goes to a VM). The data key comes from Bro with each request (HKDF from
BROWSER_STATE_KEY and the workspace id) and lives in memory only.

Encryption: AES-256-GCM per chunk under a key of this set alone — HKDF of the data key with a random salt
and the set id — with the part number and the chunk's index within its part as the nonce, and the set id,
part, index and a last-chunk flag as associated data. A chunk moved to another place, another set or
another part, or a part cut short, fails its tag. The manifest carries an HMAC under the same set key, so
its list of chunks and their SHA-256 (of the stored bytes, checked before decryption) cannot be edited.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path

import aiohttp
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from yarl import URL

FORMAT = 1
PARTS = ("profile", "image")
TAG_BYTES = 16
ATTEMPTS = 3


class SetError(Exception):
    """The set cannot be written or read: a missing URL, a transfer that kept failing, or tampering."""


def data_key(value):
    """Bro's data key: 64 hex characters (32 bytes)."""
    if not isinstance(value, str) or len(value) != 64:
        raise ValueError("dataKey must be 64 hex characters")
    return bytes.fromhex(value)


def set_keys(key, set_id, salt):
    """(encryption key, manifest MAC key) of one set."""
    material = HKDF(algorithm=hashes.SHA256(), length=64, salt=salt,
                    info=f"bro-browser-set:v{FORMAT}:{set_id}".encode()).derive(key)
    return material[:32], material[32:]


def nonce(part, index):
    return PARTS.index(part).to_bytes(4, "big") + index.to_bytes(8, "big")


def associated(set_id, part, index, last):
    return f"{set_id}|{part}|{index}|{int(last)}".encode()


def seal(key, set_id, part, index, last, plain):
    return AESGCM(key).encrypt(nonce(part, index), plain, associated(set_id, part, index, last))


def unseal(key, set_id, part, index, last, sealed):
    try:
        return AESGCM(key).decrypt(nonce(part, index), sealed, associated(set_id, part, index, last))
    except Exception:
        raise SetError(f"chunk {index} of {part} does not decrypt: tampered, reordered or from another set") from None


def canonical(manifest):
    return json.dumps({k: v for k, v in manifest.items() if k != "mac"}, sort_keys=True,
                      separators=(",", ":")).encode()


def sign(mac_key, manifest):
    return {**manifest, "mac": hmac.new(mac_key, canonical(manifest), hashlib.sha256).hexdigest()}


def verified(key, manifest):
    """The manifest after its MAC is checked, with its set's encryption key."""
    try:
        salt = base64.b64decode(manifest["salt"])
        set_id = manifest["setId"]
        mac = manifest["mac"]
    except (KeyError, TypeError, ValueError):
        raise SetError("manifest is malformed") from None
    if manifest.get("format") != FORMAT:
        raise SetError(f"manifest format {manifest.get('format')!r} is not {FORMAT}")
    encryption, mac_key = set_keys(key, set_id, salt)
    expected = hmac.new(mac_key, canonical(manifest), hashlib.sha256).hexdigest()
    if not isinstance(mac, str) or not hmac.compare_digest(mac, expected):
        raise SetError("manifest does not verify: another key, or edited")
    return encryption


def plan(sizes, chunk_bytes):
    """Chunks of each part in order: (part, index in part, global index, offset, length, last)."""
    chunks, number = [], 0
    for part, size in sizes:
        count = max(1, -(-size // chunk_bytes))
        for index in range(count):
            offset = index * chunk_bytes
            chunks.append((part, index, number, offset, min(chunk_bytes, size - offset), index == count - 1))
            number += 1
    return chunks


async def transfer(http, method, url, data=None):
    """One PUT or GET with retries (network errors and 5xx); a 4xx is final (an expired or wrong URL).
    The URL goes out byte for byte as Bro presigned it: yarl would otherwise requote it (`%2F` in the
    credential, `%3A` in a key), and the signature would no longer match."""
    for attempt in range(ATTEMPTS):
        try:
            async with http.request(method, URL(url, encoded=True), data=data,
                                    timeout=aiohttp.ClientTimeout(total=120)) as response:
                if response.status < 300:
                    return await response.read()
                if response.status < 500:
                    raise SetError(f"{method} answered {response.status}")
                failure = f"{method} answered {response.status}"
        except (aiohttp.ClientError, asyncio.TimeoutError) as error:
            failure = f"{method} failed: {type(error).__name__}"
        if attempt < ATTEMPTS - 1:
            await asyncio.sleep(0.5 * 2 ** attempt)
    raise SetError(failure)


def read_range(path, offset, length):
    with open(path, "rb") as file:
        file.seek(offset)
        return file.read(length)


def write_range(path, offset, data):
    descriptor = os.open(path, os.O_WRONLY)
    try:
        os.pwrite(descriptor, data, offset)
    finally:
        os.close(descriptor)


async def upload(http, *, key, set_id, parts, chunk_urls, manifest_url, chunk_bytes, parallel, extra):
    """Encrypt and PUT `parts` ([(name, path of its compressed bytes, plain size)]) in parallel, then the
    manifest. Returns the manifest. Memory holds at most `parallel` chunks."""
    sizes = [(name, Path(path).stat().st_size) for name, path, _plain in parts]
    chunks = plan(sizes, chunk_bytes)
    if len(chunk_urls) < len(chunks):
        raise SetError(f"the set needs {len(chunks)} chunk URLs, {len(chunk_urls)} were given")
    salt = os.urandom(16)
    encryption, mac_key = set_keys(key, set_id, salt)
    paths = {name: path for name, path, _plain in parts}
    limit = asyncio.Semaphore(parallel)
    digests = {}

    async def put(part, index, number, offset, length, last):
        async with limit:
            plain = await asyncio.to_thread(read_range, paths[part], offset, length)
            sealed = await asyncio.to_thread(seal, encryption, set_id, part, index, last, plain)
            digests[number] = (hashlib.sha256(sealed).hexdigest(), len(sealed))
            await transfer(http, "PUT", chunk_urls[number], sealed)

    await gather_all([put(*chunk) for chunk in chunks])
    manifest = {
        "format": FORMAT, "setId": set_id, "salt": base64.b64encode(salt).decode(), "chunkBytes": chunk_bytes,
        **extra,
        "parts": [{
            "name": name, "plainBytes": plain, "bytes": dict(sizes)[name],
            "chunks": [{"index": number, "sha256": digests[number][0], "bytes": digests[number][1]}
                       for part, _i, number, _o, _l, _last in chunks if part == name],
        } for name, _path, plain in parts],
    }
    manifest = sign(mac_key, manifest)
    await transfer(http, "PUT", manifest_url, json.dumps(manifest).encode())
    return manifest


async def fetch_manifest(http, key, manifest_url):
    try:
        manifest = json.loads(await transfer(http, "GET", manifest_url))
    except ValueError:
        raise SetError("manifest is not JSON") from None
    if not isinstance(manifest, dict):
        raise SetError("manifest is malformed")
    return manifest, verified(key, manifest)


async def download(http, *, manifest, encryption, part, chunk_urls, target, parallel):
    """GET one part's chunks in parallel into `target` (its compressed bytes), each checked by SHA-256
    and decrypted. Returns the part's entry of the manifest."""
    entry = next((p for p in manifest["parts"] if p.get("name") == part), None)
    if entry is None:
        raise SetError(f"the set has no {part}")
    chunk_bytes, set_id = manifest["chunkBytes"], manifest["setId"]
    listed = entry["chunks"]
    if not listed or sum(c["bytes"] - TAG_BYTES for c in listed) != entry["bytes"]:
        raise SetError(f"{part}: the chunks do not add up to its size")
    with open(target, "wb") as file:
        file.truncate(entry["bytes"])
    limit = asyncio.Semaphore(parallel)

    async def get(index, chunk):
        number = chunk["index"]
        if not isinstance(number, int) or not 0 <= number < len(chunk_urls):
            raise SetError(f"no URL for chunk {number}")
        async with limit:
            sealed = await transfer(http, "GET", chunk_urls[number])
            if hashlib.sha256(sealed).hexdigest() != chunk["sha256"]:
                raise SetError(f"chunk {number} does not match its checksum")
            plain = await asyncio.to_thread(unseal, encryption, set_id, part, index, index == len(listed) - 1, sealed)
            await asyncio.to_thread(write_range, target, index * chunk_bytes, plain)

    await gather_all([get(index, chunk) for index, chunk in enumerate(listed)])
    return entry


async def gather_all(coroutines):
    """Run all; on the first failure cancel the rest and raise it."""
    tasks = [asyncio.ensure_future(c) for c in coroutines]
    try:
        await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
