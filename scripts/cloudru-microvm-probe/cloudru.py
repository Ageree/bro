"""Throwaway probe VMs in Cloud.ru Evolution for the microVM experiments (docs/browser-microvm.md).

Not Bro code and not the pilot (scripts/cloudru-browser-pilot): plain Ubuntu VMs with root login on the
serial console, so console.py can run commands without any inbound port. The root password lives in
$PROBE_STATE_DIR/<name>.password (default ~/.bro-probe), never in git.

  python cloudru.py usage                         quota usage of the project
  python cloudru.py list                          VMs and floating IPs of the project
  python cloudru.py price gen-2-4 low-2-4 ...     hourly and monthly price of flavors (API, VAT included)
  python cloudru.py create NAME [--flavor gen-2-4] [--no-ip] [--ip 10.0.0.210] [--disk 15]
  python cloudru.py delete NAME                   VM and the floating IP it had (Cloud.ru keeps the IP otherwise)

Names must not start with "bro-": production finds its VMs by exact name, but keep the spaces apart.
Needs CLOUDRU_KEY_ID and CLOUDRU_KEY_SECRET.
"""

import argparse
import base64
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

COMPUTE = "https://compute.api.cloud.ru/api"
ZONE = "ru.AZ-3"
SUBNET = "Default_ru.AZ-3"
# Egress to 0.0.0.0/0, ingress only 80/443 — nothing listens there on a probe VM but the test HTTP server.
SECURITY_GROUP = "bro-browser-pilot"
STATE_DIR = Path(os.environ.get("PROBE_STATE_DIR", Path.home() / ".bro-probe"))
STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
TOKEN = STATE_DIR / "token"


def clean(value):
    """Keys arrive with line breaks inside or wrapped in typographic quotes; either breaks the header."""
    return "".join(value.split()).strip("‘’“”'\"")


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


def http(method, url, body=None, headers=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json", **(headers or {})}
    # The session egress proxy drops a tunnel now and then (connection reset): retry the request.
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data, headers, method=method),
                                        timeout=timeout) as r:
                payload, code = r.read(), r.status
            break
        except urllib.error.HTTPError as e:
            payload, code = e.read(), e.code
            break
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if attempt == 5:
                raise
            time.sleep(2 ** attempt)
    try:
        return code, json.loads(payload)
    except ValueError:
        return code, payload.decode(errors="replace")


def token():
    if TOKEN.exists() and time.time() - TOKEN.stat().st_mtime < 1500:
        return TOKEN.read_text()
    code, body = http("POST", "https://iam.api.cloud.ru/api/v1/auth/token",
                      {"keyId": clean(os.environ["CLOUDRU_KEY_ID"]),
                       "secret": clean(os.environ["CLOUDRU_KEY_SECRET"])})
    if code != 200:
        sys.exit(f"auth {code}: {body}")
    write_private(TOKEN, body["access_token"])
    return body["access_token"]


def api(method, path, body=None):
    url = path if path.startswith("https://") else COMPUTE + path
    return http(method, url, body, {"Authorization": "Bearer " + token()})


def project_id():
    cached = STATE_DIR / "project"
    if cached.exists():
        return cached.read_text()
    _, customers = api("GET", "https://organization.api.cloud.ru/v1/customers")
    customer = customers["customers"][0]["customer_id"]
    # Without the customer filter the API answers with an error.
    _, projects = api("GET", f"https://organization.api.cloud.ru/v1/projects?customer_ids={customer}")
    pid = projects["projects"][0]["id"]
    write_private(cached, pid)
    return pid


def vm_by_name(name):
    # The name filter matches a substring ("probe-1" lists "probe-10"): keep the exact match.
    _, body = api("GET", f"/v1/vms?project_id={project_id()}&name={name}&limit=50")
    return next((v for v in body["items"] if v["name"] == name), None)


def floating_ips():
    _, body = api("GET", f"/v1/floating-ips?project_id={project_id()}&limit=100")
    return body["items"]


def cmd_usage(_):
    print(json.dumps(api("GET", f"/v1/project-entity-usage?project_id={project_id()}")[1], indent=1))


