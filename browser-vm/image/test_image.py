"""Image build tests: python -m unittest browser-vm/image/test_image.py (stdlib only).

`build.py` runs against a fake Compute API on a fake clock; `provision.sh`'s boot script runs in a temp
directory with a fake curl.
"""

import base64
import contextlib
import gzip
import http.server
import io
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import build  # noqa: E402

PROVISION = (Path(__file__).parent / "provision.sh").read_text()
FIP = {"id": "fip-1", "ip_address": "203.0.113.7"}


class Clock:
    """Time that moves only when the script sleeps; a script that never gives up fails the test."""

    def __init__(self):
        self.start = self.now = 1_800_000_000.0

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        if self.now - self.start > 20000:
            raise RuntimeError("the script kept waiting")

    def at(self):
        return self.now - self.start


class Cloud:
    """The Compute API for one build. `stopped_at` is when the builder powers itself off; `page(t)` is
    what https://<ip>.sslip.io/stage answers t seconds in (a string, or None for no answer). `existing`
    is a {"name", "id"} already on the account under the exact name a `create()` call is about to use (a
    stale --keep-builder builder, an old image of the same --version), for the pre-create name check."""

    def __init__(self, clock, page, stopped_at=None, image_code=201, vm_state="running", address=True,
                 existing=None):
        self.clock, self.page, self.stopped_at = clock, page, stopped_at
        self.image_code, self.vm_state, self.address = image_code, vm_state, address
        self.existing = existing
        self.calls = []

    def api(self, method, url, body=None):
        path = url.removeprefix(build.COMPUTE)
        self.calls.append((method, path, body))
        if path.startswith("/v1/security-groups?"):
            return 200, {"items": [{"name": build.SECURITY_GROUP, "id": "sg"}]}
        if path == "/v1/security-groups/sg":
            return 200, {"state": "created"}
        if path == "/v1/security-groups/sg/rules":
            return 200, {"items": [{"direction": "ingress", "port_range": "80:80"},
                                   {"direction": "ingress", "port_range": "443:443"},
                                   {"direction": "egress", "port_range": "any"}]}
        if method == "GET" and (path.startswith("/v1/vms?") or path.startswith("/v1/images?")):
            # The name-existence check every create() does before its POST.
            hit = self.existing if self.existing and f"name={self.existing['name']}" in path else None
            return 200, {"items": [hit] if hit else []}
        if (method, path) == ("POST", "/v1.1/vms"):
            return 201, [{"id": "vm-1"}]
        if (method, path) == ("GET", "/v1/vms/vm-1"):
            stopped = self.stopped_at is not None and self.clock.at() >= self.stopped_at
            return 200, {"id": "vm-1", "state": "stopped" if stopped else self.vm_state,
                         "interfaces": [{"floating_ip": FIP}] if self.address else [{}],
                         "disks": [{"id": "disk-1", "primary": True}]}
        if (method, path) == ("GET", "/v1/disks/disk-1"):
            return 200, {"state": "available"}
        if (method, path) == ("POST", "/v1/images"):
            return (201, {"id": "img-1"}) if self.image_code < 300 else (self.image_code, {"error": "conflict"})
        if (method, path) == ("GET", "/v1/images/img-1"):
            return 200, {"availability_zones": [{"availability_zone_name": build.ZONE, "state": "created", "size": 5}]}
        if method == "DELETE":
            return 204, ""
        if method == "POST":  # detach, set-power
            return 200, {}
        raise AssertionError(f"unexpected call {method} {path}")

    def http(self, method, url, body=None, headers=None, timeout=60, resend=False):
        answer = self.page(self.clock.at()) if url.endswith("/stage") else "the provision log"
        if answer is None:
            raise urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
        return 200, answer

    def called(self, method, path):
        return [body for m, p, body in self.calls if (m, p) == (method, path)]


