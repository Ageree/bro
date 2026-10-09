"""How a browser host comes up (operator script, stdlib only).

The project keeps at most two custom images, both in production, so a host is not an image: it boots the
stock ubuntu-22.04 and cloud-init sets it up. From Cloud.ru, GitHub and PyPI accept connections and send
nothing, and archive.ubuntu.com does not answer (30.09.2026), so a host reaches only mirror.yandex.ru (apt)
and Object Storage: everything else it needs travels in the bundle, fetched here, where they answer.

  python boot.py vendor --dir vendor/
      Caddy's static binary (GitHub release, sha256 pinned in vendor.json) and the hostd wheels
      (requirements.txt, sha256 pinned per wheel) for the host's Python 3.10 on x86_64

  python boot.py vendor --dir vendor/ --firecracker-url URL --kernel-url URL
      also Firecracker and its guest kernel (browser-vm/firecracker/pins.json: the tarball, the binaries in it
      and the kernel are checked against its sha256s) into vendor/firecracker/, for a firecracker host; the
      URLs are presigned GETs of the objects the pins name (their S3 keys)

  python boot.py bundle --vendor vendor/ --out host-bundle.tgz
      the host code (provision.sh, hostd and its modules) with the vendored files, as a reproducible
      tarball; prints its sha256. Upload it next to the sandbox rootfs and presign a GET for each new host.
      With vendor/firecracker/ it carries Firecracker too (bundle for a firecracker host; also the body of a
      self-update: hostd's POST /v1/admin/update takes this tarball by URL and sha256)

  BRO_HOST_UPDATE_SIGNING_KEY=… python boot.py token --host-id bro-host-1 --scope update
      [--legacy-host-key, with BROWSER_VM_SIGNING_KEY instead: for the one update that gives a host made before
      the update key its key; see browser-vm/host/README.md]
      a 10-minute token for hostd's /v1/admin/update and the sandbox logs. It is signed with the host's update key
      (HMAC-SHA256 of that signing key and "bro-browser-host-update:<host id>"), which only the operator can make:
      Bro holds BROWSER_VM_SIGNING_KEY, from which the host's ordinary key comes, and must not reach root on a host.
      Bro's own tokens have no scope and are refused there

  BRO_HOST_UPDATE_SIGNING_KEY=… python boot.py bundle --vendor vendor/ --out host-bundle.tgz --enroll-update-key HOST_ID
      a bundle for that one host that also carries its update key (enroll/update-key): the update that applies it
      writes the key into /etc/bro/host.json (a host made before the key existed, or a rotated key); do not keep
      the object in Object Storage afterwards

  BROWSER_VM_SIGNING_KEY=… [BRO_HOST_UPDATE_SIGNING_KEY=…] python boot.py cloud-init --host-id bro-host-1 \\
      --bundle-url … --bundle-sha256 … --rootfs-version … --rootfs-url … --rootfs-sha256 … \\
      [--runtime runc|runsc|firecracker --runsc-release 20260914] [--apt-mirror …] [--domain …]
      the user data for one host (base64 it for the Compute API). With BRO_HOST_UPDATE_SIGNING_KEY set host.json
      also carries `updateKey`; Bro's own writer (`browserHostCloudInit`) never does, and a host without it
      answers 403 on the operator's routes

On the host, bro-host-boot (a cloud-init per-boot script: every boot until the host is ready) fetches the
bundle, checks its SHA-256 and runs provision.sh, which points apt at the mirror, installs runc (or a pinned
runsc, or Firecracker from the bundle), nftables and zstd, Caddy and the hostd venv from the bundle, their systemd units, and unpacks the
rootfs. Bro's own host creation (`browserHostCloudInit` in agent/lib/browser-pool/hosts.ts) writes the same
user data byte for byte, and tests/agent/browser-pool/hosts.test.ts runs this script to hold it to that:
change both together.

Boot budget (estimated; measure on the first real host): stock boot ≈ 45 s, apt ≈ 40–60 s, venv ≈ 10 s,
rootfs (≈ 0.5 GB zstd, inside Cloud.ru, 17 s on the stage 1 stand) ≈ 20–60 s, certificate ≈ 10 s — about
2–3 minutes, 6 at worst. Caddy and hostd start right after apt and the venv, before the rootfs: from then on
Bro follows `stage` on https://<domain>/h/v1/health, including a `failed:<stage>:line N`; before that a host
that does not answer is only slow. It takes sandboxes at `ready`.
"""

