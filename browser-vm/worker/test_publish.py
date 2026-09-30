"""Tests of publish.py (stdlib only): the value Bro reads and the upload to a presigned URL."""

import contextlib
import hashlib
import http.server
import io
import re
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import publish

HERE = Path(__file__).parent


@contextlib.contextmanager
def bucket():
    """A stand-in for Object Storage that keeps a key once, as a PUT with If-None-Match: * asks."""
    stored = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_PUT(self):  # noqa: N802 - the stdlib's name
            body = self.rfile.read(int(self.headers["Content-Length"]))
            key = self.path.split("?")[0]
            if self.headers.get("If-None-Match") == "*" and key in stored:
                self.send_response(412)
            else:
                stored[key] = (self.path, body)
                self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", stored
    finally:
        server.shutdown()
        server.server_close()


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
        source = b'VERSION = "2026-09-30.1"\n\xef\xbb\xbf'
        with bucket() as (origin, stored):
            publish.upload(source, f"{origin}/bucket/workers/w.py?X-Amz-Signature=abc")
        self.assertEqual(stored["/bucket/workers/w.py"], ("/bucket/workers/w.py?X-Amz-Signature=abc", source))

    def test_does_not_overwrite_a_published_version(self):
        first = b'VERSION = "2026-09-30.1"\n'
        with bucket() as (origin, stored), tempfile.TemporaryDirectory() as folder:
            url = f"{origin}/bucket/workers/w.py?X-Amz-Signature=abc"
            publish.upload(first, url)
            file = Path(folder) / "worker.py"
            file.write_bytes(b'VERSION = "2026-09-30.1"\nCHANGED = 1\n')
            with mock.patch.object(publish, "committed", return_value=None), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(publish.main(["--file", str(file), "--put-url", url]), 3)
        self.assertIn("already published", err.getvalue())
        self.assertEqual(stored["/bucket/workers/w.py"][1], first)

    def test_refuses_changed_code_under_the_committed_version(self):
        head = b'VERSION = "2026-09-30.1"\n'
        changed = b'VERSION = "2026-09-30.1"\nCHANGED = 1\n'
        path = Path("worker.py")
        with mock.patch.object(publish, "committed", return_value=head):
            self.assertFalse(publish.unbumped(head, path))
            self.assertTrue(publish.unbumped(changed, path))
            self.assertFalse(publish.unbumped(b'VERSION = "2026-09-30.2"\nCHANGED = 1\n', path))
            with tempfile.TemporaryDirectory() as folder, bucket() as (origin, stored), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
                file = Path(folder) / "worker.py"
                file.write_bytes(changed)
                self.assertEqual(publish.main(["--file", str(file), "--put-url", f"{origin}/b/w.py"]), 2)
                self.assertEqual(stored, {})
                self.assertEqual(publish.main(["--file", str(file), "--put-url", f"{origin}/b/w.py", "--force"]), 0)
                self.assertEqual(stored["/b/w.py"][1], changed)
        self.assertIn("bump it", err.getvalue())

    def test_reads_the_committed_worker_from_git(self):
        # This very file is in git: HEAD has a worker.py with a VERSION line (or, outside git, nothing).
        head = publish.committed(HERE / "worker.py")
        if head is not None:
            self.assertIn(b"VERSION = ", head)

    def test_prints_the_env_value(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(publish.main([]), 0)
        self.assertRegex(out.getvalue(), r"BROWSER_VM_WORKER=[\w.-]+:workers/worker-[\w.-]+\.py:[0-9a-f]{64}\n")


if __name__ == "__main__":
    unittest.main()
