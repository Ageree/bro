"""Firecracker microVMs of a browser host: the one module that knows the jailer, the API and the guest contract.

hostd's third runtime (`runtime: "firecracker"`, next to runc and runsc): a sandbox is a microVM, started
through the jailer, configured over its API socket, and parked as a memory snapshot kept on the host's own
disk. hostd's HTTP API and Bro's side do not change. hostd.py drives the sandbox's life; this module holds
what is specific to the VM:

  Host files    /opt/bro/firecracker/{firecracker,jailer,vmlinux}   (provision.sh, from the bundle)
  Rootfs        /srv/bro/rootfs/<version>.ext4: the unpacked rootfs directory as one read-only ext4 image, with
                guest/bro-fc-init and guest/bro-fc-clock injected, shared by every VM (drive `rootfs`, /dev/vda)
  Profile       <sandbox dir>/profile.img attached as a drive (/dev/vdb): never mounted on the host while the VM
                runs
  Config        <sandbox dir>/config.img, a tiny ext4 with worker.json and resolv.conf (/dev/vdc)
  Jail          <jailer_dir>/firecracker/<id>/root: the chroot. Files are hard links of the host's (the kernel,
                the rootfs image, the two sandbox images; the snapshot files are moved in); the API socket is
                firecracker.socket in it. The same in-chroot names every time, because a snapshot remembers the
                paths of its drives.
  Snapshots     <root>/snapshots/<id>/<generation>/{vmstate,mem,profile.img,config.img,meta.json}: the memory
                of a parked VM, local only. The set in Object Storage carries the profile alone; its manifest's
                `snapshot` block says which local snapshot belongs to it (`snapshot_block`).

The guest kernel (browser-vm/firecracker/) must have everything built in: ext4, overlayfs, virtio-mmio,
virtio-blk, virtio-net, virtio-rng, IP_PNP (the guest address comes from the kernel cmdline), ptp_kvm and VMGENID.

CLI (provision.sh): `firecracker.py build-image --rootfs DIR --out FILE` builds the rootfs image, if it is not
current already.
"""

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import network

HERE = Path(__file__).parent
GUEST_INIT = "/usr/local/sbin/bro-fc-init"
GUEST_CLOCK = "/usr/local/sbin/bro-fc-clock"
GUEST_FILES = (("guest/bro-fc-init", GUEST_INIT), ("guest/bro-fc-clock", GUEST_CLOCK))
# Bump with anything about how the image is built that its scripts' text does not show.
IMAGE_FORMAT = 1

# Names inside the jail (relative to its root) and the API's paths of them.
KERNEL, ROOTFS, PROFILE, CONFIG, SOCKET, SNAP = ("vmlinux", "rootfs.ext4", "profile.img", "config.img",
                                                  "firecracker.socket", "snap")
VMSTATE, MEMORY = f"{SNAP}/vmstate", f"{SNAP}/mem"
SNAPSHOT_FILES = ("vmstate", "mem", "profile.img", "config.img")
MEMORY_MARGIN_BYTES = 256 * 2**20
# Firecracker's metadata service inside the guest: the host's clock goes there (`clock_request`).
MMDS_ADDRESS = "169.254.169.254"


class FirecrackerError(Exception):
    """The API answered with an error (or not at all)."""


# --- Rootfs image ------------------------------------------------------------------------------------



def guest_scripts():
    """{path in the image: bytes} of what is injected."""
    return {target: (HERE / source).read_bytes() for source, target in GUEST_FILES}


def image_id(version):
    """Names the image's contents: a rootfs version and the scripts in it. A snapshot is only restored on the
    image it was taken on (its memory runs the init and the clock helper of that image)."""
    digest = hashlib.sha256(f"{IMAGE_FORMAT}\0{version}".encode())
    for target, data in sorted(guest_scripts().items()):
        digest.update(target.encode() + b"\0" + data)
    return digest.hexdigest()[:16]


