"""Bro browser host daemon: runs people's browsers as sandboxes on one Cloud.ru VM (127.0.0.1:8090, behind
Caddy at /h/). Plan: docs/browser-pool.md.

A sandbox is one workspace's browser: the shared read-only rootfs (`<root>/rootfs/<version>/`, Chrome in
Xvfb, the worker; its PID 1 is /usr/local/sbin/bro-sandbox-init) in a network namespace of its own
(network.py). The runtime is `Config.runtime`:

  runc   (default; stage 1 decided it) a plain container: its own pid, ipc, uts, mount, cgroup and network
         namespaces, a cgroup with the memory, CPU and pids limits, the seccomp profile seccomp.json, the
         rootfs under an overlayfs hostd mounts itself (lower = the rootfs directory, upper and work on a
         per-sandbox tmpfs) — runc has no --overlay2. No memory snapshot: a park stops the sandbox gracefully
         (SIGTERM to its init: Chrome writes cookies to the profile) and keeps the profile alone; a restore is
         a fresh start with it (`path: cold`). What the worker kept outside the profile (its runs, sessions
         and their agent memory, saved tabs) does not survive a park.
  runsc  gVisor with `--overlay2=root:memory --platform=systrap`: a park freezes the sandbox (`runsc
         checkpoint` into /dev/shm/bro-<id>), and a restore brings it back with its open pages, falling
         back to a cold start with the profile when the snapshot does not fit.

Everything of one sandbox on the host lives under `<root>/sandboxes/<id>/`:

  profile/       bind-mounted read-write at /var/lib/bro/profile (the Chrome profile: sign-ins); with
                 `profile_mb` the mount of profile.img, an ext4 image of that size, so a sandbox cannot fill
                 the host's disk
  worker.json    bind-mounted read-only at /etc/bro/worker.json ({"environment", "key"}, 0600, never logged)
  resolv.conf    bind-mounted read-only at /etc/resolv.conf (public resolvers, not 127.0.0.53)
  overlay/       runc: the tmpfs holding the overlay's upper and work directories (the sandbox's writes)
  root/          runc: the overlay mount, the container's root
  bundle/        the OCI config.json, the same paths on every host so a snapshot restores anywhere
  runtime.log    stdout and stderr of the runtime and the sandbox: always a file, never a pipe (a restored
                 gVisor sandbox keeps its stdio, and a pipe reader would wait forever)
  router.nft     the router namespace's ruleset
  sandbox.json   the record hostd keeps (no secrets)

Parking packs the profile (and with runsc the checkpoint image) in `<root>/staging/<id>/` on disk,
compresses (zstd), encrypts and uploads them as a set (sets.py) over URLs Bro presigned. hostd decides
nothing about people: Bro chooses hosts, and before a park Bro has already told the worker to drop its
secrets (worker POST /v1/park).

Auth: `Authorization: Bearer v1.<payload>.<sig>`, the worker's token format with the host's key
(HMAC-SHA256(BROWSER_VM_SIGNING_KEY, "bro-browser-host:" + host id), delivered once in /etc/bro/host.json)
and the payload {"env": <host id>, "exp": <unix seconds>}, at most 15 minutes ahead.

Routes (all but /v1/health need a token):
  GET    /v1/health                     version, runtime and its version, boot stage
  GET    /v1/capacity                   memory, /dev/shm, sandboxes, CPU model and features, rootfs versions
  POST   /v1/sandboxes                  {id, workspace, generation, memoryMb?, workerKey, rootfsVersion,
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
from pathlib import Path, PurePosixPath

import aiohttp
from aiohttp import web

import caddy
import network
import sets

VERSION = "2026-10-01.1"
MAX_TOKEN_LIFETIME_S = 900
RUNTIMES = ("runc", "runsc")
SANDBOX_ID = re.compile(r"[a-z0-9-]{1,63}")
ROOTFS_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
HEX_KEY = re.compile(r"[0-9a-f]{64}")
# runsc's default spec: capabilities inside gVisor's own kernel, not the host's. The init needs
# setuid/setgid to drop to the `bro` user.
RUNSC_CAPABILITIES = ["CAP_AUDIT_WRITE", "CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL",
                      "CAP_MKNOD", "CAP_NET_BIND_SERVICE", "CAP_NET_RAW", "CAP_SETFCAP", "CAP_SETGID",
                      "CAP_SETPCAP", "CAP_SETUID", "CAP_SYS_CHROOT"]
# Under runc these are real capabilities on the host's kernel: the init drops to `bro` (SETUID/SETGID), and
# the worker's `sudo systemctl … bro-chrome` needs them back (so no noNewPrivileges either). No MKNOD and no
# NET_RAW: nothing in the sandbox makes devices or raw sockets. Chrome's own sandbox needs none of them: it
# makes a user namespace of its own.
RUNC_CAPABILITIES = ["CAP_AUDIT_WRITE", "CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL",
                     "CAP_NET_BIND_SERVICE", "CAP_SETFCAP", "CAP_SETGID", "CAP_SETPCAP", "CAP_SETUID",
                     "CAP_SYS_CHROOT"]
# `runc spec`'s defaults: what a plain container must not read or change of the host's kernel.
MASKED_PATHS = ["/proc/acpi", "/proc/asound", "/proc/kcore", "/proc/keys", "/proc/latency_stats",
                "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug", "/proc/scsi", "/sys/firmware"]
READONLY_PATHS = ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"]
log = logging.getLogger("bro-hostd")


@dataclasses.dataclass
class Config:
    """Every path and tool of the host, overridable from /etc/bro/hostd.json (same key names)."""

    root: str = "/srv/bro"
    shm: str = "/dev/shm"
    runtime: str = "runc"
    runc: str = "runc"
    runc_root: str = "/run/runc-bro"
    runsc: str = "runsc"
    runsc_root: str = "/run/runsc-bro"
    platform: str = "systrap"
    init: str = "/usr/local/sbin/bro-sandbox-init"
    ip: str = "ip"
    nft: str = "nft"
    zstd: str = "zstd"
    mount: str = "mount"
    umount: str = "umount"
    caddy: str = "caddy"
    caddyfile: str = "/etc/caddy/Caddyfile"
    caddy_admin: str = "/run/caddy/admin.sock"
    domain: str = ""
    uplink: str = ""
    transit_pool: str = "172.31.0.0/16"
    dns: tuple = ("77.88.8.8", "1.1.1.1")
    # More destinations sandboxes are refused (CIDRs), on top of network.BLOCKED: refused at once.
    egress_blocked: tuple = ()
    # STAND ONLY, empty in production: TCP ports of the host itself sandboxes may reach (the stage 2 stand's
    # stand-in for the residential proxy, scripts/cloudru-sandbox-probe/pool.py). Every other host port is
    # refused, and hostd's own, ssh, http(s) and Caddy's admin ports can never be listed.
    stand_host_ports: tuple = ()
    listen_host: str = "127.0.0.1"
    listen_port: int = 8090
    worker_port: int = 8080
    chunk_bytes: int = 16 * 1024 * 1024
    parallel: int = 6
    parallel_parks: int = 2
    # The cgroup memory limit of a sandbox whose request names none (stage 1: p95 1.7 GB without gVisor,
    # 2.2 GB with it, gVisor's peak 3.0 GB).
    memory_mb: int = 3072
    # runc: the tmpfs under the sandbox's overlay (its writes: /tmp, the worker's runs, logs). Its pages
    # count against the sandbox's memory limit too.
    overlay_mb: int = 2048
    # runc: an OCI seccomp object (JSON file) for the sandbox; "" = none (a stand's experiment only). The
    # default, seccomp.json next to this file, allows everything but what container escapes go through
    # (keyrings, bpf, userfaultfd, mount and its new API, io_uring, modules, kexec, setns, packet and
    # nf_tables sockets): Docker's default profile would refuse the user namespace Chrome's own sandbox
    # makes (unshare/clone with CLONE_NEWUSER without CAP_SYS_ADMIN).
    seccomp_profile: str = str(Path(__file__).with_name("seccomp.json"))
    # The sandbox's CPU quota in CPUs (cgroup cpu.max); 0 = none.
    cpus: float = 2.0
    # The profile's own ext4 image (sparse, mounted over profile/): what one sandbox may write to the host's
    # disk. 0 = a plain directory (no cap).
    profile_mb: int = 2048
    mkfs: str = "mkfs.ext4"
    # What sandbox memory limits may add up to; 0 = MemTotal less `reserve_mb`.
    memory_limit_mb: int = 0
    reserve_mb: int = 1024
    log_max_bytes: int = 8 * 1024 * 1024
    start_timeout_s: float = 90
    restore_timeout_s: float = 30
    # runc park: how long the init gets to stop the worker and Chrome (its unit's TimeoutStopSec is 30 s)
    # and exit; past that the container is killed and the park goes on with `chromeStop: killed`.
    chrome_stop_timeout_s: float = 45
    # How often the host's nftables table is written again: it is the only barrier between sandboxes and
    # the VPC, and nothing else would notice it gone.
    rules_every_s: float = 30
    identity_file: str = "/etc/bro/host.json"

    def __post_init__(self):
        if self.runtime not in RUNTIMES:
            raise ValueError(f"runtime must be one of {RUNTIMES}")
        # A stand config copied with a wrong port must not open hostd, ssh or Caddy to every sandbox.
        forbidden = {22, 80, 443, 2019, self.listen_port}
        if forbidden & {int(port) for port in self.stand_host_ports}:
            raise ValueError(f"stand_host_ports may not include {sorted(forbidden)}")

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
        for name in ("dns", "egress_blocked", "stand_host_ports"):
            if name in values:
                values[name] = tuple(values[name])
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
        output is empty: runc and runsc create and restore leave the sandbox holding them."""
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


