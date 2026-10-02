"""Build the Bro browser image in Cloud.ru Evolution (operator script, stdlib only).

  python build.py [--version 2026-09-28.1] [--disk 10] [--keep-builder]

1. A builder VM from ubuntu-22.04 runs provision.sh (cloud-init carries it and the worker, no secrets),
   shows its stage at https://<ip>.sslip.io/stage, seals itself and powers off.
2. Its boot disk becomes the image `bro-browser-<version>` (POST /api/v1/images with disk_id).
3. The builder VM, its disk and its address are deleted: on a failed build too, unless provision.sh
   itself failed (the builder stays up with its log) or --keep-builder is given.

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
import urllib.parse
import urllib.request
from http.client import HTTPException
from pathlib import Path

HERE = Path(__file__).parent
WORKER = HERE.parent / "worker"
COMPUTE = "https://compute.api.cloud.ru/api"
ZONE = os.environ.get("CLOUDRU_ZONE", "ru.AZ-3")
SECURITY_GROUP = os.environ.get("CLOUDRU_SECURITY_GROUP", "bro-browser")
_token = {}
# What a poll shrugs off and asks again about: the network, or an answer cut short.
TRANSIENT = (OSError, HTTPException)


def clean(value):
    """Keys arrive with line breaks inside or wrapped in typographic quotes; either breaks the header."""
    return "".join(value.split()).strip("‘’“”'\"")


def http(method, url, body=None, headers=None, timeout=60, resend=False):
    """A request that failed on its way out is sent again whatever the method. One lost after it went
    out (urllib wraps only the former in URLError; a timeout or a drop while awaiting the answer comes
    raw) is sent again only for a GET or DELETE, or with `resend`: the server may have acted on a POST,
    and a second create is a second billed VM (`create` looks the first one up instead)."""
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
        except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
            sent = not isinstance(error, urllib.error.URLError)
            if attempt == 4 or (sent and not resend and method not in ("GET", "DELETE")):
                raise
            time.sleep(2 ** (attempt + 1))
    try:
        return code, json.loads(payload)
    except ValueError:
        return code, payload.decode(errors="replace")


def api(method, url, body=None):
    if time.time() - _token.get("at", 0) > 3000:
        code, out = http("POST", "https://iam.api.cloud.ru/api/v1/auth/token",
                         {"keyId": clean(os.environ["CLOUDRU_KEY_ID"]), "secret": clean(os.environ["CLOUDRU_KEY_SECRET"])},
                         resend=True)
        if code != 200:
            # A transient IAM error (5xx, 429) must read the same as a Compute one to read()/delete()/
            # create(), or a builder mid-cleanup loses track of what it still needs to delete.
            raise ConnectionError(f"IAM token request failed: {code} {json.dumps(out, ensure_ascii=False)[:300]}")
        _token.update(value=out["access_token"], at=time.time())
    return http(method, url, body, {"Authorization": "Bearer " + _token["value"]})


def read(url):
    """A Compute resource for a poll, or None when the API errs or does not answer: the poll asks again."""
    try:
        code, out = api("GET", url)
    except TRANSIENT:
        return None
    return out if code == 200 and isinstance(out, dict) else None


def create(url, body, name, listing):
    """POST a create and return the new resource's id (None if refused). Checked by exact name first: a
    stale resource already wearing this name (a --keep-builder builder, an old build's timed-out image of
    the same --version) would otherwise be silently adopted below as if it were the one this call just
    made, and later deleted or reported as it. Past that check the name is unique, so an answer lost
    after the request went out is settled by looking the resource up, not by a second POST: a second
    builder would provision, seal and stay behind, billed."""
    query = urllib.parse.urlencode({"name": name, "limit": 100})
    existing = next((item for item in (read(f"{listing}&{query}") or {}).get("items", [])
                      if item.get("name") == name), None)
    if existing:
        sys.exit(f"{name}: a resource with this name already exists ({existing.get('id')}); "
                 f"remove it or pick a different name/version first")
    try:
        code, out = api("POST", url, body)
    except (ConnectionError, TimeoutError, HTTPException) as error:
        print(f"{name}: no answer to the create ({error}), looking it up", flush=True)
        for _ in range(20):
            # The name filter matches a part of the name: the exact match is ours.
            items = (read(f"{listing}&{query}") or {}).get("items", [])
            found = next((item["id"] for item in items if item.get("name") == name), None)
            if found:
                print(f"{name}: {found}", flush=True)
                return found
            time.sleep(3)
        raise
    if code >= 300:
        print(f"{name}: not created, {code} {json.dumps(out, ensure_ascii=False)[:600]}", flush=True)
        return None
    found = (out[0] if isinstance(out, list) else out)["id"]
    print(f"{name}: {found}", flush=True)
    return found


def delete(what, url, body=None):
    """Delete and say so; one already gone counts. Whatever stays is billed and holds quota."""
    try:
        code, out = api("DELETE", url, body)
    except TRANSIENT as error:
        code, out = None, error
    if code is not None and (code < 300 or code == 404):
        print(f"{what} deleted", flush=True)
    else:
        print(f"{what} NOT deleted ({code}: {str(out)[:300]}): delete it in the console", flush=True)


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
             ("/opt/bro/image/jev-ultrafast.patch", HERE / "jev-ultrafast.patch", "0644"),
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
    vm_id = create(f"{COMPUTE}/v1.1/vms", [{
        "project_id": project, "name": name, "availability_zone_name": ZONE, "flavor_name": args.flavor,
        "image_name": "ubuntu-22.04",
        "disks": [{"name": f"{name}-boot", "size": args.disk, "disk_type_name": "SSD"}],
        "interfaces": [{"type": "regular", "subnet_name": f"Default_{ZONE}", "new_external_ip": True,
                        "security_group_names": [SECURITY_GROUP]}],
        "cloud_init": base64.b64encode(user_data.encode()).decode(),
    }], name, f"{COMPUTE}/v1/vms?project_id={project}")
    if not vm_id:
        sys.exit("the builder was not created")
    # Every way out deletes the builder (a stopped VM still holds its quota), except a failure inside
    # provision.sh, which stays up with its log.
    keep, boot_disk, image, image_ready = args.keep_builder, None, None, False
    try:
        vm, ip = None, None
        while not ip:
            if time.time() - started > 600:
                sys.exit(f"the builder has no public address after 10 minutes ({(vm or {}).get('state')})")
            time.sleep(3)
            vm = read(f"{COMPUTE}/v1/vms/{vm_id}")
            ip = next((i["floating_ip"]["ip_address"] for i in (vm or {}).get("interfaces", [])
                       if i.get("floating_ip")), None)
        host = f"https://{ip.replace('.', '-')}.sslip.io"
        print(f"builder {vm_id} at {host}", flush=True)
        rebooted = reached = False

        def stage():
            nonlocal rebooted, reached
            current = read(f"{COMPUTE}/v1/vms/{vm_id}")
            if current and current.get("state") == "stopped":
                return "done (builder powered off)"
            try:
                code, text = http("GET", host + "/stage", timeout=8)
            except TRANSIENT:
                code, text = None, None
            if code is not None:
                reached = True
                return str(text).strip() if code == 200 else None
            # The first boot of a new VM can hang before cloud-init; a reboot gets it going. Only that: once
            # the page has answered, the VM is installing or sealing (the page goes first, then the power),
            # and a reboot would only break the build. 15 minutes, not 7: a healthy but slow first boot
            # (apt mirrors, DNS) can still be short of the stage server at 7 minutes, and cloud-init does
            # not run provision.sh again after a reboot, so rebooting a boot that was merely slow strands
            # it half-installed for the rest of the build to wait out silently.
            if not reached and not rebooted and time.time() - started > 900:
                current = read(f"{COMPUTE}/v1/vms/{vm_id}")
                if current and current.get("state") == "running":
                    rebooted = True
                    print("no answer after 15 minutes: reboot", flush=True)
                    try:
                        api("POST", f"{COMPUTE}/v1/vms/{vm_id}/set-power", {"state": "reboot"})
                    except TRANSIENT as error:
                        print(f"reboot: {error}", flush=True)
            return None

        result, seconds = wait(stage, "stage", 2400)
        if result.startswith("failed"):
            keep = True
            _, log = http("GET", host + "/log", timeout=15)
            print(str(log)[-6000:])
            sys.exit(f"image build failed; the builder {vm_id} is left running for inspection")
        print(f"sealed after {seconds:.0f} s")
        # An image is made only from a disk no VM holds: the stopped builder lets go of its boot disk,
        # which the builder's deletion then no longer takes along.
        boot_disk = next(d["id"] for d in vm["disks"] if d.get("primary") or d.get("bootable"))
        code, out = api("POST", f"{COMPUTE}/v1/disks/{boot_disk}/detach", {"vm_id": vm_id})
        assert code < 300, (code, out)

        def detached():
            disk = read(f"{COMPUTE}/v1/disks/{boot_disk}")
            if disk is None:
                return None
            return "done" if disk.get("state") == "available" else disk.get("state")

        wait(detached, "disk", 300, 3)
        image = create(f"{COMPUTE}/v1/images", {
            "name": image_name, "display_name": image_name, "project_id": project,
            "availability_zones": [{"availability_zone_name": ZONE}], "disk_id": boot_disk,
            "min_disk": args.disk, "min_cpu": 2, "min_ram": 4,
            "description": f"Bro browser worker image {args.version}: Chrome, Xvfb, Caddy, browser-use 0.13.10, jev",
        }, image_name, f"{COMPUTE}/v1/images?project_id={project}")
        if not image:
            sys.exit("the image was not created")

        def image_state():
            # The image has a state per availability zone, not one of its own.
            current = read(f"{COMPUTE}/v1/images/{image}")
            if current is None:
                return None
            zones = current.get("availability_zones", [])
            zone = next((z for z in zones if z.get("availability_zone_name") == ZONE), {})
            state = zone.get("state")
            return f"done ({state}, {zone.get('size')} bytes)" if state == "created" else state

        wait(image_state, "image", 3600, 15)
        image_ready = True
    finally:
        if not keep:
            # An image still being made keeps its disk: delete that one once the image is there.
            pending = image is not None and not image_ready
            remove_builder(vm_id, None if pending else boot_disk)
            if pending:
                print(f"builder disk {boot_disk} kept: image {image} is still being made from it", flush=True)
    if not args.no_warm:
        warm_up(project, image_name, args.disk)
    print(json.dumps({"image": image_name, "image_id": image, "build_seconds": round(time.time() - started)}))


def remove_builder(vm_id, boot_disk):
    """The builder with its public address, and its boot disk if detached (a VM deletion takes along
    only the boot disk it still holds)."""
    vm = read(f"{COMPUTE}/v1/vms/{vm_id}")
    if vm is None:
        print(f"builder {vm_id} could not be read: its public address stays, delete it in the console", flush=True)
    fips = [i["floating_ip"]["id"] for i in (vm or {}).get("interfaces", []) if i.get("floating_ip")]
    delete(f"builder VM {vm_id} with addresses {fips}", f"{COMPUTE}/v1/vms/{vm_id}",
           {"delete_attachments": {"disk_ids": [], "external_ips": fips}})
    if boot_disk:
        delete(f"builder disk {boot_disk}", f"{COMPUTE}/v1/disks/{boot_disk}")


def warm_up(project, image_name, disk):
    """The first VMs from a new image take ≈ 6 minutes to get a disk (the image is being laid out in the
    zone); once one exists, the next come up in about a minute. Pay that once here, not in a person's
    first errand: create a throwaway VM, wait for its disk, delete it."""
    started = time.time()
    name = f"{image_name}-warmup"
    vm_id = create(f"{COMPUTE}/v1.1/vms", [{
        "project_id": project, "name": name, "availability_zone_name": ZONE,
        "flavor_name": "gen-2-4", "image_name": image_name,
        "disks": [{"name": f"{name}-boot", "size": disk, "disk_type_name": "SSD"}],
        "interfaces": [{"type": "regular", "subnet_name": f"Default_{ZONE}", "security_group_names": [SECURITY_GROUP]}],
    }], name, f"{COMPUTE}/v1/vms?project_id={project}")
    if not vm_id:
        print("warm-up skipped")
        return

    def running():
        vm = read(f"{COMPUTE}/v1/vms/{vm_id}")
        if vm is None:
            return None
        return "done" if vm.get("state") == "running" else vm.get("state")

    try:
        wait(running, "warm-up VM", 1200, 10)
    finally:
        vm = read(f"{COMPUTE}/v1/vms/{vm_id}") or {}
        delete(f"warm-up VM {vm_id}", f"{COMPUTE}/v1/vms/{vm_id}",
               {"delete_attachments": {"disk_ids": [d["id"] for d in vm.get("disks", [])], "external_ips": []}})
    print(f"image warmed up in {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
