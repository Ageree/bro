"""Selectel cloud (OpenStack) and managed PostgreSQL for Bro's app VM, from the session (stdlib only). Used by
scripts/cloudru-app-host/host.py when BRO_CLOUD=selectel; runnable alone for the network and the database.

  python cloud.py network                      bro-net (10.77.0.0/24) behind bro-router, security group
                                               bro-app (80 and 443 in); safe to repeat
  python cloud.py servers                      the project's servers in SELECTEL_REGION
  python cloud.py console NAME [--lines 80]    the server's console log (read only)
  python cloud.py pg create [--flavor 2-4096-32]  the PostgreSQL 18 cluster bro-pg in bro-net's subnet
  python cloud.py pg status                    cluster, address, users, databases

Region and zone: SELECTEL_REGION (ru-3) and SELECTEL_ZONE (ru-3b: ru-3a had no room on 09.10), env or ~/.bro-selectel/api.env. A server
reaches the internet through the router; its public address is a floating IP (a port straight on the
external network is refused, 05.10). The app VM boots Ubuntu 22.04 on a local-disk flavor: it keeps no data
(the database is the managed cluster, files are in S3), so recreating it is the way to change its host code.
"""

import argparse
import base64
import json
import sys
import time

from api import call, setting

REGION = setting("SELECTEL_REGION", "ru-3")
ZONE = setting("SELECTEL_ZONE", "ru-3b")
CLOUD = f"https://{REGION}.cloud.api.selcloud.ru"
COMPUTE = f"{CLOUD}/compute/v2.1"
NETWORK = f"{CLOUD}/network/v2.0"
IMAGE = f"{CLOUD}/image/v2"
DBAAS = f"https://{REGION}.dbaas.selcloud.ru/v1"
NOVA = {"X-OpenStack-Nova-API-Version": "2.79"}
NET_NAME, SUBNET_NAME, ROUTER_NAME = "bro-net", "bro-subnet", "bro-router"
CIDR = "10.77.0.0/24"
APP_GROUP = "bro-app"
UBUNTU = "Ubuntu 22.04 LTS 64-bit"
# Selectel's resolvers in the subnet (the default the panel sets for a new private network).
DNS = ["188.93.16.19", "188.93.17.19"]
PG_CLUSTER = "bro-pg"
PG_VERSION = "18"


def compute(method, path, body=None, ok=(200, 201, 202, 204)):
    return call(method, COMPUTE + path, body, ok, NOVA)


def network(method, path, body=None, ok=(200, 201, 202, 204)):
    return call(method, NETWORK + path, body, ok)


def one(items, what):
    if len(items) > 1:
        sys.exit(f"more than one {what}: resolve it in the panel")
    return items[0] if items else None


# --- Network -----------------------------------------------------------------------------------------------


def external_network():
    return network("GET", "/networks?router:external=true")["networks"][0]["id"]


def ensure_network():
    """(network id, subnet id): made once, found afterwards."""
    net = one(network("GET", f"/networks?name={NET_NAME}")["networks"], NET_NAME)
    if net is None:
        net = network("POST", "/networks", {"network": {"name": NET_NAME}})["network"]
        print(f"network {NET_NAME} {net['id']}")
    subnet = one(network("GET", f"/subnets?name={SUBNET_NAME}")["subnets"], SUBNET_NAME)
    if subnet is None:
        subnet = network("POST", "/subnets", {"subnet": {
            "network_id": net["id"], "cidr": CIDR, "ip_version": 4, "name": SUBNET_NAME,
            "dns_nameservers": DNS}})["subnet"]
        print(f"subnet {SUBNET_NAME} {CIDR}")
    router = one(network("GET", f"/routers?name={ROUTER_NAME}")["routers"], ROUTER_NAME)
    if router is None:
        router = network("POST", "/routers", {"router": {
            "name": ROUTER_NAME, "external_gateway_info": {"network_id": external_network()}}})["router"]
        print(f"router {ROUTER_NAME}")
    ports = network("GET", f"/ports?device_id={router['id']}&network_id={net['id']}")["ports"]
    if not ports:
        network("PUT", f"/routers/{router['id']}/add_router_interface", {"subnet_id": subnet["id"]})
        print("router interface in the subnet")
    ensure_app_group()
    return net["id"], subnet["id"]


