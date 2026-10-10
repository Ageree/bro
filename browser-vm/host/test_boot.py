"""Host boot tests: cd browser-vm/host && python -m unittest (stdlib only, and hostd's imports for its tokens).

The user data `boot.py` renders, the bundle it packs (with a fake vendor directory and pins made for it),
and its boot script run in a temp directory with fake curl, dpkg and systemctl; `provision.sh` is checked for
syntax and for what must never drift (runc by default and a pinned runsc, nothing fetched from GitHub or PyPI,
no flushed nftables, sandboxes that outlive hostd, every step safe to repeat).
"""

import base64
import gzip
import hashlib
import hmac
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
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import boot  # noqa: E402

PROVISION = (Path(__file__).parent / "provision.sh").read_text()
UNITS = (Path(__file__).parent / "units.sh").read_text()
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

    def test_memory_limit_only_when_shared(self):
        # A server shared with the code sandbox host: hostd gets its share; alone, boot.json is as Bro writes it.
        _mode, settings = written(boot.cloud_init(**ARGS, memory_limit_mb=18432), "/etc/bro/boot.json")
        self.assertEqual(json.loads(settings)["memoryLimitMb"], 18432)
        self.assertNotIn("memoryLimitMb", json.loads(written(boot.cloud_init(**ARGS), "/etc/bro/boot.json")[1]))
        with self.assertRaises(ValueError):
            boot.cloud_init(**ARGS, memory_limit_mb=-1)

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

    def test_the_update_key_is_written_only_when_the_operators_signing_key_is_given(self):
        # Bro's own writer (agent/lib/browser-pool/hosts.ts) never writes it, and tests/agent/browser-pool/
        # hosts.test.ts holds this script to its bytes: without the operator's key nothing changes.
        _mode, plain = written(boot.cloud_init(**ARGS), "/etc/bro/host.json")
        self.assertEqual(plain, json.dumps({"host": "bro-host-1", "key": "aa" * 32}))
        update = boot.update_key("33" * 32, "bro-host-1")
        mode, identity = written(boot.cloud_init(**ARGS, host_update_key=update), "/etc/bro/host.json")
        self.assertEqual(mode, "0600")
        self.assertEqual(json.loads(identity), {"host": "bro-host-1", "key": "aa" * 32, "updateKey": update.hex()})
        # HMAC-SHA256(signing key, "bro-browser-host-update:" + host id): another domain than the host key,
        # so one never stands in for the other, and another host has another key.
        self.assertEqual(update, hmac.new(bytes.fromhex("33" * 32), b"bro-browser-host-update:bro-host-1",
                                          hashlib.sha256).digest())
        self.assertNotEqual(update, boot.host_key("33" * 32, "bro-host-1"))
        self.assertNotEqual(update, boot.update_key("33" * 32, "bro-host-2"))
        self.assertEqual(len(update.hex()), 64)

    def test_the_command_line_makes_the_update_key_from_its_own_env_and_never_from_bros(self):
        argv = ["cloud-init", "--host-id", "bro-host-1", "--bundle-url", "https://b/x", "--bundle-sha256", "ab" * 32,
                "--rootfs-version", "v1", "--rootfs-url", "https://b/r", "--rootfs-sha256", "cd" * 32]
        only_bro = {"BROWSER_VM_SIGNING_KEY": "11" * 32}
        both = {**only_bro, "BRO_HOST_UPDATE_SIGNING_KEY": " 33" + "33" * 31 + "\n"}
        for env, expected in ((only_bro, None), (both, boot.update_key("33" * 32, "bro-host-1").hex())):
            with self.subTest(sorted(env)), unittest.mock.patch.dict(os.environ, env, clear=True), \
                    unittest.mock.patch("sys.stdout", io.StringIO()) as out:
                boot.main(argv)
            identity = json.loads(written(out.getvalue(), "/etc/bro/host.json")[1])
            self.assertEqual(identity.get("updateKey"), expected)
            self.assertEqual(identity["key"], boot.host_key("11" * 32, "bro-host-1").hex())
        # The operator's key is not derived from Bro's: without its own env there is no token to make.
        with unittest.mock.patch.dict(os.environ, only_bro, clear=True), self.assertRaises(SystemExit) as stopped:
            boot.main(["token", "--host-id", "bro-host-1", "--scope", "update"])
        self.assertIn("BRO_HOST_UPDATE_SIGNING_KEY is required", str(stopped.exception))

    def test_the_boot_script_runs_at_every_boot_and_logs_itself(self):
        # runcmd runs once per instance, marked done before it starts: a reboot mid-provision (02.10.2026)
        # left the host dead. A per-boot script runs again, the first boot included.
        user_data = boot.cloud_init(**ARGS)
        head = "  - path: /var/lib/cloud/scripts/per-boot/bro-host-boot\n    permissions: \"0700\"\n    content: |\n"
        self.assertIn(head, user_data)
        self.assertEqual(boot.BOOT_SCRIPT_PATH, "/var/lib/cloud/scripts/per-boot/bro-host-boot")
        self.assertNotIn("runcmd", user_data)
        self.assertNotIn("/usr/local/sbin/", user_data)
        script = user_data.split(head, 1)[1]
        self.assertEqual(script, "".join(f"      {line}\n" if line else "\n" for line in boot.BOOT_SCRIPT.splitlines()))
        self.assertTrue(boot.BOOT_SCRIPT.startswith(
            "#!/bin/bash\nset -euo pipefail\nexec >>/var/log/bro-provision.log 2>&1\n"))

    def test_firecracker_is_a_runtime_that_needs_nothing_more_in_the_user_data(self):
        # The bundle carries Firecracker and the kernel: boot.json names the runtime and nothing else.
        _mode, settings = written(boot.cloud_init(**{**ARGS, "runtime": "firecracker"}), "/etc/bro/boot.json")
        settings = json.loads(settings)
        self.assertEqual((settings["runtime"], settings["runscRelease"]), ("firecracker", ""))
        self.assertEqual(set(settings), set(json.loads(written(boot.cloud_init(**ARGS), "/etc/bro/boot.json")[1])))
        self.assertEqual(boot.RUNTIMES, ("runc", "runsc", "firecracker"))

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

    def test_carries_the_rollback_guard_and_an_update_key_only_when_asked_to(self):
        directory, pins = self.vendor()
        self.assertIn("rollback.sh", boot.FILES)
        plain = boot.bundle(directory, **pins)
        key = boot.update_key("33" * 32, "bro-host-1")
        enrolled = boot.bundle(directory, enroll_update_key=key, **pins)
        self.assertEqual(enrolled, boot.bundle(directory, enroll_update_key=key, **pins))  # still reproducible

        def entries(data):
            with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data))) as tar:
                return {m.name: (m.mode, tar.extractfile(m).read()) for m in tar.getmembers()}

        self.assertNotIn("enroll/update-key", entries(plain))  # the shared bundle never holds a host's key
        self.assertEqual(entries(enrolled)["enroll/update-key"], (0o600, key.hex().encode() + b"\n"))
        self.assertEqual(entries(plain)["rollback.sh"][0], 0o755)
        self.assertEqual({k: v for k, v in entries(enrolled).items() if k != "enroll/update-key"}, entries(plain))

    def test_the_command_line_enrolls_the_key_derived_from_the_operators_signing_key(self):
        out = Path(tempfile.mkdtemp()) / "host.tgz"
        self.addCleanup(shutil.rmtree, out.parent, True)
        env = {"BRO_HOST_UPDATE_SIGNING_KEY": "33" * 32}
        with unittest.mock.patch.dict(os.environ, env, clear=True), \
                unittest.mock.patch.object(boot, "bundle", return_value=b"tgz") as made, \
                unittest.mock.patch("sys.stdout", io.StringIO()):
            boot.main(["bundle", "--vendor", "v", "--out", str(out), "--enroll-update-key", "bro-host-1"])
            boot.main(["bundle", "--vendor", "v", "--out", str(out)])
        self.assertEqual(made.call_args_list, [
            unittest.mock.call("v", enroll_update_key=boot.update_key("33" * 32, "bro-host-1")),
            unittest.mock.call("v", enroll_update_key=None)])
        with unittest.mock.patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit):
            boot.main(["bundle", "--vendor", "v", "--out", str(out), "--enroll-update-key", "bro-host-1"])

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


