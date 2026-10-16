"""Pure-Python AES-128/256 for pypdf: the sandbox has neither `cryptography` nor `pycryptodome`.

pypdf's fallback provider decrypts RC4 but raises DependencyError for AES, so most modern
password-protected PDFs could not be opened. `install()` puts this module in its place.

The key schedule and the single-block cipher use T-tables on Python ints; ECB and CBC
decryption of many blocks are vectorised with numpy (the blocks are independent there).
CBC encryption is sequential by nature (≈ 1.5 s per MB). Own scripts:
`from brokit.aes import install; install()` before using pypdf.
"""

import secrets
import struct

_RCON = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36)


def _sboxes():
    """The AES S-box and its inverse, generated from GF(2^8) arithmetic (FIPS-197 §5.1.1)."""
    sbox = [0] * 256
    p = q = 1
    while True:
        p = p ^ ((p << 1) & 0xFF) ^ (0x1B if p & 0x80 else 0)  # p * 3
        q ^= q << 1  # q / 3
        q ^= q << 2
        q ^= q << 4
        q &= 0xFF
        if q & 0x80:
            q ^= 0x09
        x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4))
        sbox[p] = (x ^ 0x63) & 0xFF
        if p == 1:
            break
    sbox[0] = 0x63
    inverse = [0] * 256
    for index, value in enumerate(sbox):
        inverse[value] = index
    return sbox, inverse


SBOX, INV_SBOX = _sboxes()


def _times(a, b):
    result = 0
    while b:
        if b & 1:
            result ^= a
        a = ((a << 1) ^ 0x1B) & 0xFF if a & 0x80 else a << 1
        b >>= 1
    return result


def _rotate(word, bits):
    return ((word >> bits) | (word << (32 - bits))) & 0xFFFFFFFF


def _tables(first):
    return [first, [_rotate(w, 8) for w in first], [_rotate(w, 16) for w in first], [_rotate(w, 24) for w in first]]


TE = _tables([(_times(s, 2) << 24) | (s << 16) | (s << 8) | _times(s, 3) for s in SBOX])
TD = _tables([(_times(s, 14) << 24) | (_times(s, 9) << 16) | (_times(s, 13) << 8) | _times(s, 11) for s in INV_SBOX])

_numpy_tables = {}


def _np():
    """numpy and the tables as uint32 arrays, built on first use (most commands never decrypt)."""
    import numpy

    if not _numpy_tables:
        _numpy_tables.update(
            te=[numpy.array(t, dtype=numpy.uint32) for t in TE],
            td=[numpy.array(t, dtype=numpy.uint32) for t in TD],
            sbox=numpy.array(SBOX, dtype=numpy.uint32),
            inv=numpy.array(INV_SBOX, dtype=numpy.uint32),
        )
    return numpy, _numpy_tables


def _sub_word(word):
    return (SBOX[word >> 24] << 24) | (SBOX[(word >> 16) & 255] << 16) | (SBOX[(word >> 8) & 255] << 8) | SBOX[word & 255]


