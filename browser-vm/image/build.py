"""Build the Bro browser image in Cloud.ru Evolution (operator script, stdlib only).

  python build.py [--version 2026-09-28.1] [--disk 10] [--keep-builder]

1. A builder VM from ubuntu-22.04 runs provision.sh (cloud-init carries it and the worker, no secrets),
   shows its stage at https://<ip>.sslip.io/stage, seals itself and powers off.
2. Its boot disk becomes the image `bro-browser-<version>` (POST /api/v1/images with disk_id).
3. The builder VM, its disk and its address are deleted.

Needs CLOUDRU_KEY_ID and CLOUDRU_KEY_SECRET. Also ensures the shared security group `bro-browser`
(HTTPS in for the worker, HTTP in for Let's Encrypt, all out) that every person's VM joins.
"""

import argparse
import base64
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
WORKER = HERE.parent / "worker"
COMPUTE = "https://compute.api.cloud.ru/api"
ZONE = os.environ.get("CLOUDRU_ZONE", "ru.AZ-3")
SECURITY_GROUP = os.environ.get("CLOUDRU_SECURITY_GROUP", "bro-browser")
_token = {}


def clean(value):
    """Keys arrive with line breaks inside or wrapped in typographic quotes; either breaks the header."""
    return "".join(value.split()).strip("‘’“”'\"")


def http(method, url, body=None, headers=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data, {"Content-Type": "application/json", **(headers or {})}, method=method)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload, code = response.read(), response.status
            break
        except urllib.error.HTTPError as error:
            payload, code = error.read(), error.code
            break
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if attempt == 4:
                raise
            time.sleep(2 ** (attempt + 1))
    try:
        return code, json.loads(payload)
    except ValueError:
        return code, payload.decode(errors="replace")


def api(method, url, body=None):
    if time.time() - _token.get("at", 0) > 3000:
        code, out = http("POST", "https://iam.api.cloud.ru/api/v1/auth/token",
                         {"keyId": clean(os.environ["CLOUDRU_KEY_ID"]), "secret": clean(os.environ["CLOUDRU_KEY_SECRET"])})
        assert code == 200, (code, out)
        _token.update(value=out["access_token"], at=time.time())
    return http(method, url, body, {"Authorization": "Bearer " + _token["value"]})


def project_id():
    if os.environ.get("CLOUDRU_PROJECT_ID"):
        return os.environ["CLOUDRU_PROJECT_ID"]
    _, customers = api("GET", "https://organization.api.cloud.ru/v1/customers")
    customer = customers["customers"][0]["customer_id"]
    _, projects = api("GET", f"https://organization.api.cloud.ru/v1/projects?customer_ids={customer}")
    return projects["projects"][0]["id"]


def ensure_security_group(project):
    """The shared group with its three rules; a new group accepts rules only once it is `created`."""
    _, groups = api("GET", f"{COMPUTE}/v1/security-groups?project_id={project}")
    group = next((g for g in groups["items"] if g["name"] == SECURITY_GROUP), None)
    if not group:
        code, group = api("POST", f"{COMPUTE}/v1/security-groups",
                          {"project_id": project, "name": SECURITY_GROUP, "availability_zone_name": ZONE,
                           "description": "Bro browser VMs: HTTPS to the worker, HTTP for Let's Encrypt, all egress"})
        assert code < 300, (code, group)
    for _ in range(60):
        _, current = api("GET", f"{COMPUTE}/v1/security-groups/{group['id']}")
        if current.get("state") == "created":
            break
        time.sleep(2)
    _, existing = api("GET", f"{COMPUTE}/v1/security-groups/{group['id']}/rules")
    have = {(r["direction"], r["port_range"]) for r in existing.get("items", [])}
    for rule in [{"direction": "ingress", "ip_protocol": "tcp", "port_range": "80:80"},
                 {"direction": "ingress", "ip_protocol": "tcp", "port_range": "443:443"},
                 {"direction": "egress", "ip_protocol": "any", "port_range": "any"}]:
        if (rule["direction"], rule["port_range"]) in have:
            continue
        code, out = api("POST", f"{COMPUTE}/v1/security-groups/{group['id']}/rules",
                        {**rule, "ether_type": "IPv4", "remote_ip_prefix": "0.0.0.0/0"})
        assert code < 300, (code, out)
    return group["id"]


