"""Code host boot tests: cd sandbox/host && python3 -m unittest (stdlib only).

The user data boot.py renders, the bundle it packs, its boot script run in a temp directory with a fake
curl, fetch.py against a local HTTP server with and without Range, and provision.sh's syntax and what must
not drift (a pinned runsc held by apt, the rootfs unpacked with its own uids, Caddy's admin on a socket).
"""

import gzip
import hashlib
import hmac
import http.server
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import boot  # noqa: E402
import fetch  # noqa: E402

HERE = Path(__file__).parent
PROVISION = (HERE / "provision.sh").read_text()
ARGS = dict(host_id="sbx-code-1", key=bytes.fromhex("aa" * 32),
            bundle_url="https://s3.cloud.ru/b/code-host.tgz?X-Amz-Signature=x&y='z", bundle_sha256="ab" * 32,
            rootfs_version="20261001-b853d5d4", rootfs_url="https://s3.cloud.ru/b/rootfs.tar.zst?sig=1",
            rootfs_sha256="cd" * 32, runsc_url="https://s3.cloud.ru/b/runsc.deb?sig=2", runsc_sha256="ef" * 32)


def written(user_data, path):
    """The content of one write_files entry (single-quoted scalars only)."""
    match = re.search(rf"- path: {re.escape(path)}\n    permissions: \"(\d+)\"\n    content: '((?:[^']|'')*)'",
                      user_data)
    return match.group(1), match.group(2).replace("''", "'")


def private_dir(test):
    directory = Path(tempfile.mkdtemp())  # not enterContext: the host's Python is 3.10
    test.addCleanup(shutil.rmtree, directory, True)
    return directory


class CloudInitTest(unittest.TestCase):
    def test_host_key_is_bros_derivation(self):
        # sandboxHostKey in agent/lib/sandbox/keys.ts: HMAC-SHA256(hex-decoded signing key, label).
        expected = hmac.new(bytes.fromhex("33" * 32), b"bro-sandbox-host:sbx-code-1", hashlib.sha256).digest()
        self.assertEqual(boot.host_key("33" * 32, "sbx-code-1"), expected)
        self.assertEqual(len(expected), 32)

    def test_sandboxd_config_and_boot_settings_are_private_files(self):
        user_data = boot.cloud_init(**ARGS)
        self.assertTrue(user_data.startswith("#cloud-config\n"))
        mode, config = written(user_data, "/etc/bro/sandboxd.json")
        # Only keys sandboxd's Config knows: it refuses unknown ones.
        self.assertEqual((mode, json.loads(config)),
                         ("0600", {"host": "sbx-code-1", "key": "aa" * 32, "rootfs_version": "20261001-b853d5d4"}))
        mode, settings = written(user_data, "/etc/bro/code-host-boot.json")
        settings = json.loads(settings)
        self.assertEqual(mode, "0600")
        self.assertEqual(settings["bundle"], {"url": ARGS["bundle_url"], "sha256": "ab" * 32})  # a quote survives
        self.assertEqual(settings["rootfs"], {"version": "20261001-b853d5d4", "url": ARGS["rootfs_url"],
                                              "sha256": "cd" * 32})
        self.assertEqual(settings["runsc"], {"release": boot.VENDOR["runsc"]["release"], "url": ARGS["runsc_url"],
                                             "sha256": "ef" * 32})
        self.assertEqual((settings["domain"], settings["aptMirror"]), ("", "http://mirror.yandex.ru/ubuntu"))
        self.assertIn("/usr/local/sbin/bro-code-host-boot > /var/log/bro-provision.log", user_data)
        self.assertNotIn("chpasswd", user_data)

    def test_console_password_is_a_hash_and_ssh_stays_off(self):
        digest = "$6$0123456789abcdef$" + "A" * 86
        user_data = boot.cloud_init(**ARGS, console_password_hash=digest)
        self.assertIn(f"    - {{name: root, password: '{digest}', type: hash}}", user_data)
        self.assertIn("ssh_pwauth: false", user_data)
        with self.assertRaises(ValueError):
            boot.cloud_init(**ARGS, console_password_hash="plain text")

    def test_refuses_what_provision_would_refuse(self):
        bad = [{"host_id": "Sbx_1"}, {"key": b"short"}, {"rootfs_version": "../x"}, {"runsc_release": "release"},
               {"runsc_release": "2026-09-28"}, {"runsc_url": None}, {"runsc_url": ""}, {"runsc_sha256": None},
               {"bundle_sha256": "AB" * 32},
               {"apt_mirror": "http://mirror.yandex.ru/ubuntu; rm -rf /"}, {"domain": "a b.example"}]
        for change in bad:
            with self.subTest(change), self.assertRaises(ValueError):
                boot.cloud_init(**{**ARGS, **change})
        for hosts in ([("brobro.tech", "10.0.1.7; rm")], [("bro tech", "10.0.1.7")], [("brobro.tech", "999.0.1.7")],
                      [("brobro.tech", "\u0661\u0660.0.1.7")],  # Arabic-Indic digits: \d, but not for provision.sh
                      [("brobro.tech", "10.0.1.7"), ("brobro.tech", "10.0.1.8")]):
            with self.subTest(hosts), self.assertRaises(ValueError):
                boot.cloud_init(**ARGS, hosts=hosts)
        _mode, settings = written(boot.cloud_init(**{**ARGS, "runsc_release": "20260928.0"}),
                                  "/etc/bro/code-host-boot.json")
        self.assertEqual(json.loads(settings)["runsc"]["release"], "20260928.0")