def ensure_app_group():
    group = one(network("GET", f"/security-groups?name={APP_GROUP}")["security_groups"], APP_GROUP)
    if group is None:
        group = network("POST", "/security-groups", {"security_group": {
            "name": APP_GROUP, "description": "Bro app VM: HTTP and HTTPS in"}})["security_group"]
        for port in (80, 443):
            network("POST", "/security-group-rules", {"security_group_rule": {
                "security_group_id": group["id"], "direction": "ingress", "protocol": "tcp",
                "port_range_min": port, "port_range_max": port, "remote_ip_prefix": "0.0.0.0/0",
                "ethertype": "IPv4"}})
        print(f"security group {APP_GROUP} (80, 443 in)")
    return group["id"]


# --- Servers -----------------------------------------------------------------------------------------------


def server_by_name(name):
    servers = compute("GET", f"/servers/detail?name=^{name}$")["servers"]
    return one([s for s in servers if s["name"] == name], name)


def server(server_id):
    return compute("GET", f"/servers/{server_id}")["server"]


def flavor_id(name):
    flavors = compute("GET", "/flavors/detail?is_public=None")["flavors"]
    found = next((f for f in flavors if f["name"] == name), None)
    if found is None:
        sys.exit(f"no flavor {name} in {REGION}")
    return found


def image_id(name=UBUNTU):
    images = call("GET", f"{IMAGE}/images?visibility=public&name={name.replace(' ', '%20')}")["images"]
    found = next((i for i in images if i["name"] == name and i.get("status") == "active"), None)
    if found is None:
        sys.exit(f"no image {name} in {REGION}")
    return found["id"]


def create_server(name, flavor, user_data, disk_gb=40, purpose="bro-app"):
    """A server in bro-net with the app security group and cloud-init user data. A flavor with its own local
    disk boots from it; one without (disk 0) gets a network volume of disk_gb, deleted with the server."""
    net_id, _ = ensure_network()
    found = flavor_id(flavor)
    body = {"name": name, "flavorRef": found["id"], "availability_zone": ZONE,
            "networks": [{"uuid": net_id}], "security_groups": [{"name": APP_GROUP}],
            "metadata": {"purpose": purpose},
            "user_data": base64.b64encode(user_data.encode()).decode()}
    if found["disk"]:
        body["imageRef"] = image_id()
    else:
        body["block_device_mapping_v2"] = [{
            "boot_index": 0, "uuid": image_id(), "source_type": "image", "destination_type": "volume",
            "volume_size": disk_gb, "volume_type": f"fast.{ZONE}", "delete_on_termination": True}]
    return compute("POST", "/servers", {"server": body})["server"]["id"]


def wait_active(server_id, minutes=10):
    deadline = time.time() + minutes * 60
    while time.time() < deadline:
        current = server(server_id)
        if current["status"] == "ACTIVE":
            return current
        if current["status"] == "ERROR":
            sys.exit(f"server failed: {current.get('fault')}")
        time.sleep(5)
    sys.exit(f"server {server_id} not ACTIVE after {minutes} minutes")


def floating_ip_of(server_id):
    """(address, floating IP id) of the server's port, or (None, None)."""
    for port in network("GET", f"/ports?device_id={server_id}")["ports"]:
        for fip in network("GET", f"/floatingips?port_id={port['id']}")["floatingips"]:
            return fip["floating_ip_address"], fip["id"]
    return None, None


def attach_floating_ip(server_id):
    address, fip_id = floating_ip_of(server_id)
    if address:
        return address, fip_id
    ports = network("GET", f"/ports?device_id={server_id}")["ports"]
    if not ports:
        sys.exit("the server has no port yet")
    fip = network("POST", "/floatingips", {"floatingip": {
        "floating_network_id": external_network(), "port_id": ports[0]["id"]}})["floatingip"]
    return fip["floating_ip_address"], fip["id"]


def reboot(server_id):
    compute("POST", f"/servers/{server_id}/action", {"reboot": {"type": "HARD"}})


def delete_server(server_id):
    """The server, then its floating IP (a floating IP left behind stays billed)."""
    _, fip_id = floating_ip_of(server_id)
    compute("DELETE", f"/servers/{server_id}", ok=(204, 404))
    deadline = time.time() + 300
    while time.time() < deadline:
        status, _ = call_status("GET", f"{COMPUTE}/servers/{server_id}")
        if status == 404:
            break
        time.sleep(5)
    if fip_id:
        network("DELETE", f"/floatingips/{fip_id}", ok=(204, 404))


def call_status(method, url):
    from api import project_token, request
    status, answer, _ = request(method, url, {"X-Auth-Token": project_token(), **NOVA})
    return status, answer


def console_log(server_id, lines=80):
    return compute("POST", f"/servers/{server_id}/action", {"os-getConsoleOutput": {"length": lines}})["output"]