def run_build(cloud, clock, *args):
    """main() with its output kept; the SystemExit (if any) is returned."""
    argv = ["build.py", "--version", "t1", "--no-warm", *args]
    fake_time = types.SimpleNamespace(time=clock.time, sleep=clock.sleep, strftime=time.strftime)
    with mock.patch.object(sys, "argv", argv), mock.patch.dict(os.environ, {"CLOUDRU_PROJECT_ID": "p"}), \
            mock.patch.object(build, "api", cloud.api), mock.patch.object(build, "http", cloud.http), \
            mock.patch.object(build, "time", fake_time), contextlib.redirect_stdout(io.StringIO()):
        try:
            build.main()
        except SystemExit as error:
            return error
    return None


BUILDER_DELETED = {"delete_attachments": {"disk_ids": [], "external_ips": ["fip-1"]}}


class BuildTest(unittest.TestCase):
    def test_seal_after_the_stage_answered_is_not_rebooted(self):
        # The page answers from 60 s, goes away at 450 s with the seal; the VM shows `stopped` at 480 s.
        clock = Clock()
        cloud = Cloud(clock, lambda t: "python" if 60 <= t < 450 else None, stopped_at=480)
        self.assertIsNone(run_build(cloud, clock))
        self.assertEqual(cloud.called("POST", "/v1/vms/vm-1/set-power"), [])
        self.assertEqual(cloud.called("DELETE", "/v1/vms/vm-1"), [BUILDER_DELETED])
        self.assertEqual(cloud.called("DELETE", "/v1/disks/disk-1"), [None])

    def test_first_boot_that_never_answers_is_rebooted_once_then_deleted(self):
        clock = Clock()
        cloud = Cloud(clock, lambda t: None)
        self.assertIsNotNone(run_build(cloud, clock))
        self.assertEqual(cloud.called("POST", "/v1/vms/vm-1/set-power"), [{"state": "reboot"}])
        self.assertEqual(cloud.called("DELETE", "/v1/vms/vm-1"), [BUILDER_DELETED])
        # The boot disk is still attached, so the VM deletion takes it along.
        self.assertEqual(cloud.called("DELETE", "/v1/disks/disk-1"), [])

    def test_no_reboot_unless_the_vm_reads_running(self):
        clock = Clock()
        cloud = Cloud(clock, lambda t: None, vm_state="starting")
        run_build(cloud, clock)
        self.assertEqual(cloud.called("POST", "/v1/vms/vm-1/set-power"), [])

    def test_slow_but_healthy_first_boot_is_not_rebooted(self):
        # The page first answers at 800 s: past the old 7-minute watchdog, short of the new 15-minute one.
        # apt mirrors or DNS can genuinely take this long before the stage server is even up.
        clock = Clock()
        cloud = Cloud(clock, lambda t: "caddy" if 800 <= t < 1300 else None, stopped_at=1300)
        self.assertIsNone(run_build(cloud, clock))
        self.assertEqual(cloud.called("POST", "/v1/vms/vm-1/set-power"), [])
        self.assertEqual(cloud.called("DELETE", "/v1/vms/vm-1"), [BUILDER_DELETED])

    def test_stalled_after_reboot_still_fails_loudly_and_cleans_up(self):
        # Never answers before the reboot; afterwards it comes back stuck on a non-terminal value forever
        # (cloud-init does not run provision.sh again), instead of going silent again. The build must
        # still notice and end the build rather than wait it out as if this were normal progress.
        clock = Clock()
        cloud = Cloud(clock, lambda t: "caddy" if t > 950 else None)
        error = run_build(cloud, clock)
        self.assertIsNotNone(error)
        self.assertIn("timed out", str(error))
        self.assertEqual(cloud.called("POST", "/v1/vms/vm-1/set-power"), [{"state": "reboot"}])
        self.assertEqual(cloud.called("DELETE", "/v1/vms/vm-1"), [BUILDER_DELETED])

    def test_refused_image_deletes_the_builder_and_its_detached_disk(self):
        clock = Clock()
        cloud = Cloud(clock, lambda t: "python" if t < 300 else None, stopped_at=320, image_code=409)
        self.assertIsNotNone(run_build(cloud, clock))
        self.assertEqual(cloud.called("DELETE", "/v1/vms/vm-1"), [BUILDER_DELETED])
        self.assertEqual(cloud.called("DELETE", "/v1/disks/disk-1"), [None])

    def test_builder_without_an_address_is_deleted(self):
        clock = Clock()
        cloud = Cloud(clock, lambda t: None, address=False)
        self.assertIsNotNone(run_build(cloud, clock))
        self.assertEqual(cloud.called("DELETE", "/v1/vms/vm-1"),
                         [{"delete_attachments": {"disk_ids": [], "external_ips": []}}])

    def test_failed_provision_keeps_the_builder_for_its_log(self):
        clock = Clock()
        cloud = Cloud(clock, lambda t: "failed:python:line 160")
        self.assertIn("left running", str(run_build(cloud, clock)))
        self.assertEqual([c for c in cloud.calls if c[0] == "DELETE"], [])

    def test_keep_builder_keeps_it(self):
        clock = Clock()
        cloud = Cloud(clock, lambda t: None)
        run_build(cloud, clock, "--keep-builder")
        self.assertEqual([c for c in cloud.calls if c[0] == "DELETE"], [])

    def test_warm_up_vm_that_never_runs_is_deleted(self):
        clock = Clock()
        cloud = Cloud(clock, lambda t: None, vm_state="creating")
        with mock.patch.object(build, "api", cloud.api), \
                mock.patch.object(build, "time", types.SimpleNamespace(time=clock.time, sleep=clock.sleep)), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            build.warm_up("p", "bro-browser-t1", 10)
        self.assertEqual(cloud.called("DELETE", "/v1/vms/vm-1"),
                         [{"delete_attachments": {"disk_ids": ["disk-1"], "external_ips": []}}])

    def test_create_whose_answer_is_lost_adopts_the_vm_by_its_exact_name(self):
        calls, posted = [], False

        def api(method, url, body=None):
            nonlocal posted
            calls.append((method, url))
            if method == "POST":
                posted = True
                raise TimeoutError("timed out")
            if not posted:  # the pre-create name check: nothing by this name exists yet
                return 200, {"items": []}
            # The API's name filter matches a part of the name.
            return 200, {"items": [{"name": "bro-image-builder-t1-2", "id": "other"},
                                   {"name": "bro-image-builder-t1", "id": "vm-1"}]}

        with mock.patch.object(build, "api", api), contextlib.redirect_stdout(io.StringIO()):
            found = build.create(f"{build.COMPUTE}/v1.1/vms", [{}], "bro-image-builder-t1",
                                 f"{build.COMPUTE}/v1/vms?project_id=p")
        self.assertEqual(found, "vm-1")
        self.assertEqual([m for m, _ in calls].count("POST"), 1)
        self.assertEqual(calls[-1][1], f"{build.COMPUTE}/v1/vms?project_id=p&name=bro-image-builder-t1&limit=100")

    def test_create_aborts_when_a_resource_with_the_name_already_exists(self):
        # A --keep-builder builder or a timed-out image left over from an earlier run of the same
        # --version must not be silently adopted as this run's own.
        def api(method, url, body=None):
            if method == "GET":
                return 200, {"items": [{"name": "bro-image-builder-t1", "id": "stale-vm"}]}
            raise AssertionError(f"should not {method} once a name conflict is found")

        with mock.patch.object(build, "api", api), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                build.create(f"{build.COMPUTE}/v1.1/vms", [{}], "bro-image-builder-t1",
                             f"{build.COMPUTE}/v1/vms?project_id=p")
        self.assertIn("bro-image-builder-t1", str(raised.exception))
        self.assertIn("stale-vm", str(raised.exception))

    def test_build_aborts_before_creating_a_builder_with_an_already_taken_name(self):
        clock = Clock()
        cloud = Cloud(clock, lambda t: None, existing={"name": "bro-image-builder-t1", "id": "stale-vm"})
        error = run_build(cloud, clock)
        self.assertIsNotNone(error)
        self.assertIn("bro-image-builder-t1", str(error))
        self.assertEqual(cloud.called("POST", "/v1.1/vms"), [])