class BundleTest(unittest.TestCase):
    def setUp(self):
        self.vendor = private_dir(self)
        (self.vendor / "caddy").write_bytes(b"caddy binary")
        self.sandboxd = self.vendor / "sandboxd-build"
        self.sandboxd.write_bytes(b"\x7fELF sandboxd")
        self.pins = {"caddy_sha256": boot.sha256(b"caddy binary")}

    def test_bundle_is_reproducible_and_complete(self):
        first = boot.bundle(self.vendor, self.sandboxd, **self.pins)
        self.assertEqual(first, boot.bundle(self.vendor, self.sandboxd, **self.pins))
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(first))) as tar:
            members = {m.name: m.mode for m in tar.getmembers()}
        self.assertEqual(members, {"provision.sh": 0o755, "fetch.py": 0o644, "sandboxd.service": 0o644,
                                   "sandboxd": 0o755, "vendor/caddy": 0o755})

    def test_refuses_an_unpinned_caddy_or_a_non_binary(self):
        with self.assertRaises(ValueError):
            boot.bundle(self.vendor, self.sandboxd, caddy_sha256="00" * 32)
        script = self.vendor / "sandboxd.sh"
        script.write_text("#!/bin/sh\n")
        with self.assertRaises(ValueError):
            boot.bundle(self.vendor, script, **self.pins)

    def test_unit_runs_the_binary_provision_installs(self):
        unit = (HERE / "sandboxd.service").read_text()
        exec_start = re.search(r"^ExecStart=(\S+)", unit, re.M).group(1)
        self.assertTrue(exec_start.startswith("/"))
        self.assertIn('install -m 755 "$HOST/sandboxd" "$SANDBOXD"', PROVISION)


class BootScriptTest(unittest.TestCase):
    def test_fetches_checks_and_hands_over(self):
        work = private_dir(self)
        bundle_dir = work / "bundle"
        bundle_dir.mkdir()
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w:gz") as tar:
            data = b"#!/bin/bash\necho provisioned from $(pwd)\n"
            info = tarfile.TarInfo("provision.sh")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        (bundle_dir / "code-host.tgz").write_bytes(raw.getvalue())
        bin_dir = work / "bin"
        bin_dir.mkdir()
        # curl -o <file> <url>: copy the fixture, only for the bundle's own URL (its query whole); the
        # script's paths are moved under the temp directory.
        url = "https://s3.cloud.ru/b/code-host.tgz?X-Amz-Signature=x&y=z"
        (bin_dir / "curl").write_text(f"#!/bin/bash\n[ \"${{!#}}\" = '{url}' ] || exit 22\n"
                                      f"while [ $# -gt 1 ]; do [ \"$1\" = -o ] && out=$2; shift; done\n"
                                      f"cp {bundle_dir / 'code-host.tgz'} \"$out\"\n")
        (bin_dir / "curl").chmod(0o755)
        settings = work / "boot.json"
        settings.write_text(json.dumps({"bundle": {"url": url, "sha256": hashlib.sha256(raw.getvalue()).hexdigest()}}))
        script = boot.BOOT_SCRIPT.replace("/etc/bro/code-host-boot.json", str(settings)) \
            .replace("/root/", f"{work}/").replace("/opt/bro/code-host", str(work / "host"))
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                                env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"provisioned from", result.stdout)
        self.assertFalse((work / "bro-code-host.tgz").exists())

        settings.write_text(json.dumps({"bundle": {"url": url, "sha256": "00" * 32}}))
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                                env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"})
        self.assertNotEqual(result.returncode, 0)


