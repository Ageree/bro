"""The code sandbox host on Cloud.ru (sandbox/README.md): keys, artifacts in Object Storage, the VM.

  python host.py key NAME
      the host key of NAME into ~/.bro-code-host/NAME.json (0600): HMAC-SHA256(SANDBOX_SIGNING_KEY,
      "bro-sandbox-host:" + NAME), as Bro derives it. SANDBOX_SIGNING_KEY is made once (32 random bytes) in
      ~/.bro-code-host/signing.json (0600); give Bro the same value
  python host.py deliver --sandboxd BIN [--rootfs out/rootfs-V.tar.zst | --rootfs-version V] [--print-urls]
      packs the bundle (sandbox/host/boot.py bundle, Caddy and runsc from ~/.bro-code-host/vendor, made by
      `boot.py vendor`), uploads it, the runsc package and the rootfs when Object Storage lacks them, and
      records keys and sha256 in ~/.bro-code-host/deliver.json. Prints presigned GET links redacted, whole
      only with --print-urls
  python host.py create NAME [--flavor gen-2-8] [--disk 30] [--no-console] [--wait-minutes 20]
                         [--hosts-entry brobro.tech=bro-app-1 …]
      the VM in CLOUDRU_ZONE (ru.AZ-1) with a public IP, cloud-init from boot.py (fresh 12-hour links), then
      waits for it to run and then for https://<ip with dashes>.sslip.io/v1/health, each up to --wait-minutes.
      Unless --no-console, root may log in on the serial console with the password in
      ~/.bro-code-host/NAME.password (the user data holds only its hash). --hosts-entry NAME=TARGET pins NAME
      in the host's /etc/hosts at TARGET, an IPv4 address or a VM of the project (its private address): Bro's
      domain at Bro's VM, since one VM of the project cannot reach another's public address
  python host.py status NAME [--stage]      state, address, health; --stage reads the provision stage over
                                            the serial console
  python host.py reboot NAME                set-power reboot (a first boot stuck in initramfs)
  python host.py update-sandboxd NAME --sandboxd BIN
                                            a new sandboxd binary on a live host (Object Storage, then the
                                            serial console): checked, swapped, restarted; sandboxes outlive
                                            the restart. Run deliver too, so new hosts get the same binary
  python host.py set-hosts NAME --hosts-entry brobro.tech=bro-app-1 …
                                            the same pins on a live host, over the serial console
  python host.py delete NAME                the VM and its public IP

Host names must match sbx-[a-z0-9-]+: this script never acts on any other VM of the project. Needs
CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET and CLOUDRU_S3_TENANT_ID; reuses the stand's Compute API, console and S3
helpers (scripts/cloudru-sandbox-probe) with their state in ~/.bro-code-host.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
STATE = Path(os.environ.get("BRO_CODE_HOST_DIR", Path.home() / ".bro-code-host"))
STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
os.environ["PROBE_STATE_DIR"] = str(STATE)  # the stand's token, project and console caches live here too
sys.path.insert(0, str(REPO / "scripts" / "cloudru-sandbox-probe"))
sys.path.insert(0, str(REPO / "sandbox" / "host"))
import boot  # noqa: E402
import cloudru  # noqa: E402
import s3  # noqa: E402

NAME = re.compile(r"sbx-[a-z0-9-]{1,59}")
VENDOR = STATE / "vendor"
DELIVERED = STATE / "deliver.json"
LINK_SECONDS = 12 * 3600


def host_name(name):
    if not NAME.fullmatch(name):
        sys.exit("host names must match sbx-[a-z0-9-]+ (this script touches no other VM)")
    return name


def write_private(path, text):
    cloudru.write_private(path, text)
    os.chmod(path, 0o600)


def signing_key():
    path = STATE / "signing.json"
    if not path.exists():
        write_private(path, json.dumps({"SANDBOX_SIGNING_KEY": secrets.token_hex(32)}) + "\n")
        print(f"made a new SANDBOX_SIGNING_KEY in {path}")
    return json.loads(path.read_text())["SANDBOX_SIGNING_KEY"]


def host_key(name):
    """The host key: derived from the signing key, never stored on its own without it."""
    return hmac.new(bytes.fromhex(signing_key()), f"bro-sandbox-host:{name}".encode(), hashlib.sha256).hexdigest()


def cmd_key(args):
    name = host_name(args.name)
    path = STATE / f"{name}.json"
    write_private(path, json.dumps({"host": name, "key": host_key(name)}) + "\n")
    print(f"host key of {name} in {path} (from {STATE / 'signing.json'})")


def redact(url):
    return url.split("?", 1)[0] + "?…"


def stored(key):
    """The size of an object in the bucket, or None."""
    return next((size for found, size in s3.listing(key) if found == key), None)


def stored_text(key):
    """A small object's text, or None when the bucket has none."""
    code, body = s3.send(urllib.request.Request(s3.presign("GET", key, 300)))
    if code not in (200, 404):
        sys.exit(f"get {key} {code}: {body[:300]!r}")
    return body.decode() if code == 200 else None