class ApiTransientErrorTest(unittest.TestCase):
    """A 5xx/429 from IAM must read as a transient error to read()/delete()/create(), the same as a
    Compute one, not raise the bare AssertionError that only crashed cleanup and leaked the builder."""

    def setUp(self):
        build._token.clear()
        self.addCleanup(build._token.clear)
        env = mock.patch.dict(os.environ, {"CLOUDRU_KEY_ID": "k", "CLOUDRU_KEY_SECRET": "s"})
        env.start()
        self.addCleanup(env.stop)

    def test_iam_5xx_raises_a_connection_error_not_an_assertion_error(self):
        with mock.patch.object(build, "http", lambda *a, **k: (503, {"error": "unavailable"})):
            with self.assertRaises(ConnectionError):
                build.api("GET", f"{build.COMPUTE}/v1/vms/vm-1")

    def test_read_shrugs_off_an_iam_outage_instead_of_crashing(self):
        with mock.patch.object(build, "http", lambda *a, **k: (429, {"error": "rate limited"})):
            self.assertIsNone(build.read(f"{build.COMPUTE}/v1/vms/vm-1"))

    def test_cleanup_logs_every_resource_it_could_not_delete_during_an_iam_outage(self):
        with mock.patch.object(build, "http", lambda *a, **k: (503, {"error": "unavailable"})), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            build.remove_builder("vm-1", "disk-1")  # must not raise: every resource stays visible in the log
        log = out.getvalue()
        self.assertIn("builder vm-1 could not be read", log)
        self.assertIn("builder VM vm-1", log)
        self.assertIn("builder disk disk-1", log)
        self.assertEqual(log.count("NOT deleted"), 2)


