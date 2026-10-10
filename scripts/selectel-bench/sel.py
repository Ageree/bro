"""Selectel cloud (OpenStack) for the browser speed bench: a private network
with a router, a VM per role with a floating IP, and the cleanup.

The cloud session reaches a VM only over HTTP on port 80 (SSH is closed), so
a VM gets its whole job as cloud-init user data and serves its results
read-only from /var/www/bench (`userdata.tpl.sh`).

Env: SELECTEL_TOKEN or SELECTEL_API_KEY (static API key from the panel), SELECTEL_PROJECT (the
project id), SELECTEL_REGION (default ru-7). A project token is cached for
six hours next to SELECTEL_STATE (default ~/.selectel-bench).

    python3 sel.py up NAME FLAVOR AZ USERDATA [--volume]   # prints the IP
    python3 sel.py console NAME
    python3 sel.py down                                    # every bench resource
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

PROJECT = os.environ.get("SELECTEL_PROJECT", "")
REGION = os.environ.get("SELECTEL_REGION", "ru-7")
STATE = os.path.expanduser(os.environ.get("SELECTEL_STATE", "~/.selectel-bench"))
UBUNTU_24 = "Ubuntu 24.04 LTS 64-bit"
PURPOSE = "bro-browser-bench"


def _req(method, url, headers, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", "Accept": "application/json", **headers}
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode(errors="replace")[:2000]


def project_token():
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    path = os.path.join(STATE, "ptoken.json")
    if not os.path.exists(path) or time.time() - os.path.getmtime(path) > 6 * 3600:
        status, answer = _req(
            "POST", "https://api.selectel.ru/vpc/resell/v2/tokens",
            {"X-Token": (os.environ.get("SELECTEL_TOKEN") or os.environ["SELECTEL_API_KEY"]).strip()},
            {"token": {"project_id": PROJECT}},
        )
        if status != 200:
            raise SystemExit(f"project token: {status} {answer}")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, json.dumps(answer).encode())
        os.close(fd)
    return json.load(open(path))["token"]["id"]


def api(method, service, path, body=None):
    base = {
        "compute": f"https://{REGION}.cloud.api.selcloud.ru/compute/v2.1",
        "network": f"https://{REGION}.cloud.api.selcloud.ru/network/v2.0",
        "image": f"https://{REGION}.cloud.api.selcloud.ru/image/v2",
    }[service]
    headers = {"X-Auth-Token": project_token()}
    if service == "compute":
        headers["X-OpenStack-Nova-API-Version"] = "2.79"
    return _req(method, base + path, headers, body)


def one(method, service, path, key):
    status, answer = api(method, service, path)
    return answer[key] if status == 200 else []


def external_net():
    return one("GET", "network", "/networks?router:external=true", "networks")[0]["id"]


def ensure_net():
    """bench-net 192.168.77.0/24 behind bench-router: a port straight on the
    external network fails with «Failed to allocate the network(s)»."""
    nets = one("GET", "network", "/networks?name=bench-net", "networks")
    if nets:
        return nets[0]["id"]
    _, net = api("POST", "network", "/networks", {"network": {"name": "bench-net"}})
    net_id = net["network"]["id"]
    _, sub = api("POST", "network", "/subnets", {"subnet": {
        "network_id": net_id, "cidr": "192.168.77.0/24", "ip_version": 4, "name": "bench-subnet",
        "dns_nameservers": ["188.93.16.19", "188.93.17.19"]}})
    _, router = api("POST", "network", "/routers", {"router": {
        "name": "bench-router", "external_gateway_info": {"network_id": external_net()}}})
    api("PUT", "network", f"/routers/{router['router']['id']}/add_router_interface",
        {"subnet_id": sub["subnet"]["id"]})
    groups = one("GET", "network", "/security-groups?name=default", "security_groups")
    api("POST", "network", "/security-group-rules", {"security_group_rule": {
        "security_group_id": groups[0]["id"], "direction": "ingress", "protocol": "tcp",
        "port_range_min": 80, "port_range_max": 80, "remote_ip_prefix": "0.0.0.0/0", "ethertype": "IPv4"}})
    return net_id


def image_id():
    images = one("GET", "image", "/images?visibility=public&limit=500", "images")
    return next(i["id"] for i in images if i["name"] == UBUNTU_24)


def flavor_id(name):
    flavors = one("GET", "compute", "/flavors/detail?is_public=None", "flavors")
    return next(f["id"] for f in flavors if f["name"] == name)


def server_by_name(name):
    servers = one("GET", "compute", f"/servers/detail?name=^{name}$", "servers")
    return servers[0] if servers else None


def up(name, flavor, az, userdata, volume=False):
    """A local-disk flavor boots in 30–45 s; a network volume (flavors with
    disk 0) took 135 s on 05.10. Rebuild of a volume-backed VM keeps its old
    disk and cloud-init does not run the new user data: recreate it."""
    net = ensure_net()
    server = {"name": name, "flavorRef": flavor_id(flavor), "availability_zone": az,
              "networks": [{"uuid": net}], "metadata": {"purpose": PURPOSE},
              "user_data": base64.b64encode(open(userdata, "rb").read()).decode()}
    if volume:
        server["block_device_mapping_v2"] = [{
            "boot_index": 0, "uuid": image_id(), "source_type": "image", "destination_type": "volume",
            "volume_size": 15, "volume_type": f"universal.{az}", "delete_on_termination": True}]
    else:
        server["imageRef"] = image_id()
    started = time.time()
    status, answer = api("POST", "compute", "/servers", {"server": server})
    if status != 202:
        raise SystemExit(f"create: {status} {answer}")
    sid = answer["server"]["id"]
    while True:
        _, current = api("GET", "compute", f"/servers/{sid}")
        if current["server"]["status"] in ("ACTIVE", "ERROR"):
            break
        time.sleep(2)
    if current["server"]["status"] == "ERROR":
        raise SystemExit(f"server failed: {current['server'].get('fault')}")
    ports = one("GET", "network", f"/ports?device_id={sid}", "ports")
    _, fip = api("POST", "network", "/floatingips", {"floatingip": {
        "floating_network_id": external_net(), "port_id": ports[0]["id"]}})
    print(json.dumps({"id": sid, "ip": fip["floatingip"]["floating_ip_address"],
                      "active_s": round(time.time() - started, 1)}))


def console(name):
    server = server_by_name(name)
    _, answer = api("POST", "compute", f"/servers/{server['id']}/action",
                    {"os-getConsoleOutput": {"length": 60}})
    print(answer.get("output", ""))


def down():
    for server in one("GET", "compute", "/servers/detail", "servers"):
        if server.get("metadata", {}).get("purpose") == PURPOSE:
            print("server", server["name"], api("DELETE", "compute", f"/servers/{server['id']}")[0])
    time.sleep(10)
    for fip in one("GET", "network", "/floatingips", "floatingips"):
        print("floating ip", fip["floating_ip_address"], api("DELETE", "network", f"/floatingips/{fip['id']}")[0])
    for router in one("GET", "network", "/routers?name=bench-router", "routers"):
        for sub in one("GET", "network", "/subnets?name=bench-subnet", "subnets"):
            api("PUT", "network", f"/routers/{router['id']}/remove_router_interface", {"subnet_id": sub["id"]})
        print("router", api("DELETE", "network", f"/routers/{router['id']}")[0])
    for net in one("GET", "network", "/networks?name=bench-net", "networks"):
        print("network", api("DELETE", "network", f"/networks/{net['id']}")[0])


if __name__ == "__main__":
    command, args = sys.argv[1], sys.argv[2:]
    if command == "up":
        up(*args[:4], volume="--volume" in args)
    elif command == "console":
        console(args[0])
    elif command == "down":
        down()