import argparse
import base64
import gzip
import hashlib
import hmac
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
FILES = ("provision.sh", "units.sh", "update.sh", "rollback.sh", "hostd.py", "network.py", "sets.py", "caddy.py",
         "firecracker.py", "selfupdate.py", "guest/bro-fc-init", "guest/bro-fc-clock", "seccomp.json",
         "requirements.txt")
EXECUTABLE = (".sh", "bro-fc-init", "bro-fc-clock")
FIRECRACKER_DIR = HERE.parent / "firecracker"
VENDOR = json.loads((HERE / "vendor.json").read_text())
RUNTIMES = ("runc", "runsc", "firecracker")
RUNSC_RELEASE = re.compile(r"\d{8}(\.\d+)?")
APT_MIRROR = "http://mirror.yandex.ru/ubuntu"
BOOT_SCRIPT_PATH = "/var/lib/cloud/scripts/per-boot/bro-host-boot"
# Fetches the bundle named in boot.json, checks it and hands over to provision.sh. A cloud-init per-boot
# script: cloud-init runs it at every boot, the first one included, and it does nothing once the host is
# ready (its Caddy and hostd start on their own). Bro reboots a host that stays silent (a first boot may
# hang in initramfs), and on 02.10.2026 such a reboot landed mid-provision: runcmd, which cloud-init marks
# done before it runs it, never ran again and the host stayed dead. Cloud.ru's reboot is a hard reset, so
# a run it cut short may have left torn files behind (02.10: every apt Packages list empty, while the
# InRelease files that apt-get update checks were whole): before provision.sh runs again, the apt lists
# and cache and hostd's venv go (provision.sh makes them anew; hostd may run from the venv) and dpkg is
# repaired. The rest of provision.sh is safe to repeat from any stage.
# It waits up to 40 attempts 10 s apart (7-13 minutes) for the network: in ru.AZ-1 (30.09.2026) a new VM
# boots and runs this while its public address is still being attached, with no DNS or egress for 3+
# minutes.
BOOT_SCRIPT = r"""#!/bin/bash
set -euo pipefail
exec >>/var/log/bro-provision.log 2>&1
STAGE=$(cat /srv/bro/stage 2>/dev/null || echo none)
echo "bro-host-boot $(date -u +%FT%TZ) stage $STAGE"
if [ "$STAGE" = ready ]; then
  exit 0
fi
field() { python3 -c 'import json, sys
value = json.load(open("/etc/bro/boot.json"))
for key in sys.argv[1].split("."):
    value = value[key]
print(value)' "$1"; }
URL=$(field bundle.url)
SHA=$(field bundle.sha256)
for i in $(seq 1 40); do
  curl -fsS --connect-timeout 10 -m 300 -o /root/bro-host.tgz "$URL" && break
  [ "$i" = 40 ] && exit 1
  sleep 10
done
echo "$SHA  /root/bro-host.tgz" | sha256sum -c --quiet -
mkdir -p /opt/bro/host
tar -xzf /root/bro-host.tgz -C /opt/bro/host
rm -f /root/bro-host.tgz
if [ -e /srv/bro/stage ]; then
  systemctl stop bro-hostd 2>/dev/null || true
  rm -rf /opt/bro/venv /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
  for i in 1 2 3 4 5 6; do
    DEBIAN_FRONTEND=noninteractive dpkg --configure -a && break
    [ "$i" = 6 ] && { echo "bro-host-boot: dpkg --configure -a failed 6 times, no provisioning"; exit 1; }
    sleep 10
  done
fi
exec bash /opt/bro/host/provision.sh
"""


def host_key(signing_key_hex, host_id):
    """The key hostd checks tokens with: Bro derives it the same way and keeps no per-host secret."""
    return hmac.new(bytes.fromhex(signing_key_hex), f"bro-browser-host:{host_id}".encode(), hashlib.sha256).digest()


def update_key(update_signing_key_hex, host_id):
    """The key hostd checks `update`-scope tokens with (`updateKey` of host.json). Derived from a signing key the
    operator alone keeps (BRO_HOST_UPDATE_SIGNING_KEY): Bro has none of it, so Bro cannot make such a token."""
    return hmac.new(bytes.fromhex(update_signing_key_hex), f"bro-browser-host-update:{host_id}".encode(),
                    hashlib.sha256).digest()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def pinned_wheels(text=None):
    """The sha256 of every wheel requirements.txt pins."""
    text = (HERE / "requirements.txt").read_text() if text is None else text
    return set(re.findall(r"--hash=sha256:([0-9a-f]{64})", text))


