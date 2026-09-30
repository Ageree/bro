"""Bro browser host daemon: runs people's browsers as gVisor sandboxes on one Cloud.ru VM (127.0.0.1:8090,
behind Caddy at /h/). Plan: docs/browser-pool.md.

A sandbox is one workspace's browser: the shared read-only rootfs (`<root>/rootfs/<version>/`, Chrome in
Xvfb, the worker; its PID 1 is /usr/local/sbin/bro-sandbox-init) under `runsc --overlay2=root:memory
--platform=systrap`, in a network namespace of its own (network.py). Everything of one sandbox on the
host lives under `<root>/sandboxes/<id>/`:

  profile/       bind-mounted read-write at /var/lib/bro/profile (the Chrome profile: sign-ins)
  worker.json    bind-mounted read-only at /etc/bro/worker.json ({"environment", "key"}, 0600, never logged)
  resolv.conf    bind-mounted read-only at /etc/resolv.conf (public resolvers, not 127.0.0.53)
  bundle/        the OCI config.json, the same paths on every host so a snapshot restores anywhere
  runsc.log      stdout and stderr of runsc: always a file, never a pipe (a restored sandbox keeps its
                 stdio, and a pipe reader would wait forever)
  router.nft     the router namespace's ruleset
  sandbox.json   the record hostd keeps (no secrets)

Parking freezes a sandbox (`runsc checkpoint` into /dev/shm/bro-<id>: only the image itself is in RAM),
packs its profile and the image in `<root>/staging/<id>/` on disk, compresses (zstd), encrypts and uploads
them as a set (sets.py) over URLs Bro presigned; restoring reverses that and falls back to a cold start with
the profile alone when the snapshot does not fit (other runsc, other CPU features, another rootfs, less
memory, no room in /dev/shm, runsc refusing it). hostd decides nothing about people: Bro chooses hosts, and
before a park Bro has already told the worker to drop its secrets (worker POST /v1/park).

Auth: `Authorization: Bearer v1.<payload>.<sig>`, the worker's token format with the host's key
(HMAC-SHA256(BROWSER_VM_SIGNING_KEY, "bro-browser-host:" + host id), delivered once in /etc/bro/host.json)
and the payload {"env": <host id>, "exp": <unix seconds>}, at most 15 minutes ahead.

Routes (all but /v1/health need a token):
  GET    /v1/health                     version, runsc version, boot stage
  GET    /v1/capacity                   memory, /dev/shm, sandboxes, CPU model and features, rootfs versions
  POST   /v1/sandboxes                  {id, workspace, generation, memoryMb, workerKey, rootfsVersion,
                                         restore?: {manifestUrl, chunkUrls, dataKey} | profile?: {same}}
                                         fresh start, restore, or cold start; idempotent by id + generation
  GET    /v1/sandboxes/<id>             the record
  DELETE /v1/sandboxes/<id>?generation= stop, wipe its host dir and /dev/shm
  POST   /v1/sandboxes/<id>/park        {generation, dataKey, upload: {chunkUrls, manifestUrl}}
"""

import asyncio
import base64
import contextlib
import dataclasses
import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import tarfile
import time
from pathlib import Path

import aiohttp
from aiohttp import web

import caddy
import network
import sets

VERSION = "2026-09-30.1"
MAX_TOKEN_LIFETIME_S = 900
SANDBOX_ID = re.compile(r"[a-z0-9-]{1,63}")
ROOTFS_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
HEX_KEY = re.compile(r"[0-9a-f]{64}")
# Capabilities of runsc's default spec: the init needs setuid/setgid to drop to the `bro` user. They are
# capabilities inside gVisor's own kernel, not the host's.
CAPABILITIES = ["CAP_AUDIT_WRITE", "CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL",
                "CAP_MKNOD", "CAP_NET_BIND_SERVICE", "CAP_NET_RAW", "CAP_SETFCAP", "CAP_SETGID", "CAP_SETPCAP",
                "CAP_SETUID", "CAP_SYS_CHROOT"]
log = logging.getLogger("bro-hostd")


@dataclasses.dataclass
class Config:
    """Every path and tool of the host, overridable from /etc/bro/hostd.json (same key names)."""

    root: str = "/srv/bro"
    shm: str = "/dev/shm"
    runsc: str = "runsc"
    runsc_root: str = "/run/runsc-bro"
    platform: str = "systrap"
    init: str = "/usr/local/sbin/bro-sandbox-init"
    ip: str = "ip"
    nft: str = "nft"
    zstd: str = "zstd"
    caddy: str = "caddy"
    caddyfile: str = "/etc/caddy/Caddyfile"
    caddy_admin: str = "/run/caddy/admin.sock"
    domain: str = ""
    uplink: str = ""
    transit_pool: str = "172.31.0.0/16"
    dns: tuple = ("77.88.8.8", "1.1.1.1")
    listen_host: str = "127.0.0.1"
    listen_port: int = 8090
    worker_port: int = 8080
    chunk_bytes: int = 16 * 1024 * 1024
    parallel: int = 6
    parallel_parks: int = 2
    # What sandbox memory limits may add up to; 0 = MemTotal less `reserve_mb`.
    memory_limit_mb: int = 0
    reserve_mb: int = 1024
    log_max_bytes: int = 8 * 1024 * 1024
    start_timeout_s: float = 90
    restore_timeout_s: float = 30
    identity_file: str = "/etc/bro/host.json"

    @classmethod
    def load(cls, path):
        try:
            values = json.loads(Path(path).read_text())
        except FileNotFoundError:
            values = {}
        known = {field.name for field in dataclasses.fields(cls)}
        unknown = set(values) - known
        if unknown:
            raise ValueError(f"unknown settings in {path}: {sorted(unknown)}")
        if "dns" in values:
            values["dns"] = tuple(values["dns"])
        return cls(**values)

    @property
    def sandboxes(self):
        return Path(self.root) / "sandboxes"

    @property
    def rootfs(self):
        return Path(self.root) / "rootfs"

    @property
    def staging(self):
        return Path(self.root) / "staging"