# Top-level directories of a profile no set carries: the profile image's own lost+found, and Chrome's
# BrowserMetrics, where every Chrome that ends on SIGTERM (a park) leaves a 4 MiB .pma file it never
# takes back: carried from set to set they grew the profile by 4 MiB a park (e2e 30.09: 4 → 25 MB in six).
LEFT_OUT_OF_SETS = frozenset({"lost+found", "BrowserMetrics"})

# Chrome's caches, at any depth of the profile: Chrome builds them again, and nothing a person signed in
# with lives there (cookies, Local Storage and IndexedDB do not). Carried along they made the pilot's set
# 255 MiB after five errands (01.10), every park uploading and every start downloading all of it.
CHROME_CACHES = frozenset({
    "Cache", "Code Cache", "GPUCache", "CacheStorage", "ScriptCache", "ShaderCache", "GrShaderCache",
    "GraphiteDawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "component_crx_cache", "extensions_crx_cache",
})


def pack(source, target):
    """A tar of the directory's regular files and directories only (blocking: run it in a thread). The
    profile is written by the sandbox and unpacked by root on another host (`unpack`): symlinks (Chrome's
    Singleton* ones, which it makes again), FIFOs, devices and sockets stay out, and a second name of a
    hard-linked file goes in as a copy of its own."""
    source = Path(source)

    def plain(member):
        if member.isdir() and PurePosixPath(member.name).name in CHROME_CACHES:
            return None
        if member.islnk():
            member.type, member.linkname = tarfile.REGTYPE, ""
            member.size = os.lstat(source / member.name).st_size
        return member if member.isreg() or member.isdir() else None

    with tarfile.open(target, "w") as tar:
        for child in sorted(source.iterdir()):
            if child.name in LEFT_OUT_OF_SETS and child.is_dir():
                continue
            tar.add(child, arcname=child.name, filter=plain)
    return Path(target).stat().st_size