def gz64(path):
    return base64.b64encode(gzip.compress(path.read_bytes(), 9)).decode()


def cloud_init(version):
    files = [("/opt/bro/image/provision.sh", HERE / "provision.sh", "0755"),
             ("/opt/bro/worker/worker.py", WORKER / "worker.py", "0644"),
             ("/opt/bro/worker/jev_segment.py", WORKER / "jev_segment.py", "0644")]
    lines = ["#cloud-config", "write_files:"]
    for target, source, mode in files:
        lines += [f"  - path: {target}", f'    permissions: "{mode}"', "    encoding: gz+b64",
                  f"    content: {gz64(source)}"]
    lines += ["runcmd:",
              f"  - [bash, -c, 'IMAGE_VERSION={version} /opt/bro/image/provision.sh > /var/log/bro-provision.log 2>&1']"]
    return "\n".join(lines) + "\n"


def wait(check, what, limit, every=5):
    started, seen = time.time(), None
    while time.time() - started < limit:
        value = check()
        if value is not None and value != seen:
            print(f"+{time.time() - started:6.0f}s {what}: {value}", flush=True)
            seen = value
        if isinstance(value, str) and (value.startswith("done") or value.startswith("failed")):
            return value, time.time() - started
        time.sleep(every)
    sys.exit(f"timed out waiting for {what}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default=time.strftime("%Y%m%d-%H%M"))
    parser.add_argument("--disk", type=int, default=10)
    parser.add_argument("--flavor", default="gen-2-4")
    parser.add_argument("--keep-builder", action="store_true")
    parser.add_argument("--no-warm", action="store_true", help="skip the throwaway VM that lays the image out")
    args = parser.parse_args()
    project = project_id()
    ensure_security_group(project)
    name = f"bro-image-builder-{args.version}".replace(".", "-")
    image_name = f"bro-browser-{args.version}".replace(".", "-")
    user_data = cloud_init(args.version)
    print(f"cloud-init: {len(user_data)} bytes")
    started = time.time()
    code, out = api("POST", f"{COMPUTE}/v1.1/vms", [{
        "project_id": project, "name": name, "availability_zone_name": ZONE, "flavor_name": args.flavor,
        "image_name": "ubuntu-22.04",
        "disks": [{"name": f"{name}-boot", "size": args.disk, "disk_type_name": "SSD"}],
        "interfaces": [{"type": "regular", "subnet_name": f"Default_{ZONE}", "new_external_ip": True,
                        "security_group_names": [SECURITY_GROUP]}],
        "cloud_init": base64.b64encode(user_data.encode()).decode(),
    }])
    assert code < 300, (code, out)
    vm_id = out[0]["id"]
    vm, ip = None, None
    while not ip:
        _, vm = api("GET", f"{COMPUTE}/v1/vms/{vm_id}")
        ip = next((i["floating_ip"]["ip_address"] for i in vm.get("interfaces", []) if i.get("floating_ip")), None)
        time.sleep(3)
    host = f"https://{ip.replace('.', '-')}.sslip.io"
    print(f"builder {vm_id} at {host}", flush=True)
    rebooted = False

    def stage():
        nonlocal rebooted
        _, current = api("GET", f"{COMPUTE}/v1/vms/{vm_id}")
        if current.get("state") == "stopped":
            return "done (builder powered off)"
        try:
            code, text = http("GET", host + "/stage", timeout=8)
            return str(text).strip() if code == 200 else None
        except Exception:
            # The first boot of a new VM can hang before cloud-init; a reboot gets it going.
            if not rebooted and time.time() - started > 420:
                rebooted = True
                print("no answer after 7 minutes: reboot", flush=True)
                api("POST", f"{COMPUTE}/v1/vms/{vm_id}/set-power", {"state": "reboot"})
            return None

    result, seconds = wait(stage, "stage", 2400)
    if result.startswith("failed"):
        _, log = http("GET", host + "/log", timeout=15)
        print(str(log)[-6000:])
        sys.exit("image build failed; the builder is left running for inspection")
    print(f"sealed after {seconds:.0f} s")
    boot_disk = next(d["id"] for d in vm["disks"] if d.get("primary") or d.get("bootable"))
    # An image is made only from a disk no VM holds: the stopped builder lets go of its boot disk.
    code, out = api("POST", f"{COMPUTE}/v1/disks/{boot_disk}/detach", {"vm_id": vm_id})
    assert code < 300, (code, out)

    def detached():
        _, disk = api("GET", f"{COMPUTE}/v1/disks/{boot_disk}")
        return "done" if disk.get("state") == "available" else disk.get("state")

    wait(detached, "disk", 300, 3)
    code, image = api("POST", f"{COMPUTE}/v1/images", {
        "name": image_name, "display_name": image_name, "project_id": project,
        "availability_zones": [{"availability_zone_name": ZONE}], "disk_id": boot_disk,
        "min_disk": args.disk, "min_cpu": 2, "min_ram": 4,
        "description": f"Bro browser worker image {args.version}: Chrome, Xvfb, Caddy, browser-use 0.13.10, jev",
    })
    print("image", code, json.dumps(image, ensure_ascii=False)[:600], flush=True)
    assert code < 300, code

    def image_state():
        # The image has a state per availability zone, not one of its own.
        _, current = api("GET", f"{COMPUTE}/v1/images/{image['id']}")
        zone = next((z for z in current.get("availability_zones", []) if z.get("availability_zone_name") == ZONE), {})
        state = zone.get("state")
        return f"done ({state}, {zone.get('size')} bytes)" if state == "created" else state

    wait(image_state, "image", 3600, 15)
    if not args.keep_builder:
        fips = [i["floating_ip"]["id"] for i in vm.get("interfaces", []) if i.get("floating_ip")]
        code, _ = api("DELETE", f"{COMPUTE}/v1/vms/{vm_id}", {"delete_attachments": {"disk_ids": [], "external_ips": fips}})
        print("builder VM deleted", code)
        code, _ = api("DELETE", f"{COMPUTE}/v1/disks/{boot_disk}")
        print("builder disk deleted", code)
    if not args.no_warm:
        warm_up(project, image_name, args.disk)
    print(json.dumps({"image": image_name, "image_id": image["id"], "build_seconds": round(time.time() - started)}))


def warm_up(project, image_name, disk):
    """The first VMs from a new image take ≈ 6 minutes to get a disk (the image is being laid out in the
    zone); once one exists, the next come up in about a minute. Pay that once here, not in a person's
    first errand: create a throwaway VM, wait for its disk, delete it."""
    started = time.time()
    code, out = api("POST", f"{COMPUTE}/v1.1/vms", [{
        "project_id": project, "name": f"{image_name}-warmup", "availability_zone_name": ZONE,
        "flavor_name": "gen-2-4", "image_name": image_name,
        "disks": [{"name": f"{image_name}-warmup-boot", "size": disk, "disk_type_name": "SSD"}],
        "interfaces": [{"type": "regular", "subnet_name": f"Default_{ZONE}", "security_group_names": [SECURITY_GROUP]}],
    }])
    if code >= 300:
        print("warm-up skipped:", code, out)
        return
    vm_id = out[0]["id"]

    def running():
        _, vm = api("GET", f"{COMPUTE}/v1/vms/{vm_id}")
        return "done" if vm.get("state") == "running" else vm.get("state")

    wait(running, "warm-up VM", 1200, 10)
    _, vm = api("GET", f"{COMPUTE}/v1/vms/{vm_id}")
    api("DELETE", f"{COMPUTE}/v1/vms/{vm_id}",
        {"delete_attachments": {"disk_ids": [d["id"] for d in vm.get("disks", [])], "external_ips": []}})
    print(f"image warmed up in {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