class RangeHandler(http.server.BaseHTTPRequestHandler):
    body = b""
    ranges = True
    seen = []
    cut = 0  # how many ranged answers (other than bytes=0-0) end half way

    def do_GET(self):  # noqa: N802
        header = self.headers.get("Range")
        self.seen.append(header)
        match = re.fullmatch(r"bytes=(\d+)-(\d+)", header or "")
        if self.ranges and match:
            start, end = int(match.group(1)), min(int(match.group(2)), len(self.body) - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(self.body)}")
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            part = self.body[start:end + 1]
            if header != "bytes=0-0" and self.cut:
                type(self).cut -= 1
                part = part[:len(part) // 2]
                self.close_connection = True
            self.wfile.write(part)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *args):
        pass


class FetchTest(unittest.TestCase):
    def serve(self, body, ranges, cut=0):
        handler = type("Handler", (RangeHandler,), {"body": body, "ranges": ranges, "seen": [], "cut": cut})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}/object?X-Amz-Signature=secret", handler

    def test_parallel_ranges_make_the_whole_file(self):
        body = os.urandom(fetch.MIN_PART * 3 + 12345)
        url, handler = self.serve(body, ranges=True)
        out = private_dir(self) / "rootfs.tar.zst"
        size, _ = fetch.fetch(url, str(out), hashlib.sha256(body).hexdigest(), parts=4)
        self.assertEqual((size, out.read_bytes()), (len(body), body))
        self.assertEqual(len([r for r in handler.seen if r != "bytes=0-0"]), 3)  # 3 parts of at least MIN_PART
        self.assertEqual(oct(out.stat().st_mode & 0o777), "0o600")

    def test_a_server_without_ranges_gets_one_get(self):
        body = b"small object"
        url, _ = self.serve(body, ranges=False)
        out = private_dir(self) / "x"
        self.assertEqual(fetch.fetch(url, str(out), hashlib.sha256(body).hexdigest())[0], len(body))
        self.assertEqual(out.read_bytes(), body)

    def test_a_range_cut_short_resumes_and_a_server_that_always_cuts_runs_out_of_attempts(self):
        body = b"0123456789" * 1000
        url, handler = self.serve(body, ranges=True, cut=2)
        out = private_dir(self) / "x"
        with mock.patch.object(fetch.time, "sleep"):
            self.assertEqual(fetch.fetch(url, str(out), hashlib.sha256(body).hexdigest())[0], len(body))
        self.assertEqual(out.read_bytes(), body)
        self.assertEqual(handler.seen[1:], ["bytes=0-9999", "bytes=5000-9999", "bytes=7500-9999"])

        url, handler = self.serve(body, ranges=True, cut=-1)
        with mock.patch.object(fetch.time, "sleep"), self.assertRaises(SystemExit) as raised:
            fetch.fetch(url, str(out), hashlib.sha256(body).hexdigest())
        self.assertIn("ended early", str(raised.exception))
        self.assertEqual(len(handler.seen), 1 + fetch.ATTEMPTS)

    def test_a_wrong_sha256_leaves_nothing_and_never_shows_the_query(self):
        url, _ = self.serve(b"object", ranges=True)
        out = private_dir(self) / "x"
        with self.assertRaises(SystemExit) as raised:
            fetch.fetch(url, str(out), "00" * 32)
        self.assertNotIn("secret", str(raised.exception))
        self.assertFalse(out.exists() or Path(str(out) + ".part").exists())