def upload(key, path=None, data=None):
    data = Path(path).read_bytes() if data is None else data
    code, body = s3.send(urllib.request.Request(s3.presign("PUT", key), data, method="PUT"))
    if code != 200:
        sys.exit(f"put {key}: {code} {body[:200]!r}")
    print(f"uploaded {key} ({len(data)} bytes)")


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def cmd_deliver(args):
    if not (VENDOR / "caddy").exists():
        sys.exit(f"no vendored Caddy: python sandbox/host/boot.py vendor --dir {VENDOR}")
    bundle = boot.bundle(VENDOR, args.sandboxd)
    bundle_sha = boot.sha256(bundle)
    bundle_key = f"sandbox/host/code-host-{bundle_sha[:16]}.tgz"
    if stored(bundle_key) != len(bundle):
        upload(bundle_key, data=bundle)

    runsc = boot.VENDOR["runsc"]
    runsc_file = VENDOR / f"runsc-{runsc['version']}.deb"
    runsc_key = f"sandbox/runsc/runsc-{runsc['version']}.deb"
    if stored(runsc_key) != runsc_file.stat().st_size:
        if file_sha256(runsc_file) != runsc["sha256"]:
            sys.exit(f"{runsc_file} is not the pinned runsc package")
        upload(runsc_key, runsc_file)

    if args.rootfs:
        match = re.fullmatch(r"rootfs-(.+)\.tar\.zst", Path(args.rootfs).name)
        if not match:
            sys.exit("--rootfs must be a rootfs-<version>.tar.zst of sandbox/image/build_rootfs.sh")
        version, rootfs_sha = match.group(1), file_sha256(args.rootfs)
        rootfs_key = f"sandbox/rootfs/{version}.tar.zst"
        # The size alone does not tell a rebuilt archive of the same version: its recorded sha256 must match too,
        # or new hosts would fetch the old bytes and fail fetch.py's check against this one.
        recorded = (stored_text(rootfs_key + ".sha256") or "").split()[:1]
        if stored(rootfs_key) != Path(args.rootfs).stat().st_size or recorded != [rootfs_sha]:
            upload(rootfs_key, args.rootfs)
            upload(rootfs_key + ".sha256", data=f"{rootfs_sha}  rootfs-{version}.tar.zst\n".encode())
    else:
        version = args.rootfs_version or json.loads(DELIVERED.read_text())["rootfs"]["version"]
        rootfs_key = f"sandbox/rootfs/{version}.tar.zst"
        recorded = stored_text(rootfs_key + ".sha256")
        if not recorded:
            sys.exit(f"no {rootfs_key}.sha256 in the bucket: deliver --rootfs FILE")
        rootfs_sha = recorded.split()[0]

    record = {
        "bundle": {"key": bundle_key, "sha256": bundle_sha, "size": len(bundle)},
        "runsc": {"release": runsc["release"], "version": runsc["version"], "key": runsc_key,
                  "sha256": runsc["sha256"]},
        "rootfs": {"version": version, "key": rootfs_key, "sha256": rootfs_sha, "size": stored(rootfs_key)},
    }
    DELIVERED.write_text(json.dumps(record, indent=1) + "\n")
    print(json.dumps(record, indent=1))
    for name in ("bundle", "runsc", "rootfs"):
        url = s3.presign("GET", record[name]["key"], LINK_SECONDS)
        print(f"{name}: {url if args.print_urls else redact(url)}")