FIRECRACKER_PINS = {
    "kernel": {"version": "6.1.0", "sha256": boot.sha256(b"guest kernel")},
    "firecracker": {"version": "v1.0.0", "sha256": boot.sha256(b"tgz"),
                    "firecrackerSha256": boot.sha256(b"fc binary"), "jailerSha256": boot.sha256(b"jailer binary")},
    "paths": {"firecracker": "release/firecracker", "jailer": "release/jailer"},
}


class FirecrackerBundleTest(unittest.TestCase):
    """The bundle of a firecracker host: the same, with vendor/firecracker/ checked against the pins."""

    vendor = BundleTest.vendor

    def with_firecracker(self):
        directory, pins = self.vendor()
        (directory / "firecracker").mkdir()
        (directory / "firecracker" / "firecracker").write_bytes(b"fc binary")
        (directory / "firecracker" / "jailer").write_bytes(b"jailer binary")
        (directory / "firecracker" / "vmlinux").write_bytes(b"guest kernel")
        return directory, {**pins, "firecracker_pins": FIRECRACKER_PINS}

    def test_carries_the_pinned_binaries_and_kernel_reproducibly(self):
        directory, pins = self.with_firecracker()
        first = boot.bundle(directory, **pins)
        self.assertEqual(first, boot.bundle(directory, **pins))
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(first))) as tar:
            members = {m.name: m.mode for m in tar.getmembers()}
            versions = json.loads(tar.extractfile("vendor/firecracker/versions.json").read())
        self.assertEqual({k: v for k, v in members.items() if k.startswith("vendor/firecracker")}, {
            "vendor/firecracker/firecracker": 0o755, "vendor/firecracker/jailer": 0o755,
            "vendor/firecracker/vmlinux": 0o644, "vendor/firecracker/versions.json": 0o644})
        self.assertEqual(versions, {"firecracker": "v1.0.0", "kernel": "6.1.0"})
        self.assertEqual((members["guest/bro-fc-init"], members["guest/bro-fc-clock"], members["update.sh"]),
                         (0o755, 0o755, 0o755))
        self.assertLessEqual({"firecracker.py", "selfupdate.py", "units.sh", "update.sh"}, set(members))

    def test_a_binary_or_kernel_that_is_not_the_pinned_one_never_goes_in(self):
        for name in ("firecracker", "jailer", "vmlinux"):
            with self.subTest(name):
                directory, pins = self.with_firecracker()
                (directory / "firecracker" / name).write_bytes(b"something else")
                with self.assertRaisesRegex(ValueError, name):
                    boot.bundle(directory, **pins)
        directory, pins = self.with_firecracker()
        (directory / "firecracker" / "extra").write_bytes(b"x")
        with self.assertRaisesRegex(ValueError, "extra"):
            boot.bundle(directory, **pins)

    def test_the_repository_pins_load(self):
        pins = boot.firecracker_pins()
        self.assertRegex(pins["kernel"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(set(pins["paths"]), {"firecracker", "jailer"})

    def test_vendor_checks_the_downloads_against_the_pins(self):
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory, True)
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w:gz") as tar:
            for name, data in (("release/firecracker", b"fc binary"), ("release/jailer", b"jailer binary")):
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        pins = json.loads(json.dumps(FIRECRACKER_PINS))
        pins["firecracker"]["sha256"] = boot.sha256(raw.getvalue())
        served = {"tgz": raw.getvalue(), "kernel": b"guest kernel"}
        original = boot.urllib.request.urlopen

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        boot.urllib.request.urlopen = lambda url, timeout=0: Response(served[url])
        self.addCleanup(setattr, boot.urllib.request, "urlopen", original)
        boot.vendor_firecracker(directory, "tgz", "kernel", pins)
        self.assertEqual((directory / "firecracker" / "jailer").read_bytes(), b"jailer binary")
        self.assertEqual((directory / "firecracker" / "firecracker").stat().st_mode & 0o777, 0o755)
        self.assertEqual((directory / "firecracker" / "vmlinux").read_bytes(), b"guest kernel")
        served["kernel"] = b"another kernel"
        with self.assertRaisesRegex(SystemExit, "guest kernel"):
            boot.vendor_firecracker(directory, "tgz", "kernel", pins)


class TokenTest(unittest.TestCase):
    def test_the_update_token_hostd_checks(self):
        sys.path.insert(0, str(Path(__file__).parent))
        import hostd

        key = boot.host_key("11" * 32, "host-1")
        identity = {"host": "host-1", "key": key, "updateKey": boot.update_key("33" * 32, "host-1")}
        value = boot.token("33" * 32, "host-1", "update")
        self.assertEqual(hostd.verify_token(value, identity, scope="update")["scope"], "update")
        with self.assertRaisesRegex(hostd.Unauthorized, "bad signature"):
            hostd.verify_token(value, identity)  # an update token opens nothing else
        with self.assertRaisesRegex(hostd.Unauthorized, "token scope"):
            hostd.verify_token(boot.token("33" * 32, "host-1", "other"), identity, scope="update")
        # Signed with the key Bro holds (the host's, from BROWSER_VM_SIGNING_KEY) it is no operator's token.
        signed = value.rsplit(".", 1)[0]
        forged = signed + "." + base64.urlsafe_b64encode(
            hmac.new(key, signed.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
        with self.assertRaisesRegex(hostd.Unauthorized, "bad signature"):
            hostd.verify_token(forged, identity, scope="update")

    def test_the_legacy_token_is_the_one_a_hostd_without_the_key_takes_and_one_with_it_refuses(self):
        sys.path.insert(0, str(Path(__file__).parent))
        import hostd

        # hostd 2026-10-09.1 checked a scope claim with the host's own key; the update that gives such a host
        # its updateKey is signed that way (BROWSER_VM_SIGNING_KEY), through the command line, once.
        host_key = boot.host_key("11" * 32, "host-1")
        with unittest.mock.patch.dict(os.environ, {"BROWSER_VM_SIGNING_KEY": "11" * 32}, clear=True), \
                unittest.mock.patch("sys.stdout", io.StringIO()) as out:
            boot.main(["token", "--host-id", "host-1", "--scope", "update", "--legacy-host-key"])
        legacy = out.getvalue().strip()
        old_identity = {"host": "host-1", "key": host_key, "updateKey": host_key}  # what the old check amounts to
        self.assertEqual(hostd.verify_token(legacy, old_identity, scope="update")["scope"], "update")
        new_identity = {"host": "host-1", "key": host_key, "updateKey": boot.update_key("33" * 32, "host-1")}
        with self.assertRaisesRegex(hostd.Unauthorized, "bad signature"):
            hostd.verify_token(legacy, new_identity, scope="update")
        with unittest.mock.patch.dict(os.environ, {"BRO_HOST_UPDATE_SIGNING_KEY": "33" * 32}, clear=True), \
                self.assertRaises(SystemExit):
            boot.main(["token", "--host-id", "host-1", "--legacy-host-key"])  # it needs Bro's signing key

    def test_only_the_update_scope_exists_on_the_command_line(self):
        with unittest.mock.patch.dict(os.environ, {"BRO_HOST_UPDATE_SIGNING_KEY": "33" * 32}, clear=True), \
                self.assertRaises(SystemExit):
            boot.main(["token", "--host-id", "h", "--scope", "other"])


class HostScriptsTest(unittest.TestCase):
    """update.sh and rollback.sh run for real, with every path they touch moved into a temp directory and
    systemctl, systemd-run, curl and sleep stubbed (each call lands in `calls`, in order). `host` is the
    bundle's tree as hostd swapped it in, `host.old` the previous one."""

    HERE = Path(__file__).parent
    PATHS = (("/opt/bro/host.failed", "host.failed"), ("/opt/bro/host.old", "host.old"), ("/opt/bro/host", "host"),
             ("/opt/bro/venv", "venv"), ("/opt/bro/firecracker", "fc"), ("/etc/bro/", "etc/"),
             ("/srv/bro/", "srv/"), ("/etc/systemd/system", "units"), ("/usr/bin/caddy", "caddy.bin"))
    SHA = "ab" * 32

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        for name in ("etc", "srv", "units", "bin", "venv/bin"):
            (self.tmp / name).mkdir(parents=True)
        # The venv's python: a wrapper, because a symlink to the test interpreter would lose its site-packages.
        (self.tmp / "venv/bin/python").write_text(f'#!/bin/bash\nexec {sys.executable} "$@"\n')
        (self.tmp / "venv/bin/pip").write_text(f'#!/bin/bash\necho "pip $*" >> {self.tmp}/calls\n')
        for name, body in {
            "systemctl": 'echo "systemctl $*" >> {calls}\n',
            "systemd-run": 'echo "systemd-run $*" >> {calls}\n',
            "sleep": "",
            "curl": 'echo curl >> {calls}\n[ -f {tmp}/health.json ] && cat {tmp}/health.json || exit 22\n',
        }.items():
            (self.tmp / "bin" / name).write_text("#!/bin/bash\n" + body.format(calls=self.tmp / "calls", tmp=self.tmp))
        for path in [*(self.tmp / "bin").iterdir(), *(self.tmp / "venv/bin").iterdir()]:
            path.chmod(0o755)
        (self.tmp / "etc/boot.json").write_text(json.dumps({"runtime": "runc"}))
        (self.tmp / "etc/hostd.json").write_text(json.dumps({"identity_file": str(self.tmp / "etc/host.json")}))
        (self.tmp / "etc/host.json").write_text(json.dumps({"host": "bro-host-1", "key": "aa" * 32}))
        (self.tmp / "etc/host.json").chmod(0o600)
        (self.tmp / "srv/update.json").write_text(json.dumps({"state": "applying", "sha256": self.SHA}))

    def moved(self, text):
        for path, local in self.PATHS:
            text = text.replace(path, f"{self.tmp}/{local}")
        self.assertNotRegex(text, r"(?<![\w.-])/(etc/bro|opt/bro|srv/bro|etc/systemd)")
        return text

    def tree(self, name, *, version="2099-01-01.1", changes=None):
        """The host code as a bundle ships it, in <tmp>/<name>, with the script paths moved; `changes` are
        {file: text | None (delete)} applied on top."""
        target = self.tmp / name
        for file in boot.FILES:
            (target / file).parent.mkdir(parents=True, exist_ok=True)
            data = (self.HERE / file).read_bytes()
            if file in ("update.sh", "rollback.sh", "units.sh"):  # the ones that run here
                data = self.moved(data.decode()).encode()
            (target / file).write_bytes(data)
            (target / file).chmod(0o755 if file.endswith(".sh") or file.startswith("guest") else 0o644)
        text = (target / "hostd.py").read_text()
        (target / "hostd.py").write_text(re.sub(r'(?m)^VERSION = ".*"$', f'VERSION = "{version}"', text))
        (self.tmp / "venv/.requirements.sha256").write_text(
            boot.sha256((target / "requirements.txt").read_bytes()) + "\n")  # the wheels are in place already
        for file, content in (changes or {}).items():
            if content is None:
                (target / file).unlink()
            else:
                (target / file).parent.mkdir(parents=True, exist_ok=True)
                (target / file).write_text(content)
        return target

    def run_script(self, script, *args):
        env = {**os.environ, "PATH": f"{self.tmp / 'bin'}:{os.environ['PATH']}"}
        return subprocess.run(["bash", str(self.tmp / "host" / script), *args], capture_output=True, text=True,
                              env=env, cwd=self.tmp)

    def calls(self):
        path = self.tmp / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def units(self):
        return sorted(path.name for path in (self.tmp / "units").iterdir())

    # update.sh --------------------------------------------------------------------------------------------

    def test_update_sh_takes_good_code_and_arms_the_rollback_guard_last(self):
        self.tree("host")
        result = self.run_script("update.sh")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("compiles, imports and takes this host's settings", result.stdout)
        run = [call for call in self.calls() if call.startswith("systemd-run")]
        self.assertEqual(run, [f"systemd-run --quiet --unit=bro-hostd-rollback-{self.SHA[:12]} --on-active=15s "
                               f"--description=Roll hostd back unless 2099-01-01.1 comes up "
                               f"bash {self.tmp}/host/rollback.sh 2099-01-01.1 {self.SHA}"])
        # Armed after the units were written and every file was installed: it is the last thing update.sh does,
        # and an earlier timer of the same bundle (a retry) is cleared first.
        self.assertEqual(self.calls()[-1], run[0])
        self.assertIn(f"systemctl stop bro-hostd-rollback-{self.SHA[:12]}.timer "
                      f"bro-hostd-rollback-{self.SHA[:12]}.service", self.calls())
        self.assertIn("bro-hostd.service", self.units())
        self.assertTrue(result.stdout.rstrip().endswith("update.sh: done"))

    def test_update_sh_refuses_code_that_does_not_compile_before_it_changes_anything(self):
        for name, changes in {
            "a syntax error in hostd": {"hostd.py": 'VERSION = "2099-01-01.1"\ndef broken(:\n'},
            "a syntax error in a module": {"network.py": "class Network(:\n"},
            "a syntax error in the guest clock": {"guest/bro-fc-clock": "def (:\n"},
        }.items():
            with self.subTest(name):
                shutil.rmtree(self.tmp / "host", ignore_errors=True)
                self.tree("host", changes=changes)
                result = self.run_script("update.sh")
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(self.units(), [])  # no unit rewritten
                self.assertFalse([c for c in self.calls() if c.startswith(("systemd-run", "systemctl"))])

    def test_update_sh_refuses_code_that_does_not_import(self):
        for name, changes in {
            "a missing dependency": {"hostd.py": 'import no_such_module_anywhere\nVERSION = "2099-01-01.1"\n'},
            "a module that fails when imported": {"sets.py": "raise RuntimeError('boom')\n"},
            "a module the bundle forgot": {"caddy.py": None},
        }.items():
            with self.subTest(name):
                shutil.rmtree(self.tmp / "host", ignore_errors=True)
                self.tree("host", changes=changes)
                result = self.run_script("update.sh")
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(self.units(), [])
                self.assertFalse([c for c in self.calls() if c.startswith("systemd-run")])

    def test_update_sh_refuses_code_that_cannot_take_this_hosts_settings(self):
        # A setting the new Config no longer knows would stop hostd at start (Config.load).
        (self.tmp / "etc/hostd.json").write_text(json.dumps({"retired_setting": 1}))
        self.tree("host")
        result = self.run_script("update.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown settings", result.stderr)
        self.assertEqual(self.units(), [])

    def test_update_sh_refuses_scripts_that_do_not_parse(self):
        for name, changes in {"a bundle script": {"provision.sh": "if then\n"},
                              "the guest init": {"guest/bro-fc-init": "#!/bin/sh\nif then\n"}}.items():
            with self.subTest(name):
                shutil.rmtree(self.tmp / "host", ignore_errors=True)
                self.tree("host", changes=changes)
                self.assertNotEqual(self.run_script("update.sh").returncode, 0)
                self.assertEqual(self.units(), [])

    def test_update_sh_installs_the_update_key_a_bundle_carries_and_only_that(self):
        key = boot.update_key("33" * 32, "bro-host-1").hex()
        self.tree("host", changes={"enroll/update-key": key + "\n"})
        result = self.run_script("update.sh")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("update key enrolled", result.stdout)
        identity = self.tmp / "etc/host.json"
        self.assertEqual(json.loads(identity.read_text()), {"host": "bro-host-1", "key": "aa" * 32, "updateKey": key})
        self.assertEqual(identity.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.tmp / "host/enroll").exists())  # the secret does not stay in the tree
        # A bundle without one leaves the key the host has.
        shutil.rmtree(self.tmp / "host")
        self.tree("host")
        self.assertEqual(self.run_script("update.sh").returncode, 0)
        self.assertEqual(json.loads(identity.read_text())["updateKey"], key)

    def test_update_sh_fails_on_an_update_key_that_is_not_one_and_keeps_the_hosts_identity(self):
        before = (self.tmp / "etc/host.json").read_text()
        self.tree("host", changes={"enroll/update-key": "not a key\n"})
        result = self.run_script("update.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not 64 lower-case hex", result.stderr)
        self.assertEqual((self.tmp / "etc/host.json").read_text(), before)
        self.assertFalse([c for c in self.calls() if c.startswith("systemd-run")])

    # rollback.sh -----------------------------------------------------------------------------------------

    def after_failed_update(self, health=None, old=True):
        """host = the new tree (2099-01-01.1), host.old = the previous one, a timer that fires now."""
        self.tree("host", version="2099-01-01.1", changes={"marker": "new"})
        if old:
            self.tree("host.old", version="old", changes={"marker": "old", "vendor/caddy": "old caddy"})
        (self.tmp / "caddy.bin").write_text("new caddy")
        (self.tmp / "srv/update.json").write_text(json.dumps({"state": "restarting", "sha256": self.SHA}))
        if health is not None:
            (self.tmp / "health.json").write_text(json.dumps(health))

    def test_rollback_sh_leaves_an_update_alone_when_the_new_hostd_reports_it(self):
        self.after_failed_update({"hostd": "2099-01-01.1", "update": {"state": "done", "version": "2099-01-01.1"}})
        (self.tmp / "srv/update.json").write_text(json.dumps({"state": "done", "sha256": self.SHA}))
        result = self.run_script("rollback.sh", "2099-01-01.1", self.SHA)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.tmp / "host/marker").read_text(), "new")
        self.assertEqual([c for c in self.calls() if c.startswith("systemctl")], [])
        self.assertFalse((self.tmp / "host.failed").exists())

    def test_rollback_sh_puts_the_previous_tree_back_when_hostd_never_answers(self):
        self.after_failed_update()  # curl fails: hostd does not come up
        result = self.run_script("rollback.sh", "2099-01-01.1", self.SHA)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.tmp / "host/marker").read_text(), "old")
        self.assertEqual((self.tmp / "host.failed/marker").read_text(), "new")  # kept for the operator
        self.assertFalse((self.tmp / "host.old").exists())
        systemctl = [c for c in self.calls() if c.startswith("systemctl")]
        self.assertEqual(systemctl, ["systemctl stop bro-hostd", "systemctl daemon-reload", "systemctl restart caddy",
                                     "systemctl reset-failed bro-hostd", "systemctl restart bro-hostd"])
        self.assertEqual((self.tmp / "caddy.bin").read_text(), "old caddy")  # and the old tree's Caddy
        self.assertIn("bro-hostd.service", self.units())  # the old tree's unit
        state = json.loads((self.tmp / "srv/update.json").read_text())
        self.assertEqual((state["state"], state["sha256"], state["version"]), ("rolled-back", self.SHA, "2099-01-01.1"))
        self.assertIn("did not report 2099-01-01.1", state["error"])
        self.assertEqual(self.calls().count("curl"), 38)  # ~90 s of asking, 2 s apart

    def test_rollback_sh_does_not_take_another_version_or_bundle_or_state_for_the_new_hostd(self):
        wrong = {
            "the old hostd still answers": ({"hostd": "old", "update": {"state": "restarting"}}, "restarting"),
            "the new hostd, no state yet": ({"hostd": "2099-01-01.1", "update": {"state": "restarting"}}, "restarting"),
            "done, but for another bundle": ({"hostd": "2099-01-01.1", "update": {"state": "done"}}, "done"),
        }
        for name, (health, state) in wrong.items():
            with self.subTest(name):
                shutil.rmtree(self.tmp / "host", ignore_errors=True)
                shutil.rmtree(self.tmp / "host.old", ignore_errors=True)
                shutil.rmtree(self.tmp / "host.failed", ignore_errors=True)
                self.after_failed_update(health)
                other = "cd" * 32 if name.startswith("done") else self.SHA
                (self.tmp / "srv/update.json").write_text(json.dumps({"state": state, "sha256": other}))
                self.assertEqual(self.run_script("rollback.sh", "2099-01-01.1", self.SHA).returncode, 0)
                self.assertEqual((self.tmp / "host/marker").read_text(), "old")

    def test_rollback_sh_without_a_previous_tree_says_so_and_changes_nothing(self):
        self.after_failed_update(old=False)
        result = self.run_script("rollback.sh", "2099-01-01.1", self.SHA)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.tmp / "host/marker").read_text(), "new")
        self.assertEqual([c for c in self.calls() if c.startswith("systemctl")], [])
        self.assertEqual(json.loads((self.tmp / "srv/update.json").read_text())["state"], "rollback-failed")

    def test_the_guard_is_in_the_bundle_and_parsed_whole_before_it_swaps_its_own_directory(self):
        script = (self.HERE / "rollback.sh").read_text()
        subprocess.run(["bash", "-n", str(self.HERE / "rollback.sh")], check=True)
        self.assertTrue(script.rstrip().endswith('main "$@"\nexit $?'))  # bash reads a script as it runs it
        self.assertIn("rollback.sh", boot.FILES)


