"""hostd tests: cd browser-vm/host && python -m unittest (needs aiohttp and cryptography; no root).

runc, runsc, mount, umount, mkfs.ext4, ip, nft, zstd and caddy are a fake runner (records argv, writes a
fake checkpoint image, can refuse a restore or ignore SIGTERM, runs a test's hooks at SIGTERM and delete); Object Storage is an aiohttp server behind
"presigned" URLs; the sandbox's worker is an aiohttp server the transit addresses reach (the transit pool is
put on 127.0.0.0/16 for the tests). The sandbox and park tests run under both runtimes where the behaviour
is the same (`RUNTIME`); the snapshot tests are gVisor's, the stopped-Chrome park is runc's.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import random
import shutil
import stat
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).parent))
import hostd  # noqa: E402
import network  # noqa: E402
import sets  # noqa: E402

SIGNING = bytes.fromhex("11" * 32)
HOST_ID = "host-test-1"
KEY = hmac.new(SIGNING, f"bro-browser-host:{HOST_ID}".encode(), hashlib.sha256).digest()
IDENTITY = {"host": HOST_ID, "key": KEY}
DATA_KEY = "22" * 32
WORKER_KEY = "ab" * 32
MARKER = b"cookie-secret-marker-0123456789"


def token(host=HOST_ID, key=KEY, lifetime=300):
    payload = base64.urlsafe_b64encode(json.dumps({"env": host, "exp": int(time.time()) + lifetime}).encode())
    signed = "v1." + payload.rstrip(b"=").decode()
    signature = base64.urlsafe_b64encode(hmac.new(key, signed.encode(), hashlib.sha256).digest())
    return f"{signed}.{signature.rstrip(b'=').decode()}"


def request(**overrides):
    return {"id": "ws-abc", "workspace": "personal:abc", "generation": 3, "memoryMb": 2048,
            "workerKey": WORKER_KEY, "rootfsVersion": "v1", **overrides}


RUNSC_VERSION = "runsc version release-20260914.0"
RUNC_VERSION = "runc version 1.1.12-0ubuntu2~22.04.1"


class FakeRunner:
    """runc, runsc, mount, umount, mkfs.ext4, ip, nft, zstd and caddy as the host would run them."""

    def __init__(self):
        self.calls = []
        self.containers = {}
        self.fail_restore = False
        self.fail_checkpoint = False
        self.ignore_term = False  # the init does not stop on SIGTERM
        self.fail_kill = False  # `runc kill` fails (the container is already gone)
        self.signals = []  # (container, signal) of every `kill`
        self.on_term = None  # a test's hook at SIGTERM: what the sandbox does as it stops (container)
        self.on_delete = None  # a test's hook at `delete` (container)
        self.stuck = set()  # containers `delete` cannot remove
        self.mounted = set()
        self.host_rules, self.router_rules, self.caddyfiles = [], [], []
        self.checkpointed, self.restored = [], []
        self.image_bytes = random.Random(7).randbytes(300 * 1024)

    def argv(self, tool):
        return [argv for argv, _log in self.calls if Path(argv[0]).name == tool]

    def runtime_calls(self, command):
        return [(argv, log) for argv, log in self.calls
                if Path(argv[0]).name in ("runc", "runsc") and command in argv]

    async def run(self, argv, *, log_file=None, timeout=120):
        self.calls.append((list(argv), log_file))
        if log_file is not None:
            with open(log_file, "ab") as sink:  # a file the sandbox keeps, as the real runner gives
                sink.write(b"runsc output\n")
        tool = Path(argv[0]).name
        if tool in ("runsc", "runc"):
            return self.runtime(tool, argv[1:])
        if tool == "mount":
            assert Path(argv[-1]).is_dir(), f"mount point {argv[-1]} missing"
            self.mounted.add(argv[-1])
            return 0, ""
        if tool == "mkfs.ext4":
            assert Path(argv[-1]).stat().st_size > 0, "mkfs on an empty image"
            return 0, ""
        if tool == "umount":
            if argv[-1] not in self.mounted:
                return 32, "not mounted"
            self.mounted.discard(argv[-1])
            return 0, ""
        if tool == "ip":
            if argv[1:] == ["-j", "route", "show", "default"]:
                return 0, json.dumps([{"dst": "default", "gateway": "10.0.0.1", "dev": "eth0"}])
            if "nft" in argv:
                self.router_rules.append(Path(argv[-1]).read_text())
            return 0, ""
        if tool == "nft":
            self.host_rules.append(Path(argv[-1]).read_text())
            return 0, ""
        if tool == "zstd":
            source, target = Path(argv[-3]), Path(argv[-1])
            data = source.read_bytes()
            if "-d" in argv:
                assert data.startswith(b"ZSTD"), "not a fake zstd frame"
                target.write_bytes(data[4:])
            else:
                target.write_bytes(b"ZSTD" + data)
            if "--rm" in argv:
                source.unlink()
            return 0, ""
        if tool == "caddy":
            self.caddyfiles.append(Path(argv[3]).read_text())
            return 0, ""
        raise AssertionError(f"unexpected command {argv}")

    def runtime(self, tool, args):
        if args == ["--version"]:
            return 0, (RUNSC_VERSION if tool == "runsc" else RUNC_VERSION) + "\nspec: 1.1.0\n"
        if tool == "runc":
            assert not any(a.startswith(("--overlay2", "--platform")) for a in args), "runsc flags given to runc"
        flags = [a for a in args if a.startswith("--")]
        words = [a for a in args if not a.startswith("--")]
        command = words[0]
        container = words[1] if command in ("exec", "kill") else words[-1]
        option = lambda name: next(f.split("=", 1)[1] for f in flags if f.startswith(f"--{name}="))  # noqa: E731
        if command == "create":
            self.containers[container] = "created"
        elif command == "start":
            self.containers[container] = "running"
        elif command == "checkpoint":
            image = Path(option("image-path"))
            image.mkdir(parents=True)
            if self.fail_checkpoint:
                (image / "checkpoint.img").write_bytes(self.image_bytes[:1000])  # half written
                return 1, "checkpoint failed"
            (image / "checkpoint.img").write_bytes(self.image_bytes)
            self.checkpointed.append(hashlib.sha256(self.image_bytes).hexdigest())
            self.containers[container] = "stopped"
        elif command == "restore":
            if self.fail_restore:
                return 1, "incompatible snapshot"
            self.restored.append(hashlib.sha256((Path(option("image-path")) / "checkpoint.img").read_bytes()).hexdigest())
            self.containers[container] = "running"
        elif command == "exec":
            raise AssertionError("hostd never runs anything inside a sandbox")
        elif command == "kill":
            self.signals.append((container, words[2]))
            if container not in self.containers or self.fail_kill:
                return 1, "container does not exist"
            if words[2] == "SIGTERM":
                if self.on_term is not None:
                    self.on_term(container)
                if not self.ignore_term:
                    self.containers[container] = "stopped"
            else:
                self.containers[container] = "stopped"
        elif command == "delete":
            if container in self.stuck:
                return 124, f"{tool} timed out after 60 s"
            if self.on_delete is not None:
                self.on_delete(container)
            self.containers.pop(container, None)
        elif command == "state":
            if container not in self.containers:
                return 1, "not found"
            return 0, json.dumps({"id": container, "status": self.containers[container]})
        elif command == "events":
            return 0, json.dumps({"type": "stats", "data": {"memory": {"usage": {"usage": 1500 * 2**20}}}})
        return 0, ""


class FakeStorage:
    """Object Storage behind presigned URLs: records the order of PUTs and how many ran at once."""

    def __init__(self):
        self.objects, self.puts, self.gets, self.raw = {}, [], [], []
        self.fail = set()
        self.in_flight = self.most_in_flight = 0

    async def put(self, request):
        key = request.match_info["key"]
        self.in_flight += 1
        self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            await asyncio.sleep(0.02)
            if key in self.fail:
                return web.Response(status=500)
            self.objects[key] = await request.read()
            self.raw.append(request.raw_path)
            self.puts.append(key)
            return web.Response(status=200)
        finally:
            self.in_flight -= 1

    async def get(self, request):
        key = request.match_info["key"]
        self.gets.append(key)
        if key not in self.objects:
            return web.Response(status=404)
        return web.Response(body=self.objects[key])

    def app(self):
        app = web.Application(client_max_size=64 * 1024 * 1024)
        app.add_routes([web.put("/bucket/{key:.+}", self.put), web.get("/bucket/{key:.+}", self.get)])
        return app


class HostTest(unittest.IsolatedAsyncioTestCase):
    RUNTIME = "runc"

    async def asyncSetUp(self):
        self.tmp = Path(tempfile.mkdtemp())  # not enterContext: the host's Python is 3.10
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.storage = FakeStorage()
        self.s3 = TestServer(self.storage.app())
        await self.s3.start_server()
        self.addAsyncCleanup(self.s3.close)
        self.worker_hits = []

        async def worker_health(request):
            self.worker_hits.append(request.host)
            return web.json_response({"worker": "test"})

        worker = web.Application()
        worker.add_routes([web.get("/v1/health", worker_health)])
        runner = web.AppRunner(worker)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", 0)
        await site.start()
        self.addAsyncCleanup(runner.cleanup)
        self.worker_port = runner.addresses[0][1]

    def url(self, key):
        return str(self.s3.make_url(f"/bucket/{key}")) + "?X-Amz-Signature=presigned"

    def set_urls(self, generation, count=64):
        return {"chunkUrls": [self.url(f"ws/{generation}/chunk-{i:04d}") for i in range(count)],
                "manifestUrl": self.url(f"ws/{generation}/manifest.json")}

    def park_body(self, generation=3, **overrides):
        return {"generation": generation, "dataKey": DATA_KEY, "upload": self.set_urls(generation), **overrides}

    async def host(self, name="a", versions=("v1",), **settings):
        root = self.tmp / name
        for version in versions:
            rootfs = root / "rootfs" / version / "etc"
            rootfs.mkdir(parents=True)
            (rootfs / "passwd").write_text(
                f"root:x:0:0::/root:/bin/bash\nbro:x:{os.getuid()}:{os.getgid()}::/home/bro:/bin/bash\n")
        config = hostd.Config(**{
            "root": str(root), "shm": str(root / "shm"), "runtime": self.RUNTIME, "runsc": "/usr/bin/runsc",
            "runc": "/usr/sbin/runc", "mount": "/usr/bin/mount", "umount": "/usr/bin/umount",
            "mkfs": "/usr/sbin/mkfs.ext4", "profile_mb": 64,
            "caddyfile": str(root / "Caddyfile"), "domain": "203-0-113-7.sslip.io", "transit_pool": "127.0.0.0/16",
            "worker_port": self.worker_port, "chunk_bytes": 64 * 1024, "parallel": 4, "start_timeout_s": 3,
            "restore_timeout_s": 3, **settings})
        runner = FakeRunner()
        host = hostd.Host(config, IDENTITY, runner)
        await host.start()
        self.addAsyncCleanup(host.close)
        client = TestClient(TestServer(hostd.application(host)))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        return host, runner, client

    async def call(self, client, method, path, body=None, auth=True):
        headers = {"Authorization": f"Bearer {token()}"} if auth else {}
        response = await client.request(method, path, json=body, headers=headers)
        return response.status, await response.json()

    async def started(self, name="a", **overrides):
        host, runner, client = await self.host(name)
        status, record = await self.call(client, "POST", "/v1/sandboxes", request(**overrides))
        self.assertEqual(status, 201, record)
        profile = Path(host.config.root) / "sandboxes" / record["id"] / "profile"
        (profile / "Default").mkdir()
        (profile / "Default" / "Cookies").write_bytes(MARKER)  # Chrome signed in somewhere
        return host, runner, client, record

    async def parked_set(self):
        host, runner, client, _record = await self.started()
        status, parked = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual(status, 200, parked)
        return runner, parked

    def restore_body(self, kind="restore", generation=4):
        return request(generation=generation, **{kind: {**self.set_urls(3), "dataKey": DATA_KEY}})

    def profile_on(self, host):
        return (Path(host.config.root) / "sandboxes" / "ws-abc" / "profile" / "Default" / "Cookies").read_bytes()


class TokenTest(unittest.TestCase):
    def test_host_key_derivation_is_pinned_for_bro(self):
        self.assertEqual(KEY.hex(), "fc0873b32715053d3ff2f84210fe16de8ecebea4b2ea502271c9d927192c9620")

    def test_accepts_a_host_token_and_refuses_the_rest(self):
        now = time.time()
        self.assertEqual(hostd.verify_token(token(), IDENTITY, now)["env"], HOST_ID)
        cases = {
            "bad signature": token(key=b"x" * 32),
            "token for another host": token(host="host-other"),
            "expired token": token(lifetime=-5),
            "malformed token": "v1.abc",
        }
        for reason, value in cases.items():
            with self.subTest(reason), self.assertRaisesRegex(hostd.Unauthorized, reason):
                hostd.verify_token(value, IDENTITY, now)
        with self.assertRaisesRegex(hostd.Unauthorized, "expired token"):
            hostd.verify_token(token(lifetime=hostd.MAX_TOKEN_LIFETIME_S + 60), IDENTITY, now)
        with self.assertRaisesRegex(hostd.Unauthorized, "host not configured"):
            hostd.verify_token(token(), None, now)


class EncryptionTest(unittest.TestCase):
    def setUp(self):
        self.key, _mac = sets.set_keys(bytes.fromhex(DATA_KEY), "ws|a|3", b"s" * 16)

    def test_round_trip(self):
        sealed = sets.seal(self.key, "ws|a|3", "image", 2, False, b"page memory")
        self.assertNotIn(b"page memory", sealed)
        self.assertEqual(sets.unseal(self.key, "ws|a|3", "image", 2, False, sealed), b"page memory")

    def test_tampered_reordered_mixed_or_truncated_chunks_fail(self):
        sealed = sets.seal(self.key, "ws|a|3", "image", 2, False, b"page memory")
        other_set, _ = sets.set_keys(bytes.fromhex(DATA_KEY), "ws|a|4", b"s" * 16)
        flipped = bytes([sealed[0] ^ 1]) + sealed[1:]
        cases = {
            "flipped byte": (self.key, "ws|a|3", "image", 2, False, flipped),
            "another index": (self.key, "ws|a|3", "image", 3, False, sealed),
            "another part": (self.key, "ws|a|3", "profile", 2, False, sealed),
            "another set": (other_set, "ws|a|4", "image", 2, False, sealed),
            "taken for the last chunk": (self.key, "ws|a|3", "image", 2, True, sealed),
        }
        for reason, args in cases.items():
            with self.subTest(reason), self.assertRaises(sets.SetError):
                sets.unseal(*args)

    def test_manifest_mac_catches_edits_and_other_keys(self):
        data = bytes.fromhex(DATA_KEY)
        _enc, mac_key = sets.set_keys(data, "ws|a|3", b"s" * 16)
        manifest = sets.sign(mac_key, {"format": sets.FORMAT, "setId": "ws|a|3",
                                       "salt": base64.b64encode(b"s" * 16).decode(), "parts": []})
        self.assertEqual(sets.verified(data, manifest), self.key)
        with self.assertRaises(sets.SetError):
            sets.verified(data, {**manifest, "parts": [{"name": "image"}]})
        with self.assertRaises(sets.SetError):
            sets.verified(bytes.fromhex("33" * 32), manifest)


class ArchiveTest(unittest.TestCase):
    """What root on a host extracts was written by a sandbox: nothing but files and directories under it."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def crafted(self, members):
        archive = self.tmp / "set.tar"
        with tarfile.open(archive, "w") as tar:
            for name, kind, value in members:
                info = tarfile.TarInfo(name)
                info.type = kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    info.linkname = value
                    tar.addfile(info)
                elif kind == tarfile.REGTYPE:
                    info.size, info.mode = len(value), 0o4755
                    tar.addfile(info, __import__("io").BytesIO(value))
                else:
                    tar.addfile(info)
        return archive

    def test_links_escapes_and_special_members_are_skipped_the_rest_comes_out(self):
        outside = self.tmp / "outside"
        outside.mkdir()
        archive = self.crafted([
            ("a", tarfile.SYMTYPE, str(outside)),  # an absolute link, then a file through it
            ("a/owned", tarfile.REGTYPE, b"x"),
            ("b", tarfile.SYMTYPE, "."),  # a chain of relative links
            ("b/b/b/../../../outside/chain", tarfile.REGTYPE, b"x"),
            ("../outside/dotdot", tarfile.REGTYPE, b"x"),
            (str(outside / "absolute"), tarfile.REGTYPE, b"x"),
            ("hard", tarfile.LNKTYPE, str(outside / "target")),
            ("fifo", tarfile.FIFOTYPE, None),
            ("dev", tarfile.CHRTYPE, None),
            ("Default", tarfile.DIRTYPE, None),
            ("Default/Cookies", tarfile.REGTYPE, MARKER),
        ])
        target = self.tmp / "profile"
        hostd.unpack(archive, target)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual((target / "Default" / "Cookies").read_bytes(), MARKER)
        self.assertFalse((target / "Default" / "Cookies").stat().st_mode & stat.S_ISUID)
        # Absolute and `..` names are mapped under the target by the `data` filter; nothing is a link.
        for path in target.rglob("*"):
            self.assertFalse(path.is_symlink(), path)
            self.assertTrue(path.resolve().is_relative_to(target.resolve()), path)
        self.assertFalse((target / "hard").exists() or (target / "fifo").exists() or (target / "dev").exists())