def vendored(vendor_dir, *, caddy_sha256=None, wheel_hashes=None):
    """[(path in the bundle, bytes, mode)] of the vendored files, each checked against its pin: Caddy's
    binary, and exactly one wheel for every pinned requirement."""
    vendor_dir = Path(vendor_dir)
    caddy_sha256 = caddy_sha256 or VENDOR["caddy"]["binarySha256"]
    wheel_hashes = pinned_wheels() if wheel_hashes is None else wheel_hashes
    binary = (vendor_dir / "caddy").read_bytes()
    if sha256(binary) != caddy_sha256:
        raise ValueError("vendor/caddy is not the pinned Caddy binary")
    files = [("vendor/caddy", binary, 0o755)]
    found = set()
    for wheel in sorted((vendor_dir / "wheels").glob("*.whl")):
        data = wheel.read_bytes()
        digest = sha256(data)
        if digest not in wheel_hashes:
            raise ValueError(f"{wheel.name} is not pinned in requirements.txt")
        found.add(digest)
        files.append((f"wheels/{wheel.name}", data, 0o644))
    if found != wheel_hashes:
        raise ValueError(f"{len(wheel_hashes - found)} pinned wheels are missing from {vendor_dir / 'wheels'}")
    return files


def firecracker_pins(path=None):
    """browser-vm/firecracker/pins.json (the tarball, the two binaries in it and the guest kernel) with
    firecracker.json beside it (where the binaries are in the tarball)."""
    path = Path(path) if path else FIRECRACKER_DIR / "pins.json"
    pins = json.loads(path.read_text())
    layout = json.loads((path.parent / "firecracker.json").read_text())["binaries"]
    return {**pins, "paths": {name: layout[name]["path"] for name in ("firecracker", "jailer")}}


def vendored_firecracker(vendor_dir, pins=None):
    """[(path in the bundle, bytes, mode)] of vendor/firecracker/ when the vendor directory has it: the two
    binaries and the guest kernel, each checked against its pin, and the pins themselves; nothing else."""
    folder = Path(vendor_dir) / "firecracker"
    if not folder.exists():
        return []
    pins = pins or firecracker_pins()
    expected = {"firecracker": pins["firecracker"]["firecrackerSha256"], "jailer": pins["firecracker"]["jailerSha256"],
                "vmlinux": pins["kernel"]["sha256"]}
    files = []
    for name, digest in expected.items():
        data = (folder / name).read_bytes()
        if sha256(data) != digest:
            raise ValueError(f"vendor/firecracker/{name} is not the pinned one")
        files.append((f"vendor/firecracker/{name}", data, 0o644 if name == "vmlinux" else 0o755))
    stray = {p.name for p in folder.iterdir()} - set(expected)
    if stray:
        raise ValueError(f"vendor/firecracker holds files the pins do not name: {sorted(stray)}")
    files.append(("vendor/firecracker/versions.json", json.dumps(
        {"firecracker": pins["firecracker"]["version"], "kernel": pins["kernel"]["version"]}, sort_keys=True).encode(),
        0o644))
    return files


def bundle(vendor_dir, enroll_update_key=None, **pins):
    """The host code and its vendored files as a gzip tarball, byte for byte the same for the same files. With
    `enroll_update_key` (a host's update key, bytes) the bundle is that host's alone: it also carries
    enroll/update-key, which update.sh writes into host.json."""
    entries = [(name, (HERE / name).read_bytes(), 0o755 if name.endswith(EXECUTABLE) else 0o644) for name in FILES]
    if enroll_update_key is not None:
        entries.append(("enroll/update-key", enroll_update_key.hex().encode() + b"\n", 0o600))
    entries += vendored(vendor_dir, **{k: v for k, v in pins.items() if k != "firecracker_pins"})
    entries += vendored_firecracker(vendor_dir, pins.get("firecracker_pins"))
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, data, mode in entries:
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.mode = len(data), 0, mode
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