class SlowServer(http.server.BaseHTTPRequestHandler):
    """Takes the request, then answers after a second: past the client's timeout."""

    received = []

    def answer(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.received.append(self.command)
        threading.Event().wait(1)
        with contextlib.suppress(OSError):
            self.send_response(200)
            self.end_headers()

    do_GET = do_POST = answer

    def log_message(self, *args):
        pass


class HttpRetryTest(unittest.TestCase):
    def setUp(self):
        SlowServer.received = []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SlowServer)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/"
        # Straight to the local server, whatever proxy the environment names.
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
        self.sleeps = []
        patcher = mock.patch.object(build, "time", types.SimpleNamespace(time=time.time, sleep=self.sleeps.append))
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        urllib.request.install_opener(None)
        self.server.shutdown()
        self.server.server_close()

    def test_post_the_server_received_is_not_sent_again(self):
        with self.assertRaises(TimeoutError):
            build.http("POST", self.url, [{"name": "bro-image-builder-t1"}], timeout=0.3)
        self.assertEqual(SlowServer.received, ["POST"])

    def test_get_is_sent_again(self):
        with self.assertRaises(TimeoutError):
            build.http("GET", self.url, timeout=0.3)
        self.assertEqual(SlowServer.received, ["GET"] * 5)

    def test_post_that_never_went_out_is_sent_again(self):
        self.server.shutdown()
        self.server.server_close()
        with self.assertRaises(urllib.error.URLError):
            build.http("POST", self.url, [{}], timeout=0.3)
        self.assertEqual(len(self.sleeps), 4)