class NetworkTest(unittest.TestCase):
    def test_every_sandbox_has_the_same_inside_address_and_its_own_transit(self):
        plan = network.Network()
        self.assertEqual(plan.transit(0), ("172.31.0.1", "172.31.0.2"))
        self.assertEqual(plan.transit(5), ("172.31.0.21", "172.31.0.22"))
        first, second = plan.setup("a", 0, "/r.nft"), plan.setup("b", 1, "/r.nft")
        inside = ["ip", "-n", "bro-s-a", "addr", "add", "192.168.254.2/30", "dev", "eth0"]
        self.assertIn(inside, first)
        self.assertIn(["ip", "-n", "bro-s-b", "addr", "add", "192.168.254.2/30", "dev", "eth0"], second)
        self.assertIn(["ip", "addr", "add", "172.31.0.5/30", "dev", "brt1"], second)
        # Interface names in the root namespace stay under Linux's 15 characters for the whole pool.
        self.assertLessEqual(len(plan.uplink_veth(plan.slots - 1)), 15)
        with self.assertRaises(ValueError):
            plan.transit(plan.slots)

    def test_inside_and_transit_ranges_stay_out_of_the_cloud_network(self):
        import ipaddress
        vpc = ipaddress.ip_network("10.0.0.0/8")
        self.assertFalse(network.INNER.overlaps(vpc))
        self.assertFalse(network.Network().pool.overlaps(vpc))

    def test_router_forwards_only_the_worker_port_in(self):
        rules = network.Network(worker_port=8080).router_rules()
        self.assertIn('iifname "up0" tcp dport 8080 dnat to 192.168.254.2:8080', rules)
        self.assertIn('oifname "up0" masquerade', rules)
        self.assertIn("type filter hook forward priority filter; policy drop;", rules)
        self.assertTrue(rules.startswith("table ip bro_router\ndelete table ip bro_router\n"))