def tree_mb(path):
    """What a directory holds on disk, roughly (blocking: run it in a thread)."""
    total = 0
    for directory, _names, files in os.walk(path):
        for name in files:
            with contextlib.suppress(OSError):
                total += os.lstat(os.path.join(directory, name)).st_size
    return total // 2**20


def only_plain_files(member, target):
    """The extraction filter: regular files and directories under the target, through tarfile's `data`
    filter (no absolute or `..` paths, no owners, no setuid bits). Symlinks and hard links are never
    extracted, so no member can lead a later one out of the target (the `data` filter's own link checks
    have had bypasses); links, devices, FIFOs and anything the filter refuses are skipped, never fatal: a
    sandbox that left a FIFO in its profile must not make its sign-ins impossible to restore."""
    if not (member.isreg() or member.isdir()):
        return None
    try:
        return tarfile.data_filter(member, target)
    except tarfile.FilterError:
        return None


def unpack(archive, target):
    """Extract a set's tar (blocking: run it in a thread) into a directory hostd made. Its contents come
    from a sandbox, and hostd is root: `only_plain_files` decides. Files come out owned by hostd."""
    Path(target).mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        tar.extractall(target, filter=only_plain_files)


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


def init_killed_chrome(log_path, offset):
    """Whether the init's log, after `offset`, says it had to SIGKILL Chrome (bro-sandbox-init `stop`)."""
    try:
        with open(log_path, "rb") as file:
            size = file.seek(0, os.SEEK_END)
            file.seek(offset if offset <= size else 0)  # trimmed meanwhile (`trim_logs`): read it all
            text = file.read(4 * 2**20)
    except OSError:
        return False
    return b"bro-sandbox-init: bro-chrome killed" in text


def ms(started):
    return round((time.monotonic() - started) * 1000)


def status_of(code, output):
    """The `status` of `runc state` / `runsc state` JSON, or None."""
    with contextlib.suppress(ValueError, AttributeError):
        if code == 0:
            return json.loads(output or "{}").get("status")
    return None


# --- Sandboxes ---------------------------------------------------------------------------------------