class HostsTest(unittest.TestCase):
    """Bro's domain pinned at its private address: in the boot settings, then in /etc/hosts by provision.sh."""

    def test_boot_settings_carry_the_entries(self):
        _mode, settings = written(boot.cloud_init(**ARGS, hosts=[("brobro.tech", "10.0.1.7")]),
                                  "/etc/bro/code-host-boot.json")
        self.assertEqual(json.loads(settings)["hosts"], [{"name": "brobro.tech", "address": "10.0.1.7"}])
        _mode, settings = written(boot.cloud_init(**ARGS), "/etc/bro/code-host-boot.json")
        self.assertEqual(json.loads(settings)["hosts"], [])
        self.assertEqual(boot.hosts_entry(" BroBro.tech = 10.0.1.7"), ("brobro.tech", "10.0.1.7"))

    TEMPLATE = "127.0.1.1 {{fqdn}} {{hostname}}\n127.0.0.1 localhost\n"
    # provision.sh's hosts stage: the arguments it is run with there, and its script.
    ARGV, SCRIPT = re.search(r"^python3 - ([^\n]*) <<'PY'\n(.*?)\nPY\n", PROVISION, re.S | re.M).groups()

    def run_stage(self, entries, hosts, template=None):
        """The stage with the very arguments provision.sh gives it, each file in a temp directory (the template
        only when given). Returns the hosts file, the template (or None) and the directory."""
        directory = private_dir(self)
        files = {'"$BOOT"': directory / "boot.json", "/etc/hosts": directory / "hosts",
                 "/etc/cloud/templates/hosts.debian.tmpl": directory / "hosts.debian.tmpl"}
        files['"$BOOT"'].write_text(json.dumps({"hosts": entries}))
        files["/etc/hosts"].write_text(hosts)
        if template is not None:
            files["/etc/cloud/templates/hosts.debian.tmpl"].write_text(template)
        subprocess.run([sys.executable, "-c", self.SCRIPT, *(str(files[arg]) for arg in self.ARGV.split())],
                       check=True, capture_output=True)
        tmpl = directory / "hosts.debian.tmpl"
        return (directory / "hosts").read_text(), tmpl.read_text() if tmpl.exists() else None, directory

    def test_provision_writes_one_marked_line_per_name(self):
        entries = [{"name": "brobro.tech", "address": "10.0.1.7"}]
        hosts, template, _ = self.run_stage(entries, "127.0.0.1 localhost\n1.2.3.4 brobro.tech\n")
        self.assertEqual(hosts, "127.0.0.1 localhost\n10.0.1.7 brobro.tech # bro-private\n")
        self.assertIsNone(template)  # an image without the template: nothing made up
        self.assertEqual(self.run_stage(entries, hosts)[0], hosts)  # run again: the same file
        self.assertEqual(self.run_stage([], hosts)[0], "127.0.0.1 localhost\n")

    def test_provision_pins_the_names_in_cloud_inits_template_too(self):
        entries = [{"name": "brobro.tech", "address": "10.0.1.7"}]
        hosts, template, _ = self.run_stage(entries, "127.0.0.1 localhost\n", template=self.TEMPLATE)
        self.assertEqual(template, self.TEMPLATE + "10.0.1.7 brobro.tech # bro-private\n")
        self.assertEqual(self.run_stage(entries, hosts, template=template)[1], template)

    def test_provision_replaces_the_files_whole_with_their_mode(self):
        directory = self.run_stage([{"name": "brobro.tech", "address": "10.0.1.7"}], "127.0.0.1 localhost\n")[2]
        (directory / "hosts").chmod(0o640)
        inode = (directory / "hosts").stat().st_ino
        subprocess.run([sys.executable, "-c", self.SCRIPT, str(directory / "boot.json"), str(directory / "hosts")],
                       check=True)
        self.assertNotEqual((directory / "hosts").stat().st_ino, inode)  # renamed over, never truncated
        self.assertEqual((directory / "hosts").stat().st_mode & 0o7777, 0o640)
        self.assertEqual(sorted(path.name for path in directory.iterdir()), ["boot.json", "hosts"])

    def test_provision_refuses_a_name_pinned_twice(self):
        entries = [{"name": "brobro.tech", "address": "10.0.1.7"}, {"name": "brobro.tech", "address": "10.0.1.8"}]
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_stage(entries, "127.0.0.1 localhost\n")

    def test_stage_comes_before_sandboxd(self):
        self.assertLess(PROVISION.index("stage hosts"), PROVISION.index("stage sandboxd"))


class ProvisionTest(unittest.TestCase):
    def test_syntax(self):
        subprocess.run(["bash", "-n", str(HERE / "provision.sh")], check=True)

    def test_what_must_not_drift(self):
        # runsc: a dated release, checked after install and held; the rootfs with its own uids, hidden until
        # whole; Caddy's admin API never on TCP; NDJSON streams unbuffered.
        self.assertIn('grep -q "release-${RUNSC_RELEASE}"', PROVISION)
        self.assertIn("apt-mark hold runsc", PROVISION)
        self.assertIn('tar --numeric-owner -I zstd -xpf "$ARCHIVE" -C "$PARTIAL"', PROVISION)
        self.assertIn('mv "$PARTIAL" "$ROOTFS"', PROVISION)
        self.assertIn("admin unix//run/caddy/admin.sock", PROVISION)
        self.assertIn("flush_interval -1", PROVISION)
        self.assertNotIn("github.com", PROVISION)
        self.assertNotIn("gvisor.dev", PROVISION)  # out of reach from Cloud.ru: runsc comes from Object Storage
        self.assertNotIn("pip install", PROVISION)


if __name__ == "__main__":
    unittest.main()