class SandboxTest(HostTest):
    async def test_health_needs_no_token_and_everything_else_does(self):
        _host, _runner, client = await self.host()
        status, health = await self.call(client, "GET", "/v1/health", auth=False)
        version = RUNSC_VERSION if self.RUNTIME == "runsc" else RUNC_VERSION
        self.assertEqual((status, health["runtime"], health["runtimeVersion"]), (200, self.RUNTIME, version))
        self.assertEqual(health["runsc"], RUNSC_VERSION if self.RUNTIME == "runsc" else None)
        for method, path in [("GET", "/v1/capacity"), ("POST", "/v1/sandboxes"), ("GET", "/v1/sandboxes/ws-abc"),
                             ("DELETE", "/v1/sandboxes/ws-abc?generation=3"), ("POST", "/v1/sandboxes/ws-abc/park")]:
            with self.subTest(path):
                self.assertEqual((await self.call(client, method, path, {}, auth=False))[0], 401)

    async def test_sandbox_ids_are_validated(self):
        _host, runner, client = await self.host()
        for bad in ["WS-abc", "ws_abc", "a" * 64, "", "../x", "ws.abc"]:
            with self.subTest(bad):
                status, _ = await self.call(client, "POST", "/v1/sandboxes", request(id=bad))
                self.assertEqual(status, 400)
        self.assertEqual((await self.call(client, "GET", "/v1/sandboxes/ws_abc"))[0], 400)
        self.assertEqual(runner.runtime_calls("create"), [])

    async def test_fresh_start_builds_the_sandbox_the_contract_describes(self):
        host, runner, client = await self.host()
        status, record = await self.call(client, "POST", "/v1/sandboxes", request())
        self.assertEqual((status, record["state"], record["path"], record["route"]), (201, "running", "fresh", "/g/ws-abc/"))
        home = Path(host.config.root) / "sandboxes" / "ws-abc"
        worker_json = home / "worker.json"
        self.assertEqual(worker_json.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(worker_json.read_text()), {"environment": "personal:abc", "key": WORKER_KEY})
        self.assertNotIn("127.0.0.53", (home / "resolv.conf").read_text())
        bundle = json.loads((home / "bundle" / "config.json").read_text())
        self.assertEqual(bundle["process"]["args"], ["/usr/local/sbin/bro-sandbox-init"])
        self.assertEqual(bundle["hostname"], "bro-sandbox")
        self.assertIs(bundle["process"]["noNewPrivileges"], False)  # the worker's sudo
        for capability in ("CAP_SETUID", "CAP_SETGID"):
            self.assertIn(capability, bundle["process"]["capabilities"]["bounding"])
        self.assertEqual(bundle["linux"]["resources"]["pids"], {"limit": 4096})
        self.assertIn("BRO_WORKER_BIND=0.0.0.0", bundle["process"]["env"])
        mounts = {m["destination"]: m for m in bundle["mounts"]}
        self.assertEqual((mounts["/var/lib/bro/profile"]["source"], mounts["/var/lib/bro/profile"]["options"]),
                         (str(home / "profile"), ["rbind", "rw"]))
        self.assertEqual(mounts["/etc/bro/worker.json"]["options"], ["rbind", "ro"])
        self.assertEqual(mounts["/etc/resolv.conf"]["source"], str(home / "resolv.conf"))
        self.assertIn({"type": "network", "path": "/var/run/netns/bro-s-ws-abc"}, bundle["linux"]["namespaces"])
        self.assertEqual(bundle["linux"]["resources"]["memory"]["limit"], 2048 * 2**20)
        (create, log), = runner.runtime_calls("create")
        self.assertEqual(Path(create[0]).name, self.RUNTIME)
        self.assertIn(f"--bundle={home / 'bundle'}", create)
        self.assertEqual(log, home / "runtime.log")  # stdio to a file, never a pipe
        self.assertEqual(len(runner.runtime_calls("start")), 1)
        self.assertIn("127.0.0.2", self.worker_hits[-1])  # the worker was reached at the router's transit address
        # The worker key never reaches a command line.
        self.assertFalse(any(WORKER_KEY in " ".join(argv) for argv, _ in runner.calls))

    async def test_host_ruleset_isolates_sandboxes_and_caddy_routes_each(self):
        host, runner, client = await self.host()
        await self.call(client, "POST", "/v1/sandboxes", request())
        await self.call(client, "POST", "/v1/sandboxes", request(id="ws-def", workspace="personal:def"))
        rules = runner.host_rules[-1]
        self.assertTrue(rules.startswith("table inet bro\ndelete table inet bro\n"))  # one atomic transaction
        for blocked in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"):
            self.assertIn(blocked, rules)
        self.assertIn('iifname "brt0" ip saddr != 127.0.0.2 drop', rules)
        self.assertIn('iifname "brt1" ip saddr != 127.0.0.6 drop', rules)
        self.assertIn('iifname "brt*" ip daddr @blocked jump refuse', rules)
        self.assertIn('iifname "brt*" oifname "eth0" accept', rules)
        self.assertIn('oifname "brt*" drop', rules)  # nothing opens a connection into a sandbox but the host
        # ...and a neighbour sandbox is refused at once, before that silent drop (stage 2: it timed out).
        self.assertIn('iifname "brt*" oifname "brt*" jump refuse\n\t\toifname "brt*" drop', rules)
        self.assertIn("accept\n\t\tiifname \"brt*\" jump refuse\n\t}\n\tchain forward", rules)  # no port of the host
        self.assertNotIn("dport", rules)  # the stand's open host port is off by default
        # Refused at once, never silently dropped: a silent address hung browser-use for minutes.
        self.assertIn("chain refuse {\n\t\tmeta l4proto tcp reject with tcp reset\n"
                      "\t\treject with icmpx type admin-prohibited\n\t}", rules)
        self.assertEqual(rules.count('iifname "brt*" drop'), 0)
        self.assertIn('iifname "in0" meta l4proto tcp reject with tcp reset', runner.router_rules[-1])
        self.assertIn('oifname "eth0" ip saddr 127.0.0.0/16 masquerade', rules)
        self.assertIn("dnat to 192.168.254.2", runner.router_rules[-1])
        caddyfile = runner.caddyfiles[-1]
        self.assertIn("admin unix//run/caddy/admin.sock", caddyfile)
        self.assertIn("203-0-113-7.sslip.io {", caddyfile)
        self.assertIn(f"handle_path /g/ws-abc/* {{\n\t\treverse_proxy 127.0.0.2:{self.worker_port} {{\n"
                      f"\t\t\theader_up X-Forwarded-Prefix /g/ws-abc\n", caddyfile)
        self.assertIn(f"handle_path /g/ws-def/* {{\n\t\treverse_proxy 127.0.0.6:{self.worker_port} {{\n"
                      f"\t\t\theader_up X-Forwarded-Prefix /g/ws-def\n", caddyfile)
        self.assertIn("handle_path /h/* {\n\t\treverse_proxy 127.0.0.1:8090", caddyfile)

    def test_stand_host_ports_open_only_those_ports_of_the_host(self):
        rules = network.Network(stand_ports=(3130,)).host_rules([0], "eth0")
        self.assertIn('\t\tiifname "brt*" tcp dport { 3130 } accept\n\t\tiifname "brt*" jump refuse\n', rules)
        self.assertEqual(rules.count("dport"), 1)  # the forward chain (other destinations) is unchanged
        with self.assertRaises(ValueError):
            network.Network(stand_ports=(0,))

    async def test_generation_rules(self):
        _host, runner, client = await self.host()
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request()))[0], 201)
        status, again = await self.call(client, "POST", "/v1/sandboxes", request())
        self.assertEqual((status, again["path"]), (200, "fresh"))
        self.assertEqual(len(runner.runtime_calls("create")), 1)
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request(generation=2)))[0], 409)
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request(workspace="personal:x")))[0], 409)
        status, adopted = await self.call(client, "POST", "/v1/sandboxes", request(generation=4))
        self.assertEqual((status, adopted["generation"], adopted["path"]), (200, 4, "adopted"))
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body(3)))[0], 409)
        self.assertEqual((await self.call(client, "DELETE", "/v1/sandboxes/ws-abc?generation=3"))[0], 409)
        self.assertEqual((await self.call(client, "DELETE", "/v1/sandboxes/ws-abc?generation=4"))[0], 200)

    async def test_a_rootfs_the_host_lacks_is_refused_before_anything_starts(self):
        _host, runner, client = await self.host()
        status, answer = await self.call(client, "POST", "/v1/sandboxes", request(rootfsVersion="v2"))
        self.assertEqual((status, answer["rootfsVersion"]), (409, "v2"))
        self.assertEqual(runner.argv("ip")[1:], [])

    async def test_delete_wipes_the_host_dir_shm_network_and_route(self):
        host, runner, client, _record = await self.started()
        (Path(host.config.shm) / "bro-ws-abc").mkdir(parents=True)
        status, _ = await self.call(client, "DELETE", "/v1/sandboxes/ws-abc?generation=3")
        self.assertEqual(status, 200)
        self.assertFalse((Path(host.config.root) / "sandboxes" / "ws-abc").exists())
        self.assertFalse((Path(host.config.shm) / "bro-ws-abc").exists())
        self.assertIn(["ip", "netns", "del", "bro-s-ws-abc"], runner.argv("ip"))
        self.assertNotIn("/g/ws-abc/", runner.caddyfiles[-1])
        self.assertNotIn("brt0", runner.host_rules[-1])
        self.assertEqual((await self.call(client, "GET", "/v1/sandboxes/ws-abc"))[0], 404)

    async def test_capacity(self):
        _host, _runner, client, _record = await self.started()
        status, capacity = await self.call(client, "GET", "/v1/capacity")
        self.assertEqual(status, 200)
        self.assertEqual(capacity["rootfsVersions"], ["v1"])
        self.assertEqual(capacity["sandboxes"], [{"id": "ws-abc", "state": "running", "generation": 3,
                                                  "memoryMb": 2048, "usedMb": 1500}])
        self.assertEqual(capacity["runtime"], self.RUNTIME)
        if self.RUNTIME == "runsc":
            self.assertEqual(capacity["snapshotFormat"]["runsc"], RUNSC_VERSION)
        else:
            self.assertIsNone(capacity["snapshotFormat"])  # runc makes no snapshots
        self.assertEqual(len(capacity["cpu"]["features"]), 16)

    async def test_a_restarted_hostd_keeps_live_sandboxes_and_fails_lost_ones(self):
        host, runner, _client, _record = await self.started()
        await self.call(_client, "POST", "/v1/sandboxes", request(id="ws-def", workspace="personal:def"))
        runner.containers.pop("bro-ws-def")  # the host lost this one
        again = hostd.Host(host.config, IDENTITY, runner)
        await again.start()
        self.addAsyncCleanup(again.close)
        self.assertEqual(again.sandboxes["ws-abc"]["state"], "running")
        self.assertEqual(again.sandboxes["ws-def"]["state"], "failed")

    async def test_a_restarted_hostd_settles_a_sandbox_it_left_halfway(self):
        host, runner, _client, _record = await self.started()
        path = Path(host.config.root) / "sandboxes" / "ws-abc" / "sandbox.json"
        path.write_text(json.dumps({**json.loads(path.read_text()), "state": "starting"}))
        again = hostd.Host(host.config, IDENTITY, runner)
        await again.start()
        self.addAsyncCleanup(again.close)
        self.assertEqual(again.sandboxes["ws-abc"]["state"], "running")  # its worker answers
        path.write_text(json.dumps({**json.loads(path.read_text()), "state": "parking", "slot": None}))
        third = hostd.Host(host.config, IDENTITY, runner)
        await third.start()
        self.addAsyncCleanup(third.close)
        self.assertEqual(third.sandboxes["ws-abc"]["state"], "failed")

    async def test_a_sandbox_the_runtime_cannot_delete_keeps_its_record(self):
        host, runner, client, _record = await self.started()
        runner.stuck.add("bro-ws-abc")
        netns_deletes = runner.argv("ip").count(["ip", "netns", "del", "bro-s-ws-abc"])  # the start's fresh netns
        status, answer = await self.call(client, "DELETE", "/v1/sandboxes/ws-abc?generation=3")
        self.assertEqual((status, answer["error"]), (502, f"{self.RUNTIME} could not delete the sandbox"))
        self.assertTrue((Path(host.config.root) / "sandboxes" / "ws-abc" / "profile").exists())
        self.assertEqual(runner.argv("ip").count(["ip", "netns", "del", "bro-s-ws-abc"]), netns_deletes)
        self.assertEqual(runner.argv("umount"), [])  # its root stays mounted under it
        status, record = await self.call(client, "GET", "/v1/sandboxes/ws-abc")
        self.assertEqual((status, record["state"]), (200, "failed"))
        self.assertIn("/g/ws-abc/", runner.caddyfiles[-1])  # its slot is still taken
        runner.stuck.clear()
        self.assertEqual((await self.call(client, "DELETE", "/v1/sandboxes/ws-abc?generation=3"))[0], 200)

    async def test_a_rootfs_without_the_bro_user_is_a_failed_start(self):
        host, runner, client = await self.host()
        (Path(host.config.root) / "rootfs" / "v1" / "etc" / "passwd").write_text("root:x:0:0::/root:/bin/bash\n")
        status, answer = await self.call(client, "POST", "/v1/sandboxes", request())
        self.assertEqual(status, 502)
        self.assertIn("no bro user", answer["error"])
        self.assertEqual(runner.runtime_calls("create"), [])

    async def test_memory_limits_never_add_up_to_more_than_the_host_has(self):
        _host, _runner, client = await self.host(memory_limit_mb=5000)
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request()))[0], 201)
        second = request(id="ws-def", workspace="personal:def")
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", second))[0], 201)
        status, answer = await self.call(client, "POST", "/v1/sandboxes", request(id="ws-ghi", workspace="personal:ghi"))
        self.assertEqual((status, answer["committedMb"]), (507, 4096))
        await self.call(client, "DELETE", "/v1/sandboxes/ws-def?generation=3")
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", second))[0], 201)

    async def test_the_runsc_log_is_cut_to_its_newer_half(self):
        host, _runner, _client, _record = await self.started()
        host.config.log_max_bytes = 1000
        log = Path(host.config.root) / "sandboxes" / "ws-abc" / "runtime.log"
        log.write_bytes(b"o" * 1500 + b"n" * 500)
        host.trim_logs()
        self.assertEqual(log.read_bytes(), b"n" * 500)

    def test_image_and_staging_of_two_ids_never_meet(self):
        config = hostd.Config(root="/srv/bro", shm="/dev/shm")
        a, b = hostd.Paths(config, "x"), hostd.Paths(config, "staging-x")
        self.assertEqual(str(a.image), "/dev/shm/bro-x")
        self.assertEqual(str(a.staging), "/srv/bro/staging/x")  # on disk: RAM holds only the image
        self.assertNotIn(a.image, (b.image, b.staging))
        self.assertNotIn(b.image, (a.image, a.staging))