def vendor(target):
    """Fetch Caddy and the wheels (run where GitHub and PyPI answer: the operator's machine or a session)."""
    target = Path(target)
    (target / "wheels").mkdir(parents=True, exist_ok=True)
    caddy = VENDOR["caddy"]
    with urllib.request.urlopen(caddy["url"], timeout=300) as response:
        archive = response.read()
    if sha256(archive) != caddy["sha256"]:
        raise SystemExit(f"{caddy['url']} is not the pinned archive")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        binary = tar.extractfile("caddy").read()
    if sha256(binary) != caddy["binarySha256"]:
        raise SystemExit("the Caddy archive holds another binary than the pinned one")
    (target / "caddy").write_bytes(binary)
    (target / "caddy").chmod(0o755)
    wheels = VENDOR["wheels"]
    argv = [sys.executable, "-m", "pip", "download", "-q", "--require-hashes", "--no-deps",
            "--only-binary=:all:", "--implementation", "cp", "--python-version", wheels["python"],
            "-d", str(target / "wheels"), "-r", str(HERE / "requirements.txt")]
    for platform in wheels["platforms"]:
        argv += ["--platform", platform]
    for abi in wheels["abis"]:
        argv += ["--abi", abi]
    subprocess.run(argv, check=True)
    vendored(target)  # exactly the pinned set, nothing else


def download(url, expected_sha256, what):
    with urllib.request.urlopen(url, timeout=600) as response:
        data = response.read()
    if sha256(data) != expected_sha256:
        raise SystemExit(f"{what} is not the pinned object (sha256 differs)")
    return data


def vendor_firecracker(target, firecracker_url, kernel_url, pins=None):
    """Firecracker, the jailer and the guest kernel into <target>/firecracker/, each against its pin."""
    pins = pins or firecracker_pins()
    folder = Path(target) / "firecracker"
    folder.mkdir(parents=True, exist_ok=True)
    release = pins["firecracker"]
    archive = download(firecracker_url, release["sha256"], "the Firecracker tarball")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for name in ("firecracker", "jailer"):
            data = tar.extractfile(pins["paths"][name]).read()
            if sha256(data) != release[f"{name}Sha256"]:
                raise SystemExit(f"the tarball holds another {name} than the pinned one")
            (folder / name).write_bytes(data)
            (folder / name).chmod(0o755)
    kernel = download(kernel_url, pins["kernel"]["sha256"], "the guest kernel")
    (folder / "vmlinux").write_bytes(kernel)
    vendored_firecracker(target, pins)


def token(signing_key_hex, host_id, scope, lifetime_s=600, now=None, legacy=False):
    """A hostd token (hostd.py `verify_token`) with a scope claim, for the operator's calls: signed with the
    host's update key, derived from the operator's BRO_HOST_UPDATE_SIGNING_KEY, not from the one Bro holds.
    `legacy` signs with the host's ordinary key instead (then `signing_key_hex` is BROWSER_VM_SIGNING_KEY): the
    one token a hostd older than the update key accepts, for the update that enrolls the key and nothing else;
    a hostd with the key refuses it."""
    payload = base64.urlsafe_b64encode(json.dumps(
        {"env": host_id, "exp": int((time.time() if now is None else now) + lifetime_s), "scope": scope},
        separators=(",", ":")).encode()).rstrip(b"=").decode()
    signed = f"v1.{payload}"
    key = host_key(signing_key_hex, host_id) if legacy else update_key(signing_key_hex, host_id)
    signature = hmac.new(key, signed.encode(), hashlib.sha256).digest()
    return f"{signed}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def quoted(text):
    """A single-quoted YAML scalar: the JSON stays as written, a quote inside is written twice."""
    return "'" + text.replace("'", "''") + "'"


def cloud_init(*, host_id, key, bundle_url, bundle_sha256, rootfs_version, rootfs_url, rootfs_sha256,
               runtime="runc", runsc_release=None, apt_mirror=APT_MIRROR, domain=None, host_update_key=None):
    if runtime not in RUNTIMES:
        raise ValueError(f"runtime must be one of {RUNTIMES}")
    if runtime == "runsc" and not RUNSC_RELEASE.fullmatch(runsc_release or ""):
        raise ValueError("runsc needs a dated gVisor release such as 20260914 or 20260914.0")
    if not re.fullmatch(r"[a-z0-9-]{1,63}", host_id):
        raise ValueError("host id must match [a-z0-9-]{1,63}")
    if apt_mirror and not re.fullmatch(r"https?://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?", apt_mirror):
        raise ValueError("apt mirror must be a plain http(s) URL")
    identity = {"host": host_id, "key": key.hex()}
    if host_update_key is not None:  # the operator's: Bro's own writer leaves it out
        identity["updateKey"] = host_update_key.hex()
    identity = json.dumps(identity)
    boot = json.dumps({
        "hostId": host_id, "domain": domain or "", "runtime": runtime, "runscRelease": runsc_release or "",
        "aptMirror": apt_mirror or "",
        "bundle": {"url": bundle_url, "sha256": bundle_sha256},
        "rootfs": {"version": rootfs_version, "url": rootfs_url, "sha256": rootfs_sha256},
    })
    script = "".join(f"      {line}\n" if line else "\n" for line in BOOT_SCRIPT.splitlines())
    return "\n".join([
        "#cloud-config",
        "write_files:",
        "  - path: /etc/bro/host.json",
        '    permissions: "0600"',
        f"    content: {quoted(identity)}",
        "  - path: /etc/bro/boot.json",
        '    permissions: "0600"',
        f"    content: {quoted(boot)}",
        f"  - path: {BOOT_SCRIPT_PATH}",
        '    permissions: "0700"',
        "    content: |",
        script.rstrip("\n"),
        "",
    ])


