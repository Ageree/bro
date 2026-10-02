"""How a code sandbox host comes up (operator script, stdlib only; sandbox/README.md).

A code host is the stock ubuntu-22.04 of Cloud.ru set up by cloud-init, as the browser pool's hosts are
(browser-vm/host/boot.py). From Cloud.ru, GitHub and PyPI accept connections and send nothing and
archive.ubuntu.com does not answer (30.09.2026): the host reaches only mirror.yandex.ru (apt) and Object
Storage, and everything else travels there from here.

  python boot.py vendor --dir vendor/
      Caddy's static binary (GitHub release) and the runsc package of the pinned gVisor release (its dated
      apt repository), each checked against its sha256 in vendor.json

  python boot.py bundle --vendor vendor/ --sandboxd sandboxd --out code-host.tgz
      provision.sh, fetch.py, the sandboxd unit and binary and Caddy as a reproducible tarball; prints its
      sha256. The runsc package and the rootfs go to Object Storage as objects of their own

  SANDBOX_SIGNING_KEY=… python boot.py cloud-init --host-id sbx-code-1 \\
      --bundle-url … --bundle-sha256 … --rootfs-version … --rootfs-url … --rootfs-sha256 … \\
      --runsc-url … --runsc-sha256 … [--runsc-release 20260928] [--apt-mirror …] [--domain …] \\
      [--console-password-hash '$6$…'] [--hosts-entry brobro.tech=10.0.1.7 …]
      the user data for one host (base64 it for the Compute API). Without --domain the host serves
      <its public IP with dashes>.sslip.io. The runsc package comes from Object Storage too (the vendored one):
      gVisor's own apt repository is untested from Cloud.ru. The console password hash, when given, lets
      root log in on the serial console (there is no SSH). Each --hosts-entry pins a name in the host's
      /etc/hosts: Bro's own domain at its VM's private address, since from one VM of the project another's
      public address cannot be reached (02.10.2026) and sandboxd calls Bro's tool router by that name

On the host, /usr/local/sbin/bro-code-host-boot fetches the bundle, checks its SHA-256 and runs
provision.sh. The host key in /etc/bro/sandboxd.json is HMAC-SHA256(SANDBOX_SIGNING_KEY,
"bro-sandbox-host:" + host id), as Bro derives it (sandboxHostKey in agent/lib/sandbox/keys.ts).
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
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
FILES = ("provision.sh", "fetch.py", "sandboxd.service")
VENDOR = json.loads((HERE / "vendor.json").read_text())
HOST_ID = re.compile(r"[a-z0-9-]{1,63}")
ROOTFS_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
RUNSC_RELEASE = re.compile(r"\d{8}(\.\d+)?")
SHA256 = re.compile(r"[0-9a-f]{64}")
HOST_NAME = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+")
IPV4 = re.compile(r"(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}")
APT_MIRROR = "http://mirror.yandex.ru/ubuntu"
# Fetches the bundle named in the boot settings, checks it and hands over to provision.sh. Written by
# cloud-init, which runs it once per instance: it waits up to 40 attempts 10 s apart for the network, since in
# ru.AZ-1 a new VM boots while its public address is still being attached (no DNS or egress for 3+ minutes).
BOOT_SCRIPT = r"""#!/bin/bash
set -euo pipefail
field() { python3 -c 'import json, sys
value = json.load(open("/etc/bro/code-host-boot.json"))
for key in sys.argv[1].split("."):
    value = value[key]
print(value)' "$1"; }
URL=$(field bundle.url)
SHA=$(field bundle.sha256)
for i in $(seq 1 40); do
  curl -fsS --connect-timeout 10 -m 300 -o /root/bro-code-host.tgz "$URL" && break
  [ "$i" = 40 ] && exit 1
  sleep 10
done
echo "$SHA  /root/bro-code-host.tgz" | sha256sum -c --quiet -
rm -rf /opt/bro/code-host
mkdir -p /opt/bro/code-host
tar -xzf /root/bro-code-host.tgz -C /opt/bro/code-host
rm -f /root/bro-code-host.tgz
exec bash /opt/bro/code-host/provision.sh
"""


def host_key(signing_key_hex, host_id):
    """The key sandboxd checks tokens with: Bro derives it the same way and keeps no per-host secret."""
    return hmac.new(bytes.fromhex(signing_key_hex), f"bro-sandbox-host:{host_id}".encode(), hashlib.sha256).digest()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def vendored(vendor_dir, *, caddy_sha256=None):
    """[(path in the bundle, bytes, mode)] of the vendored files, each checked against its pin."""
    binary = (Path(vendor_dir) / "caddy").read_bytes()
    if sha256(binary) != (caddy_sha256 or VENDOR["caddy"]["binarySha256"]):
        raise ValueError("vendor/caddy is not the pinned Caddy binary")
    return [("vendor/caddy", binary, 0o755)]


def bundle(vendor_dir, sandboxd, **pins):
    """The host code, sandboxd and Caddy as a gzip tarball, byte for byte the same for the same files."""
    binary = Path(sandboxd).read_bytes()
    if not binary.startswith(b"\x7fELF"):
        raise ValueError(f"{sandboxd} is not a Linux binary")
    entries = [(name, (HERE / name).read_bytes(), 0o755 if name.endswith(".sh") else 0o644) for name in FILES]
    entries += [("sandboxd", binary, 0o755)] + vendored(vendor_dir, **pins)
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, data, mode in entries:
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.mode = len(data), 0, mode
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


def download(url, expected):
    with urllib.request.urlopen(url, timeout=600) as response:
        data = response.read()
    if sha256(data) != expected:
        raise SystemExit(f"{url} is not the pinned file")
    return data


def vendor(target):
    """Fetch Caddy and the runsc package (run where GitHub and Google answer: the operator or a session)."""
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    caddy = VENDOR["caddy"]
    with tarfile.open(fileobj=io.BytesIO(download(caddy["url"], caddy["sha256"])), mode="r:gz") as tar:
        binary = tar.extractfile("caddy").read()
    if sha256(binary) != caddy["binarySha256"]:
        raise SystemExit("the Caddy archive holds another binary than the pinned one")
    (target / "caddy").write_bytes(binary)
    (target / "caddy").chmod(0o755)
    runsc = VENDOR["runsc"]
    (target / f"runsc-{runsc['version']}.deb").write_bytes(download(runsc["url"], runsc["sha256"]))


def quoted(text):
    """A single-quoted YAML scalar: the JSON stays as written, a quote inside is written twice."""
    return "'" + text.replace("'", "''") + "'"


def cloud_init(*, host_id, key, bundle_url, bundle_sha256, rootfs_version, rootfs_url, rootfs_sha256,
               runsc_url, runsc_sha256, runsc_release=None, apt_mirror=APT_MIRROR, domain=None,
               console_password_hash=None, hosts=()):
    runsc_release = runsc_release or VENDOR["runsc"]["release"]
    if not HOST_ID.fullmatch(host_id):
        raise ValueError("host id must match [a-z0-9-]{1,63}")
    if len(key) != 32:
        raise ValueError("the host key is 32 bytes")
    if not ROOTFS_VERSION.fullmatch(rootfs_version):
        raise ValueError("rootfs version must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}")
    # A dated release, never the moving `release` suite: what runs sandboxes changes only with a new host.
    if not RUNSC_RELEASE.fullmatch(runsc_release):
        raise ValueError("runsc needs a dated gVisor release such as 20260928")
    if not runsc_url:
        raise ValueError("the runsc package needs its Object Storage URL (boot.py vendor, then upload it)")
    for name, digest in (("bundle", bundle_sha256), ("rootfs", rootfs_sha256), ("runsc", runsc_sha256 or "")):
        if not SHA256.fullmatch(digest):
            raise ValueError(f"{name} sha256 must be 64 lower-case hex characters")
    if apt_mirror and not re.fullmatch(r"https?://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?", apt_mirror):
        raise ValueError("apt mirror must be a plain http(s) URL")
    if domain and not re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+", domain):
        raise ValueError("domain must be a plain host name")
    if console_password_hash and not re.fullmatch(r"\$6\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}",
                                                  console_password_hash):
        raise ValueError("the console password must be a SHA-512 crypt hash ($6$…)")
    for name, address in hosts:
        if not HOST_NAME.fullmatch(name) or not IPV4.fullmatch(address):
            raise ValueError("a hosts entry is a plain host name and an IPv4 address")
    # sandboxd's own config (unknown keys are an error there): who it is, its key, which rootfs it runs.
    identity = json.dumps({"host": host_id, "key": key.hex(), "rootfs_version": rootfs_version})
    boot = json.dumps({
        "hostId": host_id, "domain": domain or "", "aptMirror": apt_mirror or "",
        "bundle": {"url": bundle_url, "sha256": bundle_sha256},
        "rootfs": {"version": rootfs_version, "url": rootfs_url, "sha256": rootfs_sha256},
        "runsc": {"release": runsc_release, "url": runsc_url, "sha256": runsc_sha256},
        "hosts": [{"name": name, "address": address} for name, address in hosts],
    })
    script = "".join(f"      {line}\n" if line else "\n" for line in BOOT_SCRIPT.splitlines())
    lines = [
        "#cloud-config",
        "write_files:",
        "  - path: /etc/bro/sandboxd.json",
        '    permissions: "0600"',
        f"    content: {quoted(identity)}",
        "  - path: /etc/bro/code-host-boot.json",
        '    permissions: "0600"',
        f"    content: {quoted(boot)}",
        "  - path: /usr/local/sbin/bro-code-host-boot",
        '    permissions: "0700"',
        "    content: |",
        script.rstrip("\n"),
    ]
    if console_password_hash:
        # Serial console only: no SSH password login (port 22 is closed by the security group anyway).
        lines += ["ssh_pwauth: false", "chpasswd:", "  expire: false", "  users:",
                  f"    - {{name: root, password: {quoted(console_password_hash)}, type: hash}}"]
    lines += [
        "runcmd:",
        "  - [bash, -c, \"/usr/local/sbin/bro-code-host-boot > /var/log/bro-provision.log 2>&1\"]",
        "",
    ]
    return "\n".join(lines)


def hosts_entry(text):
    """'brobro.tech=10.0.1.7' -> ('brobro.tech', '10.0.1.7')."""
    name, sep, address = text.partition("=")
    if not sep:
        raise SystemExit(f"--hosts-entry takes NAME=IPV4, not {text!r}")
    return name.strip().lower(), address.strip()


def signing_key_from_env():
    signing = "".join(os.environ.get("SANDBOX_SIGNING_KEY", "").split()).strip("‘’“”'\"")
    if not re.fullmatch(r"(?:[0-9a-fA-F]{2}){32,}", signing):
        sys.exit("SANDBOX_SIGNING_KEY (at least 32 bytes in hex) is required")
    return signing


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    fetch = commands.add_parser("vendor")
    fetch.add_argument("--dir", required=True)
    pack = commands.add_parser("bundle")
    pack.add_argument("--vendor", required=True)
    pack.add_argument("--sandboxd", required=True)
    pack.add_argument("--out", required=True)
    init = commands.add_parser("cloud-init")
    for name in ("host-id", "bundle-url", "bundle-sha256", "rootfs-version", "rootfs-url", "rootfs-sha256",
                 "runsc-url", "runsc-sha256"):
        init.add_argument(f"--{name}", required=True)
    for name in ("runsc-release", "domain", "console-password-hash"):
        init.add_argument(f"--{name}")
    init.add_argument("--apt-mirror", default=APT_MIRROR)
    init.add_argument("--hosts-entry", action="append", default=[], metavar="NAME=IPV4")
    args = parser.parse_args(argv)
    if args.command == "vendor":
        vendor(args.dir)
        return
    if args.command == "bundle":
        data = bundle(args.vendor, args.sandboxd)
        Path(args.out).write_bytes(data)
        print(sha256(data))
        return
    sys.stdout.write(cloud_init(
        host_id=args.host_id, key=host_key(signing_key_from_env(), args.host_id),
        bundle_url=args.bundle_url, bundle_sha256=args.bundle_sha256, rootfs_version=args.rootfs_version,
        rootfs_url=args.rootfs_url, rootfs_sha256=args.rootfs_sha256, runsc_release=args.runsc_release,
        runsc_url=args.runsc_url, runsc_sha256=args.runsc_sha256, apt_mirror=args.apt_mirror,
        domain=args.domain, console_password_hash=args.console_password_hash,
        hosts=[hosts_entry(entry) for entry in args.hosts_entry]))


if __name__ == "__main__":
    main()