class BootScriptTest(unittest.TestCase):
    """bro-boot from provision.sh, with its two files in a temp directory and a fake curl and sleep."""

    def run_boot(self, ipify="", icanhazip="", caddyfile=None):
        script = re.search(r"cat > /usr/local/sbin/bro-boot <<'SCRIPT'\n(.*?)\nSCRIPT\n", PROVISION, re.S).group(1)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            script = script.replace("/var/lib/bro/public_ip", str(tmp / "public_ip"))
            script = script.replace("/etc/caddy/Caddyfile", str(tmp / "Caddyfile"))
            (tmp / "bro-boot").write_text(script)
            (tmp / "bin").mkdir()
            (tmp / "bin" / "curl").write_text(
                "#!/bin/bash\nfor last; do :; done\n"
                'case "$last" in\n  https://api.ipify.org) answer="$IPIFY" ;;\n'
                '  https://ipv4.icanhazip.com) answer="$ICANHAZIP" ;;\n  *) exit 2 ;;\nesac\n'
                '[ -n "$answer" ] || exit 22\nprintf \'%s\\n\' "$answer"\n')
            (tmp / "bin" / "sleep").write_text("#!/bin/sh\nexit 0\n")
            for tool in ("curl", "sleep"):
                (tmp / "bin" / tool).chmod(0o755)
            if caddyfile is not None:
                (tmp / "Caddyfile").write_text(caddyfile)
                (tmp / "public_ip").write_text("198.51.100.4\n")
            env = {**os.environ, "PATH": f"{tmp / 'bin'}:{os.environ['PATH']}", "IPIFY": ipify, "ICANHAZIP": icanhazip}
            done = subprocess.run(["bash", str(tmp / "bro-boot")], env=env, capture_output=True, text=True, timeout=30)
            files = {name: (tmp / name).read_text() if (tmp / name).exists() else None
                     for name in ("Caddyfile", "public_ip")}
        return done.returncode, files

    def test_caddyfile_has_no_admin_api(self):
        code, files = self.run_boot(ipify="203.0.113.7")
        self.assertEqual(code, 0)
        self.assertEqual(files["Caddyfile"],
                         "{\n\tadmin off\n}\n203-0-113-7.sslip.io {\n\treverse_proxy 127.0.0.1:8080\n}\n")
        self.assertEqual(files["public_ip"], "203.0.113.7\n")

    def test_second_echo_service_stands_in(self):
        _, files = self.run_boot(icanhazip="203.0.113.8")
        self.assertIn("203-0-113-8.sslip.io {", files["Caddyfile"])

    def test_no_address_keeps_the_last_caddyfile(self):
        last = "{\n\tadmin off\n}\n198-51-100-4.sslip.io {\n\treverse_proxy 127.0.0.1:8080\n}\n"
        code, files = self.run_boot(caddyfile=last)
        self.assertEqual(code, 0)
        self.assertEqual(files, {"Caddyfile": last, "public_ip": "198.51.100.4\n"})

    def test_an_answer_that_is_not_an_address_keeps_the_last_caddyfile(self):
        code, files = self.run_boot(ipify="<html>rate limited</html>", caddyfile="last")
        self.assertEqual(files["Caddyfile"], "last")


class WorkerRollbackTest(unittest.TestCase):
    """bro-worker-rollback from provision.sh, on a temp worker directory with a fake systemctl and sleep."""

    def run_rollback(self, previous):
        script = re.search(r"cat > /usr/local/sbin/bro-worker-rollback <<'SCRIPT'\n(.*?)\nSCRIPT\n", PROVISION,
                           re.S).group(1)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "bro-worker-rollback").write_text(script.replace("/opt/bro/worker", str(tmp)))
            (tmp / "bin").mkdir()
            for tool in ("systemctl", "sleep"):
                (tmp / "bin" / tool).write_text(f'#!/bin/sh\necho "{tool} $*" >> "{tmp}/calls"\n')
                (tmp / "bin" / tool).chmod(0o755)
            (tmp / "worker.py").write_text("new")
            if previous:
                (tmp / "worker.py.prev").write_text("old")
            env = {**os.environ, "PATH": f"{tmp / 'bin'}:{os.environ['PATH']}"}
            done = subprocess.run(["bash", str(tmp / "bro-worker-rollback")], env=env, capture_output=True, text=True,
                                  timeout=30)
            return (done.returncode, (tmp / "worker.py").read_text(), (tmp / "worker.py.prev").exists(),
                    (tmp / "calls").read_text().splitlines())

    def test_a_worker_update_that_does_not_start_is_rolled_back(self):
        self.assertEqual(self.run_rollback(previous=True), (0, "old", False, [
            "systemctl reset-failed bro-worker", "systemctl start --no-block bro-worker"]))

    def test_with_no_update_to_undo_the_worker_is_started_again_after_a_pause(self):
        self.assertEqual(self.run_rollback(previous=False), (0, "new", False, [
            "sleep 60", "systemctl reset-failed bro-worker", "systemctl start --no-block bro-worker"]))

    def test_failed_starts_of_the_worker_go_to_the_rollback(self):
        unit = re.search(r"cat > /etc/systemd/system/bro-worker.service <<'UNIT'\n(.*?)\nUNIT\n", PROVISION,
                         re.S).group(1)
        head = unit.split("[Service]")[0]  # start limits and OnFailure= belong to [Unit]
        self.assertIn("\nOnFailure=bro-worker-rollback.service\n", head)
        # Bounded: with Restart=always the unit reaches `failed`, and so the rollback, only at the limit.
        self.assertIn("\nStartLimitIntervalSec=300\nStartLimitBurst=5\n", head)
        self.assertIn("cat > /etc/systemd/system/bro-worker-rollback.service", PROVISION)