def env_key(name, required=False):
    """A signing key from the environment as hex (session secrets arrive with stray blanks and quotes)."""
    value = "".join(os.environ.get(name, "").split()).strip("‘’“”'\"")
    if required and not value:
        sys.exit(f"{name} is required")
    try:
        bytes.fromhex(value)
    except ValueError:
        sys.exit(f"{name} is not hex")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    fetch = commands.add_parser("vendor")
    fetch.add_argument("--dir", required=True)
    fetch.add_argument("--firecracker-url")
    fetch.add_argument("--kernel-url")
    tokens = commands.add_parser("token")
    tokens.add_argument("--host-id", required=True)
    tokens.add_argument("--scope", default="update", choices=["update"])
    tokens.add_argument("--legacy-host-key", action="store_true",
                        help="sign with the host's ordinary key (BROWSER_VM_SIGNING_KEY): only for the update that "
                             "gives a host older than the update key its updateKey")
    pack = commands.add_parser("bundle")
    pack.add_argument("--vendor", required=True)
    pack.add_argument("--out", required=True)
    pack.add_argument("--enroll-update-key", metavar="HOST_ID",
                      help="carry that host's update key (from BRO_HOST_UPDATE_SIGNING_KEY) for update.sh to install")
    init = commands.add_parser("cloud-init")
    for name in ("host-id", "bundle-url", "bundle-sha256", "rootfs-version", "rootfs-url", "rootfs-sha256"):
        init.add_argument(f"--{name}", required=True)
    init.add_argument("--runtime", choices=RUNTIMES, default="runc")
    init.add_argument("--runsc-release")
    init.add_argument("--apt-mirror", default=APT_MIRROR)
    init.add_argument("--domain")
    args = parser.parse_args(argv)
    if args.command == "vendor":
        vendor(args.dir)
        if args.firecracker_url or args.kernel_url:
            if not (args.firecracker_url and args.kernel_url):
                sys.exit("--firecracker-url and --kernel-url go together")
            vendor_firecracker(args.dir, args.firecracker_url, args.kernel_url)
        return
    if args.command == "bundle":
        enroll = None
        if args.enroll_update_key:
            enroll = update_key(env_key("BRO_HOST_UPDATE_SIGNING_KEY", required=True), args.enroll_update_key)
        data = bundle(args.vendor, enroll_update_key=enroll)
        Path(args.out).write_bytes(data)
        print(sha256(data))
        return
    if args.command == "token":
        name = "BROWSER_VM_SIGNING_KEY" if args.legacy_host_key else "BRO_HOST_UPDATE_SIGNING_KEY"
        print(token(env_key(name, required=True), args.host_id, args.scope, legacy=args.legacy_host_key))
        return
    signing = env_key("BROWSER_VM_SIGNING_KEY", required=True)
    operator = env_key("BRO_HOST_UPDATE_SIGNING_KEY")
    sys.stdout.write(cloud_init(
        host_update_key=update_key(operator, args.host_id) if operator else None,
        host_id=args.host_id, key=host_key(signing, args.host_id), runtime=args.runtime,
        runsc_release=args.runsc_release, apt_mirror=args.apt_mirror, bundle_url=args.bundle_url,
        bundle_sha256=args.bundle_sha256, rootfs_version=args.rootfs_version, rootfs_url=args.rootfs_url,
        rootfs_sha256=args.rootfs_sha256, domain=args.domain))


if __name__ == "__main__":
    main()