def cmd_list(_):
    _, body = api("GET", f"/v1/vms?project_id={project_id()}&limit=100")
    for v in body["items"]:
        print("vm ", v["name"], v["state"], v["id"])
    for ip in floating_ips():
        print("fip", ip["ip_address"], ip.get("state"), (ip.get("interface") or {}).get("ip_address"))


def cmd_price(args):
    pid = project_id()
    _, flavors = api("GET", f"/v1/flavors?project_id={pid}&limit=500")
    ids = {f["name"]: f["id"] for f in flavors["items"]}
    for name in args.flavors:
        code, body = api("POST", f"/v1/projects/{pid}/price-calculation", {"total_count": 1, "flavor_id": ids[name]})
        print(name, code, body if code != 200 else f"{body['total_price_hour']:.2f} ₽/h, {body['total_price_month']:.0f} ₽/month")


def cloud_init(name):
    password = "Pr" + secrets.token_hex(8) + "9!"
    write_private(STATE_DIR / f"{name}.password", password)
    # Serial console login instead of SSH; a small HTTP server on :80 for the private-network test.
    text = f"""#cloud-config
package_update: false
ssh_pwauth: false
chpasswd:
  expire: false
  users:
    - {{name: root, password: "{password}", type: text}}
runcmd:
  - [bash, -c, 'nohup python3 -m http.server 80 --directory /tmp >/dev/null 2>&1 &']
"""
    return base64.b64encode(text.encode()).decode()


def cmd_create(args):
    if args.name.startswith("bro-"):
        sys.exit("probe names must not start with bro-")
    interface = {"type": "regular", "subnet_name": SUBNET, "new_external_ip": not args.no_ip,
                 "security_group_names": [SECURITY_GROUP]}
    if args.ip:
        interface["ip_address"] = args.ip
    vm = {"project_id": project_id(), "name": args.name, "availability_zone_name": ZONE,
          "flavor_name": args.flavor, "image_name": "ubuntu-22.04",
          "disks": [{"name": args.name + "-disk", "size": args.disk, "disk_type_name": "SSD"}],
          "interfaces": [interface], "cloud_init": cloud_init(args.name)}
    started = time.time()
    # v1.1 takes an array of VMs; cloud_init must be base64.
    code, body = api("POST", "/v1.1/vms", [vm])
    if code != 201:
        sys.exit(f"create {code}: {body}")
    while True:
        found = vm_by_name(args.name)
        print(f"+{time.time() - started:.0f}s {found and found['state']}", flush=True)
        if found and found["state"] == "running":
            break
        time.sleep(10)
    print("running; cloud-init needs about a minute more before the serial login works")


def cmd_delete(args):
    vm = vm_by_name(args.name)
    if vm is None:
        sys.exit("no such VM")
    _, full = api("GET", f"/v1/vms/{vm['id']}")
    addresses = {i.get("ip_address") for i in full.get("interfaces", [])}
    ips = [ip["id"] for ip in floating_ips() if (ip.get("interface") or {}).get("ip_address") in addresses]
    print("delete vm", api("DELETE", f"/v1/vms/{vm['id']}")[0])
    while vm_by_name(args.name) is not None:
        time.sleep(10)
    # DELETE of a VM keeps its public IP, which stays billed.
    for ip in ips:
        print("delete ip", api("DELETE", f"/v1/floating-ips/{ip}")[0])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("usage").set_defaults(fn=cmd_usage)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    price = sub.add_parser("price")
    price.add_argument("flavors", nargs="+")
    price.set_defaults(fn=cmd_price)
    create = sub.add_parser("create")
    create.add_argument("name")
    create.add_argument("--flavor", default="gen-2-4")
    create.add_argument("--no-ip", action="store_true")
    create.add_argument("--ip")
    create.add_argument("--disk", type=int, default=15)
    create.set_defaults(fn=cmd_create)
    delete = sub.add_parser("delete")
    delete.add_argument("name")
    delete.set_defaults(fn=cmd_delete)
    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
