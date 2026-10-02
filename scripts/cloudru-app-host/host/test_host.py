"""App VM tests: cd scripts/cloudru-app-host/host && python3 -m unittest (stdlib, and the zstd binary for the
release tests: they fail without it rather than skip; CI installs it).

deployd's tokens, env file, Caddyfile and jobs (a release that comes up, one that does not and goes back,
a failed migration, an env that breaks the app) against a temporary root with a fake runner, its HTTP
routes, the watchdog's alert rules, the user data boot.py renders, provision.sh's syntax and units, and
host.py's parser and env profiles.
"""

import base64
import hashlib
import http.server
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
# ops/store.py imports the stand's s3.py, which `host.py build` puts next to it in a release.
sys.path.insert(1, str(Path(__file__).resolve().parents[1] / "ops"))
sys.path.insert(2, str(Path(__file__).resolve().parents[3] / "scripts" / "cloudru-sandbox-probe"))
import boot  # noqa: E402
import deployd  # noqa: E402
import store  # noqa: E402
import watchdog  # noqa: E402

HERE = Path(__file__).parent
KEY = bytes(range(32))
IDENTITY = {"host": "bro-app-1", "key": KEY}


class FakeRunner(deployd.Runner):
    """systemctl, chown and node are recorded; tar runs for real; health is what the test says."""

    def __init__(self, archives):
        self.archives = archives
        self.calls = []
        self.health = {}
        self.migrate_exit = 0
        self.enabled = set()  # units `systemctl is-enabled` says yes to
        self.egress_exits = []  # exit codes of the next tg_egress.py --check calls, then 0

    def run(self, argv, *, env=None, cwd=None, user=None, timeout=600):
        self.calls.append({"argv": argv, "env": env, "cwd": cwd, "user": user})
        if argv[0] == "tar":
            result = subprocess.run(argv, capture_output=True, text=True)
            return result.returncode, result.stdout + result.stderr
        if argv[0] == deployd.NODE:
            return self.migrate_exit, "migrate app: done\nmigrate world: done\n"
        if argv[:2] == ["systemctl", "is-active"]:
            return 0, "active\n"
        if argv[:2] == ["systemctl", "is-enabled"]:
            return (0, "") if argv[-1] in self.enabled else (1, "")
        if argv[:1] == ["python3"] and argv[-1] == "--check":
            return (self.egress_exits.pop(0) if self.egress_exits else 0), "no answer: TimeoutError\n"
        return 0, ""

    def healthy(self, url, timeout=5):
        version = os.readlink(self.current).rsplit("/", 1)[-1] if os.path.islink(self.current) else None
        return self.health.get(version, True)

    def download(self, url, out, sha256, timeout=60):
        data = self.archives[url]
        if hashlib.sha256(data).hexdigest() != sha256:
            raise deployd.Refused("the release does not match its sha256")
        Path(out).write_bytes(data)


def wait_until(condition, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.02)
    return condition()


def release_archive(version, files=None):
    with tempfile.TemporaryDirectory() as tree:
        root = Path(tree)
        (root / "release.json").write_text(json.dumps({"version": version}))
        for name, text in (files or {"web/server.js": "", "eve/server/index.mjs": "",
                                     "ops/migrate.mjs": ""}).items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(text)
        out = root.parent / f"{version}-{os.getpid()}.tar.zst"
        subprocess.run(["tar", "-C", str(root), "-I", "zstd", "-cf", str(out), "."], check=True)
        data = out.read_bytes()
        out.unlink()
        return data


class ReleaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("zstd"):
            raise RuntimeError("the release tests need the zstd binary (apt install zstd)")

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.paths = deployd.Paths(self.root)
        self.paths.env.parent.mkdir(parents=True)
        self.paths.env.write_text(deployd.render_env({"DATABASE_URL": "postgres://a", "WORKFLOW_POSTGRES_URL":
                                                      "postgres://w"}))
        self.archives = {}
        self.runner = FakeRunner(self.archives)
        self.runner.current = self.paths.current
        self.deployd = deployd.Deployd(self.paths, self.runner, IDENTITY)
        self.log = []
        deployd.HEALTH_WAIT_S = 0
        deployd.BRIDGE_DRAIN_S = 0

    def body(self, version):
        data = release_archive(version)
        url = f"https://s3.cloud.ru/bucket/app/releases/{version}.tar.zst?X-Amz-Signature=x"
        self.archives[url] = data
        return {"version": version, "url": url, "sha256": hashlib.sha256(data).hexdigest()}

    def release(self, version):
        return self.deployd.do_release(self.body(version), self.log.append)

    def test_release_migrates_before_the_switch_and_goes_live(self):
        body = self.body("v1")
        result = self.deployd.do_release(body, self.log.append)
        self.assertEqual(result, {"version": "v1", "previous": None})
        self.assertEqual(os.readlink(self.paths.current), "releases/v1")
        migrate = next(c for c in self.runner.calls if c["argv"][0] == deployd.NODE)
        self.assertEqual(migrate["argv"][1:], ["ops/migrate.mjs", "app", "world"])
        self.assertEqual(migrate["user"], "bro")
        self.assertEqual(migrate["env"]["WORKFLOW_POSTGRES_URL"], "postgres://w")
        restarts = [c["argv"][2] for c in self.runner.calls if c["argv"][:2] == ["systemctl", "restart"]]
        self.assertEqual(restarts, ["bro-eve", "bro-web"])
        info = json.loads((self.paths.releases / "v1" / "release.json").read_text())
        self.assertEqual(info["sha256"], body["sha256"])
        self.assertEqual(self.deployd.history(), ["v1"])
        self.assertFalse(any("X-Amz" in line for line in self.log))

    def test_an_unhealthy_release_goes_back_to_the_previous(self):
        self.release("v1")
        self.runner.health["v2"] = False
        with self.assertRaisesRegex(deployd.Refused, "back on v1 \\(healthy\\)"):
            self.release("v2")
        self.assertEqual(os.readlink(self.paths.current), "releases/v1")
        self.assertEqual(self.deployd.history(), ["v1"])

    def test_an_unhealthy_first_release_leaves_nothing_current_and_nothing_running(self):
        self.runner.health["v1"] = False
        with self.assertRaisesRegex(deployd.Refused, "current is cleared"):
            self.release("v1")
        self.assertFalse(os.path.lexists(self.paths.current))
        stops = [c["argv"][2] for c in self.runner.calls if c["argv"][:2] == ["systemctl", "stop"]]
        self.assertEqual(stops, list(deployd.STOPPABLE))
        self.assertEqual(self.deployd.history(), [])
        self.runner.health["v2"] = True
        self.assertEqual(self.release("v2"), {"version": "v2", "previous": None})

    def test_a_first_release_whose_services_do_not_stop_says_so(self):
        run = self.runner.run

        def failing_stop(argv, **kwargs):
            if argv[:2] == ["systemctl", "stop"]:
                self.runner.calls.append({"argv": argv})
                return 1, "Job for bro-eve.service canceled."
            return run(argv, **kwargs)

        self.runner.run = failing_stop
        self.runner.health["v1"] = False
        with self.assertRaisesRegex(deployd.Refused, "did not stop") as refused:
            self.release("v1")
        self.assertNotIn("services are stopped", str(refused.exception))
        self.assertFalse(os.path.lexists(self.paths.current))

    def test_a_release_that_bro_cannot_own_is_not_unpacked(self):
        run = self.runner.run

        def failing_chown(argv, **kwargs):
            if argv[0] == "chown":
                self.runner.calls.append({"argv": argv})
                return 1, "chown: invalid user: 'bro:bro'"
            return run(argv, **kwargs)

        self.runner.run = failing_chown
        with self.assertRaisesRegex(deployd.Refused, "chown"):
            self.release("v1")
        self.assertEqual(self.deployd.releases(), [])
        self.assertEqual(list(self.paths.releases.iterdir()), [])
        self.assertFalse(self.paths.current.exists())

    def test_a_failed_migration_leaves_current_alone(self):
        self.release("v1")
        self.runner.migrate_exit = 1
        with self.assertRaisesRegex(deployd.Refused, "migrations failed"):
            self.release("v2")
        self.assertEqual(os.readlink(self.paths.current), "releases/v1")

    def test_the_archive_must_match_its_sha256_and_come_from_object_storage(self):
        body = self.body("v1")
        with self.assertRaisesRegex(deployd.Refused, "sha256"):
            self.deployd.do_release({**body, "sha256": "0" * 64}, self.log.append)
        with self.assertRaisesRegex(deployd.Refused, "s3.cloud.ru"):
            self.deployd.do_release({**body, "url": "https://example.com/v1.tar.zst"}, self.log.append)
        with self.assertRaisesRegex(deployd.Refused, "version"):
            self.deployd.do_release({**body, "version": "../x"}, self.log.append)
        self.assertFalse(self.paths.current.exists())

    def test_an_archive_of_another_version_is_refused(self):
        body = self.body("v1")
        self.archives[body["url"]] = release_archive("v9")
        body["sha256"] = hashlib.sha256(self.archives[body["url"]]).hexdigest()
        with self.assertRaisesRegex(deployd.Refused, "not 'v1'"):
            self.deployd.do_release(body, self.log.append)
        self.assertEqual(self.deployd.releases(), [])

    def test_rollback_goes_to_the_release_before(self):
        self.release("v1")
        self.release("v2")
        self.assertEqual(self.deployd.do_rollback({}, self.log.append)["version"], "v1")
        self.assertEqual(os.readlink(self.paths.current), "releases/v1")
        with self.assertRaisesRegex(deployd.Refused, "current already"):
            self.deployd.do_rollback({"version": "v1"}, self.log.append)

    def test_a_second_rollback_goes_further_back(self):
        for version in ("v1", "v2", "v3"):
            self.release(version)
        self.assertEqual(self.deployd.do_rollback({}, self.log.append)["version"], "v2")
        self.assertEqual(self.deployd.do_rollback({}, self.log.append)["version"], "v1")
        self.assertEqual(self.deployd.history(), ["v1"])
        with self.assertRaisesRegex(deployd.Refused, "no earlier release"):
            self.deployd.do_rollback({}, self.log.append)
        # A named release goes live like a release; the next rollback leaves it.
        self.assertEqual(self.deployd.do_rollback({"version": "v3"}, self.log.append)["version"], "v3")
        self.assertEqual(self.deployd.do_rollback({}, self.log.append)["version"], "v1")

    def test_old_releases_are_pruned(self):
        for n in range(1, 9):
            self.release(f"v{n}")
        self.assertEqual(len(self.deployd.releases()), deployd.KEEP_RELEASES)
        self.assertIn("v8", self.deployd.releases())

    def test_env_put_writes_the_file_and_restores_it_when_the_app_breaks(self):
        self.release("v1")
        before = self.paths.env.read_text()
        result = self.deployd.do_env({"env": {"A": "1", "B": 'quote " and $dollar'}}, self.log.append)
        self.assertEqual(result["names"], ["A", "B"])
        self.assertEqual(self.paths.env.stat().st_mode & 0o777, 0o600)
        self.assertEqual(deployd.read_env(self.paths), {"A": "1", "B": 'quote " and $dollar'})
        self.runner.health["v1"] = False
        with self.assertRaisesRegex(deployd.Refused, "previous one is back"):
            self.deployd.do_env({"env": {"A": "2"}}, self.log.append)
        self.assertEqual(deployd.read_env(self.paths)["A"], "1")
        self.assertNotEqual(self.paths.env.read_text(), before)

    def test_env_put_can_migrate_the_new_databases_first(self):
        self.release("v1")
        self.runner.calls.clear()
        self.deployd.do_env({"env": {"DATABASE_URL": "postgres://new", "WORKFLOW_POSTGRES_URL": "postgres://w2"},
                             "migrate": True}, self.log.append)
        migrate = next(c for c in self.runner.calls if c["argv"][0] == deployd.NODE)
        self.assertEqual(migrate["env"]["WORKFLOW_POSTGRES_URL"], "postgres://w2")
        first_restart = next(i for i, c in enumerate(self.runner.calls) if c["argv"][:2] == ["systemctl", "restart"])
        self.assertLess(self.runner.calls.index(migrate), first_restart)
        self.runner.migrate_exit = 1
        self.runner.calls.clear()
        with self.assertRaisesRegex(deployd.Refused, "migrations failed"):
            self.deployd.do_env({"env": {"DATABASE_URL": "postgres://other", "WORKFLOW_POSTGRES_URL": "postgres://w3"},
                                 "opsEnv": {"NEON_DATABASE_URL": "postgres://n"}, "migrate": True}, self.log.append)
        self.assertEqual(deployd.read_env(self.paths)["WORKFLOW_POSTGRES_URL"], "postgres://w2")
        self.assertFalse(self.paths.ops_env.exists())  # the ops scripts' names go back with it (none before)
        self.assertFalse(any(c["argv"][:2] == ["systemctl", "restart"] for c in self.runner.calls))

    def test_ops_runs_only_scripts_of_the_current_release(self):
        self.release("v1")
        with self.assertRaisesRegex(deployd.Refused, "no ops/db-backup.sh"):
            self.deployd.do_ops({"script": "db-backup.sh"}, self.log.append)
        with self.assertRaisesRegex(deployd.Refused, "script"):
            self.deployd.do_ops({"script": "../web/server.js"}, self.log.append)
        (self.paths.releases / "v1" / "ops" / "db-backup.sh").write_text("")
        with self.assertRaisesRegex(deployd.Refused, "args"):
            self.deployd.do_ops({"script": "db-backup.sh", "args": ["a b"]}, self.log.append)
        self.deployd.do_ops({"script": "db-backup.sh", "args": ["app"]}, self.log.append)
        call = self.runner.calls[-1]
        self.assertEqual(call["argv"][0], "/bin/bash")
        self.assertEqual(call["user"], "bro")

    def systemctl(self):
        return [" ".join(c["argv"][1:3]) for c in self.runner.calls
                if c["argv"][0] == "systemctl" and c["argv"][1] in ("restart", "stop", "start")]

    def test_an_enabled_bridge_is_stopped_around_every_restart_of_eve(self):
        self.release("v1")
        self.assertNotIn("stop bro-tg-bridge", self.systemctl())  # not enabled: left alone
        self.runner.enabled.add("bro-tg-bridge")
        both = ["stop bro-tg-bridge", "restart bro-eve", "restart bro-web", "start bro-tg-bridge"]
        for work, expected in (
                (lambda: self.release("v2"), both),
                (lambda: self.deployd.do_rollback({}, self.log.append), both),
                (lambda: self.deployd.do_env({"env": {"A": "1"}}, self.log.append), both),
                (lambda: self.deployd.do_restart({"units": ["bro-eve", "bro-tg-bridge"]}, self.log.append),
                 ["stop bro-tg-bridge", "restart bro-eve", "start bro-tg-bridge"])):
            self.runner.calls.clear()
            work()
            self.assertEqual(self.systemctl(), expected)
        # Web alone does not touch the bridge.
        self.runner.calls.clear()
        self.deployd.do_restart({"units": ["bro-web"]}, self.log.append)
        self.assertEqual(self.systemctl(), ["restart bro-web"])

    def test_the_bridge_comes_back_even_when_the_release_does_not(self):
        self.release("v1")
        self.runner.enabled.add("bro-tg-bridge")
        self.runner.health["v2"] = False
        self.runner.calls.clear()
        with self.assertRaisesRegex(deployd.Refused, "back on v1"):
            self.release("v2")
        calls = self.systemctl()
        self.assertEqual((calls[0], calls[-1]), ("stop bro-tg-bridge", "start bro-tg-bridge"))
        self.runner.calls.clear()
        self.runner.health["v1"] = False
        with self.assertRaisesRegex(deployd.Refused, "previous one is back"):
            self.deployd.do_env({"env": {"A": "2"}}, self.log.append)
        self.assertEqual(self.systemctl()[-1], "start bro-tg-bridge")

    def fail_stopping(self, unit):
        run = self.runner.run

        def failing_stop(argv, **kwargs):
            if argv == ["systemctl", "stop", unit]:
                self.runner.calls.append({"argv": argv})
                return 1, f"Job for {unit}.service canceled."
            return run(argv, **kwargs)

        self.runner.run = failing_stop

    def test_a_bridge_that_does_not_stop_keeps_eve_as_it_runs(self):
        self.release("v1")
        env = {"A": "1", "WORKFLOW_POSTGRES_URL": "postgres://w"}
        self.deployd.do_env({"env": env, "opsEnv": {"NEON_DATABASE_URL": "postgres://n"}}, self.log.append)
        self.runner.enabled.add("bro-tg-bridge")
        self.fail_stopping("bro-tg-bridge")
        self.runner.calls.clear()
        with self.assertRaisesRegex(deployd.Refused, "did not stop"):
            self.release("v2")
        self.assertEqual(os.readlink(self.paths.current), "releases/v1")
        self.assertEqual(self.systemctl(), ["stop bro-tg-bridge", "start bro-tg-bridge"])
        for work in (lambda: self.deployd.do_rollback({"version": "v2"}, self.log.append),
                     lambda: self.deployd.do_restart({"units": ["bro-eve"]}, self.log.append),
                     lambda: self.deployd.do_env({"env": {**env, "A": "2"}, "migrate": True}, self.log.append)):
            self.runner.calls.clear()
            with self.assertRaisesRegex(deployd.Refused, "did not stop"):
                work()
            self.assertEqual(self.systemctl(), ["stop bro-tg-bridge", "start bro-tg-bridge"])
        # The env the services run on is the one on disk, and the ops scripts keep their names.
        self.assertEqual(deployd.read_env(self.paths), env)
        self.assertEqual(deployd.read_ops_env(self.paths), {"NEON_DATABASE_URL": "postgres://n"})

    def test_env_put_takes_the_env_back_on_any_failure_of_the_migrations(self):
        self.release("v1")
        before = self.paths.env.read_text()
        run = self.runner.run

        def timing_out(argv, **kwargs):
            if argv[0] == deployd.NODE:
                raise subprocess.TimeoutExpired(argv, 900)
            return run(argv, **kwargs)

        self.runner.run = timing_out
        with self.assertRaises(subprocess.TimeoutExpired):
            self.deployd.do_env({"env": {"WORKFLOW_POSTGRES_URL": "postgres://w2"},
                                 "opsEnv": {"NEON_DATABASE_URL": "postgres://n"}, "migrate": True}, self.log.append)
        self.assertEqual(self.paths.env.read_text(), before)
        self.assertFalse(self.paths.ops_env.exists())

    def test_a_stop_that_fails_leaves_the_watchdog_watching(self):
        self.fail_stopping("bro-eve")
        with self.assertRaisesRegex(deployd.Refused, "did not stop"):
            self.deployd.do_stop({"units": ["bro-eve", "bro-web"]}, self.log.append)
        self.assertFalse(self.paths.maintenance.exists())
        self.paths.maintenance.parent.mkdir(parents=True, exist_ok=True)
        planned = {"since": 1000, "units": ["bro-web"]}
        self.paths.maintenance.write_text(json.dumps(planned))
        with self.assertRaisesRegex(deployd.Refused, "did not stop"):
            self.deployd.do_stop({"units": ["bro-eve"]}, self.log.append)
        self.assertEqual(json.loads(self.paths.maintenance.read_text()), planned)

    def test_a_host_update_holds_the_job_slot_until_it_gives_it_back(self):
        quiet = mock.patch("builtins.print")  # the jobs' log lines
        quiet.start()
        self.addCleanup(quiet.stop)
        self.assertEqual(self.deployd.end_host_update(), {"ended": None})  # none held: nothing to end
        held = self.deployd.start_job("host-update", self.deployd.do_host_update, {})
        with self.assertRaisesRegex(deployd.Refused, f"busy with job {held['id']} \\(host-update\\)"):
            self.deployd.start_job("release", self.deployd.do_release, {})
        self.assertEqual(self.deployd.status()["job"], held["id"])
        self.assertEqual(self.deployd.end_host_update(), {"ended": held["id"]})
        self.assertTrue(wait_until(lambda: held["state"] == "done"))
        self.assertEqual(held["result"], {"ended": "host.py"})
        other = self.deployd.start_job("restart", lambda body, log: None, {})
        self.assertTrue(wait_until(lambda: other["state"] == "done"))
        self.assertEqual(self.deployd.end_host_update(), {"ended": None})  # another kind of job is not ended
        with mock.patch.object(deployd, "HOST_UPDATE_S", 0.05):
            lapsing = self.deployd.start_job("host-update", self.deployd.do_host_update, {})
            self.assertTrue(wait_until(lambda: lapsing["state"] == "done"))
        self.assertEqual(lapsing["result"], {"ended": "timeout"})
        self.assertIsNone(self.deployd.running_job())

    def test_the_path_to_telegram_is_checked_after_a_release_when_tg_egress_is_installed(self):
        self.assertNotIn("telegram", self.release("v1"))
        self.paths.tg_egress.parent.mkdir(parents=True)
        self.paths.tg_egress.write_text("")
        self.assertEqual(self.release("v2")["telegram"], "ok")
        self.runner.egress_exits = [1]  # a restart of tg-egress brings it back
        self.runner.calls.clear()
        self.assertEqual(self.release("v3")["telegram"], "ok")
        self.assertIn("restart bro-tg-egress", self.systemctl())
        self.runner.egress_exits = [1, 1]  # still down: said, and the release stays
        result = self.release("v4")
        self.assertEqual((result["telegram"], os.readlink(self.paths.current)), ("down", "releases/v4"))
        self.assertTrue(any("WARNING" in line for line in self.log))

    def test_tg_bridge_sh_runs_as_root_from_the_host_bundle(self):
        (self.paths.host_ops).mkdir(parents=True)
        (self.paths.host_ops / "tg-bridge.sh").write_text("")
        for args in (["switch-to-bridge"], ["switch-to-webhook", "https://bro-next.vercel.app/eve/v1/telegram"],
                     ["status"], ["hold"]):
            self.deployd.do_ops({"script": "tg-bridge.sh", "args": args}, self.log.append)  # no release needed
            call = self.runner.calls[-1]
            self.assertEqual(call["argv"], ["/bin/bash", str(self.paths.host_ops / "tg-bridge.sh"), *args])
            self.assertIsNone(call["user"])
            self.assertNotIn("DATABASE_URL", call["env"])
        for args in (["switch-to-webhook", "http://x.example/eve/v1/telegram"], ["switch-to-webhook"],
                     ["status", "--now"], ["rm"]):
            with self.assertRaisesRegex(deployd.Refused, "tg-bridge.sh"):
                self.deployd.do_ops({"script": "tg-bridge.sh", "args": args}, self.log.append)

    def test_a_stop_is_planned_until_the_units_restart(self):
        self.deployd.do_stop({"units": ["bro-eve", "bro-web"]}, self.log.append)
        planned = json.loads(self.paths.maintenance.read_text())
        self.assertEqual(planned["units"], ["bro-eve", "bro-web"])
        self.assertEqual(self.deployd.status()["plannedStop"], planned)
        self.deployd.do_stop({"units": ["bro-eve"]}, self.log.append)  # a second stop keeps the first time
        self.assertEqual(json.loads(self.paths.maintenance.read_text())["since"], planned["since"])
        self.deployd.do_restart({"units": ["bro-web"]}, self.log.append)
        self.assertEqual(json.loads(self.paths.maintenance.read_text())["units"], ["bro-eve"])
        self.deployd.do_restart({"units": ["bro-eve"]}, self.log.append)
        self.assertFalse(self.paths.maintenance.exists())
        self.assertIsNone(self.deployd.status()["plannedStop"])

    def test_status_names_what_the_env_switches_off(self):
        self.assertEqual(self.deployd.status()["off"], [])
        self.paths.env.write_text(deployd.render_env({"EVE_SCHEDULES": "off", "BACKUPS": "off", "X": "off"}))
        self.assertEqual(self.deployd.status()["off"], ["EVE_SCHEDULES", "BACKUPS"])

    def test_status_shows_what_the_watchdog_could_not_tell(self):
        self.paths.watchdog_state.parent.mkdir(parents=True, exist_ok=True)
        self.paths.watchdog_state.write_text(json.dumps({"tg-egress": {"downSince": 100, "pendingAlert": 1},
                                                         "web": {}, "undelivered": {"tg-egress": 400}}))
        status = self.deployd.status()
        self.assertEqual(status["watchdog"], {"down": {"tg-egress": 100}, "undelivered": {"tg-egress": 400}})
        self.assertIn("bro-tg-bridge", status["units"])
        self.assertEqual(status["telegram"], {"egressInstalled": False, "bridgeEnabled": False})

    def test_neon_goes_to_the_ops_scripts_only(self):
        self.release("v1")
        with self.assertRaisesRegex(deployd.Refused, "only in opsEnv"):
            self.deployd.do_env({"env": {"A": "1", "NEON_DATABASE_URL": "postgres://n"}}, self.log.append)
        with self.assertRaisesRegex(deployd.Refused, "opsEnv"):
            self.deployd.do_env({"env": {"A": "1"}, "opsEnv": {"DATABASE_URL": "x"}}, self.log.append)
        self.deployd.do_env({"env": {"A": "1"}, "opsEnv": {"NEON_DATABASE_URL": "postgres://n"}}, self.log.append)
        self.assertNotIn("NEON_DATABASE_URL", deployd.read_env(self.paths))
        self.assertEqual(self.paths.ops_env.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.deployd.env_names()["opsOnly"], ["NEON_DATABASE_URL"])
        (self.paths.releases / "v1" / "ops" / "db-copy.sh").write_text("")
        self.deployd.do_ops({"script": "db-copy.sh", "args": ["neon", "app"]}, self.log.append)
        self.assertEqual(self.runner.calls[-1]["env"]["NEON_DATABASE_URL"], "postgres://n")
        for broken in (None, [], "", 0):  # not an object: refused, and the ops scripts keep what they had
            with self.assertRaisesRegex(deployd.Refused, "opsEnv"):
                self.deployd.do_env({"env": {"A": "1"}, "opsEnv": broken}, self.log.append)
            self.assertEqual(deployd.read_ops_env(self.paths), {"NEON_DATABASE_URL": "postgres://n"})
        self.deployd.do_env({"env": {"A": "1"}}, self.log.append)  # without it: gone
        self.assertFalse(self.paths.ops_env.exists())

    def test_a_failed_env_takes_the_ops_scripts_names_back_too(self):
        self.release("v1")
        self.deployd.do_env({"env": {"A": "1"}, "opsEnv": {"NEON_DATABASE_URL": "postgres://old"}}, self.log.append)
        self.runner.health["v1"] = False
        with self.assertRaisesRegex(deployd.Refused, "previous one is back"):
            self.deployd.do_env({"env": {"A": "2"}, "opsEnv": {"NEON_DATABASE_URL": "postgres://new"}},
                                self.log.append)
        self.assertEqual(deployd.read_ops_env(self.paths), {"NEON_DATABASE_URL": "postgres://old"})
        self.assertEqual(self.paths.ops_env.stat().st_mode & 0o777, 0o600)
        self.runner.health["v1"] = True
        self.deployd.do_env({"env": {"A": "1"}}, self.log.append)
        self.runner.health["v1"] = False
        with self.assertRaisesRegex(deployd.Refused, "previous one is back"):  # none before: none after
            self.deployd.do_env({"env": {"A": "2"}, "opsEnv": {"NEON_DATABASE_URL": "postgres://new"}},
                                self.log.append)
        self.assertFalse(self.paths.ops_env.exists())


