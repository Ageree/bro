"""How a browser host comes up (operator script, stdlib only).

The project keeps at most two custom images, both in production, so a host is not an image: it boots the
stock ubuntu-22.04 and cloud-init sets it up. From Cloud.ru, GitHub and PyPI accept connections and send
nothing, and archive.ubuntu.com does not answer (30.09.2026), so a host reaches only mirror.yandex.ru (apt)
and Object Storage: everything else it needs travels in the bundle, fetched here, where they answer.

  python boot.py vendor --dir vendor/
      Caddy's static binary (GitHub release, sha256 pinned in vendor.json) and the hostd wheels
      (requirements.txt, sha256 pinned per wheel) for the host's Python 3.10 on x86_64

  python boot.py bundle --vendor vendor/ --out host-bundle.tgz
      the host code (provision.sh, hostd and its modules) with the vendored files, as a reproducible
      tarball; prints its sha256. Upload it next to the sandbox rootfs and presign a GET for each new host

  BROWSER_VM_SIGNING_KEY=… python boot.py cloud-init --host-id bro-host-1 \\
      --bundle-url … --bundle-sha256 … --rootfs-version … --rootfs-url … --rootfs-sha256 … \\
      [--runtime runc|runsc --runsc-release 20260914] [--apt-mirror …] [--domain …]
      the user data for one host (base64 it for the Compute API)

On the host, /usr/local/sbin/bro-host-boot fetches the bundle, checks its SHA-256 and runs provision.sh,
which points apt at the mirror, installs runc (or a pinned runsc), nftables and zstd, Caddy and the hostd
venv from the bundle, their systemd units, and unpacks the rootfs. Bro's own host creation
(`browserHostCloudInit` in agent/lib/browser-pool/hosts.ts) writes the same user data byte for byte, and
tests/agent/browser-pool/hosts.test.ts runs this script to hold it to that: change both together.

Boot budget (estimated; measure on the first real host): stock boot ≈ 45 s, apt ≈ 40–60 s, venv ≈ 10 s,
rootfs (≈ 0.5 GB zstd, inside Cloud.ru, 17 s on the stage 1 stand) ≈ 20–60 s, certificate ≈ 10 s — about
2–3 minutes, 6 at worst. Caddy and hostd start right after apt and the venv, before the rootfs: from then on
Bro follows `stage` on https://<domain>/h/v1/health, including a `failed:<stage>:line N`; before that a host
that does not answer is only slow. It takes sandboxes at `ready`.
"""

import argparse
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
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
FILES = ("provision.sh", "hostd.py", "network.py", "sets.py", "caddy.py", "seccomp.json", "requirements.txt")
VENDOR = json.loads((HERE / "vendor.json").read_text())
RUNTIMES = ("runc", "runsc")
RUNSC_RELEASE = re.compile(r"\d{8}(\.\d+)?")
APT_MIRROR = "http://mirror.yandex.ru/ubuntu"
# Fetches the bundle named in boot.json, checks it and hands over to provision.sh. Written by cloud-init.
BOOT_SCRIPT = r"""#!/bin/bash
set -euo pipefail
field() { python3 -c 'import json, sys
value = json.load(open("/etc/bro/boot.json"))
for key in sys.argv[1].split("."):
    value = value[key]
print(value)' "$1"; }
URL=$(field bundle.url)
SHA=$(field bundle.sha256)
for i in 1 2 3 4 5; do
  curl -fsS -m 300 -o /root/bro-host.tgz "$URL" && break
  [ "$i" = 5 ] && exit 1
  sleep $((i * 5))
done
echo "$SHA  /root/bro-host.tgz" | sha256sum -c --quiet -
mkdir -p /opt/bro/host
tar -xzf /root/bro-host.tgz -C /opt/bro/host
rm -f /root/bro-host.tgz
exec bash /opt/bro/host/provision.sh
"""


def host_key(signing_key_hex, host_id):
    """The key hostd checks tokens with: Bro derives it the same way and keeps no per-host secret."""
    return hmac.new(bytes.fromhex(signing_key_hex), f"bro-browser-host:{host_id}".encode(), hashlib.sha256).digest()


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


def bundle(vendor_dir, **pins):
    """The host code and its vendored files as a gzip tarball, byte for byte the same for the same files."""
    entries = [(name, (HERE / name).read_bytes(), 0o755 if name.endswith(".sh") else 0o644) for name in FILES]
    entries += vendored(vendor_dir, **pins)
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


def quoted(text):
    """A single-quoted YAML scalar: the JSON stays as written, a quote inside is written twice."""
    return "'" + text.replace("'", "''") + "'"


def cloud_init(*, host_id, key, bundle_url, bundle_sha256, rootfs_version, rootfs_url, rootfs_sha256,
               runtime="runc", runsc_release=None, apt_mirror=APT_MIRROR, domain=None):
    if runtime not in RUNTIMES:
        raise ValueError(f"runtime must be one of {RUNTIMES}")
    if runtime == "runsc" and not RUNSC_RELEASE.fullmatch(runsc_release or ""):
        raise ValueError("runsc needs a dated gVisor release such as 20260914 or 20260914.0")
    if not re.fullmatch(r"[a-z0-9-]{1,63}", host_id):
        raise ValueError("host id must match [a-z0-9-]{1,63}")
    if apt_mirror and not re.fullmatch(r"https?://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?", apt_mirror):
        raise ValueError("apt mirror must be a plain http(s) URL")
    identity = json.dumps({"host": host_id, "key": key.hex()})
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
        "  - path: /usr/local/sbin/bro-host-boot",
        '    permissions: "0700"',
        "    content: |",
        script.rstrip("\n"),
        "runcmd:",
        "  - [bash, -c, \"/usr/local/sbin/bro-host-boot > /var/log/bro-provision.log 2>&1\"]",
        "",
    ])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    fetch = commands.add_parser("vendor")
    fetch.add_argument("--dir", required=True)
    pack = commands.add_parser("bundle")
    pack.add_argument("--vendor", required=True)
    pack.add_argument("--out", required=True)
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
        return
    if args.command == "bundle":
        data = bundle(args.vendor)
        Path(args.out).write_bytes(data)
        print(sha256(data))
        return
    signing = "".join(os.environ.get("BROWSER_VM_SIGNING_KEY", "").split()).strip("‘’“”'\"")
    if not signing:
        sys.exit("BROWSER_VM_SIGNING_KEY is required")
    sys.stdout.write(cloud_init(
        host_id=args.host_id, key=host_key(signing, args.host_id), runtime=args.runtime,
        runsc_release=args.runsc_release, apt_mirror=args.apt_mirror, bundle_url=args.bundle_url,
        bundle_sha256=args.bundle_sha256, rootfs_version=args.rootfs_version, rootfs_url=args.rootfs_url,
        rootfs_sha256=args.rootfs_sha256, domain=args.domain))


if __name__ == "__main__":
    main()
