"""hostd tests: cd browser-vm/host && python -m unittest (needs aiohttp and cryptography; no root).

runsc, ip, nft, zstd and caddy are a fake runner (records argv, writes a fake checkpoint image, can refuse a
restore); Object Storage is an aiohttp server behind "presigned" URLs; the sandbox's worker is an aiohttp
server the transit addresses reach (the transit pool is put on 127.0.0.0/16 for the tests).
"""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import random
import sys
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


class FakeRunner:
    """runsc, ip, nft, zstd and caddy as the host would run them."""

    def __init__(self, version="runsc version release-20260914.0"):
        self.version = version
        self.calls = []
        self.containers = {}
        self.fail_restore = False
        self.fail_checkpoint = False
        self.stuck = set()  # containers `runsc delete` cannot remove
        self.host_rules, self.router_rules, self.caddyfiles = [], [], []
        self.checkpointed, self.restored = [], []
        self.image_bytes = random.Random(7).randbytes(300 * 1024)

    def argv(self, tool):
        return [argv for argv, _log in self.calls if Path(argv[0]).name == tool]

    def runsc_calls(self, command):
        return [(argv, log) for argv, log in self.calls if Path(argv[0]).name == "runsc" and command in argv]

    async def run(self, argv, *, log_file=None, timeout=120):
        self.calls.append((list(argv), log_file))
        if log_file is not None:
            with open(log_file, "ab") as sink:  # a file the sandbox keeps, as the real runner gives
                sink.write(b"runsc output\n")
        tool = Path(argv[0]).name
        if tool == "runsc":
            return self.runsc(argv[1:])
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

    def runsc(self, args):
        if args == ["--version"]:
            return 0, self.version + "\nspec: 1.1.0\n"
        flags = [a for a in args if a.startswith("--")]
        words = [a for a in args if not a.startswith("--")]
        command, container = words[0], words[-1]
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
        elif command == "delete":
            if container in self.stuck:
                return 124, "runsc timed out after 60 s"
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
    async def asyncSetUp(self):
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
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
            "root": str(root), "shm": str(root / "shm"), "runsc": "/usr/bin/runsc",
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
        self.assertEqual((status, health["runsc"]), (200, "runsc version release-20260914.0"))
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
        self.assertEqual(runner.runsc_calls("create"), [])

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
        self.assertEqual(bundle["root"], {"path": str(Path(host.config.root) / "rootfs" / "v1"), "readonly": False})
        self.assertEqual(bundle["process"]["args"], ["/usr/local/sbin/bro-sandbox-init"])
        self.assertIn("BRO_WORKER_BIND=0.0.0.0", bundle["process"]["env"])
        mounts = {m["destination"]: m for m in bundle["mounts"]}
        self.assertEqual((mounts["/var/lib/bro/profile"]["source"], mounts["/var/lib/bro/profile"]["options"]),
                         (str(home / "profile"), ["rbind", "rw"]))
        self.assertEqual(mounts["/etc/bro/worker.json"]["options"], ["rbind", "ro"])
        self.assertEqual(mounts["/etc/resolv.conf"]["source"], str(home / "resolv.conf"))
        self.assertIn({"type": "network", "path": "/var/run/netns/bro-s-ws-abc"}, bundle["linux"]["namespaces"])
        self.assertEqual(bundle["linux"]["resources"]["memory"]["limit"], 2048 * 2**20)
        (create, log), = runner.runsc_calls("create")
        self.assertIn("--overlay2=root:memory", create)
        self.assertIn("--platform=systrap", create)
        self.assertEqual(log, home / "runsc.log")  # stdio to a file, never a pipe
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
        self.assertIn('iifname "brt*" ip daddr @blocked drop', rules)
        self.assertIn('iifname "brt*" oifname "eth0" accept', rules)
        self.assertIn('oifname "brt*" drop', rules)  # nothing opens a connection into a sandbox but the host
        self.assertIn("\t\tiifname \"brt*\" drop\n\t}\n\tchain forward", rules)  # no port of the host
        self.assertIn('oifname "eth0" ip saddr 127.0.0.0/16 masquerade', rules)
        self.assertIn("dnat to 192.168.254.2", runner.router_rules[-1])
        caddyfile = runner.caddyfiles[-1]
        self.assertIn("admin unix//run/caddy/admin.sock", caddyfile)
        self.assertIn("203-0-113-7.sslip.io {", caddyfile)
        self.assertIn(f"handle_path /g/ws-abc/* {{\n\t\treverse_proxy 127.0.0.2:{self.worker_port}", caddyfile)
        self.assertIn(f"handle_path /g/ws-def/* {{\n\t\treverse_proxy 127.0.0.6:{self.worker_port}", caddyfile)
        self.assertIn("handle_path /h/* {\n\t\treverse_proxy 127.0.0.1:8090", caddyfile)

    async def test_generation_rules(self):
        _host, runner, client = await self.host()
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes", request()))[0], 201)
        status, again = await self.call(client, "POST", "/v1/sandboxes", request())
        self.assertEqual((status, again["path"]), (200, "fresh"))
        self.assertEqual(len(runner.runsc_calls("create")), 1)
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
        self.assertEqual(capacity["snapshotFormat"]["runsc"], "runsc version release-20260914.0")
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

    async def test_a_sandbox_runsc_cannot_delete_keeps_its_record(self):
        host, runner, client, _record = await self.started()
        runner.stuck.add("bro-ws-abc")
        status, answer = await self.call(client, "DELETE", "/v1/sandboxes/ws-abc?generation=3")
        self.assertEqual((status, answer["error"]), (502, "runsc could not delete the sandbox"))
        self.assertTrue((Path(host.config.root) / "sandboxes" / "ws-abc" / "profile").exists())
        self.assertNotIn(["ip", "netns", "del", "bro-s-ws-abc"], runner.argv("ip"))
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
        self.assertEqual(runner.runsc_calls("create"), [])

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
        log = Path(host.config.root) / "sandboxes" / "ws-abc" / "runsc.log"
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
        (checkpoint, _), = runner.runsc_calls("checkpoint")
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

    async def test_urls_go_out_exactly_as_presigned(self):
        _host, _runner, _client = await self.host()
        url = str(self.s3.make_url("/bucket/")) + "personal%3Aabc/3/chunk-0000?X-Amz-Credential=AK%2F2026%2Fru"
        async with aiohttp.ClientSession() as http:
            await sets.transfer(http, "PUT", url, b"x")
        self.assertEqual(self.storage.raw, ["/bucket/personal%3Aabc/3/chunk-0000?X-Amz-Credential=AK%2F2026%2Fru"])

    async def test_too_few_chunk_urls_is_a_failed_park_not_a_partial_set(self):
        _host, _runner, client, _record = await self.started()
        body = self.park_body()
        body["upload"]["chunkUrls"] = body["upload"]["chunkUrls"][:2]
        status, answer = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", body)
        self.assertEqual(status, 502)
        self.assertIn("chunk URLs", answer["error"])
        self.assertEqual(self.storage.objects, {})

    async def parked_set(self):
        host, runner, client, _record = await self.started()
        status, parked = await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body())
        self.assertEqual(status, 200, parked)
        return runner, parked

    def restore_body(self, kind="restore", generation=4):
        return request(generation=generation, **{kind: {**self.set_urls(3), "dataKey": DATA_KEY}})

    def profile_on(self, host):
        return (Path(host.config.root) / "sandboxes" / "ws-abc" / "profile" / "Default" / "Cookies").read_bytes()

    async def test_restore_on_another_host(self):
        first, _parked = await self.parked_set()
        host, runner, client = await self.host("b")
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual((status, record["path"], record["generation"]), (201, "restored", 4), record)
        self.assertEqual(self.profile_on(host), MARKER)
        self.assertEqual(runner.restored, first.checkpointed)  # the same memory image came back
        (restore, log), = runner.runsc_calls("restore")
        home = Path(host.config.root) / "sandboxes" / "ws-abc"
        self.assertIn("--detach", restore)
        self.assertIn(f"--bundle={home / 'bundle'}", restore)
        self.assertEqual(log, home / "runsc.log")
        self.assertEqual(runner.runsc_calls("create"), [])
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
        self.assertEqual(len(runner.runsc_calls("create")), 1)
        self.assertEqual(runner.argv("ip").count(["ip", "netns", "add", "bro-s-ws-abc"]), 2)
        self.assertEqual(sorted(Path(host.config.shm).iterdir()), [])
        self.assertFalse((Path(host.config.root) / "staging" / "ws-abc").exists())

    async def test_a_snapshot_on_another_rootfs_starts_cold(self):
        await self.parked_set()
        host, runner, client = await self.host("b", versions=("v1", "v2"))
        status, record = await self.call(client, "POST", "/v1/sandboxes", {**self.restore_body(), "rootfsVersion": "v2"})
        self.assertEqual((status, record["path"]), (201, "cold"))
        self.assertIn("rootfs v1", record["fallback"])
        self.assertEqual(runner.runsc_calls("restore"), [])
        self.assertEqual(self.profile_on(host), MARKER)

    async def test_links_out_of_the_profile_are_left_behind(self):
        host, _runner, client, _record = await self.started()
        profile = Path(host.config.root) / "sandboxes" / "ws-abc" / "profile"
        (profile / "SingletonSocket").symlink_to("/tmp/.org.chromium.Chromium.x/SingletonSocket")
        (profile / "Escape").symlink_to("../../../../etc")
        (profile / "SingletonLock").symlink_to("bro-sandbox-42")
        self.assertEqual((await self.call(client, "POST", "/v1/sandboxes/ws-abc/park", self.park_body()))[0], 200)
        other, _runner, client = await self.host("b")
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual(status, 201, record)
        restored = Path(other.config.root) / "sandboxes" / "ws-abc" / "profile"
        self.assertEqual(sorted(p.name for p in restored.iterdir()), ["Default", "SingletonLock"])
        self.assertEqual(self.profile_on(other), MARKER)

    async def test_a_snapshot_from_other_cpu_features_is_not_even_tried(self):
        await self.parked_set()
        host, runner, client = await self.host("b")
        host.cpu = {"model": "Other CPU", "features": "0123456789abcdef"}
        status, record = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual((status, record["path"]), (201, "cold"))
        self.assertIn("CPU", record["fallback"])
        self.assertEqual(runner.runsc_calls("restore"), [])
        self.assertEqual(self.profile_on(host), MARKER)

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
        key = "ws/3/chunk-0001"
        data = self.storage.objects[key]
        self.storage.objects[key] = data[:-1] + bytes([data[-1] ^ 1])
        host, runner, client = await self.host("b")
        status, answer = await self.call(client, "POST", "/v1/sandboxes", self.restore_body())
        self.assertEqual(status, 502)
        self.assertIn("checksum", answer["error"])
        self.assertFalse((Path(host.config.root) / "sandboxes" / "ws-abc").exists())
        self.assertEqual(runner.runsc_calls("restore") + runner.runsc_calls("create"), [])

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


if __name__ == "__main__":
    unittest.main()