def load_identity(path):
    """The host id and key from cloud-init; None on a host that has not got them yet."""
    try:
        data = json.loads(Path(path).read_text())
        return {"host": str(data["host"]), "key": bytes.fromhex(data["key"])}
    except (OSError, ValueError, KeyError):
        return None


# --- Tokens ------------------------------------------------------------------------------------------


class Unauthorized(Exception):
    pass


def unb64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify_token(token, identity, now=None):
    """The payload of a valid host token, or Unauthorized. The worker's format (`verify_token` in
    browser-vm/worker/worker.py) without a generation: fencing is per sandbox, in the request bodies."""
    if identity is None:
        raise Unauthorized("host not configured")
    now = time.time() if now is None else now
    try:
        version, payload_part, signature_part = token.split(".")
    except ValueError:
        raise Unauthorized("malformed token") from None
    if version != "v1":
        raise Unauthorized("unknown token version")
    expected = hmac.new(identity["key"], f"{version}.{payload_part}".encode(), hashlib.sha256).digest()
    try:
        signature = unb64url(signature_part)
        payload = json.loads(unb64url(payload_part))
    except ValueError:
        raise Unauthorized("malformed token") from None
    if not hmac.compare_digest(signature, expected):
        raise Unauthorized("bad signature")
    if not isinstance(payload, dict) or payload.get("env") != identity["host"]:
        raise Unauthorized("token for another host")
    expires = payload.get("exp")
    if not isinstance(expires, (int, float)) or expires <= now or expires > now + MAX_TOKEN_LIFETIME_S:
        raise Unauthorized("expired token")
    return payload


# --- Commands ----------------------------------------------------------------------------------------


class Runner:
    """Every command hostd runs goes through here (tests put a fake in its place)."""

    async def run(self, argv, *, log_file=None, timeout=120):
        """(return code, output). With `log_file` stdout and stderr are appended to that file and the
        output is empty: runsc create and restore leave the sandbox holding them."""
        if log_file is not None:
            with open(log_file, "ab") as sink:
                process = await asyncio.create_subprocess_exec(
                    *argv, stdin=asyncio.subprocess.DEVNULL, stdout=sink, stderr=sink)
        else:
            process = await asyncio.create_subprocess_exec(
                *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT)
        try:
            output, _ = await asyncio.wait_for(process.communicate(), timeout)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
            return 124, f"{argv[0]} timed out after {timeout} s"
        return process.returncode, (output or b"").decode(errors="replace")


class Refused(Exception):
    """An answer other than success: an HTTP status and a JSON body."""

    def __init__(self, status, error, **details):
        super().__init__(error)
        self.status, self.body = status, {"error": error, **details}


# --- Host facts --------------------------------------------------------------------------------------


def cpu_info(text=None):
    """The CPU model and a fingerprint of its features: a snapshot is only restored where they match."""
    if text is None:
        try:
            text = Path("/proc/cpuinfo").read_text()
        except OSError:
            text = ""
    first = text.split("\n\n", 1)[0]
    fields = dict((k.strip(), v.strip()) for k, _, v in (line.partition(":") for line in first.splitlines()) if k)
    flags = sorted(fields.get("flags", "").split())
    return {"model": fields.get("model name", "unknown"),
            "features": hashlib.sha256(" ".join(flags).encode()).hexdigest()[:16]}