def console_password(name):
    """A fresh root password for the serial console, kept here; the user data gets its SHA-512 crypt."""
    password = secrets.token_urlsafe(18)
    write_private(STATE / f"{name}.password", password)
    salt = secrets.token_hex(8)
    result = subprocess.run(["openssl", "passwd", "-6", "-salt", salt, "-stdin"], input=password,
                            capture_output=True, text=True, check=True)
    return result.stdout.strip()


def full_vm(vm_id):
    for attempt in range(5):  # GET /v1/vms/{id} answers 500 every so often (AZ-1, 30.09)
        code, body = cloudru.api("GET", f"/v1/vms/{vm_id}")
        if code == 200:
            return body
        time.sleep(3)
    sys.exit(f"read vm {code}: {body}")


def public_ip(vm):
    for interface in vm.get("interfaces") or []:
        floating = interface.get("floating_ip") or {}
        if floating.get("ip_address"):
            return floating["ip_address"], floating.get("id")
    return None, None


def health(domain, timeout=15):
    try:
        with urllib.request.urlopen(f"https://{domain}/v1/health", timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, error.read()[:200]
    except (urllib.error.URLError, OSError, ValueError) as error:
        return None, str(error)[:200]


def cmd_create(args):
    name = host_name(args.name)
    if cloudru.vm_by_name(name):
        sys.exit(f"{name} exists already")
    key_file = STATE / f"{name}.json"
    if not key_file.exists():
        sys.exit(f"no host key: python host.py key {name}")
    key = json.loads(key_file.read_text())["key"]
    if key != host_key(name):
        sys.exit(f"{key_file} is not derived from the current signing key: python host.py key {name}")
    record = json.loads(DELIVERED.read_text())
    user_data = boot.cloud_init(
        host_id=name, key=bytes.fromhex(key),
        bundle_url=s3.presign("GET", record["bundle"]["key"], LINK_SECONDS),
        bundle_sha256=record["bundle"]["sha256"],
        rootfs_version=record["rootfs"]["version"],
        rootfs_url=s3.presign("GET", record["rootfs"]["key"], LINK_SECONDS),
        rootfs_sha256=record["rootfs"]["sha256"],
        runsc_release=record["runsc"]["release"],
        runsc_url=s3.presign("GET", record["runsc"]["key"], LINK_SECONDS),
        runsc_sha256=record["runsc"]["sha256"],
        console_password_hash=None if args.no_console else console_password(name),
        hosts=hosts_entries(args.hosts_entry))
    interface = {"type": "regular", "subnet_name": cloudru.SUBNET, "new_external_ip": True,
                 "security_group_names": [cloudru.SECURITY_GROUP]}
    vm = {"project_id": cloudru.project_id(), "name": name, "availability_zone_name": cloudru.ZONE,
          "flavor_name": args.flavor, "image_name": "ubuntu-22.04",
          "disks": [{"name": name + "-disk", "size": args.disk, "disk_type_name": "SSD"}],
          "interfaces": [interface], "cloud_init": base64.b64encode(user_data.encode()).decode()}
    started = time.time()
    code, body = cloudru.api("POST", "/v1.1/vms", [vm])
    if code != 201:
        sys.exit(f"create {code}: {json.dumps(body, ensure_ascii=False)[:600]}")
    print(f"create {name} ({args.flavor}, {args.disk} GB) in {cloudru.ZONE}", flush=True)
    ip = None
    deadline = started + args.wait_minutes * 60
    while True:
        found = cloudru.vm_by_name(name)
        state = found and found["state"]
        if found and not ip:
            ip, _ = public_ip(full_vm(found["id"]))
        print(f"+{time.time() - started:.0f}s {state} {ip or ''}", flush=True)
        if state == "running" and ip:
            break
        if state in ("error", "failed"):
            sys.exit(f"{name} is {state}")
        if time.time() > deadline:
            sys.exit(f"{name} is {state} {ip or 'without a public IP'} after {args.wait_minutes} minutes: "
                     f"python host.py status {name}, or python host.py delete {name}")
        time.sleep(10)
    domain = ip.replace(".", "-") + ".sslip.io"
    print(f"running at {ip}; waiting for https://{domain}/v1/health", flush=True)
    deadline = time.time() + args.wait_minutes * 60
    while time.time() < deadline:
        code, body = health(domain)
        if code == 200:
            print(f"+{time.time() - started:.0f}s healthy: {json.dumps(body)}")
            return
        print(f"+{time.time() - started:.0f}s health: {code or body}", flush=True)
        time.sleep(15)
    sys.exit(f"no health after {args.wait_minutes} minutes: python host.py status {name} --stage "
             f"(a first boot stuck in initramfs: python host.py reboot {name})")


def hosts_entries(entries):
    """[(name, IPv4)] of --hosts-entry NAME=TARGET, a VM's name as TARGET read as its private address."""
    pinned = []
    for entry in entries:
        name, address = boot.hosts_entry(entry)
        if not boot.IPV4.fullmatch(address):
            vm = cloudru.vm_by_name(address)
            private = [i.get("ip_address") for i in ((vm or {}).get("interfaces") or []) if i.get("ip_address")]
            if not private:
                sys.exit(f"--hosts-entry {entry}: no VM {address} with a private address in the project")
            address = private[0]
        pinned.append((name, address))
    return pinned


def found_vm(name):
    vm = cloudru.vm_by_name(host_name(name))
    if vm is None:
        sys.exit(f"no VM {name}")
    return full_vm(vm["id"])


def cmd_status(args):
    vm = found_vm(args.name)
    ip, _ = public_ip(vm)
    domain = ip and ip.replace(".", "-") + ".sslip.io"
    print(json.dumps({"name": vm["name"], "id": vm["id"], "state": vm["state"],
                      "flavor": (vm.get("flavor") or {}).get("name"), "ip": ip, "domain": domain}))
    if domain:
        code, body = health(domain)
        print(f"health: {code} {json.dumps(body) if code == 200 else body}")
    if args.stage:
        import console  # websocket-client, only here
        output, status = console.run(args.name, "cat /var/lib/bro/stage; cat /var/lib/bro/timeline; "
                                     "tail -n 15 /var/log/bro-provision.log", 60)
        print(output)


def cmd_reboot(args):
    vm = found_vm(args.name)
    code, body = cloudru.api("POST", f"/v1/vms/{vm['id']}/set-power", {"state": "reboot"})
    print("set-power reboot", code, body if code >= 300 else "")


def cmd_update_sandboxd(args):
    import console  # websocket-client, only here
    found_vm(args.name)
    binary = Path(args.sandboxd).read_bytes()
    if not binary.startswith(b"\x7fELF"):
        sys.exit(f"{args.sandboxd} is not a Linux binary")
    digest = boot.sha256(binary)
    key = f"sandbox/host/sandboxd-{digest[:16]}"
    if stored(key) != len(binary):
        upload(key, data=binary)
    unit = (REPO / "sandbox" / "host" / "sandboxd.service").read_text()
    target = re.search(r"^ExecStart=(/\S+)", unit, re.M).group(1)
    url = s3.presign("GET", key, 900)
    output, status = console.run(args.name, (
        f"curl -fsS -m 300 -o {target}.new '{url}' && echo '{digest}  {target}.new' | sha256sum -c --quiet - "
        f"&& chmod 755 {target}.new && mv -f {target}.new {target} && systemctl restart sandboxd && sleep 2 "
        f"&& curl -fsS -m 10 http://127.0.0.1:8091/v1/health"), 360)
    # Only the last line: the console may echo the command, and the command holds the presigned link.
    print(f"update {digest[:16]}: exit {status}; {output.strip().splitlines()[-1][-300:] if output.strip() else ''}")
    if status != 0:
        sys.exit(1)


def cmd_set_hosts(args):
    import console  # websocket-client, only here
    found_vm(args.name)
    pinned = hosts_entries(args.hosts_entry)
    lines = "".join(f"{address} {name} # bro-private\\n" for name, address in pinned)
    names = "|".join(re.escape(name) for name, _ in pinned) or "^$"
    output, status = console.run(args.name, (
        f"sed -i -E '/# bro-private$/d; /^[^#]*[[:space:]]({names})([[:space:]]|$)/d' /etc/hosts && "
        f"printf '{lines}' >> /etc/hosts && grep -c 'bro-private' /etc/hosts"), 60)
    print(f"set-hosts: exit {status}; {output.strip().splitlines()[-1][-200:] if output.strip() else ''}")
    if status != 0:
        sys.exit(1)


def cmd_delete(args):
    vm = found_vm(args.name)
    _, floating_id = public_ip(vm)
    attachments = {"external_ips": [floating_id] if floating_id else []}
    code, body = cloudru.api("DELETE", f"/v1/vms/{vm['id']}", {"delete_attachments": attachments})
    if code >= 300:
        sys.exit(f"delete vm {code}: {body}")
    print("delete vm", code)
    while cloudru.vm_by_name(args.name) is not None:
        time.sleep(10)
    # A floating IP the VM's deletion left behind stays billed.
    if floating_id and any(ip["id"] == floating_id for ip in cloudru.floating_ips()):
        print("delete ip", cloudru.api("DELETE", f"/v1/floating-ips/{floating_id}")[0])
    print(f"{args.name} deleted")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    key = sub.add_parser("key")
    key.add_argument("name")
    key.set_defaults(fn=cmd_key)
    deliver = sub.add_parser("deliver")
    deliver.add_argument("--sandboxd", required=True)
    rootfs = deliver.add_mutually_exclusive_group()
    rootfs.add_argument("--rootfs")
    rootfs.add_argument("--rootfs-version")
    deliver.add_argument("--print-urls", action="store_true")
    deliver.set_defaults(fn=cmd_deliver)
    create = sub.add_parser("create")
    create.add_argument("name")
    create.add_argument("--flavor", default="gen-2-8")
    create.add_argument("--disk", type=int, default=30)
    create.add_argument("--no-console", action="store_true")
    create.add_argument("--wait-minutes", type=int, default=20)
    create.add_argument("--hosts-entry", action="append", default=[], metavar="NAME=TARGET")
    create.set_defaults(fn=cmd_create)
    status = sub.add_parser("status")
    status.add_argument("name")
    status.add_argument("--stage", action="store_true")
    status.set_defaults(fn=cmd_status)
    update = sub.add_parser("update-sandboxd")
    update.add_argument("name")
    update.add_argument("--sandboxd", required=True)
    update.set_defaults(fn=cmd_update_sandboxd)
    set_hosts = sub.add_parser("set-hosts")
    set_hosts.add_argument("name")
    set_hosts.add_argument("--hosts-entry", action="append", required=True, metavar="NAME=TARGET")
    set_hosts.set_defaults(fn=cmd_set_hosts)
    for name, fn in (("reboot", cmd_reboot), ("delete", cmd_delete)):
        command = sub.add_parser(name)
        command.add_argument("name")
        command.set_defaults(fn=fn)
    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
