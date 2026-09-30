"""Host boot tests: cd browser-vm/host && python -m unittest (stdlib only).

The user data `boot.py` renders, the bundle it packs (with a fake vendor directory and pins made for it),
and its boot script run in a temp directory with a fake curl; `provision.sh` is checked for syntax and for
what must never drift (runc by default and a pinned runsc, nothing fetched from GitHub or PyPI, no flushed
nftables, sandboxes that outlive hostd).
"""

import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import boot  # noqa: E402

PROVISION = (Path(__file__).parent / "provision.sh").read_text()
ARGS = dict(host_id="bro-host-1", key=bytes.fromhex("aa" * 32),
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
        self.assertEqual((settings["runtime"], settings["runscRelease"]), ("runc", ""))
        self.assertEqual(settings["aptMirror"], "http://mirror.yandex.ru/ubuntu")
        self.assertEqual(settings["rootfs"], {"version": "2026-09-30.1", "url": ARGS["rootfs_url"],
                                              "sha256": "cd" * 32})
        self.assertIn("/usr/local/sbin/bro-host-boot > /var/log/bro-provision.log", user_data)

    def test_runsc_needs_a_dated_release_and_runc_none(self):
        for release in ("release", "latest", "2026-09-14", "", None):
            with self.subTest(release), self.assertRaises(ValueError):
                boot.cloud_init(**{**ARGS, "runtime": "runsc", "runsc_release": release})
        _mode, settings = written(boot.cloud_init(**{**ARGS, "runtime": "runsc", "runsc_release": "20260914.0"}),
                                  "/etc/bro/boot.json")
        self.assertEqual((json.loads(settings)["runtime"], json.loads(settings)["runscRelease"]), ("runsc", "20260914.0"))
        with self.assertRaises(ValueError):
            boot.cloud_init(**{**ARGS, "runtime": "docker"})
        with self.assertRaises(ValueError):
            boot.cloud_init(**{**ARGS, "apt_mirror": "http://mirror.yandex.ru/ubuntu; rm -rf /"})


class BundleTest(unittest.TestCase):
    def vendor(self):
        directory = Path(tempfile.mkdtemp())  # not enterContext: the host's Python is 3.10
        self.addCleanup(shutil.rmtree, directory, True)
        (directory / "wheels").mkdir()
        (directory / "caddy").write_bytes(b"caddy binary")
        (directory / "wheels" / "aiohttp-3.12.15-cp310-cp310-manylinux_2_17_x86_64.whl").write_bytes(b"wheel a")
        (directory / "wheels" / "yarl-1.25.1-cp310-cp310-manylinux_2_17_x86_64.whl").write_bytes(b"wheel y")
        pins = {"caddy_sha256": boot.sha256(b"caddy binary"),
                "wheel_hashes": {boot.sha256(b"wheel a"), boot.sha256(b"wheel y")}}
        return directory, pins

    def test_is_reproducible_and_holds_the_host_code_caddy_and_the_wheels(self):
        directory, pins = self.vendor()
        first = boot.bundle(directory, **pins)
        self.assertEqual(first, boot.bundle(directory, **pins))
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(first))) as tar:
            members = {m.name: m.mode for m in tar.getmembers()}
        self.assertEqual(set(members), set(boot.FILES) | {
            "vendor/caddy", "wheels/aiohttp-3.12.15-cp310-cp310-manylinux_2_17_x86_64.whl",
            "wheels/yarl-1.25.1-cp310-cp310-manylinux_2_17_x86_64.whl"})
        self.assertEqual((members["provision.sh"], members["vendor/caddy"]), (0o755, 0o755))

    def test_an_unpinned_or_missing_file_never_goes_in(self):
        directory, pins = self.vendor()
        (directory / "caddy").write_bytes(b"another caddy")
        with self.assertRaisesRegex(ValueError, "Caddy"):
            boot.bundle(directory, **pins)
        directory, pins = self.vendor()
        (directory / "wheels" / "evil-1.0-py3-none-any.whl").write_bytes(b"evil")
        with self.assertRaisesRegex(ValueError, "not pinned"):
            boot.bundle(directory, **pins)
        directory, pins = self.vendor()
        (directory / "wheels" / "yarl-1.25.1-cp310-cp310-manylinux_2_17_x86_64.whl").unlink()
        with self.assertRaisesRegex(ValueError, "missing"):
            boot.bundle(directory, **pins)

    def test_every_requirement_is_pinned_to_one_wheel_and_caddy_to_one_binary(self):
        requirements = (Path(boot.__file__).parent / "requirements.txt").read_text()
        names = re.findall(r"(?m)^([a-z0-9-]+)==\S+ \\$", requirements)
        self.assertEqual(len(names), len(boot.pinned_wheels(requirements)))
        self.assertTrue({"aiohttp", "cryptography", "async-timeout"} <= set(names))  # Python 3.10 needs it
        self.assertRegex(boot.VENDOR["caddy"]["binarySha256"], r"^[0-9a-f]{64}$")
        self.assertTrue(boot.VENDOR["caddy"]["url"].startswith("https://github.com/caddyserver/caddy/releases/"))