def meminfo():
    try:
        rows = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        kib = lambda key: int(rows[key].split()[0])  # noqa: E731
        return {"total": kib("MemTotal") // 1024, "available": kib("MemAvailable") // 1024}
    except (OSError, KeyError, ValueError):
        return None


def bro_owner(rootfs):
    """(uid, gid) of the `bro` user of a rootfs: the profile and worker.json belong to it."""
    with contextlib.suppress(OSError):
        for line in (rootfs / "etc" / "passwd").read_text().splitlines():
            fields = line.split(":")
            if len(fields) > 3 and fields[0] == "bro":
                return int(fields[2]), int(fields[3])
    return None


def pack(source, target):
    """A tar of the directory's contents (Chrome's lock socket and other special files are skipped)."""
    with tarfile.open(target, "w") as tar:
        for child in sorted(Path(source).iterdir()):
            tar.add(child, arcname=child.name)
    return Path(target).stat().st_size


def skip_outward_links(member, target):
    """tarfile's `data` filter (no devices, nothing outside the target, no owners, no setuid bits), except
    that a link pointing out of the target is skipped instead of failing the set: Chrome keeps
    SingletonSocket and SingletonCookie as absolute links into /tmp."""
    try:
        return tarfile.data_filter(member, target)
    except (tarfile.AbsoluteLinkError, tarfile.LinkOutsideDestinationError):
        return None


def unpack(archive, target):
    """Extract a tar hostd packed (blocking: run it in a thread). Files come out owned by hostd."""
    Path(target).mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        tar.extractall(target, filter=skip_outward_links)


def chown_tree(path, owner):
    for directory, names, files in os.walk(path):
        os.lchown(directory, *owner)
        for name in names + files:
            os.lchown(os.path.join(directory, name), *owner)


def free_mb(path):
    try:
        return shutil.disk_usage(path).free // 2**20
    except OSError:
        return None


def remove(path):
    path = Path(path)
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    else:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def ms(started):
    return round((time.monotonic() - started) * 1000)


# --- Sandboxes ---------------------------------------------------------------------------------------


class Paths:
    def __init__(self, config, sandbox_id):
        self.dir = config.sandboxes / sandbox_id
        self.profile = self.dir / "profile"
        self.worker_json = self.dir / "worker.json"
        self.resolv = self.dir / "resolv.conf"
        self.bundle = self.dir / "bundle"
        self.log = self.dir / "runsc.log"
        self.router_rules = self.dir / "router.nft"
        self.record = self.dir / "sandbox.json"
        self.image = Path(config.shm) / f"bro-{sandbox_id}"  # the checkpoint image, the only part in RAM
        self.staging = config.staging / sandbox_id  # tars and their zstd, on disk
        self.container = f"bro-{sandbox_id}"


def valid_id(value):
    if not isinstance(value, str) or not SANDBOX_ID.fullmatch(value):
        raise Refused(400, "sandbox id must match [a-z0-9-]{1,63}")
    return value


def valid_set(value, name):
    if not isinstance(value, dict):
        raise Refused(400, f"{name} must be an object")
    urls = value.get("chunkUrls")
    manifest = value.get("manifestUrl")
    if (not isinstance(urls, list) or not 0 < len(urls) <= 4096
            or not all(isinstance(u, str) and u.startswith(("https://", "http://")) for u in urls)):
        raise Refused(400, f"{name}.chunkUrls must be a list of URLs")
    if not isinstance(manifest, str) or not manifest.startswith(("https://", "http://")):
        raise Refused(400, f"{name}.manifestUrl must be a URL")
    try:
        key = sets.data_key(value.get("dataKey"))
    except ValueError as error:
        raise Refused(400, f"{name}.{error}") from None
    return {"chunkUrls": urls, "manifestUrl": manifest, "key": key}


def generation_of(value):
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise Refused(400, "generation must be a non-negative integer")
    return value


class Host:
    def __init__(self, config, identity, runner=None):
        self.config, self.identity = config, identity
        self.runner = runner or Runner()
        self.network = network.Network(pool=config.transit_pool, worker_port=config.worker_port,
                                       ip=config.ip, nft=config.nft)
        self.sandboxes = {}
        self.locks = {}
        self.shared = asyncio.Lock()  # transit slots, the nftables table, the Caddyfile
        self.parking = asyncio.Semaphore(config.parallel_parks)  # each park holds an image and its staging
        self.housekeeping = None
        self.cpu = cpu_info()
        self.runsc_version = None
        self.uplink = config.uplink or None
        self.http = None

    # Setup ------------------------------------------------------------------------------------------

    def runsc(self, *args):
        c = self.config
        return [c.runsc, f"--root={c.runsc_root}", f"--platform={c.platform}", "--overlay2=root:memory", *args]

    async def start(self):
        self.http = aiohttp.ClientSession()
        code, output = await self.runner.run([self.config.runsc, "--version"])
        self.runsc_version = output.splitlines()[0].strip() if code == 0 and output else None
        if self.uplink is None:
            code, output = await self.runner.run(self.network.uplink_command())
            self.uplink = self.network.uplink_from(output) if code == 0 else None
        self.config.sandboxes.mkdir(parents=True, exist_ok=True)
        for path in sorted(self.config.sandboxes.glob("*/sandbox.json")):
            with contextlib.suppress(OSError, ValueError, KeyError):
                record = json.loads(path.read_text())
                code, output = await self.runner.run(self.runsc("state", Paths(self.config, record["id"]).container))
                alive = code == 0 and json.loads(output or "{}").get("status") == "running"
                if not alive and record.get("state") != "failed":
                    # The host restarted under it: its memory is gone; the profile stays for a DELETE.
                    record.update(state="failed", error="the sandbox was not running when hostd started")
                elif alive and record.get("state") in ("starting", "restoring", "parking"):
                    # hostd died halfway: a worker that answers makes it running again, otherwise it failed.
                    ready = record.get("slot") is not None and await self.worker_ready(
                        record, self.config.restore_timeout_s)
                    record.update(state="running" if ready else "failed",
                                  error=None if ready else f"hostd restarted while the sandbox was {record['state']}")
                path.write_text(json.dumps(record))
                self.sandboxes[record["id"]] = record
        await self.apply(strict=False)
        self.housekeeping = asyncio.ensure_future(self.keep_logs())

    async def close(self):
        if self.housekeeping is not None:
            self.housekeeping.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.housekeeping
        if self.http is not None:
            await self.http.close()

    def lock(self, sandbox_id):
        return self.locks.setdefault(sandbox_id, asyncio.Lock())

    async def apply(self, strict=True):
        """The host nftables table and the Caddyfile for the sandboxes there are now."""
        async with self.shared:
            live = {r["id"]: r for r in self.sandboxes.values() if r.get("slot") is not None and r["state"] != "parked"}
            rules = Path(self.config.root) / "nftables.conf"
            rules.parent.mkdir(parents=True, exist_ok=True)
            rules.write_text(self.network.host_rules([r["slot"] for r in live.values()], self.uplink or "eth0"))
            code, output = await self.runner.run([self.config.nft, "-f", str(rules)])
            if code != 0:
                log.error("nft refused the host ruleset: %s", output[-300:])
                if strict:
                    raise Refused(502, "nftables refused the host ruleset")
            if not self.config.domain:
                return
            routes = [(i, *self.network.worker_address(r["slot"])) for i, r in live.items()]
            text = caddy.caddyfile(domain=self.config.domain, admin_socket=self.config.caddy_admin,
                                   hostd_port=self.config.listen_port, routes=routes)
            path = Path(self.config.caddyfile)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(text)
            temporary.replace(path)
            code, output = await self.runner.run(caddy.reload_command(self.config.caddy, path, self.config.caddy_admin))
            if code != 0:
                log.error("caddy reload failed: %s", output[-300:])
                if strict:
                    raise Refused(502, "caddy did not take the new routes")

    # Records ----------------------------------------------------------------------------------------

    def save(self, record):
        paths = Paths(self.config, record["id"])
        if paths.dir.exists():
            temporary = paths.record.with_suffix(".tmp")
            temporary.write_text(json.dumps(record))
            temporary.replace(paths.record)

    @staticmethod
    def public(record):
        return {k: v for k, v in record.items() if k != "slot"} | {"route": f"/g/{record['id']}/"}

    @staticmethod
    def wipe(paths):
        """Blocking (large trees): run it in a thread."""
        for path in (paths.dir, paths.image, paths.staging):
            remove(path)

    async def stop(self, paths):
        """Whether the container is gone: `runsc delete --force`, and when that fails, `runsc state` must not
        know it any more. A sandbox that outlived its record would hold memory nobody counts."""
        code, output = await self.runner.run(self.runsc("delete", "--force", paths.container), timeout=60)
        if code == 0:
            return True
        code, _ = await self.runner.run(self.runsc("state", paths.container), timeout=30)
        if code in (0, 124):
            log.error("runsc could not delete %s: %s", paths.container, output[-300:])
            return False
        return True

    async def teardown(self, record):
        """Stop the sandbox and remove everything of it from the host (its record stays in memory). When
        the container cannot be deleted: 502, and its host dir, network and slot stay."""
        paths = Paths(self.config, record["id"])
        if not await self.stop(paths):
            raise Refused(502, "runsc could not delete the sandbox")
        if record.get("slot") is not None:
            for argv in self.network.teardown(record["id"], record["slot"]):
                await self.runner.run(argv)  # a namespace that is already gone is fine
        await asyncio.to_thread(self.wipe, paths)

    async def setup_network(self, record, paths):
        for argv in self.network.setup(record["id"], record["slot"], paths.router_rules):
            code, output = await self.runner.run(argv)
            if code != 0:
                raise RuntimeError(f"network setup failed at {' '.join(argv[:4])}: {output[-200:]}")

    async def rebuild_network(self, record, paths):
        """Both namespaces anew on the same slot: a sandbox that ran in them took its eth0's addresses and
        routes over (runsc's netstack), so the next create or restore there would find none."""
        for argv in self.network.teardown(record["id"], record["slot"]):
            await self.runner.run(argv)
        await self.setup_network(record, paths)

    def admit(self, sandbox_id, memory):
        """Sandbox memory limits never add up to more than the host has: past that the kernel's OOM killer
        picks some other person's browser."""
        limit = self.config.memory_limit_mb
        if not limit:
            info = meminfo()
            if info is None:
                return
            limit = info["total"] - self.config.reserve_mb
        committed = sum(r["memoryMb"] for r in self.sandboxes.values()
                        if r["id"] != sandbox_id and r["state"] not in ("parked", "failed"))
        if committed + memory > limit:
            raise Refused(507, "the host has no room for this sandbox", committedMb=committed, limitMb=limit)

    async def keep_logs(self):
        while True:
            await asyncio.sleep(60)
            await asyncio.to_thread(self.trim_logs)

    def trim_logs(self):
        """runsc.log gets the sandbox's stdio for as long as it lives: past `log_max_bytes` only the newer
        half stays (the sandbox appends, so it goes on writing at the new end)."""
        for record in list(self.sandboxes.values()):
            path = Paths(self.config, record["id"]).log
            with contextlib.suppress(OSError):
                size = path.stat().st_size
                if size <= self.config.log_max_bytes:
                    continue
                with open(path, "r+b") as file:
                    file.seek(size - self.config.log_max_bytes // 2)
                    tail = file.read()
                    file.seek(0)
                    file.truncate()
                    file.write(tail)

    # Start ------------------------------------------------------------------------------------------

    async def create(self, body):
        if not isinstance(body, dict):
            raise Refused(400, "body must be an object")
        sandbox_id = valid_id(body.get("id"))
        workspace = body.get("workspace")
        if not isinstance(workspace, str) or not 0 < len(workspace) <= 200:
            raise Refused(400, "workspace is required")
        generation = generation_of(body.get("generation"))
        memory = body.get("memoryMb")
        if not isinstance(memory, int) or not 256 <= memory <= 65536:
            raise Refused(400, "memoryMb must be 256 to 65536")
        worker_key = body.get("workerKey")
        if not isinstance(worker_key, str) or not HEX_KEY.fullmatch(worker_key):
            raise Refused(400, "workerKey must be 64 lower-case hex characters")
        version = body.get("rootfsVersion")
        if not isinstance(version, str) or not ROOTFS_VERSION.fullmatch(version):
            raise Refused(400, "rootfsVersion is required")
        if body.get("restore") is not None and body.get("profile") is not None:
            raise Refused(400, "give restore or profile, not both")
        source = None
        if body.get("restore") is not None:
            source = {**valid_set(body["restore"], "restore"), "snapshot": True}
        elif body.get("profile") is not None:
            source = {**valid_set(body["profile"], "profile"), "snapshot": False}
        async with self.lock(sandbox_id):
            existing = self.sandboxes.get(sandbox_id)
            if existing is not None and existing["state"] not in ("parked", "failed"):
                if existing["workspace"] != workspace:
                    raise Refused(409, "the id belongs to another workspace")
                if generation < existing["generation"]:
                    raise Refused(409, "stale generation", generation=existing["generation"])
                if generation > existing["generation"]:
                    # A controller that took the lease over: the live sandbox is newer than any set.
                    existing.update(generation=generation, path="adopted")
                    self.save(existing)
                return 200, self.public(existing)
            if existing is not None and generation < existing["generation"]:
                raise Refused(409, "stale generation", generation=existing["generation"])
            rootfs = self.config.rootfs / version
            if not rootfs.is_dir():
                raise Refused(409, "rootfs version is not on this host", rootfsVersion=version)
            self.admit(sandbox_id, memory)
            if existing is not None:
                await self.teardown(existing)
            record = {"id": sandbox_id, "workspace": workspace, "generation": generation, "memoryMb": memory,
                      "rootfsVersion": version, "state": "restoring" if source else "starting", "slot": None,
                      "path": None, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            self.sandboxes[sandbox_id] = record
            try:
                await self.bring_up(record, worker_key, source, rootfs)
            except Exception as error:
                log.warning("sandbox %s did not start: %s", sandbox_id, error)
                try:
                    await self.teardown(record)
                    record["slot"] = None
                except Refused:
                    pass  # still there: its slot and host dir stay taken until a DELETE gets it
                record.update(state="failed", error=str(error)[:300])
                self.save(record)
                await self.apply(strict=False)
                if isinstance(error, Refused):
                    raise
                raise Refused(502, f"sandbox did not start: {str(error)[:300]}") from None
            return 201, self.public(record)

    def bundle(self, record, paths, rootfs):
        sandbox_netns, _router = self.network.netns(record["id"])
        bind = lambda source, target, mode: {  # noqa: E731
            "destination": target, "type": "bind", "source": str(source), "options": ["rbind", mode]}
        return {
            "ociVersion": "1.0.2",
            "process": {
                "terminal": False, "user": {"uid": 0, "gid": 0}, "args": [self.config.init], "cwd": "/",
                "env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root",
                        "BRO_WORKER_BIND=0.0.0.0", f"BRO_WORKER_PORT={self.config.worker_port}"],
                "capabilities": {kind: CAPABILITIES for kind in ("bounding", "effective", "permitted")},
                "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 65536, "soft": 65536}],
            },
            # Not "readonly": with it gVisor mounts the root read-only even under --overlay2=root:memory, and
            # bro-sandbox-init dies on /run (stage 1 stand). Writes land in the overlay in the sandbox's
            # memory; the rootfs directory itself is never written.
            "root": {"path": str(rootfs), "readonly": False},
            # The same hostname everywhere: Chrome's SingletonLock names the host it was taken on.
            "hostname": "bro-sandbox",
            "mounts": [
                {"destination": "/proc", "type": "proc", "source": "proc"},
                {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "mode=755"]},
                {"destination": "/dev/pts", "type": "devpts", "source": "devpts",
                 "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"]},
                {"destination": "/dev/shm", "type": "tmpfs", "source": "shm",
                 "options": ["nosuid", "noexec", "nodev", "mode=1777", "size=1g"]},
                {"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": ["nosuid", "noexec", "nodev", "ro"]},
                bind(paths.profile, "/var/lib/bro/profile", "rw"),
                bind(paths.worker_json, "/etc/bro/worker.json", "ro"),
                bind(paths.resolv, "/etc/resolv.conf", "ro"),
            ],
            "linux": {
                "namespaces": [{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"},
                               {"type": "network", "path": f"/var/run/netns/{sandbox_netns}"}],
                # Its own cgroup: the memory limit, and a hostd restart does not take sandboxes with it.
                "cgroupsPath": f"/bro-sandboxes/{record['id']}",
                "resources": {"memory": {"limit": record["memoryMb"] * 2**20}, "pids": {"limit": 4096}},
            },
        }

    async def fetch_part(self, source, manifest, encryption, part, paths, target):
        """Download, decrypt and decompress one part of a set (staged on disk), and unpack it into `target`."""
        packed = paths.staging / f"{part}.tar.zst"
        await sets.download(self.http, manifest=manifest, encryption=encryption, part=part,
                            chunk_urls=source["chunkUrls"], target=packed, parallel=self.config.parallel)
        tar = paths.staging / f"{part}.tar"
        code, output = await self.runner.run([self.config.zstd, "-q", "-f", "-d", "--rm", str(packed), "-o", str(tar)],
                                             timeout=300)
        if code != 0:
            raise RuntimeError(f"zstd could not unpack the {part}: {output[-200:]}")
        await asyncio.to_thread(unpack, tar, target)
        await asyncio.to_thread(remove, tar)

    def snapshot_format(self, record):
        """What a snapshot must match to be restored: its memory maps the rootfs's binaries and runs its
        worker.py, and its cgroup must give it at least the memory it had."""
        return {"runsc": self.runsc_version, "cpu": self.cpu["features"], "rootfs": record["rootfsVersion"],
                "memoryMb": record["memoryMb"]}

    def fits(self, snapshot, record):
        """Whether a snapshot of that format can be restored here for this start; otherwise the reason."""
        if not isinstance(snapshot, dict):
            return "the set has no snapshot"
        if snapshot.get("runsc") != self.runsc_version:
            return f"snapshot of {snapshot.get('runsc')}, host runs {self.runsc_version}"
        if snapshot.get("cpu") != self.cpu["features"]:
            return "snapshot from a CPU with other features"
        if snapshot.get("rootfs") != record["rootfsVersion"]:
            return f"snapshot on rootfs {snapshot.get('rootfs')}, this start is on {record['rootfsVersion']}"
        if not isinstance(snapshot.get("memoryMb"), int) or snapshot["memoryMb"] > record["memoryMb"]:
            return "snapshot of a sandbox with more memory than this start gives"
        return None

    async def bring_up(self, record, worker_key, source, rootfs):
        paths = Paths(self.config, record["id"])
        try:
            await self.bring_up_in(paths, record, worker_key, source, rootfs)
        finally:
            await asyncio.to_thread(remove, paths.staging)
            await asyncio.to_thread(remove, paths.image)

    async def bring_up_in(self, paths, record, worker_key, source, rootfs):
        sandbox_id, config = record["id"], self.config
        owner = bro_owner(rootfs)
        if owner is None:
            raise RuntimeError(f"rootfs {record['rootfsVersion']} has no bro user")
        await asyncio.to_thread(self.wipe, paths)
        paths.dir.mkdir(parents=True, mode=0o700)
        paths.staging.mkdir(parents=True, mode=0o700)
        paths.profile.mkdir(mode=0o700)
        paths.worker_json.touch(mode=0o600)
        paths.worker_json.write_text(json.dumps({"environment": record["workspace"], "key": worker_key}))
        paths.resolv.write_text("".join(f"nameserver {address}\n" for address in config.dns))
        timings, started = {}, time.monotonic()
        snapshot, fallback = False, None
        if source is not None:
            manifest, encryption = await sets.fetch_manifest(self.http, source["key"], source["manifestUrl"])
            if manifest.get("workspace") != record["workspace"]:
                raise Refused(409, "the set belongs to another workspace")
            set_generation = manifest.get("generation")
            # Strictly older: this sandbox parks into <prefix>/<its generation>/ and never over the set it
            # came from, which stays whole until the new manifest is in.
            if not isinstance(set_generation, int) or set_generation >= record["generation"]:
                raise Refused(409, "the set is not older than this generation", setGeneration=set_generation)
            await self.fetch_part(source, manifest, encryption, "profile", paths, paths.profile)
            if source["snapshot"]:
                fallback = self.fits(manifest.get("snapshot"), record)
                image = next((p for p in manifest["parts"] if p.get("name") == "image"), None)
                if fallback is None and image is None:
                    fallback = "the set has no image"
                room = free_mb(config.shm)
                if fallback is None and room is not None and room < image.get("plainBytes", 0) // 2**20 + 256:
                    fallback = "no room in /dev/shm for the image"
                if fallback is None:
                    await self.fetch_part(source, manifest, encryption, "image", paths, paths.image)
                    snapshot = True
            await asyncio.to_thread(remove, paths.staging)
            timings["downloadMs"] = ms(started)
        try:
            await asyncio.to_thread(chown_tree, paths.profile, owner)
            os.chown(paths.worker_json, *owner)
        except PermissionError:
            raise RuntimeError("hostd cannot hand the profile to the bro user") from None
        async with self.shared:
            record["slot"] = self.network.allocate({r["slot"] for r in self.sandboxes.values()
                                                    if r is not record and r.get("slot") is not None})
        paths.router_rules.write_text(self.network.router_rules())
        await self.setup_network(record, paths)
        paths.bundle.mkdir()
        (paths.bundle / "config.json").write_text(json.dumps(self.bundle(record, paths, rootfs), indent=1))
        await self.apply()
        self.save(record)
        booted = time.monotonic()
        if snapshot:
            code, output = await self.runner.run(
                self.runsc("restore", f"--image-path={paths.image}", f"--bundle={paths.bundle}", "--detach",
                           paths.container), log_file=paths.log, timeout=120)
            if code == 0 and await self.worker_ready(record, config.restore_timeout_s):
                record["path"] = "restored"
            else:
                fallback = "runsc restore failed" if code != 0 else "the restored worker did not answer"
                log.warning("sandbox %s: %s, starting cold", sandbox_id, fallback)
                if not await self.stop(paths):
                    raise RuntimeError("runsc could not delete the failed restore")
                await self.rebuild_network(record, paths)
            await asyncio.to_thread(remove, paths.image)
        if record["path"] is None:
            for argv in (self.runsc("create", f"--bundle={paths.bundle}", paths.container),
                         self.runsc("start", paths.container)):
                code, output = await self.runner.run(argv, log_file=paths.log, timeout=120)
                if code != 0:
                    raise RuntimeError(f"runsc {argv[4]} failed (see {paths.log.name})")
            if not await self.worker_ready(record, config.start_timeout_s):
                raise RuntimeError("the worker did not answer")
            record["path"] = "cold" if source is not None else "fresh"
        timings["startMs"] = ms(booted)
        record.update(state="running", timings=timings, error=None)
        if fallback is not None and record["path"] == "cold":
            record["fallback"] = fallback
        self.save(record)

    async def worker_ready(self, record, seconds):
        address, port = self.network.worker_address(record["slot"])
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            with contextlib.suppress(aiohttp.ClientError, asyncio.TimeoutError, OSError):
                async with self.http.get(f"http://{address}:{port}/v1/health",
                                         timeout=aiohttp.ClientTimeout(total=2)) as response:
                    if response.status == 200:
                        return True
            await asyncio.sleep(0.25)
        return False

    # Park -------------------------------------------------------------------------------------------

    async def park(self, sandbox_id, body):
        if not isinstance(body, dict):
            raise Refused(400, "body must be an object")
        generation = generation_of(body.get("generation"))
        upload = body.get("upload")
        target = valid_set({**(upload if isinstance(upload, dict) else {}), "dataKey": body.get("dataKey")}, "upload")
        async with self.lock(sandbox_id):
            record = self.sandboxes.get(sandbox_id)
            if record is None:
                raise Refused(404, "no such sandbox")
            if generation < record["generation"]:
                raise Refused(409, "stale generation", generation=record["generation"])
            if record["state"] == "parked" and record["generation"] == generation and record.get("parked"):
                return record["parked"]  # a retried park that already succeeded
            if record["state"] != "running":
                raise Refused(409, f"sandbox is {record['state']}")
            async with self.parking:
                result = await self.park_running(record, generation, target)
        await self.apply(strict=False)
        return result

    async def park_running(self, record, generation, target):
        sandbox_id = record["id"]
        paths = Paths(self.config, sandbox_id)
        # The image is about the size of the sandbox's memory, in /dev/shm; staging on disk holds its tar
        # and the zstd of that for a moment.
        expected = await self.used_mb(record) or record["memoryMb"]
        shm_free, disk_free = free_mb(self.config.shm), free_mb(self.config.root)
        if shm_free is not None and shm_free < expected + 256:
            raise Refused(507, "no room in /dev/shm for the checkpoint", freeMb=shm_free, neededMb=expected + 256)
        if disk_free is not None and disk_free < 2 * expected + 256:
            raise Refused(507, "no room on disk to stage the set", freeMb=disk_free, neededMb=2 * expected + 256)
        record.update(generation=generation, state="parking")
        self.save(record)
        started = time.monotonic()
        await asyncio.to_thread(remove, paths.image)
        code, output = await self.runner.run(
            self.runsc("checkpoint", f"--image-path={paths.image}", paths.container), timeout=300)
        if code != 0:
            await asyncio.to_thread(remove, paths.image)
            state_code, state = await self.runner.run(self.runsc("state", paths.container))
            alive = False
            with contextlib.suppress(ValueError, AttributeError):
                alive = state_code == 0 and json.loads(state or "{}").get("status") == "running"
            record.update(state="running" if alive else "failed",
                          error=None if alive else "runsc checkpoint failed and the sandbox stopped")
            self.save(record)
            raise Refused(502, "runsc checkpoint failed", output=output[-300:])
        timings = {"checkpointMs": ms(started)}
        snapshot = self.snapshot_format(record)
        try:
            stage = time.monotonic()
            await asyncio.to_thread(remove, paths.staging)
            paths.staging.mkdir(parents=True, mode=0o700)
            parts = []
            for part, source in (("profile", paths.profile), ("image", paths.image)):
                tar = paths.staging / f"{part}.tar"
                plain = await asyncio.to_thread(pack, source, tar)
                code, output = await self.runner.run(
                    [self.config.zstd, "-q", "-f", "-3", "-T0", "--rm", str(tar), "-o", f"{tar}.zst"], timeout=300)
                if code != 0:
                    raise RuntimeError(f"zstd failed: {output[-200:]}")
                parts.append((part, Path(f"{tar}.zst"), plain))
            timings["packMs"] = ms(stage)
            stage = time.monotonic()
            manifest = await sets.upload(
                self.http, key=target["key"], set_id=f"{record['workspace']}|{sandbox_id}|{generation}",
                parts=parts, chunk_urls=target["chunkUrls"], manifest_url=target["manifestUrl"],
                chunk_bytes=self.config.chunk_bytes, parallel=self.config.parallel,
                extra={"workspace": record["workspace"], "sandbox": sandbox_id, "generation": generation,
                       "snapshot": snapshot})
            timings["uploadMs"] = ms(stage)
        except Exception as error:
            log.warning("sandbox %s: park upload failed: %s", sandbox_id, error)
            await asyncio.to_thread(remove, paths.staging)
            restored = await self.resume(record, paths)
            raise Refused(502, f"the set was not written: {str(error)[:300]}", restoredLocally=restored) from None
        timings["totalMs"] = ms(started)
        try:
            await self.teardown(record)
        except Refused:
            # The set is in, but a sandbox Bro may restore elsewhere must not live on here too.
            record.update(state="failed", error="the set is written but runsc could not delete the sandbox")
            self.save(record)
            raise Refused(502, "the set is written but runsc could not delete the sandbox", setWritten=True) from None
        result = {
            "id": sandbox_id, "state": "parked", "generation": generation, "format": snapshot,
            "chunks": sum(len(p["chunks"]) for p in manifest["parts"]),
            "parts": {p["name"]: {"plainBytes": p["plainBytes"], "bytes": p["bytes"], "chunks": len(p["chunks"])}
                      for p in manifest["parts"]},
            "timings": timings,
        }
        record.update(state="parked", slot=None, parked=result)
        return result

    async def resume(self, record, paths):
        """After a park that could not upload: bring the frozen sandbox back here from its image."""
        ready = False
        try:
            if await self.stop(paths):
                await self.rebuild_network(record, paths)
                code, _ = await self.runner.run(
                    self.runsc("restore", f"--image-path={paths.image}", f"--bundle={paths.bundle}", "--detach",
                               paths.container), log_file=paths.log, timeout=120)
                ready = code == 0 and await self.worker_ready(record, self.config.restore_timeout_s)
        except RuntimeError as error:
            log.warning("sandbox %s did not come back: %s", record["id"], error)
        await asyncio.to_thread(remove, paths.image)
        record.update(state="running" if ready else "failed",
                      error=None if ready else "the park failed and the sandbox did not come back")
        self.save(record)
        return ready

    # Delete -----------------------------------------------------------------------------------------

    async def delete(self, sandbox_id, generation):
        async with self.lock(sandbox_id):
            record = self.sandboxes.get(sandbox_id)
            if record is None:
                # Leftovers of a record hostd lost still go.
                await asyncio.to_thread(self.wipe, Paths(self.config, sandbox_id))
                raise Refused(404, "no such sandbox")
            if generation < record["generation"]:
                raise Refused(409, "stale generation", generation=record["generation"])
            try:
                await self.teardown(record)
            except Refused:
                record.update(state="failed", error="runsc could not delete the sandbox")
                self.save(record)
                raise
            del self.sandboxes[sandbox_id]
        await self.apply(strict=False)
        return {"id": sandbox_id, "deleted": True}

    # Capacity ---------------------------------------------------------------------------------------

    async def used_mb(self, record):
        code, output = await self.runner.run(self.runsc("events", "--stats", Paths(self.config, record["id"]).container))
        with contextlib.suppress(ValueError, KeyError, TypeError, AttributeError):
            if code == 0:
                return round(json.loads(output)["data"]["memory"]["usage"]["usage"] / 2**20)
        return None

    async def capacity(self):
        live = [r for r in self.sandboxes.values() if r["state"] not in ("parked",)]
        used = await asyncio.gather(*(self.used_mb(r) for r in live if r["state"] == "running"))
        usage = dict(zip([r["id"] for r in live if r["state"] == "running"], used))
        shm = None
        with contextlib.suppress(OSError):
            disk = shutil.disk_usage(self.config.shm)
            shm = {"totalMb": disk.total // 2**20, "freeMb": disk.free // 2**20}
        disk = None
        with contextlib.suppress(OSError):
            root_disk = shutil.disk_usage(self.config.root)
            disk = {"totalMb": root_disk.total // 2**20, "freeMb": root_disk.free // 2**20}
        # A rootfs still unpacking is a hidden `.<version>.partial`: the pattern leaves it out.
        versions = sorted(p.name for p in self.config.rootfs.glob("*")
                          if p.is_dir() and ROOTFS_VERSION.fullmatch(p.name)) if self.config.rootfs.exists() else []
        memory = meminfo()
        if memory is not None:
            memory["committed"] = sum(r["memoryMb"] for r in live if r["state"] != "failed")
        return {
            "host": self.identity["host"] if self.identity else None, "memoryMb": memory, "shm": shm, "disk": disk,
            "cpu": self.cpu, "runsc": self.runsc_version, "rootfsVersions": versions,
            "snapshotFormat": {"runsc": self.runsc_version, "cpu": self.cpu["features"]},
            "sandboxes": [{"id": r["id"], "state": r["state"], "generation": r["generation"],
                           "memoryMb": r["memoryMb"], "usedMb": usage.get(r["id"])} for r in live],
        }


# --- HTTP --------------------------------------------------------------------------------------------

HOST = web.AppKey("host", Host)


def authorize(request):
    header = request.headers.get("Authorization", "")
    token = header.removeprefix("Bearer ").strip() if header.startswith("Bearer ") else ""
    try:
        verify_token(token, request.app[HOST].identity)
    except Unauthorized as error:
        raise web.HTTPUnauthorized(text=json.dumps({"error": str(error)}), content_type="application/json")


async def body_of(request):
    try:
        return await request.json()
    except ValueError:
        raise Refused(400, "body must be JSON") from None


async def health(request):
    host = request.app[HOST]
    stage = Path(host.config.root) / "stage"
    return web.json_response({
        "hostd": VERSION, "runsc": host.runsc_version, "configured": host.identity is not None,
        "stage": stage.read_text().strip() if stage.exists() else None,
    })


async def capacity(request):
    authorize(request)
    return web.json_response(await request.app[HOST].capacity())


async def create_sandbox(request):
    authorize(request)
    status, record = await request.app[HOST].create(await body_of(request))
    return web.json_response(record, status=status)


async def read_sandbox(request):
    authorize(request)
    record = request.app[HOST].sandboxes.get(valid_id(request.match_info["sandbox_id"]))
    if record is None:
        raise Refused(404, "no such sandbox")
    return web.json_response(Host.public(record))


async def delete_sandbox(request):
    authorize(request)
    sandbox_id = valid_id(request.match_info["sandbox_id"])
    try:
        generation = generation_of(int(request.query.get("generation", "")))
    except ValueError:
        raise Refused(400, "generation is required") from None
    return web.json_response(await request.app[HOST].delete(sandbox_id, generation))


async def park_sandbox(request):
    authorize(request)
    sandbox_id = valid_id(request.match_info["sandbox_id"])
    return web.json_response(await request.app[HOST].park(sandbox_id, await body_of(request)))


@web.middleware
async def errors(request, handler):
    try:
        return await handler(request)
    except Refused as refusal:
        return web.json_response(refusal.body, status=refusal.status)
    except web.HTTPException:
        raise
    except Exception as error:  # an answer with the reason, never a dropped connection; bodies are not logged
        log.exception("%s %s", request.method, request.path)
        return web.json_response({"error": f"{type(error).__name__}: {error}"[:500]}, status=500)


def application(host):
    app = web.Application(middlewares=[errors], client_max_size=4 * 1024 * 1024)
    app[HOST] = host
    app.add_routes([
        web.get("/v1/health", health),
        web.get("/v1/capacity", capacity),
        web.post("/v1/sandboxes", create_sandbox),
        web.get("/v1/sandboxes/{sandbox_id}", read_sandbox),
        web.delete("/v1/sandboxes/{sandbox_id}", delete_sandbox),
        web.post("/v1/sandboxes/{sandbox_id}/park", park_sandbox),
    ])
    return app


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    config = Config.load(os.environ.get("BRO_HOSTD_CONFIG", "/etc/bro/hostd.json"))
    host = Host(config, load_identity(config.identity_file))
    await host.start()
    runner = web.AppRunner(application(host), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, config.listen_host, config.listen_port).start()
    log.info("hostd %s listening; runsc %s; configured=%s", VERSION, host.runsc_version, host.identity is not None)
    try:
        await asyncio.Event().wait()
    finally:
        await host.close()


if __name__ == "__main__":
    asyncio.run(main())
