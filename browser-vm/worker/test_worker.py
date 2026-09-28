"""Worker unit tests: python -m unittest browser-vm/worker/test_worker.py (needs aiohttp).

The token vector is shared with Bro's `tests/agent/browser-vm/token.test.ts`: both sides must agree on
the exact bytes, or every call from Bro to a VM is refused.
"""

import asyncio
import base64
import hashlib
import hmac
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import worker  # noqa: E402

SIGNING = bytes.fromhex("11" * 32)
WORKSPACE = "ws_test_123"
KEY = hmac.new(SIGNING, f"bro-browser-vm:{WORKSPACE}".encode(), hashlib.sha256).digest()
CONFIG = {"environment": WORKSPACE, "key": KEY}
TOKEN = "v1.eyJlbnYiOiJ3c190ZXN0XzEyMyIsImdlbiI6MywiZXhwIjoxNzkwMDAwMzAwfQ.sounRHPylHeCoYxmM2jPawS3Bh0zE45yyIKv54MsuL8"
SESSION_TOKEN = ("v1.eyJlbnYiOiJ3c190ZXN0XzEyMyIsImdlbiI6MywiZXhwIjoxNzkwMDAwMzAwLCJzZXMiOiJ2bTp3c190ZXN0XzEyMzpzOmFiYyJ9"
                 ".BXSmPnEMmg0KrJrCg1FDFLgyF6EQ0qXdjHeIe7oPMbY")
NOW = 1790000300 - 60


class TokenTest(unittest.TestCase):
    def test_vm_key_derivation_matches_bro(self):
        self.assertEqual(KEY.hex(), "b62a60b9925024534507acf039e236b698c33866d8e18c727661251748984301")

    def test_accepts_bro_token_and_session_scope(self):
        self.assertEqual(worker.verify_token(TOKEN, CONFIG, 0, NOW)["gen"], 3)
        self.assertEqual(worker.verify_token(SESSION_TOKEN, CONFIG, 3, NOW)["ses"], "vm:ws_test_123:s:abc")

    def test_refuses_tampering_other_vm_expiry_and_stale_generation(self):
        cases = {
            "bad signature": (TOKEN[:-2] + "AA", CONFIG, 0, NOW),
            "token for another environment": (TOKEN, {"environment": "other", "key": KEY}, 0, NOW),
            "expired token": (TOKEN, CONFIG, 0, 1790000300 + 1),
            "stale generation": (TOKEN, CONFIG, 4, NOW),
            "worker not configured": (TOKEN, None, 0, NOW),
        }
        for reason, (token, config, generation, now) in cases.items():
            with self.subTest(reason), self.assertRaisesRegex(worker.Unauthorized, reason):
                worker.verify_token(token, config, generation, now)

    def test_refuses_a_token_that_lives_too_long(self):
        with self.assertRaisesRegex(worker.Unauthorized, "expired token"):
            worker.verify_token(TOKEN, CONFIG, 0, 1790000300 - worker.MAX_TOKEN_LIFETIME_S - 5)


class SecretsTest(unittest.TestCase):
    def test_bindings_become_domain_scoped_sensitive_data(self):
        data = worker.secrets_to_sensitive_data([
            {"alias": "signin_phone", "allowedDomains": ["wildberries.ru"], "value": "9001234567"},
            {"alias": "card_number", "allowedDomains": ["shop.ru", "yookassa.ru"], "value": "4111"},
            {"alias": "Bad Alias", "allowedDomains": ["x.ru"], "value": "v"},
            {"alias": "login_password", "allowedDomains": ["no-dot", "evil.ru/path"], "value": "p"},
        ])
        self.assertEqual(data, {
            "https://*.wildberries.ru": {"signin_phone": "9001234567"},
            "https://*.shop.ru": {"card_number": "4111"},
            "https://*.yookassa.ru": {"card_number": "4111"},
        })


class ForwarderTest(unittest.IsolatedAsyncioTestCase):
    async def test_refuses_to_browse_before_the_proxy_is_set(self):
        forwarder = worker.Forwarder()
        server = await asyncio.start_server(forwarder.handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
        await writer.drain()
        answer = await reader.read(200)
        writer.close()
        server.close()
        self.assertTrue(answer.startswith(b"HTTP/1.1 502"))
        self.assertEqual(forwarder.totals["refused"], 1)

    async def test_adds_the_login_for_the_upstream(self):
        seen = []

        async def upstream(reader, writer):
            seen.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            writer.close()

        up = await asyncio.start_server(upstream, "127.0.0.1", 0)
        forwarder = worker.Forwarder()
        forwarder.configure({"host": "127.0.0.1", "port": up.sockets[0].getsockname()[1],
                             "username": "user-session-abc", "password": "p:w"})
        server = await asyncio.start_server(forwarder.handle, "127.0.0.1", 0)
        reader, writer = await asyncio.open_connection("127.0.0.1", server.sockets[0].getsockname()[1])
        writer.write(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Authorization: x\r\n\r\n")
        await writer.drain()
        await reader.read(100)
        writer.close()
        server.close()
        up.close()
        head = seen[0].decode()
        login = base64.b64encode(b"user-session-abc:p:w").decode()
        self.assertIn(f"Proxy-Authorization: Basic {login}", head)
        self.assertEqual(head.count("Proxy-Authorization"), 1)


if __name__ == "__main__":
    unittest.main()
