"""Firecracker module tests: cd browser-vm/host && python -m unittest (aiohttp is imported by the API client only).

The pure parts of firecracker.py (the kernel command line, the API requests, the jailer's argv, the snapshot
budget), the guest scripts (their order of steps, the clock helper's logic with a fake clock), and the rootfs
image: its staging directory and, where mkfs.ext4 and debugfs exist, a real image built from a small tree.
The VM's life under hostd is in test_hostd.py (FirecrackerTest).
"""

import importlib.machinery
import importlib.util
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import firecracker
import network

HERE = Path(__file__).parent


def load_script(name):
    """A guest script (no .py in its name) as a module."""
    loader = importlib.machinery.SourceFileLoader(name.replace("-", "_"), str(HERE / "guest" / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class RequestsTest(unittest.TestCase):
    def test_the_kernel_command_line_is_the_whole_one(self):
        line = firecracker.kernel_cmdline(overlay_mb=2048, worker_port=8080, now=1790000000.7)
        words = line.split()
        for word in ("console=ttyS0", "reboot=k", "panic=1", "pci=off", "nomodule", "root=/dev/vda", "ro",
                     "rootfstype=ext4", "init=/usr/local/sbin/bro-fc-init", "BRO_OVERLAY_MB=2048",
                     "BRO_WORKER_PORT=8080", "BRO_NOW=1790000000"):
            self.assertIn(word, words)
        # The guest's address is the one every sandbox has; the gateway is the router namespace's in0.
        self.assertIn(f"ip={network.INNER_SANDBOX}::{network.INNER_ROUTER}:255.255.255.252::eth0:off", words)
        self.assertLess(len(line), 2048)  # x86's limit

    def test_a_fresh_vm_is_configured_in_the_order_that_names_its_drives(self):
        requests = firecracker.boot_requests(cmdline="x", memory_mb=3072, vcpus=2)
        self.assertEqual([path for _method, path, _body in requests], [
            "/boot-source", "/drives/rootfs", "/drives/profile", "/drives/config", "/network-interfaces/eth0",
            "/machine-config", "/mmds/config", "/entropy", "/actions"])
        drives = [body for _m, path, body in requests if path.startswith("/drives/")]
        self.assertEqual([d["drive_id"] for d in drives], ["rootfs", "profile", "config"])  # vda, vdb, vdc
        self.assertEqual([d["is_read_only"] for d in drives], [True, False, True])
        self.assertEqual([d["path_on_host"] for d in drives], ["/rootfs.ext4", "/profile.img", "/config.img"])
        self.assertEqual(requests[-1], ("PUT", "/actions", {"action_type": "InstanceStart"}))

    def test_snapshot_requests_use_the_same_paths_in_the_jail(self):
        self.assertEqual(firecracker.SNAPSHOT_CREATE[2]["snapshot_path"], "/snap/vmstate")
        self.assertEqual(firecracker.SNAPSHOT_LOAD[2]["mem_backend"], {"backend_path": "/snap/mem", "backend_type": "File"})
        self.assertIs(firecracker.SNAPSHOT_LOAD[2]["resume_vm"], True)
        self.assertEqual(firecracker.SNAPSHOT_CREATE[2]["snapshot_type"], "Full")

    def test_the_jailer_execs_firecracker_in_place_in_the_sandboxs_namespace_and_cgroup(self):
        argv = firecracker.jailer_argv(jailer="/j", firecracker="/f", sandbox_id="ws-1", uid=40001, gid=40001,
                                       base=Path("/srv/bro/jailer"), netns="bro-s-ws-1", cgroup_parent="bro-sandboxes",
                                       memory_bytes=123)
        self.assertNotIn("--daemonize", argv)  # the pid hostd gets is the VM's, and its stdout is runtime.log
        self.assertEqual(argv[argv.index("--netns") + 1], "/var/run/netns/bro-s-ws-1")
        self.assertEqual(argv[argv.index("--cgroup") + 1], "memory.max=123")
        self.assertEqual(argv[argv.index("--") + 1:], ["--api-sock", "/firecracker.socket"])


class SnapshotsTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)

    def snapshot(self, sandbox_id, generation, size, age):
        directory = firecracker.snapshot_dir(self.root, sandbox_id, generation)
        directory.mkdir(parents=True)
        (directory / "mem").write_bytes(b"m" * size)
        meta = directory / "meta.json"
        meta.write_text("{}")
        os.utime(meta, (time.time() - age, time.time() - age))
        return directory

    def test_the_oldest_go_first_and_the_one_kept_never(self):
        a, b, c = (self.snapshot("a", 1, 8192, 300), self.snapshot("b", 1, 8192, 200), self.snapshot("c", 1, 8192, 100))
        self.assertEqual(firecracker.evict_snapshots(self.root, 3 * 8192 + 4096 * 3, keep=("a", 1)), [])
        self.assertEqual(firecracker.evict_snapshots(self.root, 2 * 8192 + 4096 * 3, keep=("a", 1)), ["b/1"])
        self.assertTrue(a.exists() and not b.exists() and c.exists())
        self.assertFalse(b.parent.exists())  # no empty directory of an evicted sandbox
        self.assertEqual(firecracker.evict_snapshots(self.root, 0, keep=("c", 1)), ["a/1"])
        self.assertTrue(c.exists())

    def test_snapshots_past_their_age_go_whatever_the_budget_and_the_kept_and_protected_stay(self):
        day = 86400
        old, older, young, kept, protected = (
            self.snapshot("old", 1, 4096, 8 * day), self.snapshot("older", 1, 4096, 9 * day),
            self.snapshot("young", 1, 4096, 2 * day), self.snapshot("kept", 1, 4096, 20 * day),
            self.snapshot("protected", 1, 4096, 20 * day))
        evicted = firecracker.evict_snapshots(self.root, 10**12, keep=("kept", None), max_age_s=7 * day,
                                              protect={"protected"})
        self.assertEqual(sorted(evicted), ["old/1", "older/1"])
        self.assertTrue(young.exists() and kept.exists() and protected.exists())
        self.assertFalse(old.parent.exists() or older.parent.exists())
        self.assertEqual(firecracker.evict_snapshots(self.root, 10**12, max_age_s=None), [])  # no limit

    def test_the_oldest_go_until_the_disk_has_the_room_that_was_asked_for(self):
        a, b, c = (self.snapshot("a", 1, 8192, 300), self.snapshot("b", 1, 8192, 200), self.snapshot("c", 1, 8192, 100))
        free = {"bytes": 1000}
        evicted = firecracker.evict_snapshots(
            self.root, 10**12, keep=("a", None), need_free_bytes=5000, free_bytes=lambda: free["bytes"] + 2000 * (
                3 - len(list(self.root.glob("snapshots/*/*")))))
        # Each snapshot gone frees 2000: b is not enough (3000), c makes it 5000; a is kept whatever happens.
        self.assertEqual(evicted, ["b/1", "c/1"])
        self.assertTrue(a.exists())
        # Room that cannot be made (everything left is kept): what can go goes, nothing else is touched.
        self.assertEqual(firecracker.evict_snapshots(self.root, 10**12, keep=("a", None), need_free_bytes=10**9,
                                                     free_bytes=lambda: 0), [])
        self.assertTrue(a.exists())
        # An unknown amount of free room (the disk cannot be read) evicts nothing for it.
        self.assertEqual(firecracker.evict_snapshots(self.root, 10**12, need_free_bytes=10**9,
                                                     free_bytes=lambda: None), [])

    def test_a_directory_without_meta_is_not_a_snapshot_and_counts_for_nothing(self):
        half = firecracker.snapshot_dir(self.root, "x", 1)
        half.mkdir(parents=True)
        (half / "mem").write_bytes(b"m" * 100)
        self.assertEqual(firecracker.snapshot_usage(self.root), (0, 0))
        self.snapshot("y", 2, 4096, 1)
        count, size = firecracker.snapshot_usage(self.root)
        self.assertEqual(count, 1)
        self.assertGreaterEqual(size, 4096)


class GuestScriptsTest(unittest.TestCase):
    def test_the_init_is_valid_sh_and_does_its_steps_in_order(self):
        path = HERE / "guest" / "bro-fc-init"
        subprocess.run(["sh", "-n", str(path)], check=True)
        text = path.read_text()
        self.assertTrue(text.startswith("#!/bin/sh\n"))
        steps = ["mount -n -t proc", "mount -n -t tmpfs -o \"size=${OVERLAY_MB}m", "mount -n -t overlay overlay",
                 "/dev/vdc /mnt/cfg", "cp -p /mnt/cfg/worker.json /mnt/merged/etc/bro/worker.json",
                 "/dev/vdb /mnt/merged/var/lib/bro/profile", "mount -n --move /dev /mnt/merged/dev",
                 "hostname bro-sandbox", "dirty_expire_centisecs", "bro-fc-clock --once", "pivot_root . mnt",
                 "bro-fc-init: nameservers", "\n) &\n", "bro-fc-clock </dev/null", "exec env -i"]
        code = text[text.index("export PATH"):]  # not the comment above it
        positions = [code.index(step) for step in steps]
        self.assertEqual(positions, sorted(positions), "the init's steps are out of order")
        # The network diagnostic is a background job with short timeouts: it must not hold the boot up (with
        # a resolver that does not answer it took 12 s), and it asks for a name every host resolves the same.
        diagnostic = code[code.index("\n(\n"):code.index("\n) &\n")]
        self.assertIn("bro-fc-init: nameservers", diagnostic)
        self.assertEqual(diagnostic.count("timeout=1"), 1)
        self.assertIn("settimeout(1)", diagnostic)
        self.assertNotIn("timeout=3", diagnostic)
        self.assertNotIn("settimeout(3)", diagnostic)
        self.assertIn('gethostbyname("ya.ru")', diagnostic)
        self.assertIn("\\x02ya\\x02ru", diagnostic)
        self.assertNotIn("geonode", text)
        self.assertRegex(diagnostic, r"(?m)^timeout \d+ /usr/bin/python3 - <<'PY' \|\| true$")  # and it ends by itself
        # PID 1 stays PID 1: the sandbox's init is exec'd, with the environment runc and runsc give it.
        self.assertIn("BRO_WORKER_BIND=0.0.0.0", text)
        self.assertIn("/usr/local/sbin/bro-sandbox-init", text.splitlines()[-1])
        self.assertIn("mount -n -t ext4 -o ro,nodev,nosuid,noexec /dev/vdc", text)  # the config drive is read-only
        # Ubuntu's resolv.conf is a link into /run, which a tmpfs hides: the init replaces the link with a file.
        self.assertLess(code.index("rm -f /mnt/merged/etc/resolv.conf"), code.index("> /mnt/merged/etc/resolv.conf"))
        # Bash's process substitution (google-chrome's wrapper) needs /dev/fd, which udev makes elsewhere.
        self.assertIn("ln -sfn /proc/self/fd /mnt/merged/dev/fd", code)
        # The root is read-only: a mount that tries to write /etc/mtab fails although it mounted.
        for line in code.splitlines():
            for word in ("mount ", "umount "):
                if line.lstrip().startswith(word) or f"|| {word}" in line:
                    self.assertIn(f"{word}-n", line)
        self.assertIn("nodev,nosuid,noatime /dev/vdb", text)
        self.assertNotIn("sysctl -", code)  # procps may not be in the root: /proc/sys is written directly

    def test_the_clock_id_is_the_kernels_for_a_file_descriptor(self):
        clock = load_script("bro-fc-clock")
        for descriptor in (3, 4, 10):
            self.assertEqual(clock.clock_id(descriptor), ((~descriptor) << 3) | 3)
        self.assertEqual(clock.clock_id(3), -29)  # FD_TO_CLOCKID(3)

    def test_the_clock_is_stepped_only_when_it_is_off_by_more_than_half_a_second(self):
        clock = load_script("bro-fc-clock")
        for host, realtime, stepped in ((1000.0, 1000.4, False), (1000.0, 1000.7, True), (1000.7, 1000.0, True)):
            with self.subTest(host=host, realtime=realtime):
                fake = mock.Mock(CLOCK_REALTIME=0)
                fake.clock_gettime.return_value = realtime
                with mock.patch.object(clock, "time", fake):
                    difference = clock.step_to(host)
                self.assertAlmostEqual(difference, host - realtime)
                self.assertEqual(fake.clock_settime.called, stepped)
                if stepped:
                    fake.clock_settime.assert_called_once_with(0, host)

    def test_without_ptp_the_host_time_comes_from_mmds_and_only_a_new_value_steps(self):
        clock = load_script("bro-fc-clock")
        sync = clock.Clock()
        values = iter([(5000.0, 10.0), (5000.0, 11.0), (9000.0, 12.0)])
        with mock.patch.object(clock.os, "open", side_effect=FileNotFoundError("no ptp0")), \
                mock.patch.object(clock, "mmds_now", side_effect=lambda: next(values)), \
                mock.patch.object(clock, "step_to", side_effect=lambda now: now) as step, \
                mock.patch.object(clock.time, "monotonic", return_value=10.5):
            self.assertAlmostEqual(sync.sync(), 5000.5)  # the host's time plus the half second since the read
            self.assertIsNone(sync.sync())  # the same value again: not the host's time any more
            self.assertAlmostEqual(sync.sync(), 8998.5)  # a restore wrote a new one
        self.assertEqual(step.call_count, 2)

    def test_without_any_host_clock_once_says_so_and_the_loop_keeps_trying(self):
        clock = load_script("bro-fc-clock")
        with mock.patch.object(clock.os, "open", side_effect=FileNotFoundError("no ptp0")), \
                mock.patch.object(clock, "mmds_now", side_effect=OSError("no mmds")):
            self.assertEqual(clock.main(["--once"]), 1)
            with mock.patch.object(clock.time, "sleep", side_effect=[None, KeyboardInterrupt]) as sleep:
                with self.assertRaises(KeyboardInterrupt):
                    clock.main([])
        # An error is a pause, not the end of the loop.
        self.assertEqual(sleep.call_args_list, [mock.call(clock.EVERY_S), mock.call(clock.EVERY_S)])

    def test_the_vm_gets_mmds_on_its_interface_before_it_starts(self):
        requests = firecracker.boot_requests(cmdline="x", memory_mb=2048, vcpus=2)
        paths = [path for _method, path, _body in requests]
        self.assertLess(paths.index("/mmds/config"), paths.index("/actions"))
        self.assertEqual(requests[paths.index("/mmds/config")][2]["network_interfaces"], ["eth0"])
        self.assertEqual(firecracker.clock_request(12.3456), ("PUT", "/mmds", {"bro": {"now": 12.346}}))


class RootfsImageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.rootfs = self.tmp / "v7"
        (self.rootfs / "usr" / "local" / "sbin").mkdir(parents=True)
        (self.rootfs / "usr" / "sbin").mkdir(parents=True)
        (self.rootfs / "sbin").symlink_to("usr/sbin")  # merged /usr: /sbin is a link, so the init is not there
        (self.rootfs / "etc").mkdir()
        (self.rootfs / "etc" / "passwd").write_text("root:x:0:0::/root:/bin/bash\n")
        (self.rootfs / "usr" / "local" / "sbin" / "bro-sandbox-init").write_text("#!/usr/bin/python3\n")

    def test_the_staging_directory_holds_the_scripts_and_the_debugfs_script_that_injects_them(self):
        script = firecracker.stage_image_inputs(self.tmp / "stage")
        stage = script.parent
        self.assertEqual(sorted(p.name for p in stage.iterdir()), ["bro-fc-clock", "bro-fc-init", "inject.debugfs"])
        for name in ("bro-fc-init", "bro-fc-clock"):
            self.assertEqual((stage / name).read_bytes(), (HERE / "guest" / name).read_bytes())
            self.assertEqual((stage / name).stat().st_mode & 0o777, 0o755)
        self.assertEqual(script.read_text().splitlines(), [
            f"write {stage / 'bro-fc-init'} /usr/local/sbin/bro-fc-init",
            f"write {stage / 'bro-fc-clock'} /usr/local/sbin/bro-fc-clock"])

    def test_the_image_commands_populate_from_the_rootfs_and_read_only(self):
        mkfs, debugfs = firecracker.image_commands(mkfs="mkfs.ext4", debugfs="debugfs", rootfs=self.rootfs,
                                                   image=self.tmp / "i", script=self.tmp / "s")
        self.assertEqual(mkfs[-3:], ["-d", str(self.rootfs), str(self.tmp / "i")])
        self.assertIn("^has_journal", mkfs)  # mounted read-only, so no journal
        self.assertEqual(debugfs, ["debugfs", "-w", "-f", str(self.tmp / "s"), str(self.tmp / "i")])

    def test_the_image_id_follows_the_scripts_and_the_version(self):
        self.assertEqual(firecracker.image_id("v7"), firecracker.image_id("v7"))
        self.assertNotEqual(firecracker.image_id("v7"), firecracker.image_id("v8"))
        with mock.patch.object(firecracker, "guest_scripts", return_value={"/x": b"changed"}):
            self.assertNotEqual(firecracker.image_id("v7"), "")
            changed = firecracker.image_id("v7")
        self.assertNotEqual(changed, firecracker.image_id("v7"))

    def test_the_footprint_counts_a_hard_linked_file_once(self):
        big = self.rootfs / "big"
        big.write_bytes(b"x" * 3 * 2**20)
        (self.rootfs / "again").hardlink_to(big)
        self.assertLess(firecracker.tree_footprint_mb(self.rootfs), 5)

    @unittest.skipUnless(shutil.which("mkfs.ext4") and shutil.which("debugfs"), "needs e2fsprogs")
    def test_a_real_image_has_the_rootfs_and_the_injected_scripts(self):
        image = self.tmp / "v7.ext4"
        self.assertTrue(firecracker.build_image_sync(self.rootfs, image))
        self.assertEqual(image.stat().st_mode & 0o777, 0o444)
        self.assertTrue(firecracker.image_is_current(image, "v7"))
        self.assertFalse(firecracker.build_image_sync(self.rootfs, image))  # current: nothing to do

        def debugfs(request):
            return subprocess.run(["debugfs", "-R", request, str(image)], capture_output=True, text=True).stdout

        self.assertIn("passwd", debugfs("ls /etc"))
        self.assertIn("bro-sandbox-init", debugfs("ls /usr/local/sbin"))
        for name in ("bro-fc-init", "bro-fc-clock"):
            listing = debugfs(f"stat /usr/local/sbin/{name}")
            self.assertIn("Mode:  0755", listing, listing)
            self.assertIn("Type: regular", listing)
        dump = self.tmp / "dumped"
        debugfs(f"dump /usr/local/sbin/bro-fc-init {dump}")
        self.assertEqual(dump.read_bytes(), (HERE / "guest" / "bro-fc-init").read_bytes())
        self.assertIn("usr/sbin", debugfs("stat /sbin"))  # the link is a link
        with mock.patch.object(firecracker, "IMAGE_FORMAT", firecracker.IMAGE_FORMAT + 1):
            self.assertFalse(firecracker.image_is_current(image, "v7"))  # changed scripts: built again
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir() if p.name.startswith(".")), [])


if __name__ == "__main__":
    unittest.main()