def tree_footprint_mb(path):
    """What a directory tree will take in an ext4 image: allocated blocks of every file once, plus a margin
    per inode (blocking: run it in a thread)."""
    seen, total = set(), 0
    for directory, names, files in os.walk(path):
        for name in names + files:
            with contextlib.suppress(OSError):
                info = os.lstat(os.path.join(directory, name))
                if (info.st_dev, info.st_ino) in seen:
                    continue
                seen.add((info.st_dev, info.st_ino))
                total += max(info.st_blocks * 512, 4096) + 512
    return total // 2**20 + 1


def stage_image_inputs(stage):
    """Write the injected files and the debugfs script that puts them into the image to `stage`; the script's
    path (what `mkfs.ext4 -d` cannot do from a second directory)."""
    stage = Path(stage)
    stage.mkdir(parents=True, exist_ok=True)
    lines = []
    for source, target in GUEST_FILES:
        name = Path(source).name
        (stage / name).write_bytes((HERE / source).read_bytes())
        (stage / name).chmod(0o755)
        lines.append(f"write {stage / name} {target}")
    script = stage / "inject.debugfs"
    script.write_text("\n".join(lines) + "\n")
    return script


def image_commands(*, mkfs, debugfs, rootfs, image, script):
    """argv lists that make `image` (a file of the right size already) from the rootfs directory and the
    injected scripts. Read-only at run time, so no journal; many small files, so an inode per 4 KiB."""
    return [
        [mkfs, "-q", "-F", "-m", "0", "-i", "4096", "-O", "^has_journal", "-L", "bro-root",
         "-E", "root_owner=0:0", "-d", str(rootfs), str(image)],
        [debugfs, "-w", "-f", str(script), str(image)],
    ]


def image_check_command(debugfs, image):
    return [debugfs, "-R", f"ls {Path(GUEST_INIT).parent}", str(image)]


def image_has_scripts(listing):
    return all(Path(target).name in listing for _source, target in GUEST_FILES)


def image_meta(image):
    return Path(f"{image}.json")


def image_is_current(image, version):
    try:
        return Path(image).is_file() and json.loads(image_meta(image).read_text()).get("id") == image_id(version)
    except (OSError, ValueError):
        return False


def finish_image(partial, image, version):
    """The built image takes its name (read-only for everybody) and its identity file."""
    os.chmod(partial, 0o444)
    os.replace(partial, image)
    image_meta(image).write_text(json.dumps({"id": image_id(version)}))


def build_image_sync(rootfs, image, *, mkfs="mkfs.ext4", debugfs="debugfs"):
    """provision.sh's way (no hostd yet): the same commands, run here. Returns False when it was current."""
    rootfs, image = Path(rootfs), Path(image)
    version = rootfs.name
    if image_is_current(image, version):
        return False
    partial = image.with_name(f".{image.name}.partial")
    stage = image.with_name(f".{image.name}.stage")
    shutil.rmtree(stage, ignore_errors=True)
    script = stage_image_inputs(stage)
    with open(partial, "wb") as file:
        file.truncate(image_size_mb(tree_footprint_mb(rootfs)) * 2**20)
    try:
        for argv in image_commands(mkfs=mkfs, debugfs=debugfs, rootfs=rootfs, image=partial, script=script):
            subprocess.run(argv, check=True)
        listing = subprocess.run(image_check_command(debugfs, partial), check=True, capture_output=True, text=True)
        if not image_has_scripts(listing.stdout):
            raise RuntimeError("the init scripts are not in the image")
        finish_image(partial, image, version)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
        with contextlib.suppress(FileNotFoundError):
            partial.unlink()
    return True


def image_size_mb(footprint_mb):
    return int(footprint_mb * 1.12) + 192


# --- Guest and VM configuration ----------------------------------------------------------------------