class ParkTest(HostTest):
    """What a set is, whichever runtime made it (runc here; GvisorParkTest runs them under runsc)."""

    async def test_urls_go_out_exactly_as_presigned(self):
        _host, _runner, _client = await self.host()
        url = str(self.s3.make_url("/bucket/")) + "personal%3Aabc/3/chunk-0000?X-Amz-Credential=AK%2F2026%2Fru"
        async with aiohttp.ClientSession() as http:
            await sets.transfer(http, "PUT", url, b"x")
        self.assertEqual(self.storage.raw, ["/bucket/personal%3Aabc/3/chunk-0000?X-Amz-Credential=AK%2F2026%2Fru"])

    async def test_too_few_chunk_urls_is_a_failed_park_not_a_partial_set(self):
        host, _runner, client, _record = await self.started()
        profile = Path(host.config.root) / "sandboxes" / "ws-abc" / "profile"
        (profile / "Default" / "History").write_bytes(random.Random(3).randbytes(300 * 1024))  # > 2 chunks
        body = self.park_body()
        body["upload"]["chunkUrls"] = body["upload"]["chunkUrls"][:2]
        status, answer = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", body)
        self.assertEqual(status, 502)
        self.assertIn("chunk URLs", answer["error"])
        self.assertEqual(self.storage.objects, {})

    async def test_links_and_special_files_never_travel(self):
        host, _runner, client, _record = await self.started()
        profile = Path(host.config.root) / "sandboxes" / "ws-abc" / "profile"
        (profile / "SingletonSocket").symlink_to("/tmp/.org.chromium.Chromium.x/SingletonSocket")
        (profile / "Escape").symlink_to("../../../../etc")
        (profile / "SingletonLock").symlink_to("bro-sandbox-42")
        (profile / "Default" / "Hard").hardlink_to(profile / "Default" / "Cookies")
        os.mkfifo(profile / "Default" / "Pipe")  # a sandbox's FIFO once made every later restore fail
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body()))[0], 200)
        other, _runner, client = await self.host("b")
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual(status, 201, record)
        restored = Path(other.config.root) / "sandboxes" / "ws-abc" / "profile"
        self.assertEqual(sorted(p.name for p in restored.iterdir()), ["Default"])
        self.assertEqual(sorted(p.name for p in (restored / "Default").iterdir()), ["Cookies", "Hard"])
        self.assertFalse((restored / "Default" / "Hard").is_symlink())
        self.assertEqual(self.profile_on(other), MARKER)

    async def test_a_cold_set_fetches_the_profile_alone(self):
        _runner, parked = await self.parked_set()
        self.storage.gets.clear()
        host, runner, client = await self.host("b")
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body("profile"))
        self.assertEqual((status, record["path"]), (201, "cold"))
        self.assertEqual(len(self.storage.gets), 1 + parked["parts"]["profile"]["chunks"])
        self.assertEqual(self.profile_on(host), MARKER)

    async def test_a_tampered_chunk_fails_the_start_and_leaves_nothing(self):
        await self.parked_set()
        key = "ws/3/chunk-0000"
        data = self.storage.objects[key]
        self.storage.objects[key] = data[:-1] + bytes([data[-1] ^ 1])
        host, runner, client = await self.host("b")
        status, answer = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual(status, 502)
        self.assertIn("checksum", answer["error"])
        self.assertFalse((Path(host.config.root) / "sandboxes" / "ws-abc").exists())
        self.assertEqual(runner.runtime_calls("restore") + runner.runtime_calls("create"), [])

    async def test_a_set_of_another_workspace_or_a_newer_generation_is_refused(self):
        await self.parked_set()
        _host, _runner, client = await self.host("b")
        body = self.restore_body()
        body["workspace"] = "personal:other"
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", body))[0], 409)
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", self.restore_body(generation=2)))[0], 409)
        # The same generation too: its park would overwrite the chunks of the set it came from.
        _host, _runner, client = await self.host("c")
        status, answer = await self.call(client, "POST", "/v1/sandboxes", self.restore_body(generation=3))
        self.assertEqual((status, answer["setGeneration"]), (409, 3))

    async def test_a_wrong_data_key_does_not_open_the_set(self):
        await self.parked_set()
        _host, _runner, client = await self.host("b")
        body = self.restore_body()
        body["restore"]["dataKey"] = "33" * 32
        status, answer = await self.call(client, "POST", "/v1/sandboxes", body)
        self.assertEqual(status, 502)
        self.assertIn("manifest does not verify", answer["error"])