def _expand(key):
    words_in_key = len(key) // 4
    if len(key) not in (16, 32):
        raise ValueError("AES key must be 16 or 32 bytes")
    rounds = words_in_key + 6
    w = [int.from_bytes(key[4 * i : 4 * i + 4], "big") for i in range(words_in_key)]
    for i in range(words_in_key, 4 * (rounds + 1)):
        t = w[i - 1]
        if i % words_in_key == 0:
            t = _sub_word(((t << 8) & 0xFFFFFFFF) | (t >> 24)) ^ (_RCON[i // words_in_key - 1] << 24)
        elif words_in_key > 6 and i % words_in_key == 4:
            t = _sub_word(t)
        w.append(w[i - words_in_key] ^ t)
    encrypt_keys = [w[4 * r : 4 * r + 4] for r in range(rounds + 1)]
    # Equivalent inverse cipher (FIPS-197 §5.3.5): InvMixColumns applied to the middle round keys.
    decrypt_keys = [encrypt_keys[rounds]]
    for r in range(rounds - 1, 0, -1):
        decrypt_keys.append(
            [TD[0][SBOX[k >> 24]] ^ TD[1][SBOX[(k >> 16) & 255]] ^ TD[2][SBOX[(k >> 8) & 255]] ^ TD[3][SBOX[k & 255]] for k in encrypt_keys[r]]
        )
    decrypt_keys.append(encrypt_keys[0])
    return rounds, encrypt_keys, decrypt_keys


class Key:
    """An expanded AES key."""

    def __init__(self, key):
        self.rounds, self.encrypt_keys, self.decrypt_keys = _expand(bytes(key))

    def encrypt_words(self, s0, s1, s2, s3):
        """One block as four big-endian words in, four out (the CBC loop stays on ints)."""
        t0, t1, t2, t3 = TE
        keys = self.encrypt_keys
        k = keys[0]
        s0, s1, s2, s3 = s0 ^ k[0], s1 ^ k[1], s2 ^ k[2], s3 ^ k[3]
        for r in range(1, self.rounds):
            k = keys[r]
            s0, s1, s2, s3 = (
                t0[s0 >> 24] ^ t1[(s1 >> 16) & 255] ^ t2[(s2 >> 8) & 255] ^ t3[s3 & 255] ^ k[0],
                t0[s1 >> 24] ^ t1[(s2 >> 16) & 255] ^ t2[(s3 >> 8) & 255] ^ t3[s0 & 255] ^ k[1],
                t0[s2 >> 24] ^ t1[(s3 >> 16) & 255] ^ t2[(s0 >> 8) & 255] ^ t3[s1 & 255] ^ k[2],
                t0[s3 >> 24] ^ t1[(s0 >> 16) & 255] ^ t2[(s1 >> 8) & 255] ^ t3[s2 & 255] ^ k[3],
            )
        k = keys[self.rounds]
        box = SBOX
        return (
            ((box[s0 >> 24] << 24) | (box[(s1 >> 16) & 255] << 16) | (box[(s2 >> 8) & 255] << 8) | box[s3 & 255]) ^ k[0],
            ((box[s1 >> 24] << 24) | (box[(s2 >> 16) & 255] << 16) | (box[(s3 >> 8) & 255] << 8) | box[s0 & 255]) ^ k[1],
            ((box[s2 >> 24] << 24) | (box[(s3 >> 16) & 255] << 16) | (box[(s0 >> 8) & 255] << 8) | box[s1 & 255]) ^ k[2],
            ((box[s3 >> 24] << 24) | (box[(s0 >> 16) & 255] << 16) | (box[(s1 >> 8) & 255] << 8) | box[s2 & 255]) ^ k[3],
        )

    def encrypt_block(self, block):
        return struct.pack(">4I", *self.encrypt_words(*struct.unpack(">4I", bytes(block))))

    def blocks(self, data, decrypt):
        """ECB over every 16-byte block of data at once (numpy)."""
        numpy, tables = _np()
        count = len(data) // 16
        state = numpy.frombuffer(data, dtype=">u4").astype(numpy.uint32).reshape(count, 4)
        keys = numpy.array(self.decrypt_keys if decrypt else self.encrypt_keys, dtype=numpy.uint32)
        t0, t1, t2, t3 = tables["td"] if decrypt else tables["te"]
        box = tables["inv"] if decrypt else tables["sbox"]
        # Decryption reads the columns in the inverse ShiftRows order.
        o1, o2, o3 = (3, 2, 1) if decrypt else (1, 2, 3)
        state = state ^ keys[0]
        for r in range(1, self.rounds + 1):
            c = [state[:, i] for i in range(4)]
            columns = []
            for i in range(4):
                a, b, d, e = c[i] >> 24, (c[(i + o1) % 4] >> 16) & 255, (c[(i + o2) % 4] >> 8) & 255, c[(i + o3) % 4] & 255
                if r < self.rounds:
                    columns.append(t0[a] ^ t1[b] ^ t2[d] ^ t3[e])
                else:
                    columns.append((box[a] << 24) | (box[b] << 16) | (box[d] << 8) | box[e])
            state = numpy.stack(columns, axis=1) ^ keys[r]
        return state.astype(">u4").tobytes()


def _whole_blocks(data):
    if len(data) % 16:
        raise ValueError("AES data must be a multiple of 16 bytes")
    return bytes(data)


def aes_ecb_encrypt(key, data):
    data = _whole_blocks(data)
    return Key(key).blocks(data, decrypt=False) if data else b""


def aes_ecb_decrypt(key, data):
    data = _whole_blocks(data)
    return Key(key).blocks(data, decrypt=True) if data else b""


def aes_cbc_encrypt(key, iv, data):
    data = _whole_blocks(data)
    encrypt = Key(key).encrypt_words
    words = struct.unpack(">%dI" % (len(data) // 4), data)
    c0, c1, c2, c3 = struct.unpack(">4I", bytes(iv))
    out = []
    for i in range(0, len(words), 4):
        c0, c1, c2, c3 = encrypt(words[i] ^ c0, words[i + 1] ^ c1, words[i + 2] ^ c2, words[i + 3] ^ c3)
        out.extend((c0, c1, c2, c3))
    return struct.pack(">%dI" % len(out), *out)


def aes_cbc_decrypt(key, iv, data):
    data = _whole_blocks(data)
    if not data:
        return b""
    numpy, _ = _np()
    plain = numpy.frombuffer(Key(key).blocks(data, decrypt=True), dtype=numpy.uint8)
    chain = numpy.frombuffer(bytes(iv) + data[:-16], dtype=numpy.uint8)
    return (plain ^ chain).tobytes()


class CryptAES:
    """pypdf's CryptAES contract: encrypt → IV + CBC(PKCS#7(data)); decrypt strips the IV and the padding."""

    def __init__(self, key):
        self.key = bytes(key)

    def encrypt(self, data):
        iv = secrets.token_bytes(16)
        pad = 16 - len(data) % 16
        return iv + aes_cbc_encrypt(self.key, iv, bytes(data) + bytes([pad]) * pad)

    def decrypt(self, data, *, strict=True):
        from pypdf.errors import PdfStreamError

        iv, body = bytes(data[:16]), bytes(data[16:])
        if not body:
            return body
        if len(body) % 16:
            if strict:
                raise PdfStreamError("AES data is not a multiple of 16 bytes")
            pad = 16 - len(body) % 16
            body += bytes([pad]) * pad
        out = aes_cbc_decrypt(self.key, iv, body)
        pad = out[-1]
        if 1 <= pad <= 16 and out[-pad:] == bytes([pad]) * pad:
            return out[:-pad]
        if strict:
            raise PdfStreamError("bad AES padding")
        return out[:-pad] if 1 <= pad <= 16 else out


def install():
    """Plug this provider into pypdf when pypdf has no AES of its own; returns the provider in use."""
    from pypdf import _crypt_providers, _encryption

    if _crypt_providers.crypt_provider[0] != "local_crypt_fallback":
        return _crypt_providers.crypt_provider[0]
    for name, value in (
        ("CryptAES", CryptAES),
        ("aes_ecb_encrypt", aes_ecb_encrypt),
        ("aes_ecb_decrypt", aes_ecb_decrypt),
        ("aes_cbc_encrypt", aes_cbc_encrypt),
        ("aes_cbc_decrypt", aes_cbc_decrypt),
    ):
        setattr(_encryption, name, value)
    return "brokit-aes"