class BootScriptTest(unittest.TestCase):
    """bro-host-boot with every path it touches moved into a temp directory (it deletes a host's apt lists),
    curl answering from a local file, dpkg and systemctl stubbed; every call lands in `calls`, in order. The
    temp directory holds what a run a hard reset cut short leaves behind: a venv, apt lists and debs."""

    PATHS = {"/etc/bro/boot.json": "etc/boot.json", "/var/log/bro-provision.log": "log", "/srv/bro/stage": "stage",
             "/root/": "", "/opt/bro/host": "host", "/opt/bro/venv": "venv", "/var/lib/apt/lists": "lists",
             "/var/cache/apt/archives": "archives"}
    LEFTOVERS = ("archives/lock", "archives/runc_1.1.12_amd64.deb", "lists/mirror_jammy_main_binary-amd64_Packages",
                 "lists/partial/x", "venv/bin/python")

    def run_boot(self, bundle, sha256, stage=None, dpkg_fails=False):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        served = tmp / "served.tgz"
        served.write_bytes(bundle)
        (tmp / "etc").mkdir()
        (tmp / "etc" / "boot.json").write_text(json.dumps({"bundle": {"url": "https://s3/x", "sha256": sha256}}))
        if stage is not None:
            (tmp / "stage").write_text(stage + "\n")
        for leftover in self.LEFTOVERS:
            (tmp / leftover).parent.mkdir(parents=True, exist_ok=True)
            (tmp / leftover).write_text("")
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        calls = tmp / "calls"
        stubs = {
            "curl": f'echo curl >> {calls}\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && cp {served} "$2"; shift; done\n',
            "dpkg": f'echo "dpkg $* $DEBIAN_FRONTEND" >> {calls}\n' + ("exit 1\n" if dpkg_fails else ""),
            "systemctl": f'echo "systemctl $*" >> {calls}\n',
            "sleep": "",  # the retries' pauses, at once
        }
        for name, body in stubs.items():
            (bin_dir / name).write_text("#!/bin/bash\n" + body)
            (bin_dir / name).chmod(0o755)
        user_data = boot.cloud_init(**ARGS)
        head = f"  - path: {boot.BOOT_SCRIPT_PATH}\n    permissions: \"0700\"\n    content: |\n"
        script = "\n".join(line[6:] for line in user_data.split(head, 1)[1].splitlines())
        for path, moved in self.PATHS.items():
            script = script.replace(path, f"{tmp}/{moved}")
        self.assertNotRegex(script, r"(?<![\w.-])/(etc|var|srv|opt|root)/")  # never the machine's own
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                                env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"})
        return result, tmp

    def left(self, tmp):
        return sorted(str(path.relative_to(tmp)) for name in ("venv", "lists", "archives")
                      for path in (tmp / name).rglob("*") if path.is_file())

    def bundle_with_probe(self):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w") as tar:
            data = b'echo provisioning\necho provision >> "$(dirname "$0")/../calls"\n'
            info = tarfile.TarInfo("provision.sh")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        return gzip.compress(raw.getvalue())

    def calls(self, tmp):
        path = tmp / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def test_runs_provision_from_a_bundle_that_matches(self):
        bundle = self.bundle_with_probe()
        result, tmp = self.run_boot(bundle, hashlib.sha256(bundle).hexdigest())
        self.assertEqual(result.returncode, 0, (tmp / "log").read_text())
        # A first boot: nothing to repair, nothing thrown away.
        self.assertEqual(self.calls(tmp), ["curl", "provision"])
        self.assertEqual(self.left(tmp), list(self.LEFTOVERS))
        # Everything, provision.sh's output too, goes to the log.
        self.assertEqual((result.stdout, result.stderr), ("", ""))
        log = (tmp / "log").read_text().splitlines()
        self.assertRegex(log[0], r"^bro-host-boot \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ stage none$")
        self.assertEqual(log[1:], ["provisioning"])

    def test_a_bundle_that_does_not_match_never_runs(self):
        result, tmp = self.run_boot(self.bundle_with_probe(), "00" * 32)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("provision", self.calls(tmp))

    def test_a_run_a_reboot_cut_short_is_cleaned_up_and_provisions_again(self):
        # Cloud.ru's reboot is a hard reset: on 02.10 every apt Packages list came back empty, and
        # apt-get update, which found the InRelease files whole, kept them. The venv may be torn too, and
        # hostd may run from it.
        bundle = self.bundle_with_probe()
        result, tmp = self.run_boot(bundle, hashlib.sha256(bundle).hexdigest(), stage="packages")
        self.assertEqual(result.returncode, 0, (tmp / "log").read_text())
        self.assertEqual(self.calls(tmp), ["curl", "systemctl stop bro-hostd", "dpkg --configure -a noninteractive",
                                           "provision"])
        self.assertEqual(self.left(tmp), ["archives/lock"])
        self.assertIn(" stage packages\n", (tmp / "log").read_text())

    def test_a_dpkg_that_stays_broken_stops_the_boot(self):
        # provision.sh's apt would only fail later, further from the cause.
        bundle = self.bundle_with_probe()
        result, tmp = self.run_boot(bundle, hashlib.sha256(bundle).hexdigest(), stage="packages", dpkg_fails=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(tmp), ["curl", "systemctl stop bro-hostd"]
                         + ["dpkg --configure -a noninteractive"] * 6)
        # Its hostd never starts, so the log is where a failed host says why.
        self.assertIn("bro-host-boot: dpkg --configure -a failed 6 times, no provisioning\n",
                      (tmp / "log").read_text())

    def test_a_ready_host_is_left_alone_after_a_reboot(self):
        # Its Caddy and hostd start on their own; provision.sh again would rewrite the Caddyfile hostd keeps.
        bundle = self.bundle_with_probe()
        result, tmp = self.run_boot(bundle, hashlib.sha256(bundle).hexdigest(), stage="ready")
        self.assertEqual(result.returncode, 0, (tmp / "log").read_text())
        self.assertEqual(self.calls(tmp), [])
        self.assertRegex((tmp / "log").read_text(), r"^bro-host-boot \S+ stage ready\n$")
        self.assertFalse((tmp / "host").exists())
        self.assertEqual(self.left(tmp), list(self.LEFTOVERS))


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
        self.assertIn("KillMode=process", UNITS)
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
                      "NoNewPrivileges=true\n", UNITS)
        self.assertNotRegex(PROVISION + UNITS, r"Capabilit\w*=.*CAP_NET_ADMIN")
        self.assertIn('dpkg --compare-versions "$(dpkg-query -W -f=\'${Version}\' runc)" ge 1.1.12', PROVISION)
        # The host's own public address is refused to sandboxes like every other blocked destination.
        self.assertIn('settings["egress_blocked"] = [sys.argv[3] + "/32"]', PROVISION)
        self.assertNotIn("set -x", PROVISION)  # the log must not echo presigned URLs
        # pipefail: `head` leaves early, and runc, writing the rest, died of SIGPIPE (a host, 02.10.2026).
        self.assertNotRegex(PROVISION, r"\| *head\b")
        self.assertIn("runc --version | sed -n 1p\n", PROVISION)
        self.assertIn("tar --numeric-owner -I zstd -xpf", PROVISION)  # the rootfs keeps its own ids

    def test_every_step_is_safe_to_repeat(self):
        # bro-host-boot runs this again after a reboot that cut it short, at any line, once it has thrown away
        # what such a run may leave torn and provision.sh would not make anew.
        self.assertIn("rm -rf /opt/bro/venv /var/lib/apt/lists/* /var/cache/apt/archives/*.deb", boot.BOOT_SCRIPT)
        self.assertIn("python3 -m venv /opt/bro/venv\n", PROVISION)
        self.assertIn("retry apt-get update -q\n", PROVISION)
        self.assertIn("getent group caddy >/dev/null || groupadd --system caddy", PROVISION)
        self.assertIn("id -u caddy >/dev/null 2>&1 || useradd", PROVISION)
        # Unguarded, these fail the second time.
        self.assertNotRegex(PROVISION, r"(?m)^\s*(useradd|groupadd|mkdir [^-])")
        # The rootfs: a partial download is fetched again and checked, a partial unpack thrown away, and the
        # root takes its name only once it is on disk.
        rootfs = PROVISION[PROVISION.index("stage rootfs"):PROVISION.index("stage ready")]
        self.assertIn('if [ ! -d "$ROOTFS" ]; then', rootfs)
        self.assertLess(rootfs.index('rm -rf "$PARTIAL"'), rootfs.index("tar --numeric-owner"))
        self.assertLess(rootfs.index("  sync\n"), rootfs.index('mv "$PARTIAL" "$ROOTFS"'))
        # And its name is on disk before `ready` is: a ready host is never set up again.
        self.assertIn('mv "$PARTIAL" "$ROOTFS"\n  sync\nfi\n', rootfs)

    def test_firecracker_host_setup(self):
        self.assertIn('"$RUNTIME" != firecracker', PROVISION)
        self.assertIn("firecracker) PACKAGES+=(e2fsprogs)", PROVISION)
        # No KVM, no host: said at the stage, with the kernel, not at the first sandbox.
        self.assertIn('[ ! -c /dev/kvm ]', PROVISION)
        self.assertIn('failed:/dev/kvm is missing (kernel $(uname -r))', PROVISION)
        self.assertIn('echo "kernel $(uname -r), runtime $RUNTIME"', PROVISION)
        self.assertLess(PROVISION.index("[ ! -c /dev/kvm ]"), PROVISION.index("stage venv"))
        # Binaries and kernel come from the bundle, to the paths hostd's Config names.
        self.assertIn('install -m 755 "$HOST/vendor/firecracker/firecracker" "$HOST/vendor/firecracker/jailer" '
                      '/opt/bro/firecracker/', PROVISION)
        self.assertIn('install -m 644 "$HOST/vendor/firecracker/vmlinux" /opt/bro/firecracker/vmlinux', PROVISION)
        config = hostd_config()
        self.assertEqual((config.firecracker, config.jailer, config.kernel),
                         ("/opt/bro/firecracker/firecracker", "/opt/bro/firecracker/jailer",
                          "/opt/bro/firecracker/vmlinux"))
        # The rootfs image is built before the host is ready.
        self.assertLess(PROVISION.index("firecracker.py\" build-image"), PROVISION.index("stage ready"))
        self.assertLess(PROVISION.index("stage rootfs"), PROVISION.index("firecracker.py\" build-image"))
        self.assertNotIn("github", PROVISION)

    def test_update_script_is_valid_and_repeats_only_what_a_code_update_needs(self):
        update = (Path(__file__).parent / "update.sh").read_text()
        subprocess.run(["bash", "-n", str(Path(__file__).parent / "update.sh")], check=True)
        subprocess.run(["bash", "-n", str(Path(__file__).parent / "units.sh")], check=True)
        self.assertIn('. "$HOST/units.sh"', update)
        self.assertIn('. "$HOST/units.sh"', PROVISION)
        # The venv only when requirements.txt changed (provision.sh stamps what it installed).
        self.assertIn('/opt/bro/venv/.requirements.sha256', PROVISION)
        self.assertIn('"$WANT" != "$(cat "$VENV/.requirements.sha256"', update)
        self.assertIn("--no-index --find-links", update)
        self.assertIn("--require-hashes", update)
        for forbidden in ("apt-get", "curl", "mkfs", "rm -rf"):
            self.assertNotIn(forbidden, update)

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
        sys.path.insert(0, str(Path(__file__).parent))
        import hostd

        for ip, blocked, limit, expected in (("203.0.113.7", ["203.0.113.7/32"], "", 0), ("", None, "0", 0),
                                             ("", None, "18432", 18432)):
            with self.subTest(ip=ip, limit=limit):
                target = tmp / "hostd.json"
                subprocess.run([sys.executable, "-c", code.replace("/etc/bro/hostd.json", str(target)),
                                "203-0-113-7.sslip.io", "runc", ip, limit], check=True)
                settings = json.loads(target.read_text())
                self.assertEqual(settings.get("egress_blocked"), blocked)
                self.assertEqual(settings["runtime"], "runc")
                self.assertEqual(hostd.Config.load(target).memory_limit_mb, expected)
        self.assertLess(PROVISION.index("systemctl enable --now bro-hostd"), PROVISION.index("stage rootfs"))


def hostd_config():
    sys.path.insert(0, str(Path(__file__).parent))
    import hostd

    return hostd.Config(runtime="firecracker")


if __name__ == "__main__":
    unittest.main()