class DownloadTest(unittest.TestCase):
    """The real Runner.download against a local server: a release past the limit never fills the disk."""

    def serve(self, data, length=True):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                if length:
                    self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/r.tar.zst"

    def setUp(self):
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory)
        self.out = directory / "r.tar.zst"

    def test_a_release_within_the_limit_downloads(self):
        data = b"x" * 100
        deployd.Runner().download(self.serve(data), self.out, hashlib.sha256(data).hexdigest(), limit=100)
        self.assertEqual(self.out.read_bytes(), data)

    def test_a_release_past_the_limit_is_cut_off_and_removed(self):
        data = b"x" * 100
        for length in (True, False):  # declared, and only counted
            with self.assertRaisesRegex(deployd.Refused, "more than 99"):
                deployd.Runner().download(self.serve(data, length), self.out, hashlib.sha256(data).hexdigest(),
                                          limit=99)
            self.assertFalse(self.out.exists())

    def test_a_wrong_sha256_leaves_no_file(self):
        with self.assertRaisesRegex(deployd.Refused, "sha256"):
            deployd.Runner().download(self.serve(b"x"), self.out, "0" * 64)
        self.assertFalse(self.out.exists())


class EnvFileTest(unittest.TestCase):
    def test_round_trip(self):
        values = {"A": "plain", "B": 'a "quoted" \\ back $X `cmd`', "C": "with spaces  ", "D": "'single'"}
        self.assertEqual(deployd.parse_env(deployd.render_env(values)), values)

    def test_a_line_break_or_a_bad_name_is_refused(self):
        with self.assertRaises(deployd.Refused):
            deployd.render_env({"A": "one\ntwo"})
        with self.assertRaises(deployd.Refused):
            deployd.render_env({"lower": "x"})


class CaddyTest(unittest.TestCase):
    def test_ops_routes_only_on_the_ops_host(self):
        text = deployd.render_caddyfile("1-2-3-4.sslip.io", ["cloud.brobro.tech"])
        ops, site = text.split("1-2-3-4.sslip.io {", 1)[1], text.split("cloud.brobro.tech {", 1)[1]
        self.assertIn("/ops/v1/*", ops.split("}\n\n", 1)[0] + "}")
        self.assertNotIn("/ops/", site)
        self.assertIn("import bro_app", site)
        self.assertIn("admin unix//run/caddy/admin.sock", text)
        snippet = deployd.APP_SNIPPET
        self.assertIn("handle /.well-known/workflow/* {\n\t\trespond 404", snippet)
        self.assertIn("handle /api/health {\n\t\trespond 404", snippet)
        eve = snippet.split("handle /eve/* {", 1)[1].split("\n\t}\n", 1)[0]
        self.assertIn("reverse_proxy 127.0.0.1:4274 {\n\t\t\tflush_interval -1", eve)
        # eve's streams go out unencoded: only Next's answers are compressed.
        self.assertEqual(snippet.count("encode "), 1)
        self.assertIn("\thandle {\n\t\tencode zstd gzip\n\t\treverse_proxy 127.0.0.1:3000", snippet)

    def test_www_next_to_its_apex_redirects_to_it(self):
        text = deployd.render_caddyfile("1-2-3-4.sslip.io", ["brobro.tech", "www.brobro.tech", "www.other.example"])
        www = text.split("www.brobro.tech {", 1)[1].split("\n}\n", 1)[0]
        self.assertEqual(www, "\n\tredir https://brobro.tech{uri} 308")
        self.assertIn("brobro.tech {\n\timport bro_app", text)
        # A www without its apex in the list is a site of its own.
        self.assertIn("www.other.example {\n\timport bro_app", text)

    def test_sites_are_plain_domains_and_not_sslip(self):
        self.assertEqual(deployd.checked_sites(["a.example", "a.example"]), ["a.example"])
        for bad in (["x.sslip.io"], ["bad domain"], ["a.example {\n}"], "a.example"):
            with self.assertRaises(deployd.Refused):
                deployd.checked_sites(bad)


class TokenAndHttpTest(unittest.TestCase):
    def setUp(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        self.deployd = deployd.Deployd(deployd.Paths(root), FakeRunner({}), IDENTITY)
        self.deployd.runner.current = deployd.Paths(root).current
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), deployd.make_handler(self.deployd))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.base = f"http://127.0.0.1:{server.server_address[1]}/ops/v1/"

    def get(self, path, token=None, method="GET"):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            with urllib.request.urlopen(urllib.request.Request(self.base + path, headers=headers,
                                                               method=method)) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_a_host_update_takes_and_gives_back_the_job_slot_over_http(self):
        token = deployd.sign_token(KEY, "bro-app-1")
        self.assertEqual(self.get("host-update", method="POST")[0], 401)
        with mock.patch("builtins.print"):
            code, job = self.get("host-update", token, method="POST")
            self.assertEqual(code, 202)
            code, busy = self.get("host-update", token, method="POST")
            self.assertEqual((code, busy["error"]), (400, f"busy with job {job['id']} (host-update)"))
            self.assertEqual(self.get("host-update", token, method="DELETE"), (200, {"ended": job["id"]}))
            self.assertTrue(wait_until(lambda: self.deployd.running_job() is None))
        self.assertEqual(self.get("host-update", token, method="DELETE"), (200, {"ended": None}))

    def test_tokens(self):
        token = deployd.sign_token(KEY, "bro-app-1")
        self.assertEqual(deployd.verify_token(token, IDENTITY)["env"], "bro-app-1")
        for bad in (deployd.sign_token(KEY, "bro-app-2"), deployd.sign_token(bytes(32), "bro-app-1"),
                    deployd.sign_token(KEY, "bro-app-1", ttl=3600), deployd.sign_token(KEY, "bro-app-1", ttl=-1),
                    "v2.a.b", "garbage"):
            with self.assertRaises(deployd.Unauthorized):
                deployd.verify_token(bad, IDENTITY)

    def test_routes(self):
        self.assertEqual(self.get("health")[0], 200)
        self.assertEqual(self.get("status")[0], 401)
        self.assertEqual(self.get("status", deployd.sign_token(bytes(32), "bro-app-1"))[0], 401)
        token = deployd.sign_token(KEY, "bro-app-1")
        code, status = self.get("status", token)
        self.assertEqual(code, 200)
        self.assertEqual(status["host"], "bro-app-1")
        self.assertIsNone(status["release"])
        self.assertEqual(self.get("env", token)[1]["names"], [])
        self.assertEqual(self.get("logs?unit=sshd", token)[0], 400)
        self.assertEqual(self.get("logs?unit=bro-eve&lines=5", token)[0], 200)
        self.assertEqual(self.get("jobs/nope", token)[0], 404)
        self.assertIsNone(status["job"])
        self.assertEqual(self.get("../x", token)[0], 404)

    def test_one_job_at_a_time(self):
        gate = threading.Event()
        job = self.deployd.start_job("slow", lambda body, log: gate.wait(5), {})
        with self.assertRaisesRegex(deployd.Refused, f"busy with job {job['id']}"):
            self.deployd.start_job("other", lambda body, log: None, {})
        self.assertEqual(self.deployd.running_job(), job["id"])
        gate.set()
        for _ in range(50):
            if job["state"] != "running":
                break
            time.sleep(0.05)
        self.assertEqual(job["state"], "done")
        self.deployd.start_job("other", lambda body, log: None, {})