def kernel_cmdline(*, overlay_mb, worker_port, now):
    """The whole command line (boot_args replaces Firecracker's default). The guest's address and gateway are
    ip= (the kernel's IP_PNP); BRO_* are passed to the init as environment."""
    inner = network.INNER
    ip = (f"ip={network.INNER_SANDBOX}::{network.INNER_ROUTER}:{inner.netmask}::eth0:off")
    return " ".join([
        "console=ttyS0", "reboot=k", "panic=1", "pci=off", "nomodule", "random.trust_cpu=on",
        "i8042.noaux", "i8042.nomux", "i8042.nopnp", "i8042.dumbkbd",
        "root=/dev/vda", "ro", "rootfstype=ext4", f"init={GUEST_INIT}", ip,
        f"BRO_OVERLAY_MB={overlay_mb}", f"BRO_WORKER_PORT={worker_port}", f"BRO_NOW={int(now)}",
    ])


def boot_requests(*, cmdline, memory_mb, vcpus):
    """[(method, path, body)] that configure a fresh VM and start it. Drives are attached in this order, so
    they are /dev/vda (rootfs, read-only, shared), vdb (the profile) and vdc (config) in the guest."""
    return [
        ("PUT", "/boot-source", {"kernel_image_path": f"/{KERNEL}", "boot_args": cmdline}),
        ("PUT", "/drives/rootfs", {"drive_id": "rootfs", "path_on_host": f"/{ROOTFS}", "is_root_device": True,
                                   "is_read_only": True}),
        # Writeback: the guest's flushes reach the file (fsync), so a crash of the host loses seconds.
        ("PUT", "/drives/profile", {"drive_id": "profile", "path_on_host": f"/{PROFILE}", "is_root_device": False,
                                    "is_read_only": False, "cache_type": "Writeback"}),
        ("PUT", "/drives/config", {"drive_id": "config", "path_on_host": f"/{CONFIG}", "is_root_device": False,
                                   "is_read_only": True}),
        ("PUT", "/network-interfaces/eth0", {"iface_id": "eth0", "host_dev_name": network.TAP,
                                             "guest_mac": network.GUEST_MAC}),
        ("PUT", "/machine-config", {"vcpu_count": vcpus, "mem_size_mib": memory_mb}),
        # The host's time reaches the guest through MMDS (`clock_request`): ptp_kvm needs kvm-clock, and on the
        # first real host (09.10) the guest took the TSC and had no /dev/ptp0.
        ("PUT", "/mmds/config", {"version": "V2", "network_interfaces": ["eth0"], "ipv4_address": MMDS_ADDRESS}),
        ("PUT", "/entropy", {}),
        ("PUT", "/actions", {"action_type": "InstanceStart"}),
    ]


def clock_request(now):
    """The host's wall clock into MMDS, for the guest's bro-fc-clock: after a cold start and after every
    restore, when the guest's clock is the one the snapshot was taken at."""
    return ("PUT", "/mmds", {"bro": {"now": round(now, 3)}})


PAUSE = ("PATCH", "/vm", {"state": "Paused"})
RESUME = ("PATCH", "/vm", {"state": "Resumed"})
SNAPSHOT_CREATE = ("PUT", "/snapshot/create", {"snapshot_type": "Full", "snapshot_path": f"/{VMSTATE}",
                                               "mem_file_path": f"/{MEMORY}"})
SNAPSHOT_LOAD = ("PUT", "/snapshot/load", {"snapshot_path": f"/{VMSTATE}", "resume_vm": True,
                                           "mem_backend": {"backend_path": f"/{MEMORY}", "backend_type": "File"}})


def jailer_argv(*, jailer, firecracker, sandbox_id, uid, gid, base, netns, cgroup_parent, memory_bytes):
    """The jailer, not daemonized: it execs Firecracker in place, so the process hostd starts is the VM and its
    stdout (the guest's serial console) goes to the sandbox's runtime.log. Its own cgroup under the parent
    (the memory limit; a hostd restart does not take it along), the sandbox's network namespace."""
    return [jailer, "--id", sandbox_id, "--exec-file", firecracker, "--uid", str(uid), "--gid", str(gid),
            "--chroot-base-dir", str(base), "--netns", f"/var/run/netns/{netns}",
            "--cgroup-version", "2", "--parent-cgroup", cgroup_parent,
            "--cgroup", f"memory.max={memory_bytes}", "--",
            "--api-sock", f"/{SOCKET}"]