class Paths:
    def __init__(self, config, sandbox_id):
        self.dir = config.sandboxes / sandbox_id
        self.profile = self.dir / "profile"
        self.profile_image = self.dir / "profile.img"  # with `profile_mb`: the ext4 image mounted at profile/
        self.worker_json = self.dir / "worker.json"
        self.resolv = self.dir / "resolv.conf"
        self.overlay = self.dir / "overlay"  # runc: the tmpfs with the overlay's upper and work
        self.merged = self.dir / "root"  # runc: the overlay, the container's root
        self.bundle = self.dir / "bundle"
        self.log = self.dir / "runtime.log"
        self.router_rules = self.dir / "router.nft"
        self.record = self.dir / "sandbox.json"
        self.image = Path(config.shm) / f"bro-{sandbox_id}"  # runsc's checkpoint image, the only part in RAM
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
                                       ip=config.ip, nft=config.nft, blocked=config.egress_blocked,
                                       stand_ports=config.stand_host_ports)
        self.sandboxes = {}
        self.locks = {}
        self.shared = asyncio.Lock()  # transit slots, the nftables table, the Caddyfile
        self.parking = asyncio.Semaphore(config.parallel_parks)  # each park holds its staging (and an image)
        self.housekeeping = None
        self.cpu = cpu_info()
        self.runtime_version = None
        self.uplink = config.uplink or None
        self.http = None
        self.seccomp = None
        if config.runtime == "runc" and config.seccomp_profile:
            self.seccomp = json.loads(Path(config.seccomp_profile).read_text())

    # Setup ------------------------------------------------------------------------------------------

    @property
    def gvisor(self):
        return self.config.runtime == "runsc"

    @property
    def runsc_version(self):
        """What a snapshot is pinned to; None when the host runs runc (it makes no snapshots)."""
        return self.runtime_version if self.gvisor else None

    def oci(self, *args):
        """A runtime command: runc, or runsc with the flags every runsc command of a sandbox takes."""
        c = self.config
        if self.gvisor:
            return [c.runsc, f"--root={c.runsc_root}", f"--platform={c.platform}", "--overlay2=root:memory", *args]
        return [c.runc, f"--root={c.runc_root}", *args]

    async def start(self):
        self.http = aiohttp.ClientSession()
        tool = self.config.runsc if self.gvisor else self.config.runc
        code, output = await self.runner.run([tool, "--version"])
        self.runtime_version = output.splitlines()[0].strip() if code == 0 and output else None
        if self.uplink is None:
            code, output = await self.runner.run(self.network.uplink_command())
            self.uplink = self.network.uplink_from(output) if code == 0 else None
        self.config.sandboxes.mkdir(parents=True, exist_ok=True)
        for path in sorted(self.config.sandboxes.glob("*/sandbox.json")):
            with contextlib.suppress(OSError, ValueError, KeyError):
                record = json.loads(path.read_text())
                code, output = await self.runner.run(self.oci("state", Paths(self.config, record["id"]).container))
                alive = status_of(code, output) == "running"
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
        self.housekeeping = asyncio.ensure_future(self.keep_house())

    async def close(self):
        if self.housekeeping is not None:
            self.housekeeping.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.housekeeping
        if self.http is not None:
            await self.http.close()

    def lock(self, sandbox_id):
        return self.locks.setdefault(sandbox_id, asyncio.Lock())

    def live(self):
        return {r["id"]: r for r in self.sandboxes.values() if r.get("slot") is not None and r["state"] != "parked"}

    async def write_rules(self, live):
        """The host's nftables table, whole and in one transaction (the caller holds `shared`); whether nft
        took it."""
        rules = Path(self.config.root) / "nftables.conf"
        rules.parent.mkdir(parents=True, exist_ok=True)
        rules.write_text(self.network.host_rules([r["slot"] for r in live.values()], self.uplink or "eth0"))
        code, output = await self.runner.run([self.config.nft, "-f", str(rules)])
        if code != 0:
            log.error("nft refused the host ruleset: %s", output[-300:])
        return code == 0

    async def apply(self, strict=True):
        """The host nftables table and the Caddyfile for the sandboxes there are now."""
        async with self.shared:
            live = self.live()
            if not await self.write_rules(live) and strict:
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
        """Blocking (large trees): run it in a thread, and only once `unmount` said nothing is mounted."""
        for path in (paths.dir, paths.image, paths.staging):
            remove(path)

    async def unmount(self, paths):
        """Whether the sandbox's overlay and its tmpfs are gone (or never were): a host dir is only wiped
        with nothing mounted in it, or rmtree would walk into the sandbox's root."""
        for path in (paths.merged, paths.overlay, paths.profile):  # the overlay first: it lives on the tmpfs
            if not path.is_dir():
                continue
            # Until umount says "not mounted" (fine for a directory that never was): a start that died after
            # mounting and was tried again stacks a second mount on the same point.
            output = ""
            for _ in range(3):
                code, output = await self.runner.run([self.config.umount, str(path)], timeout=60)
                if code != 0:
                    break
            if os.path.ismount(path):
                # Something still holds it (a process that outlived the container): detach it lazily, the
                # kernel frees it with the last user.
                await self.runner.run([self.config.umount, "-l", str(path)], timeout=60)
            if os.path.ismount(path):
                log.error("could not unmount %s: %s", path, output[-300:])
                return False
        return True

    async def stop(self, paths):
        """Whether the container is gone: `delete --force`, and when that fails, `state` must not know it
        any more. A sandbox that outlived its record would hold memory nobody counts."""
        code, output = await self.runner.run(self.oci("delete", "--force", paths.container), timeout=60)
        if code == 0:
            return True
        code, _ = await self.runner.run(self.oci("state", paths.container), timeout=30)
        if code in (0, 124):
            log.error("%s could not delete %s: %s", self.config.runtime, paths.container, output[-300:])
            return False
        return True

    async def teardown(self, record):
        """Stop the sandbox and remove everything of it from the host (its record stays in memory). When
        the container cannot be deleted or its root unmounted: 502, and its host dir, network and slot stay."""
        paths = Paths(self.config, record["id"])
        if not await self.stop(paths):
            raise Refused(502, f"{self.config.runtime} could not delete the sandbox")
        if not await self.unmount(paths):
            raise Refused(502, "the sandbox's root could not be unmounted")
        if record.get("slot") is not None:
            for argv in self.network.teardown(record["id"], record["slot"]):
                await self.runner.run(argv)  # a namespace that is already gone is fine
        await asyncio.to_thread(self.wipe, paths)

    async def fresh_network(self, record, paths):
        """Both namespaces anew on the record's slot, for every start and restore: a gVisor sandbox that ran
        in them took its eth0's addresses and routes over (runsc's netstack), so the next create or restore
        there would find none; leftovers of a hostd that died halfway would make `ip netns add` fail."""
        for argv in self.network.teardown(record["id"], record["slot"]):
            await self.runner.run(argv)
        for argv in self.network.setup(record["id"], record["slot"], paths.router_rules):
            code, output = await self.runner.run(argv)
            if code != 0:
                raise RuntimeError(f"network setup failed at {' '.join(argv[:4])}: {output[-200:]}")

    async def mount_profile(self, paths):
        """The profile on an ext4 image of `profile_mb` (sparse: it takes the disk its files take): a
        sandbox that writes without end fills its own image, not the host's disk every other park and
        start needs. nodev and nosuid; not noexec: Chrome loads components (Widevine) from the profile."""
        size = self.config.profile_mb
        if not size:
            return
        with open(paths.profile_image, "wb") as image:
            image.truncate(size * 2**20)
        code, output = await self.runner.run(
            [self.config.mkfs, "-q", "-F", "-m", "0", "-E", "lazy_itable_init=1,nodiscard", str(paths.profile_image)],
            timeout=120)
        if code != 0:
            raise RuntimeError(f"mkfs for the profile failed: {output[-200:]}")
        code, output = await self.runner.run(
            [self.config.mount, "-o", "loop,nodev,nosuid", str(paths.profile_image), str(paths.profile)])
        if code != 0:
            raise RuntimeError(f"the profile image did not mount: {output[-200:]}")
        await asyncio.to_thread(remove, paths.profile / "lost+found")
        os.chmod(paths.profile, 0o700)

    async def mount_root(self, paths, rootfs):
        """runc has no --overlay2: the rootfs directory under an overlayfs whose upper and work live on a
        tmpfs of this sandbox, so the rootfs itself is never written and the sandbox's writes are memory."""
        paths.overlay.mkdir(mode=0o700, exist_ok=True)
        paths.merged.mkdir(mode=0o755, exist_ok=True)
        code, output = await self.runner.run(
            [self.config.mount, "-t", "tmpfs", "-o", f"size={self.config.overlay_mb}m,mode=0755", "tmpfs",
             str(paths.overlay)])
        if code != 0:
            raise RuntimeError(f"tmpfs for the overlay failed: {output[-200:]}")
        upper, work = paths.overlay / "upper", paths.overlay / "work"
        upper.mkdir(mode=0o755, exist_ok=True)
        work.mkdir(mode=0o755, exist_ok=True)
        code, output = await self.runner.run(
            [self.config.mount, "-t", "overlay", "overlay", "-o",
             f"lowerdir={rootfs},upperdir={upper},workdir={work}", str(paths.merged)])
        if code != 0:
            raise RuntimeError(f"overlay mount failed: {output[-200:]}")

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

    async def keep_house(self):
        """Every `rules_every_s`: the nftables table again (a process with CAP_NET_ADMIN that deleted or
        flushed it would otherwise leave every sandbox unfiltered until the next start or park); every
        minute: the logs."""
        last_trim = time.monotonic()
        while True:
            await asyncio.sleep(self.config.rules_every_s)
            try:
                async with self.shared:
                    await self.write_rules(self.live())
            except Exception:  # the loop must outlive any one failure
                log.exception("rewriting the host's nftables table failed")
            if time.monotonic() - last_trim >= 60:
                last_trim = time.monotonic()
                await asyncio.to_thread(self.trim_logs)

    def trim_logs(self):
        """runtime.log gets the sandbox's stdio for as long as it lives: past `log_max_bytes` only the newer
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
        memory = body.get("memoryMb", self.config.memory_mb)
        if not isinstance(memory, int) or isinstance(memory, bool) or not 256 <= memory <= 65536:
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
                      "rootfsVersion": version, "runtime": self.config.runtime,
                      "state": "restoring" if source else "starting", "slot": None, "path": None,
                      "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
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
        capabilities = RUNSC_CAPABILITIES if self.gvisor else RUNC_CAPABILITIES
        namespaces = [{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"},
                      {"type": "network", "path": f"/var/run/netns/{sandbox_netns}"}]
        resources = {"memory": {"limit": record["memoryMb"] * 2**20}, "pids": {"limit": 4096}}
        if self.config.cpus:
            # A page that spins every core would starve its neighbours: cpu.max, period 100 ms.
            resources["cpu"] = {"quota": round(self.config.cpus * 100_000), "period": 100_000}
        spec = {
            "ociVersion": "1.0.2",
            "process": {
                "terminal": False, "user": {"uid": 0, "gid": 0}, "args": [self.config.init], "cwd": "/",
                "env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root",
                        "BRO_WORKER_BIND=0.0.0.0", f"BRO_WORKER_PORT={self.config.worker_port}"],
                "capabilities": {kind: capabilities for kind in ("bounding", "effective", "permitted")},
                # The worker becomes root again through sudo for `systemctl … bro-chrome`.
                "noNewPrivileges": False,
                "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 65536, "soft": 65536}],
            },
            # Not "readonly". gVisor mounts the root read-only even under --overlay2=root:memory with it, and
            # bro-sandbox-init dies on /run (stage 1 stand); under runc the root is hostd's overlay. Either
            # way writes land in the sandbox's memory and the rootfs directory itself is never written.
            "root": {"path": str(rootfs if self.gvisor else paths.merged), "readonly": False},
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
                "namespaces": namespaces,
                # Its own cgroup: the memory limit, and a hostd restart does not take sandboxes with it.
                "cgroupsPath": f"/bro-sandboxes/{record['id']}",
                "resources": resources,
            },
        }
        if not self.gvisor:
            namespaces.append({"type": "cgroup"})
            # Devices: none but the ones runc always gives a container (null, zero, random, tty, pts…).
            resources["devices"] = [{"allow": False, "access": "rwm"}]
            spec["linux"]["maskedPaths"] = MASKED_PATHS
            spec["linux"]["readonlyPaths"] = READONLY_PATHS
            # Under memory pressure a browser goes before hostd, Caddy or sshd. Below Chrome's own renderer
            # scores (300 and up): runc sets this with privileges, which makes it the floor nobody in the
            # sandbox may go under, and with 500 Chrome could not rank its renderers above its browser process
            # (EACCES on every renderer, stage 2 host).
            spec["process"]["oomScoreAdj"] = 200
            # seccomp.json (Config.seccomp_profile): runc applies none of its own, and Docker's default
            # refuses the user namespace Chrome's sandbox makes (unshare, clone with CLONE_NEWUSER).
            if self.seccomp is not None:
                spec["linux"]["seccomp"] = self.seccomp
        return spec

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
        if not self.gvisor:
            return "runc keeps no memory snapshots: the profile alone"
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
        config = self.config
        owner = bro_owner(rootfs)
        if owner is None:
            raise RuntimeError(f"rootfs {record['rootfsVersion']} has no bro user")
        if not await self.unmount(paths):  # leftovers of a hostd that died halfway
            raise RuntimeError("an old root of this sandbox is still mounted")
        await asyncio.to_thread(self.wipe, paths)
        paths.dir.mkdir(parents=True, mode=0o700)
        paths.staging.mkdir(parents=True, mode=0o700)
        paths.profile.mkdir(mode=0o700)
        await self.mount_profile(paths)
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
        await self.fresh_network(record, paths)
        if not self.gvisor:
            await self.mount_root(paths, rootfs)
        paths.bundle.mkdir()
        (paths.bundle / "config.json").write_text(json.dumps(self.bundle(record, paths, rootfs), indent=1))
        await self.apply()
        self.save(record)
        booted = time.monotonic()
        if snapshot:
            code, output = await self.runner.run(
                self.oci("restore", f"--image-path={paths.image}", f"--bundle={paths.bundle}", "--detach",
                         paths.container), log_file=paths.log, timeout=120)
            if code == 0 and await self.worker_ready(record, config.restore_timeout_s):
                record["path"] = "restored"
            else:
                fallback = "runsc restore failed" if code != 0 else "the restored worker did not answer"
                log.warning("sandbox %s: %s, starting cold", record["id"], fallback)
                if not await self.stop(paths):
                    raise RuntimeError("runsc could not delete the failed restore")
                await self.fresh_network(record, paths)
            await asyncio.to_thread(remove, paths.image)
        if record["path"] is None:
            await self.boot(record, paths)
            record["path"] = "cold" if source is not None else "fresh"
        timings["startMs"] = ms(booted)
        record.update(state="running", timings=timings, error=None)
        if fallback is not None and record["path"] == "cold":
            record["fallback"] = fallback
        self.save(record)

    async def boot(self, record, paths):
        """Create and start the container from its bundle, and wait for its worker."""
        for command in ("create", "start"):
            argv = self.oci(command, f"--bundle={paths.bundle}", paths.container) if command == "create" \
                else self.oci(command, paths.container)
            code, output = await self.runner.run(argv, log_file=paths.log, timeout=120)
            if code != 0:
                raise RuntimeError(f"{self.config.runtime} {command} failed (see {paths.log.name})")
        if not await self.worker_ready(record, self.config.start_timeout_s):
            raise RuntimeError("the worker did not answer")

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
                if self.gvisor:
                    result = await self.park_frozen(record, generation, target)
                else:
                    result = await self.park_stopped(record, generation, target)
        await self.apply(strict=False)
        return result

    async def write_set(self, record, paths, generation, target, sources, snapshot):
        """Pack, compress and upload the parts (`sources`: [(part, directory)]); the manifest last."""
        timings = {}
        stage = time.monotonic()
        await asyncio.to_thread(remove, paths.staging)
        paths.staging.mkdir(parents=True, mode=0o700)
        parts = []
        for part, source in sources:
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
            self.http, key=target["key"], set_id=f"{record['workspace']}|{record['id']}|{generation}",
            parts=parts, chunk_urls=target["chunkUrls"], manifest_url=target["manifestUrl"],
            chunk_bytes=self.config.chunk_bytes, parallel=self.config.parallel,
            extra={"workspace": record["workspace"], "sandbox": record["id"], "generation": generation,
                   "runtime": self.config.runtime, "snapshot": snapshot})
        timings["uploadMs"] = ms(stage)
        await asyncio.to_thread(remove, paths.staging)
        return manifest, timings

    async def finish_park(self, record, generation, manifest, snapshot, timings):
        try:
            await self.teardown(record)
        except Refused:
            # The set is in, but a sandbox Bro may restore elsewhere must not live on here too.
            record.update(state="failed", error="the set is written but the sandbox could not be removed")
            self.save(record)
            raise Refused(502, "the set is written but the sandbox could not be removed", setWritten=True) from None
        result = {
            "id": record["id"], "state": "parked", "generation": generation, "runtime": self.config.runtime,
            "format": snapshot,
            "chunks": sum(len(p["chunks"]) for p in manifest["parts"]),
            "parts": {p["name"]: {"plainBytes": p["plainBytes"], "bytes": p["bytes"], "chunks": len(p["chunks"])}
                      for p in manifest["parts"]},
            "timings": timings,
        }
        record.update(state="parked", slot=None, parked=result)
        return result

    async def park_stopped(self, record, generation, target):
        """runc: the sandbox stops gracefully (Chrome writes cookies and localStorage to the profile), the
        container goes, and the profile alone is the set. An open page does not survive this: Bro keeps a
        sandbox that waits for a code alive until the code's deadline. Nor does anything the worker kept
        outside the profile (/var/lib/bro/runs, sessions with their agent memory, saved tabs: the overlay's
        tmpfs): a restored sandbox's worker starts empty, as after a worker restart."""
        paths = Paths(self.config, record["id"])
        needed = 2 * await asyncio.to_thread(tree_mb, paths.profile) + 256  # its tar and that tar's zstd
        disk_free = free_mb(self.config.root)
        if disk_free is not None and disk_free < needed:
            raise Refused(507, "no room on disk to stage the set", freeMb=disk_free, neededMb=needed)
        record.update(generation=generation, state="parking")
        self.save(record)
        started = time.monotonic()
        stopped = await self.stop_sandbox(paths)
        timings = {"stopMs": ms(started), "chromeStop": stopped}
        if not await self.stop(paths):
            record.update(state="failed", error="the sandbox stopped but runc could not delete it")
            self.save(record)
            raise Refused(502, "runc could not delete the sandbox")
        try:
            manifest, stage_timings = await self.write_set(record, paths, generation, target,
                                                           [("profile", paths.profile)], None)
        except Exception as error:
            log.warning("sandbox %s: park upload failed: %s", record["id"], error)
            await asyncio.to_thread(remove, paths.staging)
            restored = await self.restart_here(record, paths)
            raise Refused(502, f"the set was not written: {str(error)[:300]}", restoredLocally=restored) from None
        timings.update(stage_timings, totalMs=ms(started))
        return await self.finish_park(record, generation, manifest, None, timings)

    async def stop_sandbox(self, paths):
        """How Chrome stopped: "sigterm" (it exited and wrote its profile), or "killed" (the init gave up on
        it after its TimeoutStopSec, or the whole sandbox outlived `chrome_stop_timeout_s` and runc killed
        it: the newest cookies may be missing). SIGTERM goes to the init (`runc kill`), which stops the
        worker, Chrome and Xvfb the way systemd would and exits. Nothing is run inside the sandbox: a
        `runc exec` into a container a page may have taken over is how runc's escapes start. Once SIGTERM
        is sent the sandbox is on its way out either way, so it never goes back to `running`."""
        offset = 0
        with contextlib.suppress(OSError):
            offset = paths.log.stat().st_size
        code, output = await self.runner.run(self.oci("kill", paths.container, "SIGTERM"), timeout=30)
        if code != 0:
            # Not running any more (or runc cannot reach it): whatever stopped Chrome, it was not this.
            log.warning("%s: SIGTERM failed (%s): %s", paths.container, code, output[-200:])
            await self.runner.run(self.oci("kill", paths.container, "SIGKILL"), timeout=30)
            return "killed"
        deadline = time.monotonic() + self.config.chrome_stop_timeout_s
        while True:
            code, output = await self.runner.run(self.oci("state", paths.container), timeout=30)
            if status_of(code, output) != "running":
                break
            if time.monotonic() >= deadline:
                log.warning("%s did not exit %s s after SIGTERM: killing it", paths.container,
                            self.config.chrome_stop_timeout_s)
                await self.runner.run(self.oci("kill", paths.container, "SIGKILL"), timeout=30)
                return "killed"
            await asyncio.sleep(0.25)
        return "killed" if await asyncio.to_thread(init_killed_chrome, paths.log, offset) else "sigterm"

    async def restart_here(self, record, paths):
        """runc, after a park that could not upload: the same sandbox again from its profile, in fresh
        namespaces. Its overlay is still mounted and keeps the worker's files; the init clears the X
        server's locks of the stopped sandbox before Xvfb starts (bro-sandbox-init `clear_display_locks`)."""
        ready = False
        try:
            await self.fresh_network(record, paths)
            await self.boot(record, paths)
            ready = True
        except RuntimeError as error:
            log.warning("sandbox %s did not come back: %s", record["id"], error)
        record.update(state="running" if ready else "failed",
                      error=None if ready else "the park failed and the sandbox did not come back")
        self.save(record)
        return ready

    async def park_frozen(self, record, generation, target):
        """runsc: freeze the sandbox with its open pages and upload the profile and the image."""
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
            self.oci("checkpoint", f"--image-path={paths.image}", paths.container), timeout=300)
        if code != 0:
            await asyncio.to_thread(remove, paths.image)
            state_code, state = await self.runner.run(self.oci("state", paths.container))
            alive = status_of(state_code, state) == "running"
            record.update(state="running" if alive else "failed",
                          error=None if alive else "runsc checkpoint failed and the sandbox stopped")
            self.save(record)
            raise Refused(502, "runsc checkpoint failed", output=output[-300:])
        timings = {"checkpointMs": ms(started)}
        snapshot = self.snapshot_format(record)
        try:
            manifest, stage_timings = await self.write_set(
                record, paths, generation, target, [("profile", paths.profile), ("image", paths.image)], snapshot)
        except Exception as error:
            log.warning("sandbox %s: park upload failed: %s", sandbox_id, error)
            await asyncio.to_thread(remove, paths.staging)
            restored = await self.resume(record, paths)
            raise Refused(502, f"the set was not written: {str(error)[:300]}", restoredLocally=restored) from None
        timings.update(stage_timings, totalMs=ms(started))
        return await self.finish_park(record, generation, manifest, snapshot, timings)

    async def resume(self, record, paths):
        """runsc, after a park that could not upload: bring the frozen sandbox back here from its image."""
        ready = False
        try:
            if await self.stop(paths):
                await self.fresh_network(record, paths)
                code, _ = await self.runner.run(
                    self.oci("restore", f"--image-path={paths.image}", f"--bundle={paths.bundle}", "--detach",
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
                # Leftovers of a record hostd lost still go, but never with a root still mounted in them.
                paths = Paths(self.config, sandbox_id)
                if await self.unmount(paths):
                    await asyncio.to_thread(self.wipe, paths)
                raise Refused(404, "no such sandbox")
            if generation < record["generation"]:
                raise Refused(409, "stale generation", generation=record["generation"])
            try:
                await self.teardown(record)
            except Refused as refusal:
                record.update(state="failed", error=refusal.body["error"])
                self.save(record)
                raise
            del self.sandboxes[sandbox_id]
        await self.apply(strict=False)
        return {"id": sandbox_id, "deleted": True}

    # Capacity ---------------------------------------------------------------------------------------

    async def used_mb(self, record):
        """The sandbox's cgroup memory: `runc events --stats` and `runsc events --stats` print the same JSON."""
        code, output = await self.runner.run(self.oci("events", "--stats", Paths(self.config, record["id"]).container))
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
            "cpu": self.cpu, "runtime": self.config.runtime, "runtimeVersion": self.runtime_version,
            "runsc": self.runsc_version, "rootfsVersions": versions,
            # Where a runsc set may be restored with its memory; runc makes none.
            "snapshotFormat": {"runsc": self.runsc_version, "cpu": self.cpu["features"]} if self.gvisor else None,
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
        "hostd": VERSION, "runtime": host.config.runtime, "runtimeVersion": host.runtime_version,
        "runsc": host.runsc_version, "configured": host.identity is not None,
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
    log.info("hostd %s listening; %s %s; configured=%s", VERSION, config.runtime, host.runtime_version,
             host.identity is not None)
    try:
        await asyncio.Event().wait()
    finally:
        await host.close()


if __name__ == "__main__":
    asyncio.run(main())