class WatchdogTest(unittest.TestCase):
    def test_each_sent_alert_is_saved_at_once_and_atomically(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        state_file = deployd.Paths(root).domain.with_name("watchdog.json")
        state_file.parent.mkdir(parents=True)
        now = int(time.time())
        state_file.write_text(json.dumps({"web": {"downSince": now - 600}, "eve": {"downSince": now - 600}}))
        saved = []

        def send(env, text):
            if "eve" in text:  # the second alert: the run is cut short while it is being sent
                saved.append(json.loads(state_file.read_text()))
                raise KeyboardInterrupt
            return True

        with mock.patch.dict(os.environ, {"DEPLOYD_ROOT": str(root)}), \
                mock.patch.object(watchdog, "probe", return_value={"web": False, "eve": False}), \
                mock.patch.object(watchdog, "send", side_effect=send), self.assertRaises(KeyboardInterrupt):
            watchdog.main([])
        self.assertIn("alertedAt", saved[0]["web"])
        self.assertNotIn("pendingAlert", json.dumps(saved[0]))
        self.assertEqual(state_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual([p.name for p in state_file.parent.iterdir() if p.name.startswith(".")], [])

    def test_alert_after_five_minutes_hourly_and_on_recovery(self):
        state, t0 = {}, 1_000_000
        self.assertEqual(watchdog.step(state, {"eve": False}, t0, "bro-app-1"), [])
        self.assertEqual(watchdog.step(state, {"eve": False}, t0 + 240, "bro-app-1"), [])
        [(name, alert)] = watchdog.step(state, {"eve": False}, t0 + 300, "bro-app-1")
        self.assertIn("не отвечает", alert)
        watchdog.sent(state, name)
        self.assertEqual(watchdog.step(state, {"eve": False}, t0 + 1800, "bro-app-1"), [])
        self.assertEqual(len(watchdog.step(state, {"eve": False}, t0 + 300 + 3600, "bro-app-1")), 1)
        watchdog.sent(state, "eve")
        [(name, recovered)] = watchdog.step(state, {"eve": True}, t0 + 4000, "bro-app-1")
        self.assertIn("снова работает", recovered)
        watchdog.sent(state, name)
        self.assertEqual(state["eve"], {})

    def test_an_unsent_recovery_is_sent_again(self):
        state, t0 = {"web": {"downSince": 0, "alertedAt": 300}}, 1000
        [(_, first)] = watchdog.step(state, {"web": True}, t0, "h")
        [(_, again)] = watchdog.step(state, {"web": True}, t0 + 60, "h")
        self.assertEqual(first, again)
        watchdog.sent(state, "web")
        self.assertEqual(watchdog.step(state, {"web": True}, t0 + 120, "h"), [])

    def test_only_the_sent_alert_is_marked(self):
        state = {"web": {"downSince": 0}, "eve": {"downSince": 0}}
        messages = watchdog.step(state, {"web": False, "eve": False}, 600, "h")
        self.assertEqual([name for name, _ in messages], ["web", "eve"])
        watchdog.sent(state, "web")
        state["eve"].pop("pendingAlert")
        self.assertEqual([name for name, _ in watchdog.step(state, {"web": False, "eve": False}, 660, "h")],
                         ["eve"])

    def test_backups_must_be_fresh_once_they_are_on(self):
        with tempfile.TemporaryDirectory() as root:
            paths = deployd.Paths(root)
            now = 2_000_000
            state = {}
            self.assertIsNone(watchdog.backup_fresh(paths, {}, now, state))  # no database yet
            self.assertIsNone(watchdog.backup_fresh(paths, {"DATABASE_URL": "x", "BACKUPS": "off"}, now, state))
            # Expected but the key dropped out of the env: down at once, not quietly off.
            self.assertFalse(watchdog.backup_fresh(paths, {"DATABASE_URL": "x"}, now, state))
            env = {"DATABASE_URL": "x", "BACKUP_ENCRYPTION_KEY": "k"}
            # None has run yet: fine for 26 hours from when the watchdog first expected one, then stale.
            self.assertTrue(watchdog.backup_fresh(paths, env, now + 3600, state))
            self.assertFalse(watchdog.backup_fresh(paths, env, now + 27 * 3600, state))
            paths.backups.mkdir(parents=True)
            (paths.backups / "last-backup.json").write_text(json.dumps({"finishedAt": now + 26 * 3600}))
            self.assertTrue(watchdog.backup_fresh(paths, env, now + 27 * 3600, state))
            self.assertFalse(watchdog.backup_fresh(paths, env, now + 53 * 3600, state))
            # A marker that is no time counts as none: no crash, the 26 hours run from the first expectation.
            (paths.backups / "last-backup.json").write_text(json.dumps({"finishedAt": "yesterday"}))
            self.assertFalse(watchdog.backup_fresh(paths, env, now + 27 * 3600, state))
            (paths.backups / "last-backup.json").write_text(json.dumps({"finishedAt": True}))
            self.assertTrue(watchdog.backup_fresh(paths, env, now + 3600, state))
        state = {"backup": {"downSince": 0}}
        [(_, text)] = watchdog.step(state, {"backup": False}, 300, "bro-app-1")
        self.assertIn("бэкап базы", text)
        self.assertIn("host.py logs bro-app-1 bro-backup", text)

    def test_an_alert_reaches_the_webhook_when_telegram_does_not(self):
        posted = []

        def urlopen(request, data=None, timeout=None):
            url = request if isinstance(request, str) else request.full_url
            if "api.telegram.org" in url:
                raise urllib.error.URLError("timed out")
            posted.append((url, request.data))
            return mock.MagicMock(status=200, __enter__=lambda self: self, __exit__=lambda *a: None)

        env = {"TELEGRAM_BOT_TOKEN": "1:x", "TELEGRAM_OWNER_CHAT_ID": "5",
               "OPS_ALERT_WEBHOOK_URL": "https://push.example/topic"}
        with mock.patch.object(watchdog.urllib.request, "urlopen", urlopen), \
                mock.patch("builtins.print") as printed:
            self.assertTrue(watchdog.send(env, "tg down"))
            self.assertFalse(watchdog.send({**env, "OPS_ALERT_WEBHOOK_URL": "http://push.example/t"}, "x"))
        self.assertEqual(posted, [("https://push.example/topic", "tg down".encode())])
        # A malformed URL fails as a channel does, before anything is sent, not as an exception.
        with mock.patch.object(watchdog.urllib.request, "urlopen") as urlopen, mock.patch("builtins.print"):
            self.assertFalse(watchdog.send_webhook({"OPS_ALERT_WEBHOOK_URL": "https://[::1/topic"}, "x"))
        urlopen.assert_not_called()
        self.assertIn("alert: tg down", " ".join(str(c) for c in printed.call_args_list))
        self.assertNotIn("1:x", " ".join(str(c) for c in printed.call_args_list))

    def test_undelivered_alerts_are_listed_until_they_go_out(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        paths = deployd.Paths(root)
        paths.config.parent.mkdir(parents=True)
        paths.config.write_text(json.dumps({"host": "bro-app-1"}))
        paths.domain.parent.mkdir(parents=True)
        paths.tg_egress.parent.mkdir(parents=True)
        paths.tg_egress.write_text("")
        state_file = paths.domain.with_name("watchdog.json")
        state_file.write_text(json.dumps({"tg-egress": {"downSince": 0}}))
        delivered = []
        with mock.patch.dict(os.environ, {"DEPLOYD_ROOT": str(root)}), \
                mock.patch.object(watchdog, "caddy_ok", return_value=True), \
                mock.patch.object(watchdog, "unit_is", return_value=False), \
                mock.patch.object(watchdog, "egress_ok", return_value=False), \
                mock.patch.object(watchdog, "send", side_effect=lambda env, text: bool(delivered)), \
                mock.patch.object(watchdog.time, "time", return_value=600), mock.patch("builtins.print"):
            watchdog.main([])
            state = json.loads(state_file.read_text())
            self.assertEqual(state["undelivered"], {"tg-egress": 600})
            self.assertNotIn("alertedAt", state["tg-egress"])
            delivered.append(True)
            watchdog.main([])
            state = json.loads(state_file.read_text())
            self.assertNotIn("undelivered", state)
            self.assertIn("alertedAt", state["tg-egress"])

    def test_tg_egress_is_restarted_at_most_every_ten_minutes(self):
        paths = deployd.Paths("/nonexistent")
        runs = []

        def run(argv, **kwargs):
            runs.append(argv[:2])
            return mock.MagicMock(returncode=1)

        state = {}
        with mock.patch.object(watchdog.subprocess, "run", run), mock.patch.object(watchdog.time, "sleep"), \
                mock.patch("builtins.print"):
            self.assertFalse(watchdog.egress_ok(paths, 1000, state))
            self.assertFalse(watchdog.egress_ok(paths, 1060, state))
            self.assertFalse(watchdog.egress_ok(paths, 1000 + watchdog.EGRESS_RESTART_EVERY_S, state))
        self.assertEqual(runs.count(["systemctl", "restart"]), 2)

    def test_a_check_no_longer_run_leaves_the_state(self):
        state = {"tg-bridge": {"downSince": 0, "alertedAt": 300}, "web": {"downSince": 0},
                 "undelivered": {"tg-bridge": 900}, "expected": {"backup": 5}, "egressRestartedAt": 7}
        [(name, text)] = watchdog.step(state, {"caddy": True}, 1000, "h", skip={"web"})
        self.assertEqual(name, "tg-bridge")
        self.assertIn("больше не проверяется", text)
        self.assertEqual(state["web"], {"downSince": 0})  # paused by a planned stop: kept
        self.assertEqual((state["expected"], state["egressRestartedAt"]), ({"backup": 5}, 7))
        # Not sent (no channel took it): due again on the next tick, and still listed as undelivered.
        self.assertEqual(state["tg-bridge"], {"unwatched": 1000})
        self.assertEqual(watchdog.step(state, {"caddy": True}, 1060, "h"), [(name, text)])
        self.assertEqual((state["tg-bridge"], state["undelivered"]), ({"unwatched": 1000}, {"tg-bridge": 900}))
        watchdog.sent(state, name)
        self.assertNotIn("tg-bridge", state)
        self.assertNotIn("undelivered", state)
        self.assertEqual(watchdog.step(state, {"caddy": True}, 1120, "h"), [])  # once
        self.assertNotIn("web", state)  # not paused any more and not run: gone without a word (never alerted)

    def test_a_check_run_again_drops_its_unsent_notice(self):
        state = {"tg-bridge": {"unwatched": 1000}, "undelivered": {"tg-bridge": 1000}}
        self.assertEqual(watchdog.step(state, {"tg-bridge": False}, 1060, "h"), [])
        self.assertEqual(state, {"tg-bridge": {"downSince": 1060}})

    def test_a_planned_stop_pauses_web_and_eve_for_three_hours(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        paths = deployd.Paths(root)
        self.assertEqual(watchdog.paused(paths, 0), set())
        paths.maintenance.parent.mkdir(parents=True)
        paths.maintenance.write_text(json.dumps({"since": 1000, "units": ["bro-eve", "bro-web"]}))
        self.assertEqual(watchdog.paused(paths, 1000 + 3600), {"web", "eve", "tg-bridge"})
        self.assertEqual(watchdog.paused(paths, 1000 + watchdog.MAINTENANCE_S), set())
        paths.maintenance.write_text("{")
        self.assertEqual(watchdog.paused(paths, 1000), set())

    def test_a_hold_left_without_the_bridge_alerts(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        paths = deployd.Paths(root)
        self.assertIsNone(watchdog.hold_ok(paths, 0))
        paths.tg_hold.parent.mkdir(parents=True)
        paths.tg_hold.write_text("1000\n")
        self.assertTrue(watchdog.hold_ok(paths, 1000 + 3600))
        late = 1000 + watchdog.TG_HOLD_S
        self.assertFalse(watchdog.hold_ok(paths, late))
        with mock.patch.object(watchdog, "caddy_ok", return_value=True), \
                mock.patch.object(watchdog, "unit_is", return_value=False):
            self.assertEqual(watchdog.probe(paths, {}, late, {}), {"caddy": True, "tg-hold": False})
        with mock.patch.object(watchdog, "caddy_ok", return_value=True), \
                mock.patch.object(watchdog, "unit_is", return_value=True), \
                mock.patch.object(watchdog, "http_ok", return_value=True):
            self.assertNotIn("tg-hold", watchdog.probe(paths, {}, late, {}))  # the bridge is on: it is watched
        state = {}
        watchdog.step(state, {"tg-hold": False}, late, "bro-app-1")
        [(_, text)] = watchdog.step(state, {"tg-hold": False}, late + 300, "bro-app-1")
        self.assertIn("switch-to-bridge", text)

    def test_a_backup_unit_systemd_cannot_tell_about_counts_as_failed(self):
        def show(code, stdout):
            return mock.patch.object(watchdog.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], code, stdout=stdout, stderr=""))

        with show(0, "LoadState=loaded\nResult=success\n"):
            self.assertFalse(watchdog.backup_unit_failed())
        for code, stdout in ((0, "LoadState=loaded\nResult=exit-code\n"), (0, "LoadState=not-found\nResult=success\n"),
                             (1, ""), (0, "")):
            with show(code, stdout):
                self.assertTrue(watchdog.backup_unit_failed(), (code, stdout))

    def test_a_blip_says_nothing(self):
        state = {}
        watchdog.step(state, {"web": False}, 0, "h")
        self.assertEqual(watchdog.step(state, {"web": True}, 60, "h"), [])


class BootTest(unittest.TestCase):
    def objects(self):
        return {name: {"url": f"https://s3.cloud.ru/b/app/vendor/{name}?sig", "sha256": pin}
                for name, pin in boot.vendor_objects()}

    def test_user_data(self):
        text = boot.cloud_init(host_id="bro-app-1", key=KEY, bundle_url="https://s3.cloud.ru/b/x.tgz?sig",
                               bundle_sha256="a" * 64, objects=self.objects())
        self.assertTrue(text.startswith("#cloud-config\n"))
        identity = json.loads(text.split("path: /etc/bro/deployd.json", 1)[1].split("content: '", 1)[1]
                              .split("'\n", 1)[0])
        self.assertEqual(identity, {"host": "bro-app-1", "key": KEY.hex()})
        settings = json.loads(text.split("path: /etc/bro/app-host-boot.json", 1)[1].split("content: '", 1)[1]
                              .split("'\n", 1)[0])
        self.assertEqual(settings["node"]["version"], boot.VENDOR["node"]["version"])
        self.assertEqual(len(settings["postgresqlClient"]), 3)
        self.assertNotIn(KEY.hex(), json.dumps(settings))
        self.assertIn("bro-app-host-boot > /var/log/bro-provision.log", text)

    def test_user_data_refuses_unpinned_files(self):
        objects = self.objects()
        first = next(iter(objects))
        objects[first] = {**objects[first], "sha256": "b" * 64}
        with self.assertRaisesRegex(ValueError, "pinned"):
            boot.cloud_init(host_id="bro-app-1", key=KEY, bundle_url="u", bundle_sha256="a" * 64, objects=objects)
        with self.assertRaises(ValueError):
            boot.cloud_init(host_id="Bro_App", key=KEY, bundle_url="u", bundle_sha256="a" * 64,
                            objects=self.objects())

    def test_bundle_is_reproducible_and_complete(self):
        with tempfile.TemporaryDirectory() as vendor:
            (Path(vendor) / "caddy").write_bytes(b"caddy")
            pin = hashlib.sha256(b"caddy").hexdigest()
            first, second = boot.bundle(vendor, caddy_sha256=pin), boot.bundle(vendor, caddy_sha256=pin)
            self.assertEqual(first, second)
            import gzip
            import tarfile
            with tarfile.open(fileobj=io.BytesIO(gzip.decompress(first))) as tar:
                names = tar.getnames()
            self.assertEqual(sorted(names), sorted([*boot.FILES, *boot.SIBLING_FILES, "vendor/caddy"]))
            with self.assertRaises(ValueError):
                boot.bundle(vendor)

    def test_vendor_pins(self):
        names = [name for name, _ in boot.vendor_objects()]
        self.assertIn(f"node-v{boot.VENDOR['node']['version']}-linux-x64.tar.xz", names)
        self.assertTrue(all(n.endswith(".deb") for n in names[1:]))
        self.assertTrue(all("pgdg22.04" in n or n.startswith("postgresql-client-common") for n in names[1:]))

    def test_provision_syntax_and_units(self):
        subprocess.run(["bash", "-n", str(HERE / "provision.sh")], check=True)
        eve = (HERE / "bro-eve.service").read_text()
        for line in ("PORT=4274 HOST=127.0.0.1", "WORKFLOW_LOCAL_BASE_URL=http://127.0.0.1:4274", "TZ=UTC",
                     "Restart=always", "EnvironmentFile=/etc/bro/env"):
            self.assertIn(line, eve)
        web = (HERE / "bro-web.service").read_text()
        self.assertIn("PORT=3000 HOSTNAME=127.0.0.1", web)
        for unit in ("bro-web.service", "bro-eve.service"):
            self.assertIn("Requires=bro-egress.service", (HERE / unit).read_text())

    def test_telegram_comes_with_the_host(self):
        subprocess.run(["bash", "-n", str(HERE / "install-code.sh")], check=True)
        install = (HERE / "install-code.sh").read_text()
        self.assertIn("systemctl enable bro-tg-egress.service", install)
        self.assertIn('bash "$HOST/tg-bridge/install.sh"', install)
        # update-host applies the bundle's egress rules: bro-egress, a oneshot, never runs again on a live VM.
        self.assertIn('bash "$HOST/egress.sh"', install)
        # The bridge is switched on only by switch-to-bridge, which removes the webhook first.
        self.assertNotRegex(install, r"enable[^\n]*bro-tg-bridge")
        self.assertNotRegex((HERE.parent / "tg-bridge/install.sh").read_text(), r"systemctl enable")
        provision = (HERE / "provision.sh").read_text()
        self.assertIn('bash "$HOST/install-code.sh"', provision)
        for name in boot.SIBLING_FILES:
            self.assertIn(name, provision)
        for unit in ("bro-eve.service", "bro-web.service", "bro-watchdog.service"):
            self.assertIn("After=bro-tg-egress.service", (HERE / unit).read_text(), unit)
        self.assertIn("bro-tg-egress.service", (HERE.parent / "tg-bridge/bro-tg-bridge.service").read_text())

    def test_egress_rules_are_replaced_in_one_commit(self):
        # Run for real in a network namespace of its own, with root and nobody for bro and caddy.
        if not shutil.which("iptables-restore") or not shutil.which("unshare"):
            self.skipTest("no iptables-restore or unshare")
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        script = root / "egress.sh"
        script.write_text((HERE / "egress.sh").read_text()
                          .replace("for owner in bro:BRO_EGRESS caddy:CADDY_EGRESS",
                                   "for owner in root:BRO_EGRESS nobody:CADDY_EGRESS"))
        (root / "run.sh").write_text(f"""set -e
iptables -w -N BRO_EGRESS
iptables -w -A BRO_EGRESS -d 169.254.0.0/16 -j REJECT
iptables -w -I OUTPUT -m owner --uid-owner root -j BRO_EGRESS
bash {script}
( for i in $(seq 20); do bash {script}; done ) & runs=$!
while kill -0 $runs 2>/dev/null; do
  [ "$(iptables -w -S BRO_EGRESS | grep -c REJECT || true)" = 2 ] || echo gap
done
wait $runs
iptables -w -S
""")
        namespace = ["unshare", "-n"] if os.geteuid() == 0 else ["unshare", "-rn"]
        probe = subprocess.run([*namespace, "iptables", "-w", "-S"], capture_output=True, text=True)
        if probe.returncode != 0:
            self.skipTest(f"no network namespace here: {probe.stderr.strip()[:100]}")
        result = subprocess.run([*namespace, "bash", str(root / "run.sh")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertNotIn("gap", lines)
        self.assertEqual([line for line in lines if "OUTPUT" in line and "EGRESS" in line],
                         ["-A OUTPUT -m owner --uid-owner 65534 -j CADDY_EGRESS",
                          "-A OUTPUT -m owner --uid-owner 0 -j BRO_EGRESS"])
        self.assertEqual(len([line for line in lines if line.startswith("-A BRO_EGRESS")]), 2)
        self.assertEqual(len([line for line in lines if line.startswith("-A CADDY_EGRESS")]), 1)

    def test_every_long_running_unit_restarts(self):
        for unit in ("bro-web.service", "bro-eve.service", "deployd.service", "caddy.service"):
            text = (HERE / unit).read_text()
            self.assertRegex(text, r"\nRestart=(always|on-failure)\n", unit)
        # Both servers exit with 143 on SIGTERM: a planned restart does not mark the unit failed.
        for unit in ("bro-web.service", "bro-eve.service"):
            self.assertIn("\nSuccessExitStatus=143\n", (HERE / unit).read_text(), unit)

    def test_bro_reaches_neither_the_metadata_service_nor_deployd(self):
        subprocess.run(["bash", "-n", str(HERE / "egress.sh")], check=True)
        rules = (HERE / "egress.sh").read_text()
        self.assertIn("-d 169.254.0.0/16 -j REJECT", rules)
        self.assertIn(f"--dport {deployd.LISTEN[1]} -j REJECT", rules)
        self.assertIn("for owner in bro:BRO_EGRESS caddy:CADDY_EGRESS", rules)
        # Caddy faces the internet: no metadata service for it either, and it starts only after the rules.
        caddy_chain = [line for line in rules.splitlines() if "-A CADDY_EGRESS" in line]
        self.assertEqual(caddy_chain, ["-A CADDY_EGRESS -d 169.254.0.0/16 -j REJECT"])
        # One commit: a live VM (install-code.sh) never runs a moment between the flush and the rules.
        self.assertIn("iptables-restore -w --noflush", rules)
        self.assertNotRegex(rules, r"iptables -w -(F|A|N) ")
        caddy = (HERE / "caddy.service").read_text()
        self.assertIn("Requires=bro-egress.service", caddy)
        self.assertIn("After=bro-egress.service", caddy)
        self.assertIn("caddy.service", (HERE / "bro-egress.service").read_text())
        provision = (HERE / "provision.sh").read_text()
        self.assertLess(provision.index("enable --now bro-egress"), provision.index("systemctl restart caddy"))
        self.assertIn("--uid-owner caddy -j CADDY_EGRESS || fail", provision)
        self.assertIn("chown root:root /srv/bro /srv/bro/releases /srv/bro/downloads", provision)
        self.assertNotRegex(provision, r"chown bro:bro [^\n]*/srv/bro")


class BackupTest(unittest.TestCase):
    OPS = HERE.parent / "ops"

    def test_scripts_parse_and_share_the_library(self):
        for script in sorted(self.OPS.glob("*.sh")):
            subprocess.run(["bash", "-n", str(script)], check=True)
            if script.name.startswith("db-") and script.name != "db-lib.sh":
                self.assertIn('source "$(dirname "$0")/db-lib.sh"', script.read_text(), script.name)
        lib = (self.OPS / "db-lib.sh").read_text()
        # A password never reaches a command line; a restore is one transaction.
        self.assertIn('PGPASSWORD="${!pass}"', lib)
        self.assertIn("--single-transaction", lib)
        self.assertIn("-pass env:BACKUP_ENCRYPTION_KEY", lib)
        # The providers' schemas stay where they are: a restore onto Cloud.ru failed on "schema cloudru exists".
        for flag in ("--exclude-schema=neon_auth", "--exclude-schema=cloudru",
                     "--exclude-extension=pg_stat_statements", "--exclude-extension=pgaudit"):
            self.assertIn(flag, lib)
        self.assertIn("'cloudru'", lib.split("SKIP_SCHEMAS=", 1)[1].splitlines()[0])

    def test_pruning_keeps_two_weeks_and_never_the_newest_three(self):
        now = store.datetime.datetime(2026, 10, 30, 1, 10, tzinfo=store.datetime.timezone.utc)
        day = store.datetime.timedelta(days=1)
        dumps = [((now - n * day).strftime("%Y%m%dT%H%M%SZ"), f"backups/postgres/{n}") for n in range(20, -1, -1)]
        doomed = store.doomed(dumps, 14, 3, now)
        self.assertEqual(doomed, [f"backups/postgres/{n}" for n in range(20, 14, -1)])
        cutoff = (now - 14 * day).strftime("%Y%m%dT%H%M%SZ")
        old = [(stamp, key) for stamp, key in dumps if stamp < cutoff]
        self.assertEqual(len(old), 6)
        self.assertEqual(store.doomed(old, 14, 3, now), [key for _, key in old[:-3]])

    def test_halves_of_a_backup_never_push_out_whole_ones(self):
        now = store.datetime.datetime(2026, 10, 30, 1, 10, tzinfo=store.datetime.timezone.utc)
        day = store.datetime.timedelta(days=1)
        prefix = "backups/postgres"

        def stamp(n):
            return (now - n * day).strftime("%Y%m%dT%H%M%SZ")

        whole = [f"{prefix}/{stamp(n)}.{kind}" for n in (20, 19, 18) for kind in ("dump.enc", "json")]
        # Three failed nights since (uploads cut short), a delete cut short, a copy and a run uploading now.
        halves = [f"{prefix}/{stamp(n)}.dump.enc" for n in (4, 3, 2)] + [f"{prefix}/{stamp(25)}.json"]
        others = [f"{prefix}/{stamp(30)}-neon.dump.enc", f"{prefix}/{stamp(0)}.dump.enc"]
        doomed = store.to_prune({*whole, *halves, *others}, prefix, 14, 3, now)
        self.assertEqual(doomed, [f"{prefix}/{stamp(25)}.json", *halves[:3]])
        # Past the newest three whole ones, a whole backup goes manifest first.
        whole += [f"{prefix}/{stamp(n)}.{kind}" for n in (17, 16, 15) for kind in ("dump.enc", "json")]
        doomed = store.to_prune({*whole, *halves, *others}, prefix, 14, 3, now)
        self.assertEqual(doomed[:6], [f"{prefix}/{stamp(25)}.json", f"{prefix}/{stamp(20)}.json",
                                      f"{prefix}/{stamp(20)}.dump.enc", f"{prefix}/{stamp(19)}.json",
                                      f"{prefix}/{stamp(19)}.dump.enc", f"{prefix}/{stamp(18)}.json"])
        self.assertNotIn(f"{prefix}/{stamp(17)}.json", doomed)

    def test_a_delete_is_tried_again_on_a_5xx(self):
        answers = [(503, b"SlowDown"), (500, b""), (204, b"")]
        with mock.patch.object(store.s3, "signed", side_effect=lambda *a, **k: answers.pop(0)) as signed, \
                mock.patch.object(store.time, "sleep"):
            store.delete("backups/postgres/20261002T011000Z.json")
        self.assertEqual(signed.call_count, 3)
        with mock.patch.object(store.s3, "signed", return_value=(403, b"AccessDenied")), \
                self.assertRaisesRegex(SystemExit, "403"):
            store.delete("backups/postgres/20261002T011000Z.json")

    def test_only_backup_keys(self):
        self.assertTrue(store.KEY.fullmatch("backups/postgres/20261002T011000Z.dump.enc"))
        self.assertTrue(store.KEY.fullmatch("backups/stand/postgres/20261002T011000Z-neon.json"))
        for key in ("app/releases/x.tar.zst", "backups/../pool/x.dump.enc", "backups/postgres/latest.dump.enc"):
            self.assertIsNone(store.KEY.fullmatch(key), key)
        self.assertTrue(store.NIGHTLY.fullmatch("20261002T011000Z.dump.enc"))
        self.assertIsNone(store.NIGHTLY.fullmatch("20261002T011000Z-neon.dump.enc"))

    def run_lib(self, script, stdin=""):
        return subprocess.run(["bash", "-c", f'source "{self.OPS}/db-lib.sh"; {script}'], input=stdin,
                              capture_output=True, text=True, check=True).stdout

    def test_one_db_script_at_a_time_and_a_killed_runs_dump_goes(self):
        with tempfile.TemporaryDirectory() as root:
            stale = Path(root) / "work.abc123"
            stale.mkdir()
            (stale / "db.dump").write_text("rows")
            holder = subprocess.Popen(["bash", "-c", f'source "{self.OPS}/db-lib.sh"; db_lock; echo locked; read'],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                      env={**os.environ, "BACKUP_WORKDIR": root})
            self.addCleanup(holder.kill)
            self.assertEqual(holder.stdout.readline(), "locked\n")
            self.assertFalse(stale.exists())
            lock = f"{root}/.db.lock"
            self.assertNotEqual(subprocess.run(["flock", "-n", lock, "true"]).returncode, 0)
            holder.communicate("\n", timeout=10)
            self.assertEqual(subprocess.run(["flock", "-n", lock, "true"]).returncode, 0)

    def test_restore_and_copy_take_only_the_words_they_know(self):
        env = {k: v for k, v in os.environ.items() if k != "HOST_PROFILE"}
        for script, args, said in (
                ("db-restore.sh", ["latest", "app", "--replace", "--dry-run"], "usage"),
                ("db-restore.sh", ["latest", "app", "--dry-run"], "usage"),
                ("db-restore.sh", ["latest"], "usage"),
                ("db-copy.sh", ["neon", "app", "--replace", "--live-source"], "HOST_PROFILE=stand"),
                ("db-copy.sh", ["neon", "app", "--dry-run"], "unknown flag")):
            for profile in ({}, {"HOST_PROFILE": "prod"}):
                result = subprocess.run(["bash", str(self.OPS / script), *args], capture_output=True, text=True,
                                        env={**env, **profile, "BACKUP_WORKDIR": "/nonexistent/bro-test"})
                self.assertEqual(result.returncode, 1, (script, args))
                self.assertIn(said, result.stderr, (script, args))

    def test_neon_mode_fails_when_the_other_sessions_are_not_ended(self):
        with tempfile.TemporaryDirectory() as root:
            psql = Path(root) / "psql"
            psql.write_text('#!/bin/bash\ncat > /dev/null\n[[ "$*" != *pg_terminate_backend* ]] || exit 3\necho on\n')
            psql.chmod(0o755)
            env = {**os.environ, "PATH": f"{root}:{os.environ['PATH']}", "PG_BIN": "/nonexistent",
                   "HOST_PROFILE": "prod", "BACKUP_WORKDIR": f"{root}/work",
                   "NEON_DATABASE_URL": "postgres://neon@db.example/neondb"}

            def mode(name):
                return subprocess.run(["bash", str(self.OPS / "db-neon-mode.sh"), name], capture_output=True,
                                      text=True, env=env, stdin=subprocess.DEVNULL)

            for name in ("read-only", "writable"):
                result = mode(name)
                self.assertNotEqual(result.returncode, 0, name)
                self.assertNotIn("ended", result.stdout, name)
            self.assertIn("default_transaction_read_only=on", mode("status").stdout)

    def test_a_hold_turns_off_a_bridge_left_on(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        script = root / "tg-bridge.sh"
        script.write_text((self.OPS / "tg-bridge.sh").read_text().replace("/opt/bro", f"{root}/opt/bro")
                          .replace("/var/lib/bro", f"{root}/var/lib/bro"))
        (root / "opt/bro/tg-bridge").mkdir(parents=True)
        (root / "opt/bro/tg-bridge/tg_bridge.py").write_text("")
        (root / "opt/bro/tg-egress").mkdir(parents=True)
        (root / "opt/bro/tg-egress/tg_egress.py").write_text("")
        (root / "var/lib/bro").mkdir(parents=True)
        fakes, log, mark = root / "bin", root / "calls", root / "var/lib/bro/tg-hold"
        fakes.mkdir()
        for tool, answer in (
                ("systemctl", 'case "$1" in is-*) [ -n "${ON:-}" ] ;; disable) [ -z "${NO_STOP:-}" ] ;; esac'),
                ("timeout", 'shift; exec "$@"'),
                ("python3", 'if [ "$2" = --check ]; then [ -z "${NO_EGRESS:-}" ]; else [ -z "${NO_TELEGRAM:-}" ]; fi')):
            (fakes / tool).write_text(f'#!/bin/bash\necho "{tool} ${{*##*/}}" >> "{log}"\n{answer}\n')
            (fakes / tool).chmod(0o755)

        def hold(**env):
            log.write_text("")
            mark.unlink(missing_ok=True)
            result = subprocess.run(["bash", str(script), "hold"], capture_output=True, text=True,
                                    env={**os.environ, "PATH": f"{fakes}:{os.environ['PATH']}", **env})
            hold.said = result.stdout
            return result.returncode, [c for c in log.read_text().splitlines() if not c.startswith("timeout ")], mark.exists()

        unit = "bro-tg-bridge.service"
        egress = "python3 tg_egress.py --check"
        delete = "python3 tg_bridge.py switch-to-bridge --no-start"
        self.assertEqual(hold(ON="1"), (0, [f"systemctl is-enabled --quiet {unit}",
                                            f"systemctl disable --now {unit}", egress, delete], True))
        self.assertEqual(hold(), (0, [f"systemctl is-enabled --quiet {unit}", f"systemctl is-active --quiet {unit}",
                                      egress, delete], True))
        # No path to Telegram: the message says who holds the updates now.
        code, calls, marked = hold(NO_EGRESS="1")
        self.assertEqual((code, calls[-1], marked), (1, egress, False))
        self.assertIn("the webhook stays", hold.said)
        code, calls, marked = hold(ON="1", NO_EGRESS="1")
        self.assertEqual((code, calls[-1], marked), (1, egress, True))
        self.assertIn("no webhook is set: nobody takes the updates", hold.said)
        self.assertNotIn("the webhook stays", hold.said)
        # A bridge that does not stop: no hold, and nothing done about the webhook.
        code, calls, marked = hold(ON="1", NO_STOP="1")
        self.assertNotEqual(code, 0)
        self.assertEqual((calls[-1], marked), (f"systemctl disable --now {unit}", False))
        # Stopped, then Telegram out of reach: nobody takes the updates any more, so the mark is down.
        code, calls, marked = hold(ON="1", NO_TELEGRAM="1")
        self.assertNotEqual(code, 0)
        self.assertEqual((calls[-1], marked), (delete, True))

    def test_copy_counts_takes_no_row_for_a_header(self):
        # pg_restore --data-only output: a text row that starts with "COPY " stays a row of its table.
        text = ("SET x = 1;\n"
                "COPY public.msgs (body, id) FROM stdin;\nCOPY evil\t1\nhi\t2\n\\.\n"
                'COPY public."user" (email) FROM stdin;\na@x\n\\.\n'
                "COPY drizzle.__drizzle_migrations (id) FROM stdin;\n\\.\n")
        self.assertEqual(self.run_lib("copy_counts", text).splitlines(),
                         ["drizzle.__drizzle_migrations 0", "public.msgs 2", "public.user 1"])

    def test_a_failed_restore_shows_its_first_error_only(self):
        stderr = ('psql:/var/backups/bro/work.x/restore.sql:5: ERROR:  duplicate key value violates unique '
                  'constraint "user_email_key"\nDETAIL:  Key (email)=(person@example.com) already exists.\n'
                  'CONTEXT:  COPY user, line 2: "person@example.com"\n')
        with tempfile.NamedTemporaryFile("w", suffix=".err") as f:
            f.write(stderr)
            f.flush()
            shown = self.run_lib(f'first_error "{f.name}"')
        self.assertTrue(shown.startswith("ERROR:  duplicate key"))
        self.assertNotIn("person@example.com", shown)
        lib = (self.OPS / "db-lib.sh").read_text()
        self.assertIn("-v VERBOSITY=terse -v SHOW_CONTEXT=never", lib)

    def test_db_names_are_an_allowlist(self):
        for name in ("bro", "bro_workflow", "bro_stand_workflow"):
            result = subprocess.run(["bash", "-c", f'source "{self.OPS}/db-lib.sh"; database_url db:{name}'],
                                    capture_output=True, text=True, env={**os.environ, "DATABASE_URL": "postgres://u@h/bro"})
            self.assertNotEqual(result.returncode, 0, name)
        out = subprocess.run(["bash", "-c", f'source "{self.OPS}/db-lib.sh"; database_url db:bro_stand'],
                             capture_output=True, text=True, check=True,
                             env={**os.environ, "DATABASE_URL": "postgres://u@h/bro"}).stdout
        self.assertEqual(out.strip(), "postgres://u@h/bro_stand")

    def test_manifests_are_signed_with_the_backup_key(self):
        key = b"k" * 44
        manifest = store.sign({"key": "backups/postgres/20261002T011000Z.dump.enc", "size": 1, "tables": {}}, key)
        store.authenticate(manifest, key, "backups/postgres/20261002T011000Z.dump.enc")
        with self.assertRaisesRegex(SystemExit, "another BACKUP_ENCRYPTION_KEY"):
            store.authenticate(manifest, b"x" * 44)
        with self.assertRaisesRegex(SystemExit, "signature"):
            store.authenticate({**manifest, "size": 2}, key)
        with self.assertRaisesRegex(SystemExit, "not of"):  # an older dump under a newer name
            store.authenticate(manifest, key, "backups/postgres/20261003T011000Z.dump.enc")
        unsigned = {k: v for k, v in manifest.items() if k != "hmac"}
        with self.assertRaisesRegex(SystemExit, "not signed"):
            store.authenticate(unsigned, key)

    def test_the_nightly_units(self):
        service = (HERE / "bro-backup.service").read_text()
        for line in ("OnFailure=bro-backup-alert.service", "User=bro", "EnvironmentFile=/etc/bro/env",
                     "Requires=bro-egress.service", "ops/db-backup.sh", "ops/db-restore-check.sh latest"):
            self.assertIn(line, service)
        # Both scripts of one release: `current` is read once, by one ExecStart.
        [start] = [line for line in service.splitlines() if line.startswith("ExecStart=")]
        self.assertEqual(start.count("/srv/bro/current"), 1)
        self.assertIn("readlink -e /srv/bro/current", start)
        self.assertIn("Europe/Moscow", (HERE / "bro-backup.timer").read_text())
        self.assertIn("watchdog.py alert backup", (HERE / "bro-backup-alert.service").read_text())
        self.assertIn("bro-backup.timer", (HERE / "provision.sh").read_text())
        self.assertIn("bro-backup", deployd.UNITS)


def load_host_py():
    """host.py of the session, loaded by path (its name is that of this directory), with a scratch state."""
    import importlib.util
    os.environ["BRO_APP_HOST_DIR"] = tempfile.mkdtemp()
    spec = importlib.util.spec_from_file_location("app_host", HERE.parent / "host.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HostCliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host = load_host_py()
        cls.addClassCleanup(shutil.rmtree, os.environ["BRO_APP_HOST_DIR"])

    def test_the_build_has_the_model_provider_of_the_vm(self):
        # web_search.ts decides at module load: a build without it ships the Gateway's tool, and RouterAI
        # answers 400 to every turn that carries it.
        env = self.host.build_env()
        for profile in self.host.PROFILES.values():
            self.assertEqual(env["MODEL_PROVIDER"], profile["MODEL_PROVIDER"])
        self.assertTrue(env["ROUTERAI_API_KEY"])
        self.assertEqual(self.host.build_env(WORKFLOW_WORLD="postgres")["MODEL_PROVIDER"], "routerai")

    def test_the_readme_restore_command_parses(self):
        args = self.host.parser().parse_args(
            ["ops", "bro-app-1", "db-restore.sh", "latest", "app", "--replace"])
        self.assertEqual(args.script, "db-restore.sh")
        self.assertEqual(args.args, ["latest", "app", "--replace"])
        args = self.host.parser().parse_args(["ops", "bro-app-1", "db-copy.sh", "neon", "app", "--replace"])
        self.assertEqual(args.args, ["neon", "app", "--replace"])
        for argument in ("db:bro_stand", "backups/postgres/20261002T011000Z.dump.enc", "--dump-only"):
            self.assertRegex(argument, deployd.ARGUMENT)

    def test_databases_come_from_new_secrets_per_profile(self):
        secrets_file = self.host.SECRETS / "new-secrets.json"
        self.host.SECRETS.mkdir(parents=True, exist_ok=True)
        secrets_file.write_text(json.dumps({"PG_HOST": "10.0.0.9", "PG_PORT": "5432",
                                            "PG_BRO_APP_PASSWORD": "a/b@c:d", "BACKUP_ENCRYPTION_KEY": "k" * 44}))
        self.addCleanup(secrets_file.unlink)
        prod, _ = self.host.compose_env("prod", {})
        stand, _ = self.host.compose_env("stand", {})
        self.assertEqual(prod["DATABASE_URL"], "postgresql://bro_app:a%2Fb%40c%3Ad@10.0.0.9:5432/bro")
        self.assertTrue(prod["WORKFLOW_POSTGRES_URL"].endswith("/bro_workflow"))
        self.assertTrue(stand["DATABASE_URL"].endswith("/bro_stand"))
        self.assertTrue(stand["WORKFLOW_POSTGRES_URL"].endswith("/bro_stand_workflow"))
        self.assertTrue(prod["BACKUP_CHECK_DATABASE_URL"].endswith("/bro_restore_check"))
        self.assertNotEqual(prod["BACKUP_PREFIX"], stand["BACKUP_PREFIX"])
        self.assertEqual(prod["BACKUP_ENCRYPTION_KEY"], "k" * 44)
        self.assertEqual((prod["BACKUPS"], prod["HOST_PROFILE"], stand["HOST_PROFILE"]), ("on", "prod", "stand"))
        self.assertNotIn("NEON_DATABASE_URL", prod)
        secrets_file.write_text(json.dumps({"PG_HOST": "10.0.0.9", "PG_PORT": "5432", "PG_BRO_APP_PASSWORD": "p"}))
        stand, _ = self.host.compose_env("stand", {})
        self.assertEqual(stand["BACKUPS"], "off")  # no key: off on the stand, said so; production refuses
        prod, _ = self.host.compose_env("prod", {})
        self.assertEqual(prod["BACKUPS"], "on")

    def test_production_is_vercel_production_on_the_vm(self):
        self.host.SECRETS.mkdir(parents=True, exist_ok=True)
        files = {
            "vercel-production.json": {"BLOB_READ_WRITE_TOKEN": "b", "SANDBOX_HOST_ID": "sbx-code-1",
                                       "BETTER_AUTH_URL": "https://bro-next.vercel.app", "FREE_MESSAGES_PER_DAY": "30",
                                       "PGPASSWORD": "neon", "DATABASE_URL": "neon"},
            "new-secrets.json": {"SANDBOX_SIGNING_KEY": "ab" * 32, "TELEGRAM_WEBHOOK_SECRET_TOKEN": "new-secret",
                                 "BROWSER_USE_WEBHOOK_SECRET": "w", "BROWSER_VM_SIGNING_KEY": "cd" * 32},
        }
        for name, content in files.items():
            (self.host.SECRETS / name).write_text(json.dumps(content))
            self.addCleanup((self.host.SECRETS / name).unlink)
        user = "geo-type-residential-country-ru-session-{session}-lifetime-30"
        session = {"TELEGRAM_BOT_USERNAME": "“@bro_bot”\n", "TELEGRAM_WEBHOOK_SECRET_TOKEN": "old",
                   "ROUTERAI_API_KEY": "rk", "OPENROUTER_API_KEY": "ok", "SUPERMEMORY_API_KEY": "s",
                   "BLOB_READ_WRITE_TOKEN": "b2", "BROWSER_VM_PROXY": ":".join(["proxy.example", "9000", user, "pw"])}
        prod, sources = self.host.compose_env("prod", session)
        self.assertEqual(prod["TELEGRAM_BOT_USERNAME"], "bro_bot")
        self.assertEqual(prod["BROWSER_VM_PROXY"], ":".join(["proxy.example", "10000", user, "pw"]))
        self.assertEqual((prod["TELEGRAM_WEBHOOK_SECRET_TOKEN"], sources["TELEGRAM_WEBHOOK_SECRET_TOKEN"]),
                         ("new-secret", "new-secrets"))
        self.assertEqual(prod["BROWSER_VM_LLM_API_KEY"], "rk")
        self.assertEqual({k: prod[k] for k in ("MODEL_PROVIDER", "AGENT_SANDBOX", "CLOUDRU_PRIVATE_ROUTING",
                                                "SANDBOX_HOST_ID", "EVE_SCHEDULES", "BETTER_AUTH_URL")},
                         {"MODEL_PROVIDER": "routerai", "AGENT_SANDBOX": "bro-cloudru", "CLOUDRU_PRIVATE_ROUTING": "on",
                          "SANDBOX_HOST_ID": "sbx-code-2", "EVE_SCHEDULES": "on",
                          "BETTER_AUTH_URL": "https://brobro.tech"})
        self.assertEqual(prod["FREE_MESSAGES_PER_DAY"], "30")
        for absent in ("BLOB_READ_WRITE_TOKEN", "OPENROUTER_API_KEY", "SUPERMEMORY_API_KEY", "PGPASSWORD"):
            self.assertNotIn(absent, prod)
        stand, _ = self.host.compose_env("stand", session)
        self.assertEqual((stand["SANDBOX_SIGNING_KEY"], stand["AGENT_SANDBOX"], stand["MODEL_PROVIDER"]),
                         ("ab" * 32, "bro-cloudru", "routerai"))
        for absent in ("TELEGRAM_WEBHOOK_SECRET_TOKEN", "BROWSER_USE_WEBHOOK_SECRET", "BLOB_READ_WRITE_TOKEN"):
            self.assertNotIn(absent, stand)

    def test_the_proxy_moves_to_the_sticky_port_in_either_shape(self):
        login = "u-session-{session}"
        self.assertEqual(self.host.sticky_proxy(f"h.example:9000:{login}:p"), f"h.example:10000:{login}:p")
        self.assertEqual(self.host.sticky_proxy(f"h.example:10000:{login}:p"), f"h.example:10000:{login}:p")
        url = "http" + "://" + login + ":" + "p" + "@" + "h.example:9000"
        self.assertEqual(self.host.sticky_proxy(url), url.replace(":9000", ":10000"))

    def test_update_host_installs_then_restarts_deployd(self):
        self.assertEqual(self.host.parser().parse_args(["update-host", "bro-app-1"]).fn, self.host.cmd_update_host)
        steps = self.host.UPDATE_HOST.split(" && ")
        self.assertLess(steps.index("bash /opt/bro/app-host/install-code.sh"), steps.index("systemctl restart deployd"))
        self.assertEqual(steps[-1], "curl -fsS -m 10 http://127.0.0.1:8095/ops/v1/health")
        self.assertLess(len(self.host.UPDATE_HOST), 900)  # one serial line

    def update_host(self, answers, console_codes):
        """cmd_update_host against fake deployd answers (by method and path) and console exit codes; the calls
        to deployd and how it ended."""
        calls = []

        def call(name, method, path, body=None, timeout=60, retry=None):
            calls.append((method, path))
            return answers.get((method, path), (200, {"job": None, "deployd": "new"}))

        class Console:
            def __init__(self, name):
                pass

            def login(self):
                pass

            def run(self, command, seconds):
                return "last line", console_codes.pop(0)

        console = type(sys)("console")
        console.Console = Console
        with mock.patch.dict(sys.modules, {"console": console}), \
                mock.patch.object(self.host, "call", side_effect=call), \
                mock.patch.object(self.host, "deliver_bundle", return_value=("app/host/x.tgz", "ab" * 32)), \
                mock.patch.object(self.host.s3, "presign", return_value="https://s3.example/x"), \
                mock.patch("builtins.print"):
            try:
                self.host.cmd_update_host(self.host.parser().parse_args(["update-host", "bro-app-1"]))
            except SystemExit as stop:
                return calls, str(stop)
        return calls, "done"

    def test_update_host_holds_deployds_jobs_and_gives_them_back_only_when_it_is_safe(self):
        held = {("POST", "host-update"): (202, {"id": "j1"})}
        calls, outcome = self.update_host(held, [0, 0])
        self.assertEqual(outcome, "done")
        self.assertEqual(calls, [("POST", "host-update"), ("GET", "status")])  # the restart gave them back
        for codes in ([1], [0, 2]):  # the fetch, or the install before the restart, failed
            calls, outcome = self.update_host(held, codes)
            self.assertNotEqual(outcome, "done")
            self.assertEqual(calls[-1], ("DELETE", "host-update"), codes)
        # No answer from the console: the install may still run, and a job let in now could be cut.
        calls, outcome = self.update_host(held, [0, None])
        self.assertIn("no answer from the console", outcome)
        self.assertIn("status bro-app-1 --stage", outcome)
        self.assertNotIn("failed", outcome)
        self.assertNotIn(("DELETE", "host-update"), calls)
        # Busy: nothing goes over the console.
        busy = {("POST", "host-update"): (400, {"error": "busy with job j0 (release)"})}
        calls, outcome = self.update_host(busy, [])
        self.assertIn("busy with job j0", outcome)
        self.assertEqual(calls, [("POST", "host-update")])

    def test_update_host_on_a_deployd_without_the_hold_checks_for_a_job(self):
        old = {("POST", "host-update"): (404, {"error": "not found"})}
        running = {**old, ("GET", "status"): (200, {"job": "j0", "deployd": "old"})}
        calls, outcome = self.update_host(running, [])
        self.assertIn("deployd runs job j0", outcome)
        calls, outcome = self.update_host(old, [0, 1])
        self.assertIn("the install failed", outcome)
        self.assertNotIn(("DELETE", "host-update"), calls)  # nothing held, nothing to give back

    def test_update_host_keeps_the_last_good_code_when_an_install_failed(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        self.assertIn(self.host.ROTATE_HOST_CODE, self.host.UPDATE_HOST)
        script = f"{self.host.ROTATE_HOST_CODE} && mv /opt/bro/app-host.new /opt/bro/app-host".replace(
            "/opt/bro", str(root))

        def run(current_installed):
            (root / "app-host.new").mkdir()
            (root / "app-host.new" / "code").write_text("new")
            if current_installed:
                (root / "app-host" / ".installed").write_text("")
            subprocess.run(["bash", "-c", script], check=True)

        (root / "app-host").mkdir()
        (root / "app-host" / "code").write_text("good")
        run(current_installed=False)  # the first update of an old VM: no .old yet, so it rotates
        self.assertEqual((root / "app-host.old" / "code").read_text(), "good")
        run(current_installed=False)  # the new code's install failed; a retry keeps the good one
        self.assertEqual((root / "app-host.old" / "code").read_text(), "good")
        run(current_installed=True)  # installed: it becomes the previous code
        self.assertEqual((root / "app-host.old" / "code").read_text(), "new")

    def test_production_env_refuses_without_the_expected_names_or_an_alert_webhook(self):
        values = {name: "x" for name in self.host.REQUIRED}
        values.update(BACKUPS="off", EVE_SCHEDULES="off")

        def env(*flags, extra=None):
            args = self.host.parser().parse_args(["env", "bro-app-1", "--profile", "prod", *flags])
            given = {**values, **(extra or {})}
            sources = {name: "prod.json" for name in given}
            with mock.patch.object(self.host, "compose_env", return_value=(given, sources)), \
                    mock.patch.object(self.host, "start_job", side_effect=RuntimeError("sent")), \
                    mock.patch("builtins.print") as printed:
                try:
                    args.fn(args)
                except SystemExit as stop:
                    return "refused: " + str(stop), printed
                except RuntimeError:
                    return "sent", printed
            return "dry", printed

        outcome, _ = env()
        self.assertIn("TELEGRAM_OWNER_CHAT_ID", outcome)
        self.assertIn("OPS_ALERT_WEBHOOK_URL", outcome)
        outcome, printed = env("--dry-run")
        self.assertEqual(outcome, "dry")
        lines = " ".join(str(c.args[0]) for c in printed.call_args_list)
        self.assertIn("would refuse", lines)
        self.assertIn("WARNING: EVE_SCHEDULES=off", lines)
        self.assertIn("WARNING: BACKUPS=off", lines)
        self.assertEqual(env("--allow-missing", "--no-alert-webhook")[0], "sent")
        hook = {"OPS_ALERT_WEBHOOK_URL": "https://push.example/t"}
        self.assertEqual(env("--allow-missing", extra=hook)[0], "sent")
        outcome, printed = env("--allow-missing", extra={"OPS_ALERT_WEBHOOK_URL": "http://push.example/t"})
        self.assertIn("refused", outcome)
        self.assertIn("not https", " ".join(str(c.args[0]) for c in printed.call_args_list))

    def test_remember_keeps_the_previous_file(self):
        secrets_file = self.host.SECRETS / "new-secrets.json"
        self.addCleanup(lambda: [p.unlink(missing_ok=True) for p in (secrets_file, secrets_file.with_name(
            "new-secrets.json.bak"))])
        self.host.remember(A="1")
        self.host.remember(B="2")
        self.assertEqual(json.loads(secrets_file.read_text()), {"A": "1", "B": "2"})
        self.assertEqual(json.loads(secrets_file.with_name("new-secrets.json.bak").read_text()), {"A": "1"})
        self.assertEqual(secrets_file.stat().st_mode & 0o777, 0o600)

    def test_the_stand_gets_no_key_that_reaches_people_or_production(self):
        session = {name: "x" for name in (
            "TELEGRAM_BOT_TOKEN", "IMESSAGE_PROJECT_SECRET", "YOOKASSA_SECRET_KEY", "BLOB_READ_WRITE_TOKEN",
            "BLOB_STORE_ID", "EVE_MEMORY_BLOB_READ_WRITE_TOKEN", "SUPERMEMORY_API_KEY", "COMPOSIO_API_KEY",
            "BROWSER_USE_API_KEY", "BROWSER_USE_PROXY_PASSWORD", "BROWSER_HOST_MAX", "SANDBOX_WORKSPACES",
            "BROWSER_POOL_WORKSPACES", "BROWSER_VM_WORKSPACES", "ROUTERAI_API_KEY")}
        values, _ = self.host.compose_env("stand", session)
        self.assertEqual(values["EVE_SCHEDULES"], "off")
        self.assertNotIn("TEST", values)  # Better Auth would drop its origin check
        self.assertIn("ROUTERAI_API_KEY", values)
        kept = [n for n in session if n in values and n != "ROUTERAI_API_KEY"]
        self.assertEqual(kept, [])
        prod, _ = self.host.compose_env("prod", session)
        self.assertIn("BROWSER_USE_API_KEY", prod)
        self.assertNotIn("TEST", prod)


if __name__ == "__main__":
    unittest.main()
