"""Host boot tests: cd browser-vm/host && python -m unittest (stdlib only).

The user data `boot.py` renders, the bundle it packs (with a fake vendor directory and pins made for it),
and its boot script run in a temp directory with fake curl, dpkg and systemctl; `provision.sh` is checked for
syntax and for what must never drift (runc by default and a pinned runsc, nothing fetched from GitHub or PyPI,
no flushed nftables, sandboxes that outlive hostd, every step safe to repeat).
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