class SealTest(unittest.TestCase):
    def seal_block(self):
        return re.search(r'if \[ "\$\{BRO_IMAGE_SEAL:-1\}" = "1" \]; then\n(.*?)\nfi\n', PROVISION, re.S).group(1)

    def purged_paths(self):
        # The one `rm -rf`/`rm -f` of the sealing block, its arguments possibly spread over several
        # backslash-continued lines.
        block = self.seal_block()
        paths = []
        for match in re.finditer(r"rm -rf? ((?:.*\\\n)*.*)", block):
            paths.extend(match.group(1).replace("\\\n", " ").split())
        return paths

    def test_the_builder_timeline_does_not_survive_into_the_shipped_image(self):
        # `stage()` appends the builder VM's own boot/install timestamps to this file on every install
        # stage; the comment right above the sealing block says the image "must carry no profile,
        # certificate, key, log or machine identity of the builder VM" — this is exactly such a log, and
        # every other build log the block cleans up (`/var/log/bro-provision.log`, the status directory)
        # has its own entry in the same purge.
        self.assertIn("/var/lib/bro/timeline", self.purged_paths())

    def test_every_per_builder_path_stage_writes_to_is_purged(self):
        # `stage()` writes to /var/lib/bro/stage, /var/lib/bro/timeline and (a copy of both) under
        # /var/lib/bro/status/ — none of it belongs in an image every later VM boots from.
        purged = self.purged_paths()
        for path in ("/var/lib/bro/timeline", "/var/lib/bro/status"):
            self.assertIn(path, purged)


class ChromeUnitTest(unittest.TestCase):
    def test_loopback_goes_through_the_forwarder_too(self):
        # Chrome sends localhost past --proxy-server unless `<-loopback>` subtracts that implicit rule:
        # a page could then reach CDP, the worker and Caddy on the VM itself.
        start = next(line for line in PROVISION.splitlines() if line.startswith("ExecStart=/usr/bin/google-chrome"))
        self.assertIn(" --proxy-server=http://127.0.0.1:3128 ", start)
        self.assertIn(" --proxy-bypass-list=<-loopback> ", start)



class JevPatchTest(unittest.TestCase):
    PATCH = Path(__file__).parent / "jev-ultrafast.patch"

    def test_cloud_init_carries_the_patch_byte_for_byte(self):
        # provision.sh applies it from /opt/bro/image; without it in the user data `git apply` stops the build.
        block = build.cloud_init("test").split("path: /opt/bro/image/jev-ultrafast.patch", 1)[1].split("  - path:")[0]
        content = re.search(r"content: (\S+)", block).group(1)
        self.assertEqual(gzip.decompress(base64.b64decode(content)), self.PATCH.read_bytes())

    def test_the_patch_goes_on_the_pinned_commit_before_the_venv_is_built(self):
        lines = PROVISION.splitlines()
        checkout = lines.index("git -C /opt/bro/jev-ultrafast checkout -q 1231850")
        self.assertEqual(lines[checkout + 1], "git -C /opt/bro/jev-ultrafast apply /opt/bro/image/jev-ultrafast.patch")
        self.assertIn("uv sync", lines[checkout + 2])

    def test_the_patch_touches_only_the_package(self):
        # The VM imports jev_ultrafast; the fork's tests and docs live with scripts/jev-lab, not in the image.
        files = re.findall(r"^diff --git a/(\S+) b/", self.PATCH.read_text(), re.M)
        self.assertTrue(files)
        self.assertEqual([f for f in files if not f.startswith("jev_ultrafast/")], [])


if __name__ == "__main__":
    unittest.main()
