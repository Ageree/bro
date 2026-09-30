"""Tests of publish.py (stdlib only): the value Bro reads and the upload to a presigned URL."""

import contextlib
import hashlib
import http.server
import io
import re
import threading
import unittest
from pathlib import Path

import publish

HERE = Path(__file__).parent


class Describe(unittest.TestCase):
    def test_reads_the_version_the_worker_reports(self):
        source = (HERE / "worker.py").read_bytes()
        published = publish.describe(source)
        version = re.search(r'^VERSION = "([^"]+)"$', source.decode(), re.MULTILINE).group(1)
        self.assertEqual(published["version"], version)
        self.assertEqual(published["sha256"], hashlib.sha256(source).hexdigest())
        self.assertEqual(published["key"], f"workers/worker-{version}.py")
        self.assertEqual(published["env"], f"{version}:workers/worker-{version}.py:{published['sha256']}")

    def test_refuses_code_without_a_usable_version(self):
        with self.assertRaises(ValueError):
            publish.describe(b"print('no version')\n")
        with self.assertRaises(ValueError):
            publish.describe(b'VERSION = "has space"\n')


class Upload(unittest.TestCase):
    def test_puts_the_exact_bytes(self):
        received = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_PUT(self):  # noqa: N802 - the stdlib's name
                received["path"] = self.path
                received["body"] = self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            source = b'VERSION = "2026-09-30.1"\n\xef\xbb\xbf'
            url = f"http://127.0.0.1:{server.server_port}/bucket/workers/w.py?X-Amz-Signature=abc"
            with contextlib.redirect_stdout(io.StringIO()):
                publish.upload(source, url)
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(received["body"], source)
        self.assertEqual(received["path"], "/bucket/workers/w.py?X-Amz-Signature=abc")

    def test_prints_the_env_value(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(publish.main([]), 0)
        self.assertRegex(out.getvalue(), r"BROWSER_VM_WORKER=[\w.-]+:workers/worker-[\w.-]+\.py:[0-9a-f]{64}\n")


if __name__ == "__main__":
    unittest.main()
