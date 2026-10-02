"""How Bro's own VM comes up on Cloud.ru (stdlib only; scripts/cloudru-app-host/README.md).

The stock ubuntu-22.04 of Cloud.ru, set up by cloud-init the way the code sandbox host is
(sandbox/host/boot.py): from Cloud.ru only mirror.yandex.ru (apt) and Object Storage answer reliably, so
Caddy, Node and the PostgreSQL client travel there from the session, pinned by sha256 in vendor.json.

  vendor(dir)        Caddy's static binary (GitHub release), Node's linux-x64 tarball (nodejs.org) and the
                     PostgreSQL 18 client packages for jammy (apt.postgresql.org: libpq5,
                     postgresql-client-common, postgresql-client-18), each checked against its pin
  bundle(vendor)     provision.sh, deployd.py, watchdog.py, the units and Caddy as a reproducible tarball
  cloud_init(...)    the user data for one VM: the boot settings, deployd's identity and the boot script

On the VM, /usr/local/sbin/bro-app-host-boot fetches the bundle, checks its SHA-256 and runs provision.sh.
"""

import gzip
import hashlib
import io
import json
import re
import tarfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
FILES = ("provision.sh", "deployd.py", "watchdog.py", "bro-web.service", "bro-eve.service", "deployd.service",
         "bro-watchdog.service", "bro-watchdog.timer", "caddy.service")
VENDOR = json.loads((HERE / "vendor.json").read_text())
HOST_ID = re.compile(r"[a-z0-9-]{1,63}")
SHA256 = re.compile(r"[0-9a-f]{64}")
APT_MIRROR = "http://mirror.yandex.ru/ubuntu"
BOOT_SCRIPT = r"""#!/bin/bash
set -euo pipefail
field() { python3 -c 'import json, sys
value = json.load(open("/etc/bro/app-host-boot.json"))
for key in sys.argv[1].split("."):
    value = value[key]
print(value)' "$1"; }
URL=$(field bundle.url)
SHA=$(field bundle.sha256)
for i in $(seq 1 40); do
  curl -fsS --connect-timeout 10 -m 300 -o /root/bro-app-host.tgz "$URL" && break
  [ "$i" = 40 ] && exit 1
  sleep 10
done
echo "$SHA  /root/bro-app-host.tgz" | sha256sum -c --quiet -
rm -rf /opt/bro/app-host
mkdir -p /opt/bro/app-host
tar -xzf /root/bro-app-host.tgz -C /opt/bro/app-host
rm -f /root/bro-app-host.tgz
exec bash /opt/bro/app-host/provision.sh
"""


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def vendor_objects():
    """[(file name in the vendor directory, pinned sha256)] of what goes to Object Storage on its own."""
    node = VENDOR["node"]
    objects = [(Path(node["url"]).name, node["sha256"])]
    objects += [(Path(p["url"]).name, p["sha256"]) for p in VENDOR["postgresqlClient"]["packages"]]
    return objects


def download(url, expected):
    with urllib.request.urlopen(url, timeout=600) as response:
        data = response.read()
    if sha256(data) != expected:
        raise SystemExit(f"{url} is not the pinned file")
    return data


def vendor(target):
    """Fetch Caddy, Node and the PostgreSQL client by their pins (where GitHub, nodejs.org and PGDG answer)."""
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    caddy = VENDOR["caddy"]
    if not (target / "caddy").exists() or sha256((target / "caddy").read_bytes()) != caddy["binarySha256"]:
        with tarfile.open(fileobj=io.BytesIO(download(caddy["url"], caddy["sha256"])), mode="r:gz") as tar:
            binary = tar.extractfile("caddy").read()
        if sha256(binary) != caddy["binarySha256"]:
            raise SystemExit("the Caddy archive holds another binary than the pinned one")
        (target / "caddy").write_bytes(binary)
        (target / "caddy").chmod(0o755)
    urls = {Path(VENDOR["node"]["url"]).name: VENDOR["node"]["url"]}
    urls.update({Path(p["url"]).name: p["url"] for p in VENDOR["postgresqlClient"]["packages"]})
    for name, pin in vendor_objects():
        path = target / name
        if path.exists() and sha256(path.read_bytes()) == pin:
            continue
        path.write_bytes(download(urls[name], pin))