# --- API ---------------------------------------------------------------------------------------------


class Api:
    """Firecracker's API on its unix socket."""

    def __init__(self, socket_path, timeout=60):
        self.socket_path, self.timeout = str(socket_path), timeout

    async def send(self, request, *, timeout=None):
        import aiohttp

        method, path, body = request
        connector = aiohttp.UnixConnector(path=self.socket_path)
        try:
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.request(method, f"http://localhost{path}", json=body,
                                           timeout=aiohttp.ClientTimeout(total=timeout or self.timeout)) as response:
                    text = await response.text()
                    if response.status >= 300:
                        raise FirecrackerError(f"{method} {path}: {response.status} {text[:300]}")
                    return text
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as error:
            raise FirecrackerError(f"{method} {path}: {type(error).__name__}: {error}") from None


# --- Local snapshots ---------------------------------------------------------------------------------


def snapshot_dir(root, sandbox_id, generation=None):
    base = Path(root) / "snapshots" / sandbox_id
    return base if generation is None else base / str(generation)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(2**20), b""):
            digest.update(block)
    return digest.hexdigest()


def snapshot_block(*, host, sandbox_id, generation, firecracker_version, kernel_sha256, cpu, rootfs, image,
                   memory_mb, vmstate_sha256, memory_bytes):
    """The manifest's `snapshot` entry (MAC-protected there): what a restore must match, and which local
    snapshot it is. Only this host, for this sandbox id and the generation the set was parked as."""
    return {"runtime": "firecracker", "local": True, "host": host, "sandbox": sandbox_id,
            "generation": generation, "firecracker": firecracker_version, "kernel": kernel_sha256, "cpu": cpu,
            "rootfs": rootfs, "image": image, "memoryMb": memory_mb, "vmstateSha256": vmstate_sha256,
            "memoryBytes": memory_bytes}


def dir_bytes(path):
    total = 0
    for directory, _names, files in os.walk(path):
        for name in files:
            with contextlib.suppress(OSError):
                info = os.lstat(os.path.join(directory, name))
                total += info.st_blocks * 512
    return total


def evict_snapshots(root, budget_bytes, keep=None):
    """Delete the oldest snapshots (by their meta.json) until the rest fits the budget; `keep` (id, generation)
    is never evicted. Eviction only means the next restore of that sandbox is a cold start. The names removed
    (blocking: run it in a thread)."""
    base = Path(root) / "snapshots"
    entries = []
    for meta in base.glob("*/*/meta.json"):
        directory = meta.parent
        with contextlib.suppress(OSError):
            entries.append((meta.stat().st_mtime, directory, dir_bytes(directory)))
    entries.sort()
    total = sum(size for _m, _d, size in entries)
    evicted = []
    for _mtime, directory, size in entries:
        if total <= budget_bytes:
            break
        if keep is not None and (directory.parent.name, directory.name) == (keep[0], str(keep[1])):
            continue
        shutil.rmtree(directory, ignore_errors=True)
        with contextlib.suppress(OSError):
            directory.parent.rmdir()
        evicted.append(f"{directory.parent.name}/{directory.name}")
        total -= size
    return evicted


def snapshot_usage(root):
    """(count, bytes on disk) of the local snapshots."""
    base = Path(root) / "snapshots"
    metas = list(base.glob("*/*/meta.json"))
    return len(metas), sum(dir_bytes(meta.parent) for meta in metas)


def link_or_copy(source, target):
    """A hard link (the jail and the host's files share a filesystem by design); a copy when they do not, which
    is only fit for small files (the kernel)."""
    try:
        os.link(source, target)
    except OSError:
        if Path(source).stat().st_size > 256 * 2**20:
            raise
        shutil.copyfile(source, target)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build-image")
    build.add_argument("--rootfs", required=True)
    build.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    built = build_image_sync(args.rootfs, args.out)
    print("built" if built else "current")


if __name__ == "__main__":
    sys.exit(main())