class BootScriptTest(unittest.TestCase):
    """bro-host-boot with its paths moved into a temp directory and curl answering from a local file."""

    def run_boot(self, bundle, sha256):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
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

    def test_runc_by_default_and_runsc_pinned_and_held(self):
        self.assertIn('RUNTIME="${RUNTIME:-runc}"', PROVISION)
        self.assertIn("PACKAGES+=(runc)", PROVISION)
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
        # Nothing from GitHub, PyPI or Caddy's apt repository: they are silent from Cloud.ru.
        self.assertIn('--no-index --find-links "$HOST/wheels" --require-hashes -r "$HOST/requirements.txt"',
                      PROVISION)
        for unreachable in ("github", "pypi.org", "cloudsmith", "archive.ubuntu.com/ubuntu "):
            self.assertNotIn(unreachable, PROVISION)
        self.assertIn('install -m 755 "$HOST/vendor/caddy" /usr/bin/caddy', PROVISION)
        self.assertIn("(archive|security)\\.ubuntu\\.com", PROVISION)  # apt goes to the mirror
        # Not a knob of Ubuntu's kernel (Debian's): `sysctl -e` would drop it without a word.
        self.assertNotIn("unprivileged_userns_clone", PROVISION)
        self.assertIn("fs.inotify.max_user_instances = 8192", PROVISION)  # one `bro` uid for every sandbox
        # Caddy faces the internet: it binds 80 and 443 and nothing more (no nft over hostd's table).
        self.assertIn("AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n"
                      "NoNewPrivileges=true\n", PROVISION)
        self.assertNotRegex(PROVISION, r"Capabilit\w*=.*CAP_NET_ADMIN")
        self.assertIn('dpkg --compare-versions "$(dpkg-query -W -f=\'${Version}\' runc)" ge 1.1.12', PROVISION)
        # The host's own public address is refused to sandboxes like every other blocked destination.
        self.assertIn('settings["egress_blocked"] = [sys.argv[3] + "/32"]', PROVISION)
        self.assertNotIn("set -x", PROVISION)  # the log must not echo presigned URLs
        self.assertIn("tar --numeric-owner -I zstd -xpf", PROVISION)  # the rootfs keeps its own ids

    def test_the_stage_is_readable_before_the_slow_steps(self):
        # hostd serves `stage` on /h/v1/health: it must be up before the rootfs download, or a failure
        # there would only show as a host that never answers.
        order = [line.split()[1] for line in PROVISION.splitlines() if re.match(r"stage [a-z]+$", line)]
        self.assertEqual(order, ["start", "packages", "venv", "caddy", "hostd", "network", "rootfs", "ready"])

    def test_the_hostd_settings_provision_writes_load(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        script = PROVISION[PROVISION.index("python3 -c 'import json, sys\nsettings"):]
        script = script[:script.index('"$DOMAIN" "$RUNTIME" "$IP"')]
        code = script[len("python3 -c '"):script.rindex("'")]
        for ip, blocked in (("203.0.113.7", ["203.0.113.7/32"]), ("", None)):
            with self.subTest(ip=ip):
                target = tmp / "hostd.json"
                subprocess.run([sys.executable, "-c", code.replace("/etc/bro/hostd.json", str(target)),
                                "203-0-113-7.sslip.io", "runc", ip], check=True)
                settings = json.loads(target.read_text())
                self.assertEqual(settings.get("egress_blocked"), blocked)
                self.assertEqual(settings["runtime"], "runc")
        self.assertLess(PROVISION.index("systemctl enable --now bro-hostd"), PROVISION.index("stage rootfs"))


if __name__ == "__main__":
    unittest.main()