def bundle(vendor_dir, *, caddy_sha256=None):
    """The host code and Caddy as a gzip tarball, byte for byte the same for the same files."""
    binary = (Path(vendor_dir) / "caddy").read_bytes()
    if sha256(binary) != (caddy_sha256 or VENDOR["caddy"]["binarySha256"]):
        raise ValueError("vendor/caddy is not the pinned Caddy binary")
    entries = [(name, (HERE / name).read_bytes(), 0o755 if name.endswith((".sh", ".py")) else 0o644)
               for name in FILES]
    entries.append(("vendor/caddy", binary, 0o755))
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, data, mode in entries:
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.mode = len(data), 0, mode
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


def quoted(text):
    """A single-quoted YAML scalar: the JSON stays as written, a quote inside is written twice."""
    return "'" + text.replace("'", "''") + "'"


def cloud_init(*, host_id, key, bundle_url, bundle_sha256, objects, apt_mirror=APT_MIRROR, domain=None,
               console_password_hash=None):
    """`objects`: {file name: {url, sha256}} of every vendor_objects() file, presigned GET links."""
    if not HOST_ID.fullmatch(host_id):
        raise ValueError("host id must match [a-z0-9-]{1,63}")
    if len(key) != 32:
        raise ValueError("the host key is 32 bytes")
    for name, pin in [("bundle", bundle_sha256)] + [(n, (objects.get(n) or {}).get("sha256", ""))
                                                   for n, _ in vendor_objects()]:
        if not SHA256.fullmatch(pin):
            raise ValueError(f"{name}: sha256 must be 64 lower-case hex characters")
    for name, pin in vendor_objects():
        if objects[name]["sha256"] != pin:
            raise ValueError(f"{name} is not the pinned file")
    if apt_mirror and not re.fullmatch(r"https?://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?", apt_mirror):
        raise ValueError("apt mirror must be a plain http(s) URL")
    if domain and not re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+", domain):
        raise ValueError("domain must be a plain host name")
    if console_password_hash and not re.fullmatch(r"\$6\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}",
                                                  console_password_hash):
        raise ValueError("the console password must be a SHA-512 crypt hash ($6$…)")
    identity = json.dumps({"host": host_id, "key": key.hex()})
    node = VENDOR["node"]
    boot = json.dumps({
        "hostId": host_id, "domain": domain or "", "aptMirror": apt_mirror or "",
        "bundle": {"url": bundle_url, "sha256": bundle_sha256},
        "node": {"version": node["version"], **objects[Path(node["url"]).name]},
        "postgresqlClient": [{"name": Path(p["url"]).name, **objects[Path(p["url"]).name]}
                             for p in VENDOR["postgresqlClient"]["packages"]],
    })
    script = "".join(f"      {line}\n" if line else "\n" for line in BOOT_SCRIPT.splitlines())
    lines = [
        "#cloud-config",
        "write_files:",
        "  - path: /etc/bro/deployd.json",
        '    permissions: "0600"',
        f"    content: {quoted(identity)}",
        "  - path: /etc/bro/app-host-boot.json",
        '    permissions: "0600"',
        f"    content: {quoted(boot)}",
        "  - path: /usr/local/sbin/bro-app-host-boot",
        '    permissions: "0700"',
        "    content: |",
        script.rstrip("\n"),
    ]
    if console_password_hash:
        lines += ["ssh_pwauth: false", "chpasswd:", "  expire: false", "  users:",
                  f"    - {{name: root, password: {quoted(console_password_hash)}, type: hash}}"]
    lines += [
        "runcmd:",
        "  - [bash, -c, \"/usr/local/sbin/bro-app-host-boot > /var/log/bro-provision.log 2>&1\"]",
        "",
    ]
    return "\n".join(lines)