class GvisorParkTest(ParkTest):
    """runsc: the park freezes the sandbox, and a restore brings its memory back."""

    RUNTIME = "runsc"

    async def test_park_uploads_encrypted_chunks_in_parallel_and_the_manifest_last(self):
        host, runner, client, _record = await self.started()
        status, parked = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual(status, 200, parked)
        self.assertEqual(parked["state"], "parked")
        self.assertEqual(parked["format"], {"runsc": "runsc version release-20260914.0", "cpu": host.cpu["features"],
                                            "rootfs": "v1", "memoryMb": 2048})
        self.assertEqual(set(parked["parts"]), {"profile", "image"})
        self.assertGreater(parked["parts"]["image"]["chunks"], 3)
        self.assertEqual(set(parked["timings"]), {"checkpointMs", "packMs", "uploadMs", "totalMs"})
        self.assertEqual(self.storage.puts[-1], "ws/3/manifest.json")
        self.assertEqual(len(self.storage.puts), parked["chunks"] + 1)
        self.assertGreaterEqual(self.storage.most_in_flight, 2)
        for key, data in self.storage.objects.items():
            self.assertNotIn(MARKER, data, key)
            self.assertNotIn(runner.image_bytes[:64], data, key)
        (checkpoint, _), = runner.runtime_calls("checkpoint")
        self.assertIn(f"--image-path={host.config.shm}/bro-ws-abc", checkpoint)
        self.assertFalse((Path(host.config.root) / "sandboxes" / "ws-abc").exists())
        self.assertEqual(sorted(Path(host.config.shm).iterdir()), [])
        self.assertNotIn("/g/ws-abc/", runner.caddyfiles[-1])
        status, record = await self.call(client, "GET", "/v1/sandboxes/ws-abc")
        self.assertEqual((status, record["state"]), (200, "parked"))
        # A retried park that already succeeded answers the same.
        self.assertEqual(await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body()), (200, parked))

    async def test_a_failed_upload_writes_no_manifest_and_brings_the_sandbox_back(self):
        _host, runner, client, _record = await self.started()
        self.storage.fail = {"ws/3/chunk-0002"}
        status, answer = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual((status, answer["restoredLocally"]), (502, True))
        self.assertNotIn("ws/3/manifest.json", self.storage.objects)
        self.assertEqual(runner.restored, runner.checkpointed)
        self.assertEqual((await self.call(client, "GET", "/v1/sandboxes/ws-abc"))[1]["state"], "running")
        # The frozen sandbox had taken its eth0 over: the namespaces were built again before the restore.
        self.assertEqual(runner.argv("ip").count(["ip", "netns", "add", "bro-s-ws-abc"]), 2)
        self.assertEqual(sorted(Path(_host.config.shm).iterdir()), [])

    async def test_a_failed_checkpoint_leaves_no_image_in_memory(self):
        host, runner, client, _record = await self.started()
        runner.fail_checkpoint = True
        runner.containers["bro-ws-abc"] = "running"
        status, answer = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual((status, answer["error"]), (502, "runsc checkpoint failed"))
        self.assertEqual(sorted(Path(host.config.shm).iterdir()), [])
        self.assertEqual((await self.call(client, "GET", "/v1/sandboxes/ws-abc"))[1]["state"], "running")
        self.assertEqual(self.storage.objects, {})

    async def test_restore_on_another_host(self):
        first, _parked = await self.parked_set()
        host, runner, client = await self.host("b")
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual((status, record["path"], record["generation"]), (201, "restored", 4), record)
        self.assertEqual(self.profile_on(host), MARKER)
        self.assertEqual(runner.restored, first.checkpointed)  # the same memory image came back
        (restore, log), = runner.runtime_calls("restore")
        home = Path(host.config.root) / "sandboxes" / "ws-abc"
        self.assertIn("--detach", restore)
        self.assertIn(f"--bundle={home / 'bundle'}", restore)
        self.assertEqual(log, home / "runtime.log")
        self.assertEqual(runner.runtime_calls("create"), [])
        bundle = json.loads((home / "bundle" / "config.json").read_text())
        self.assertIn({"type": "network", "path": "/var/run/netns/bro-s-ws-abc"}, bundle["linux"]["namespaces"])
        self.assertFalse((Path(host.config.shm) / "bro-ws-abc").exists())
        self.assertGreaterEqual(len([k for k in self.storage.gets if "chunk" in k]), 4)

    async def test_a_restore_runsc_refuses_starts_cold_with_the_profile(self):
        await self.parked_set()
        host, runner, client = await self.host("b")
        runner.fail_restore = True
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual((status, record["path"], record["fallback"]), (201, "cold", "runsc restore failed"))
        self.assertEqual(self.profile_on(host), MARKER)
        self.assertEqual(len(runner.runtime_calls("create")), 1)
        self.assertEqual(runner.argv("ip").count(["ip", "netns", "add", "bro-s-ws-abc"]), 2)
        self.assertEqual(sorted(Path(host.config.shm).iterdir()), [])
        self.assertFalse((Path(host.config.root) / "staging" / "ws-abc").exists())

    async def test_a_snapshot_on_another_rootfs_starts_cold(self):
        await self.parked_set()
        host, runner, client = await self.host("b", versions=("v1", "v2"))
        status, record = await self.call(client, "POST", "/v1/sandboxes", {**self.restore_body(), "rootfsVersion": "v2"})
        self.assertEqual((status, record["path"]), (201, "cold"))
        self.assertIn("rootfs v1", record["fallback"])
        self.assertEqual(runner.runtime_calls("restore"), [])
        self.assertEqual(self.profile_on(host), MARKER)

    async def test_a_snapshot_from_other_cpu_features_is_not_even_tried(self):
        await self.parked_set()
        host, runner, client = await self.host("b")
        host.cpu = {"model": "Other CPU", "features": "0123456789abcdef"}
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual((status, record["path"]), (201, "cold"))
        self.assertIn("CPU", record["fallback"])
        self.assertEqual(runner.runtime_calls("restore"), [])
        self.assertEqual(self.profile_on(host), MARKER)


