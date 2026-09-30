"""How a browser host comes up (operator script, stdlib only).

The project keeps at most two custom images, both in production, so a host is not an image: it boots the
stock ubuntu-22.04 and cloud-init sets it up. The user data carries only the host's identity and a few
URLs; the code comes as a bundle from Object Storage:

  python boot.py bundle --out host-bundle.tgz
      the host code (provision.sh, hostd and its modules) as a reproducible tarball; upload it next to
      the sandbox rootfs and presign a GET for each new host

  BROWSER_VM_SIGNING_KEY=… python boot.py cloud-init --host-id bro-host-1 --runsc-release 20260914 \\
      --bundle-url … --bundle-sha256 … --rootfs-version … --rootfs-url … --rootfs-sha256 … [--domain …]
      the user data for one host (base64 it for the Compute API)

On the host, /usr/local/sbin/bro-host-boot fetches the bundle, checks its SHA-256 and runs provision.sh,
which installs a pinned runsc, Caddy, nftables and zstd, the hostd venv and its systemd unit, and unpacks
the rootfs. Bro's own host creation (agent/lib/browser-vm, later) writes the same user data.

Boot budget (estimated; measure on the first real host): stock boot ≈ 45 s, apt ≈ 60–90 s, venv ≈ 20 s,
rootfs (≈ 0.5–0.8 GB zstd, inside Cloud.ru) ≈ 30–60 s, certificate ≈ 10 s — about 3–4 minutes, 6 at worst.
Bro follows it on https://<domain>/h/v1/health (`stage`) once Caddy is up.
"""

import argparse
import gzip
import hashlib
import hmac
import io
import json
import os
import re
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).parent
FILES = ("provision.sh", "hostd.py", "network.py", "sets.py", "caddy.py")
RUNSC_RELEASE = re.compile(r"\d{8}(\.\d+)?")
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
  curl -fsS -m 120 -o /root/bro-host.tgz "$URL" && break
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


def bundle():
    """The host code as a gzip tarball, byte for byte the same for the same files."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name in FILES:
            data = (HERE / name).read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.mode = len(data), 0, 0o755 if name.endswith(".sh") else 0o644
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


def quoted(text):
    """A single-quoted YAML scalar: the JSON stays as written, a quote inside is written twice."""
    return "'" + text.replace("'", "''") + "'"


def cloud_init(*, host_id, key, runsc_release, bundle_url, bundle_sha256, rootfs_version, rootfs_url,
               rootfs_sha256, domain=None):
    if not RUNSC_RELEASE.fullmatch(runsc_release):
        raise ValueError("runsc release must be a dated gVisor release such as 20260914 or 20260914.0")
    if not re.fullmatch(r"[a-z0-9-]{1,63}", host_id):
        raise ValueError("host id must match [a-z0-9-]{1,63}")
    identity = json.dumps({"host": host_id, "key": key.hex()})
    boot = json.dumps({
        "hostId": host_id, "domain": domain or "", "runscRelease": runsc_release,
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
    pack = commands.add_parser("bundle")
    pack.add_argument("--out", required=True)
    init = commands.add_parser("cloud-init")
    for name in ("host-id", "runsc-release", "bundle-url", "bundle-sha256", "rootfs-version", "rootfs-url",
                 "rootfs-sha256"):
        init.add_argument(f"--{name}", required=True)
    init.add_argument("--domain")
    args = parser.parse_args(argv)
    if args.command == "bundle":
        data = bundle()
        Path(args.out).write_bytes(data)
        print(hashlib.sha256(data).hexdigest())
        return
    signing = "".join(os.environ.get("BROWSER_VM_SIGNING_KEY", "").split()).strip("‘’“”'\"")
    if not signing:
        sys.exit("BROWSER_VM_SIGNING_KEY is required")
    sys.stdout.write(cloud_init(
        host_id=args.host_id, key=host_key(signing, args.host_id), runsc_release=args.runsc_release,
        bundle_url=args.bundle_url, bundle_sha256=args.bundle_sha256, rootfs_version=args.rootfs_version,
        rootfs_url=args.rootfs_url, rootfs_sha256=args.rootfs_sha256, domain=args.domain))


if __name__ == "__main__":
    main()