# --- Managed PostgreSQL ------------------------------------------------------------------------------------


def dbaas(method, path, body=None, ok=(200, 201, 202, 204)):
    return call(method, DBAAS + path, body, ok)


def pg_type_id():
    types = dbaas("GET", "/datastore-types")["datastore-types"]
    found = next((t for t in types if t["engine"] == "postgresql" and t["version"] == PG_VERSION), None)
    if found is None:
        sys.exit(f"no PostgreSQL {PG_VERSION} in {REGION}")
    return found["id"]


def pg_cluster(required=True):
    found = one([d for d in dbaas("GET", "/datastores")["datastores"] if d["name"] == PG_CLUSTER], PG_CLUSTER)
    if found is None and required:
        sys.exit(f"no cluster {PG_CLUSTER}: python cloud.py pg create")
    return found


def pg_create(flavor_name):
    cluster = pg_cluster(required=False)
    if cluster is not None:
        return cluster
    _, subnet_id = ensure_network()
    type_id = pg_type_id()
    flavors = dbaas("GET", "/flavors")["flavors"]
    flavor = next((f for f in flavors if f["name"] == flavor_name and type_id in f["datastore_type_ids"]), None)
    if flavor is None:
        sys.exit(f"no DBaaS flavor {flavor_name} for PostgreSQL {PG_VERSION}")
    return dbaas("POST", "/datastores", {"datastore": {
        "name": PG_CLUSTER, "type_id": type_id, "subnet_id": subnet_id, "node_count": 1,
        "flavor_id": flavor["id"], "project_id": setting("SELECTEL_PROJECT")}})["datastore"]


def pg_address(cluster):
    """(host, port): the cluster's private master address in bro-net."""
    connection = cluster.get("connection") or {}
    host = connection.get("master") or next(iter(connection.values()), None)
    return host, cluster.get("port") or 5433


def pg_user(name, password):
    cluster = pg_cluster()
    users = dbaas("GET", f"/users?datastore_id={cluster['id']}")["users"]
    found = next((u for u in users if u["name"] == name), None)
    if found is None:
        found = dbaas("POST", "/users", {"user": {"datastore_id": cluster["id"], "name": name,
                                                  "password": password}})["user"]
    elif password:
        dbaas("PUT", f"/users/{found['id']}", {"user": {"password": password}})
    return found


def pg_database(name, owner_id, locale="C.UTF-8"):
    cluster = pg_cluster()
    databases = dbaas("GET", f"/databases?datastore_id={cluster['id']}")["databases"]
    found = next((d for d in databases if d["name"] == name), None)
    if found is None:
        found = dbaas("POST", "/databases", {"database": {"datastore_id": cluster["id"], "name": name,
                                                          "owner_id": owner_id, "lc_collate": locale,
                                                          "lc_ctype": locale}})["database"]
    return found


def pg_status():
    cluster = pg_cluster()
    host, port = pg_address(cluster)
    users = dbaas("GET", f"/users?datastore_id={cluster['id']}")["users"]
    databases = dbaas("GET", f"/databases?datastore_id={cluster['id']}")["databases"]
    return {"status": cluster["status"], "host": host, "port": port,
            "flavor": cluster.get("flavor"), "users": [u["name"] for u in users],
            "databases": [(d["name"], d.get("lc_collate"), d.get("status")) for d in databases]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("network")
    commands.add_parser("servers")
    console = commands.add_parser("console")
    console.add_argument("name")
    console.add_argument("--lines", type=int, default=80)
    pg = commands.add_parser("pg")
    pg.add_argument("action", choices=("create", "status"))
    pg.add_argument("--flavor", default="2-4096-32")
    args = parser.parse_args(argv)
    if args.command == "network":
        print(json.dumps(dict(zip(("network", "subnet"), ensure_network()))))
    elif args.command == "servers":
        for item in compute("GET", "/servers/detail")["servers"]:
            print(json.dumps({"name": item["name"], "id": item["id"], "status": item["status"],
                              "flavor": item.get("flavor", {}).get("original_name"),
                              "ip": floating_ip_of(item["id"])[0]}))
    elif args.command == "console":
        found = server_by_name(args.name) or sys.exit(f"no server {args.name}")
        print(console_log(found["id"], args.lines))
    elif args.action == "create":
        cluster = pg_create(args.flavor)
        print(json.dumps({"id": cluster["id"], "status": cluster["status"]}))
    else:
        print(json.dumps(pg_status(), ensure_ascii=False))


if __name__ == "__main__":
    main()