class GvisorSandboxTest(SandboxTest):
    """The same sandbox contract under runsc."""

    RUNTIME = "runsc"

    async def test_gvisor_overlays_the_rootfs_itself(self):
        host, runner, client = await self.host()
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request()))[0], 201)
        bundle = json.loads((Path(host.config.root) / "sandboxes" / "ws-abc" / "bundle" / "config.json").read_text())
        self.assertEqual(bundle["root"], {"path": str(Path(host.config.root) / "rootfs" / "v1"), "readonly": False})
        (create, _log), = runner.runtime_calls("create")
        self.assertIn("--overlay2=root:memory", create)
        self.assertIn("--platform=systrap", create)
        home = Path(host.config.root) / "sandboxes" / "ws-abc"
        self.assertEqual(runner.argv("mount"), [["/usr/bin/mount", "-o", "loop,nodev,nosuid",
                                                 str(home / "profile.img"), str(home / "profile")]])
        self.assertNotIn({"type": "cgroup"}, bundle["linux"]["namespaces"])


class RuncSandboxTest(HostTest):
    """What a plain container needs that gVisor gave by itself."""

    async def test_the_root_is_an_overlay_on_a_tmpfs_of_its_own(self):
        host, runner, client = await self.host(overlay_mb=1500)
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request()))[0], 201)
        home = Path(host.config.root) / "sandboxes" / "ws-abc"
        rootfs = Path(host.config.root) / "rootfs" / "v1"
        _profile, tmpfs, overlay = runner.argv("mount")
        self.assertEqual(tmpfs, ["/usr/bin/mount", "-t", "tmpfs", "-o", "size=1500m,mode=0755", "tmpfs",
                                 str(home / "overlay")])
        self.assertEqual(overlay, ["/usr/bin/mount", "-t", "overlay", "overlay", "-o",
                                   f"lowerdir={rootfs},upperdir={home / 'overlay' / 'upper'},"
                                   f"workdir={home / 'overlay' / 'work'}", str(home / "root")])
        bundle = json.loads((home / "bundle" / "config.json").read_text())
        self.assertEqual(bundle["root"], {"path": str(home / "root"), "readonly": False})
        linux = bundle["linux"]
        self.assertIn({"type": "cgroup"}, linux["namespaces"])
        self.assertIn("/proc/kcore", linux["maskedPaths"])
        self.assertIn("/proc/sys", linux["readonlyPaths"])
        self.assertEqual(linux["resources"]["devices"], [{"allow": False, "access": "rwm"}])
        self.assertEqual(linux["cgroupsPath"], "/bro-sandboxes/ws-abc")
        # seccomp.json: everything but the escape routes; Chrome's own sandbox keeps its user namespace.
        self.assertEqual(linux["seccomp"], json.loads((Path(hostd.__file__).parent / "seccomp.json").read_text()))
        self.assertEqual(linux["resources"]["cpu"], {"quota": 200_000, "period": 100_000})
        capabilities = bundle["process"]["capabilities"]["bounding"]
        for missing in ("CAP_SYS_ADMIN", "CAP_MKNOD", "CAP_NET_RAW"):
            self.assertNotIn(missing, capabilities)
        self.assertEqual(bundle["process"]["oomScoreAdj"], 200)
        (create, _log), = runner.runtime_calls("create")
        self.assertEqual(create[:3], ["/usr/sbin/runc", f"--root={host.config.runc_root}", "create"])

    async def test_delete_unmounts_the_root_before_the_host_dir_goes(self):
        host, runner, client, _record = await self.started()
        home = Path(host.config.root) / "sandboxes" / "ws-abc"
        self.assertEqual(runner.mounted, {str(home / "profile"), str(home / "overlay"), str(home / "root")})
        self.assertEqual((await self.call(client, "DELETE", "/v1/sandboxes/ws-abc?generation=3"))[0], 200)
        self.assertEqual(runner.mounted, set())
        unmounted = [argv[-1] for argv in runner.argv("umount")]
        self.assertLess(unmounted.index(str(home / "root")), unmounted.index(str(home / "overlay")))
        self.assertIn(str(home / "profile"), unmounted)
        self.assertFalse(home.exists())

    async def test_a_configured_seccomp_profile_goes_into_the_bundle(self):
        profile = {"defaultAction": "SCMP_ACT_ERRNO", "syscalls": [{"names": ["read"], "action": "SCMP_ACT_ALLOW"}]}
        path = self.tmp / "seccomp.json"
        path.write_text(json.dumps(profile))
        host, _runner, client = await self.host(seccomp_profile=str(path))
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request()))[0], 201)
        bundle = json.loads((Path(host.config.root) / "sandboxes" / "ws-abc" / "bundle" / "config.json").read_text())
        self.assertEqual(bundle["linux"]["seccomp"], profile)

    def test_the_shipped_seccomp_profile_refuses_the_escape_routes_and_keeps_user_namespaces(self):
        profile = json.loads((Path(hostd.__file__).parent / "seccomp.json").read_text())
        self.assertEqual((profile["defaultAction"], profile["architectures"]), ("SCMP_ACT_ALLOW", ["SCMP_ARCH_X86_64"]))
        refused = {name for rule in profile["syscalls"] if not rule.get("args") for name in rule["names"]}
        for name in ("keyctl", "add_key", "request_key", "bpf", "userfaultfd", "mount", "umount2", "fsopen",
                     "open_tree", "move_mount", "pivot_root", "setns", "io_uring_setup", "init_module", "kexec_load",
                     "open_by_handle_at", "perf_event_open"):
            self.assertIn(name, refused)
        for name in ("clone", "clone3", "unshare", "chroot", "seccomp", "prctl", "ptrace"):
            self.assertNotIn(name, refused)  # Chrome's sandbox and crash handler
        sockets = [rule["args"] for rule in profile["syscalls"] if rule["names"] == ["socket"]]
        self.assertIn([{"index": 0, "value": 17, "op": "SCMP_CMP_EQ"}], sockets)  # AF_PACKET
        self.assertIn([{"index": 0, "value": 16, "op": "SCMP_CMP_EQ"}, {"index": 2, "value": 12, "op": "SCMP_CMP_EQ"}],
                      sockets)  # NETLINK_NETFILTER

    async def test_no_seccomp_and_no_cpu_quota_only_when_configured_so(self):
        host, _runner, client = await self.host(seccomp_profile="", cpus=0)
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request()))[0], 201)
        bundle = json.loads((Path(host.config.root) / "sandboxes" / "ws-abc" / "bundle" / "config.json").read_text())
        self.assertNotIn("seccomp", bundle["linux"])
        self.assertNotIn("cpu", bundle["linux"]["resources"])

    async def test_the_profile_lives_on_an_image_of_its_own_size(self):
        host, runner, client = await self.host(profile_mb=512)
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request()))[0], 201)
        home = Path(host.config.root) / "sandboxes" / "ws-abc"
        self.assertEqual(runner.argv("mkfs.ext4"), [["/usr/sbin/mkfs.ext4", "-q", "-F", "-m", "0", "-E",
                                                     "lazy_itable_init=1,nodiscard", str(home / "profile.img")]])
        self.assertEqual((home / "profile.img").stat().st_size, 512 * 2**20)
        self.assertLess((home / "profile.img").stat().st_blocks * 512, 2**20)  # sparse
        self.assertEqual(runner.argv("mount")[0], ["/usr/bin/mount", "-o", "loop,nodev,nosuid",
                                                   str(home / "profile.img"), str(home / "profile")])
        plain, runner, client = await self.host("b", profile_mb=0)
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request()))[0], 201)
        self.assertEqual(runner.argv("mkfs.ext4"), [])

    async def test_the_host_table_is_written_again_on_its_own(self):
        _host, runner, client = await self.host(rules_every_s=0.05)
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request()))[0], 201)
        written = len(runner.host_rules)
        await asyncio.sleep(0.3)
        self.assertGreater(len(runner.host_rules), written)
        self.assertIn('iifname "brt0" ip saddr != 127.0.0.2 drop', runner.host_rules[-1])  # with the live sandbox

    def test_stand_ports_never_open_hostd_ssh_or_caddy(self):
        for port in (22, 80, 443, 2019, 8090):
            with self.subTest(port), self.assertRaises(ValueError):
                hostd.Config(stand_host_ports=(port,))
        self.assertEqual(hostd.Config(stand_host_ports=(3130,)).stand_host_ports, (3130,))

    async def test_memory_comes_from_the_config_when_the_request_names_none(self):
        host, _runner, client = await self.host(memory_mb=3072)
        body = request()
        del body["memoryMb"]
        status, record = await self.call(client, "POST", "/v1/sandboxes", body)
        self.assertEqual((status, record["memoryMb"]), (201, 3072))
        bundle = json.loads((Path(host.config.root) / "sandboxes" / "ws-abc" / "bundle" / "config.json").read_text())
        self.assertEqual(bundle["linux"]["resources"]["memory"]["limit"], 3072 * 2**20)

    def test_only_known_runtimes(self):
        with self.assertRaises(ValueError):
            hostd.Config(runtime="docker")
        self.assertEqual(hostd.Config().runtime, "runc")


