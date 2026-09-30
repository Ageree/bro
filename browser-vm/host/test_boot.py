"""Host boot tests: cd browser-vm/host && python -m unittest (stdlib only).

The user data `boot.py` renders, the bundle it packs, and its boot script run in a temp directory with a
fake curl; `provision.sh` is checked for syntax and for what must never drift (pinned runsc, no flushed
nftables, sandboxes that outlive hostd).
"""

import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import boot  # noqa: E402

PROVISION = (Path(__file__).parent / "provision.sh").read_text()
ARGS = dict(host_id="bro-host-1", key=bytes.fromhex("aa" * 32), runsc_release="20260914",
            bundle_url="https://s3.cloud.ru/b/host.tgz?X-Amz-Signature=x&y='z", bundle_sha256="ab" * 32,
            rootfs_version="2026-09-30.1", rootfs_url="https://s3.cloud.ru/b/rootfs.tar.zst?sig=1",
            rootfs_sha256="cd" * 32)


def written(user_data, path):
    """The content of one write_files entry (single-quoted scalars only)."""
    match = re.search(rf"- path: {re.escape(path)}\n    permissions: \"(\d+)\"\n    content: '((?:[^']|'')*)'", user_data)
    return match.group(1), match.group(2).replace("''", "'")


class CloudInitTest(unittest.TestCase):
    def test_host_key_matches_hostd_tests(self):
        self.assertEqual(boot.host_key("11" * 32, "host-test-1").hex(),
                         "fc0873b32715053d3ff2f84210fe16de8ecebea4b2ea502271c9d927192c9620")

    def test_identity_and_boot_settings_are_private_files(self):
        user_data = boot.cloud_init(**ARGS)
        self.assertTrue(user_data.startswith("#cloud-config\n"))
        mode, identity = written(user_data, "/etc/bro/host.json")
        self.assertEqual((mode, json.loads(identity)), ("0600", {"host": "bro-host-1", "key": "aa" * 32}))
        mode, settings = written(user_data, "/etc/bro/boot.json")
        settings = json.loads(settings)
        self.assertEqual(mode, "0600")
        self.assertEqual(settings["bundle"]["url"], ARGS["bundle_url"])  # a quote in a URL survives
        self.assertEqual(settings["runscRelease"], "20260914")
        self.assertEqual(settings["rootfs"], {"version": "2026-09-30.1", "url": ARGS["rootfs_url"],
                                              "sha256": "cd" * 32})
        self.assertIn("/usr/local/sbin/bro-host-boot > /var/log/bro-provision.log", user_data)

    def test_only_a_dated_runsc_release_is_accepted(self):
        for release in ("release", "latest", "2026-09-14", ""):
            with self.subTest(release), self.assertRaises(ValueError):
                boot.cloud_init(**{**ARGS, "runsc_release": release})
        boot.cloud_init(**{**ARGS, "runsc_release": "20260914.0"})

    def test_bundle_is_reproducible_and_holds_the_host_code(self):
        first = boot.bundle()
        self.assertEqual(first, boot.bundle())
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(first))) as tar:
            members = {m.name: m.mode for m in tar.getmembers()}
        self.assertEqual(set(members), set(boot.FILES))
        self.assertEqual(members["provision.sh"], 0o755)


class BootScriptTest(unittest.TestCase):
    """bro-host-boot with its paths moved into a temp directory and curl answering from a local file."""

    def run_boot(self, bundle, sha256):
        tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        served = tmp / "served.tgz"
        served.write_bytes(bundle)
        (tmp / "etc").mkdir()
        (tmp / "etc" / "boot.json").write_text(json.dumps({"bundle": {"url": "https://s3/x", "sha256": sha256}}))
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        curl = bin_dir / "curl"
        curl.write_text(f'#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && cp {served} "$2"; shift; done\n')
        curl.chmod(0o755)
        user_data = boot.cloud_init(**ARGS)
        script = "\n".join(line[6:] for line in user_data.split("    content: |\n", 1)[1].split("\nruncmd:")[0].splitlines())
        script = (script.replace("/etc/bro/boot.json", str(tmp / "etc" / "boot.json"))
                  .replace("/root/", f"{tmp}/").replace("/opt/bro/host", str(tmp / "host")))
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                                env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"})
        return result, tmp

    def bundle_with_probe(self):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w") as tar:
            data = b'echo provisioned > "$(dirname "$0")/ran"\n'
            info = tarfile.TarInfo("provision.sh")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        return gzip.compress(raw.getvalue())

    def test_runs_provision_from_a_bundle_that_matches(self):
        bundle = self.bundle_with_probe()
        result, tmp = self.run_boot(bundle, hashlib.sha256(bundle).hexdigest())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((tmp / "host" / "ran").read_text(), "provisioned\n")

    def test_a_bundle_that_does_not_match_never_runs(self):
        result, tmp = self.run_boot(self.bundle_with_probe(), "00" * 32)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((tmp / "host" / "ran").exists())


class ProvisionTest(unittest.TestCase):
    def test_is_valid_bash(self):
        subprocess.run(["bash", "-n", str(Path(__file__).parent / "provision.sh")], check=True)

    def test_runsc_is_pinned_and_held(self):
        self.assertIn("https://storage.googleapis.com/gvisor/releases ${RUNSC_RELEASE} main", PROVISION)
        self.assertNotIn("gvisor/releases release main", PROVISION)
        self.assertIn('grep -q "release-${RUNSC_RELEASE}"', PROVISION)
        self.assertIn("apt-mark hold runsc", PROVISION)

    def test_host_setup_invariants(self):
        self.assertIn("net.ipv4.ip_forward = 1", PROVISION)
        self.assertIn("systemctl disable --now nftables", PROVISION)  # its unit flushes hostd's table
        self.assertIn("KillMode=process", PROVISION)
        self.assertIn("admin unix//run/caddy/admin.sock", PROVISION)
        self.assertNotIn("127.0.0.53", PROVISION)
        self.assertIn('sha256sum -c --quiet -', PROVISION)  # the rootfs is checked before it is unpacked
        for requirement in re.findall(r'"(aiohttp|cryptography)([^"]*)"', PROVISION):
            self.assertTrue(requirement[1].startswith("=="), requirement)
        self.assertNotIn("set -x", PROVISION)  # the log must not echo presigned URLs


if __name__ == "__main__":
    unittest.main()
