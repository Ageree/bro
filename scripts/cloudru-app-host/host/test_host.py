"""App VM tests: cd scripts/cloudru-app-host/host && python3 -m unittest (stdlib only).

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
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import boot  # noqa: E402
import deployd  # noqa: E402
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

    def run(self, argv, *, env=None, cwd=None, user=None, timeout=600):
        self.calls.append({"argv": argv, "env": env, "cwd": cwd, "user": user})
        if argv[0] == "tar":
            result = subprocess.run(argv, capture_output=True, text=True)
            return result.returncode, result.stdout + result.stderr
        if argv[0] == deployd.NODE:
            return self.migrate_exit, "migrate app: done\nmigrate world: done\n"
        if argv[:2] == ["systemctl", "is-active"]:
            return 0, "active\n"
        return 0, ""

    def healthy(self, url, timeout=5):
        version = os.readlink(self.current).rsplit("/", 1)[-1] if os.path.islink(self.current) else None
        return self.health.get(version, True)

    def download(self, url, out, sha256, timeout=60):
        data = self.archives[url]
        if hashlib.sha256(data).hexdigest() != sha256:
            raise deployd.Refused("the release does not match its sha256")
        Path(out).write_bytes(data)


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


@unittest.skipUnless(shutil.which("zstd"), "zstd is not installed")
class ReleaseTest(unittest.TestCase):
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

    def test_ops_runs_only_scripts_of_the_current_release(self):
        self.release("v1")
        with self.assertRaisesRegex(deployd.Refused, "no ops/db-dump.sh"):
            self.deployd.do_ops({"script": "db-dump.sh"}, self.log.append)
        with self.assertRaisesRegex(deployd.Refused, "script"):
            self.deployd.do_ops({"script": "../web/server.js"}, self.log.append)
        (self.paths.releases / "v1" / "ops" / "db-dump.sh").write_text("")
        with self.assertRaisesRegex(deployd.Refused, "args"):
            self.deployd.do_ops({"script": "db-dump.sh", "args": ["a b"]}, self.log.append)
        self.deployd.do_ops({"script": "db-dump.sh", "args": ["app"]}, self.log.append)
        call = self.runner.calls[-1]
        self.assertEqual(call["argv"][0], "/bin/bash")
        self.assertEqual(call["user"], "bro")


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

    def get(self, path, token=None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            with urllib.request.urlopen(urllib.request.Request(self.base + path, headers=headers)) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

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
            self.assertEqual(sorted(names), sorted([*boot.FILES, "vendor/caddy"]))
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

    def test_every_long_running_unit_restarts(self):
        for unit in ("bro-web.service", "bro-eve.service", "deployd.service", "caddy.service"):
            text = (HERE / unit).read_text()
            self.assertRegex(text, r"\nRestart=(always|on-failure)\n", unit)

    def test_bro_reaches_neither_the_metadata_service_nor_deployd(self):
        subprocess.run(["bash", "-n", str(HERE / "egress.sh")], check=True)
        rules = (HERE / "egress.sh").read_text()
        self.assertIn("-d 169.254.0.0/16 -j REJECT", rules)
        self.assertIn(f"--dport {deployd.LISTEN[1]} -j REJECT", rules)
        self.assertIn("--uid-owner bro -j BRO_EGRESS", rules)
        provision = (HERE / "provision.sh").read_text()
        self.assertIn("chown root:root /srv/bro /srv/bro/releases /srv/bro/downloads", provision)
        self.assertNotRegex(provision, r"chown bro:bro [^\n]*/srv/bro")


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

    def test_the_readme_restore_command_parses(self):
        args = self.host.parser().parse_args(
            ["ops", "bro-app-1", "db-restore.sh", "app", "s3get:app/backups/x.dump", "a" * 64, "--replace"])
        self.assertEqual(args.script, "db-restore.sh")
        self.assertEqual(args.args, ["app", "s3get:app/backups/x.dump", "a" * 64, "--replace"])

    def test_the_stand_gets_no_key_that_reaches_people_or_production(self):
        session = {name: "x" for name in (
            "TELEGRAM_BOT_TOKEN", "IMESSAGE_PROJECT_SECRET", "YOOKASSA_SECRET_KEY", "BLOB_READ_WRITE_TOKEN",
            "BLOB_STORE_ID", "EVE_MEMORY_BLOB_READ_WRITE_TOKEN", "SUPERMEMORY_API_KEY", "COMPOSIO_API_KEY",
            "BROWSER_USE_API_KEY", "BROWSER_USE_PROXY_PASSWORD", "BROWSER_HOST_MAX", "SANDBOX_WORKSPACES",
            "BROWSER_POOL_WORKSPACES", "BROWSER_VM_WORKSPACES", "ROUTERAI_API_KEY")}
        values, _ = self.host.compose_env("stand", session)
        self.assertEqual(values["SCHEDULES"], "off")
        self.assertNotIn("TEST", values)  # Better Auth would drop its origin check
        self.assertIn("ROUTERAI_API_KEY", values)
        kept = [n for n in session if n in values and n != "ROUTERAI_API_KEY"]
        self.assertEqual(kept, [])
        prod, _ = self.host.compose_env("prod", session)
        self.assertIn("BROWSER_USE_API_KEY", prod)
        self.assertNotIn("TEST", prod)


if __name__ == "__main__":
    unittest.main()