class StoppedParkTest(HostTest):
    """runc: the park stops Chrome gracefully and keeps the profile alone; a restore is a fresh start."""

    async def test_park_stops_chrome_gracefully_and_uploads_the_profile_alone(self):
        host, runner, client, _record = await self.started()
        profile = Path(host.config.root) / "sandboxes" / "ws-abc" / "profile"
        puts_at_delete = []
        # What Chrome writes as it stops must be in the set: the profile is packed after the stop, and
        # nothing is uploaded before the container is gone.
        runner.on_term = lambda _c: (profile / "Default" / "Cookies-at-stop").write_bytes(b"flushed at exit")
        runner.on_delete = lambda _c: puts_at_delete.append(len(self.storage.puts))
        status, parked = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual(status, 200, parked)
        self.assertEqual((parked["state"], parked["runtime"], parked["format"]), ("parked", "runc", None))
        self.assertEqual(set(parked["parts"]), {"profile"})
        self.assertEqual(set(parked["timings"]), {"stopMs", "chromeStop", "packMs", "uploadMs", "totalMs"})
        self.assertEqual(parked["timings"]["chromeStop"], "sigterm")
        self.assertEqual(runner.signals, [("bro-ws-abc", "SIGTERM")])  # to the init; nothing runs inside
        self.assertEqual(runner.runtime_calls("exec"), [])
        self.assertEqual(puts_at_delete[0], 0)
        self.assertEqual(runner.runtime_calls("checkpoint"), [])
        self.assertEqual(self.storage.puts[-1], "ws/3/manifest.json")
        manifest = json.loads(self.storage.objects["ws/3/manifest.json"])
        self.assertEqual((manifest["runtime"], manifest["snapshot"]), ("runc", None))
        for key, data in self.storage.objects.items():
            self.assertNotIn(MARKER, data, key)
        self.assertEqual(runner.mounted, set())
        self.assertFalse((Path(host.config.root) / "sandboxes" / "ws-abc").exists())
        self.assertNotIn("/g/ws-abc/", runner.caddyfiles[-1])
        self.assertEqual(await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body()), (200, parked))
        other, _runner, client = await self.host("b")
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", self.restore_body()))[0], 201)
        restored = Path(other.config.root) / "sandboxes" / "ws-abc" / "profile" / "Default" / "Cookies-at-stop"
        self.assertEqual(restored.read_bytes(), b"flushed at exit")

    async def test_a_chrome_the_init_had_to_kill_is_reported(self):
        host, runner, client, _record = await self.started()
        log = Path(host.config.root) / "sandboxes" / "ws-abc" / "runtime.log"
        with open(log, "ab") as sink:
            sink.write(b"bro-sandbox-init: bro-chrome killed: an older stop, before this park\n")
        host.config.log_max_bytes = 10**9

        def hung(_container):
            with open(log, "ab") as sink:
                sink.write(b"bro-sandbox-init: bro-worker stopped\n"
                           b"bro-sandbox-init: bro-chrome killed: still running 30 s after SIGTERM\n")

        runner.on_term = hung
        status, parked = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual((status, parked["timings"]["chromeStop"]), (200, "killed"))

    async def test_an_older_kill_in_the_log_does_not_count(self):
        host, runner, client, _record = await self.started()
        log = Path(host.config.root) / "sandboxes" / "ws-abc" / "runtime.log"
        with open(log, "ab") as sink:
            sink.write(b"bro-sandbox-init: bro-chrome killed: an older stop, before this park\n")
        status, parked = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual((status, parked["timings"]["chromeStop"]), (200, "sigterm"))

    async def test_a_sandbox_that_outlives_sigterm_is_killed_and_parked_never_running_again(self):
        host, runner, client, _record = await self.started()
        host.config.chrome_stop_timeout_s = 0.3
        runner.ignore_term = True
        states = []
        runner.on_delete = lambda _c: states.append(host.sandboxes["ws-abc"]["state"])
        status, parked = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual((status, parked["timings"]["chromeStop"]), (200, "killed"), parked)
        self.assertEqual(runner.signals, [("bro-ws-abc", "SIGTERM"), ("bro-ws-abc", "SIGKILL")])
        self.assertEqual(states[0], "parking")
        self.assertIn("ws/3/manifest.json", self.storage.objects)

    async def test_a_sandbox_already_gone_is_parked_as_killed(self):
        _host, runner, client, _record = await self.started()
        runner.fail_kill = True
        status, parked = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual((status, parked["timings"]["chromeStop"]), (200, "killed"))

    async def test_a_failed_upload_starts_the_same_sandbox_again_here(self):
        host, runner, client, _record = await self.started()
        self.storage.fail = {"ws/3/chunk-0000"}
        status, answer = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual((status, answer["restoredLocally"]), (502, True))
        self.assertNotIn("ws/3/manifest.json", self.storage.objects)
        self.assertEqual((await self.call(client, "GET", "/v1/sandboxes/ws-abc"))[1]["state"], "running")
        self.assertEqual(len(runner.runtime_calls("create")), 2)
        self.assertEqual(runner.argv("ip").count(["ip", "netns", "add", "bro-s-ws-abc"]), 2)  # a fresh netns
        self.assertEqual(self.profile_on(host), MARKER)

    async def test_restore_elsewhere_is_a_fresh_start_with_the_profile(self):
        await self.parked_set()
        host, runner, client = await self.host("b")
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual((status, record["path"], record["generation"]), (201, "cold", 4), record)
        self.assertIn("runc keeps no memory snapshots", record["fallback"])
        self.assertEqual(self.profile_on(host), MARKER)
        self.assertEqual(runner.runtime_calls("restore"), [])
        self.assertEqual(len(runner.runtime_calls("create")), 1)

    async def test_a_gvisor_set_comes_back_on_runc_with_its_profile_alone(self):
        gvisor, _runner, client = await self.host("a", runtime="runsc")
        status, record = await self.call(client, "POST", "/v1/sandboxes", request())
        self.assertEqual(status, 201, record)
        profile = Path(gvisor.config.root) / "sandboxes" / "ws-abc" / "profile"
        (profile / "Default").mkdir()
        (profile / "Default" / "Cookies").write_bytes(MARKER)
        status, parked = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual((status, set(parked["parts"])), (200, {"profile", "image"}))
        self.storage.gets.clear()
        host, runner, client = await self.host("b")
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual((status, record["path"]), (201, "cold"))
        self.assertEqual(len(self.storage.gets), 1 + parked["parts"]["profile"]["chunks"])  # no image chunk
        self.assertEqual(self.profile_on(host), MARKER)

    async def test_a_runc_set_starts_cold_on_a_gvisor_host(self):
        await self.parked_set()
        host, runner, client = await self.host("b", runtime="runsc")
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual((status, record["path"], record["fallback"]), (201, "cold", "the set has no snapshot"))
        self.assertEqual(runner.runtime_calls("restore"), [])
        self.assertEqual(self.profile_on(host), MARKER)


if __name__ == "__main__":
    unittest.main()
