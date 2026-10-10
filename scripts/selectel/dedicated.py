"""Selectel dedicated servers from the session (stdlib only): list them, reinstall the OS with cloud-init
user data, follow the install. The session reaches a server over HTTP(S) only (SSH is closed), so a server
gets its whole setup as cloud-init at install time and is updated later over hostd's signed API.

  python dedicated.py list
  python dedicated.py status UUID
  python dedicated.py reinstall UUID --user-data FILE [--version 2204] [--hostname NAME] [--yes]
      wipes every disk and installs Ubuntu with FILE as cloud-init user data (at most 16 KB), keeping the
      server's current partition layout. Without --yes it only prints what it would do.
  python dedicated.py wait UUID [--minutes 60]   until the install is done (`reinstall` back to 0)
  python dedicated.py order CONFIG --user-data FILE --hostname NAME [--location SPB-4] [--plan "1 day"]
                            [--version 2204] [--yes]
      buys a chip or regular server CONFIG (CL25-NVMe, say) with Ubuntu and FILE as cloud-init, both disks in
      RAID1 (/boot 1 GB, the rest /). Checks stock and the balance first; without --yes only prints the price
  python dedicated.py cancel UUID [--yes]        stops renewing the server: it goes when its paid period ends

Keys and the project: api.py.
"""

import argparse
import json
import sys
import time
from pathlib import Path

from api import call, request, setting

API = "https://api.selectel.ru/servers/v2"
USER_DATA_LIMIT = 16 * 1024


def api(method, path, body=None):
    answer = call(method, API + path, body, ok=(200, 202))
    return answer.get("result") if isinstance(answer, dict) else answer


def cmd_list(_args):
    for server in api("GET", "/resource"):
        price = server.get("billing", {}).get("price", {})
        print(json.dumps({"uuid": server["uuid"], "name": server.get("user_desc"), "info": server.get("info"),
                          "state": server["state"], "config": server.get("config_name"),
                          "paidTill": price.get("paid_till"), "plan": server.get("billing", {})
                          .get("current_price_plan", {}).get("name")}, ensure_ascii=False))


def os_config(uuid):
    return api("GET", f"/boot/os/{uuid}")


def cmd_status(args):
    resource = api("GET", f"/resource/{args.uuid}")
    config = os_config(args.uuid)
    power = api("GET", f"/power/{args.uuid}")
    print(json.dumps({"state": resource["state"], "processing": resource.get("is_processing"),
                      "os": f"{config.get('os_template')} {config.get('version')}",
                      "reinstall": config.get("reinstall"), "ip": config.get("ipv4_address"),
                      "power": (power or {}).get("driver_status", {}).get("power_state")}, ensure_ascii=False))


def cmd_reinstall(args):
    user_data = Path(args.user_data).read_text()
    if len(user_data.encode()) > USER_DATA_LIMIT:
        sys.exit(f"user data is {len(user_data.encode())} bytes, the limit is {USER_DATA_LIMIT}")
    resource = api("GET", f"/resource/{args.uuid}")
    current = os_config(args.uuid)
    templates = api("GET", f"/boot/template/os/new?service_uuid={resource['service_uuid']}"
                           f"&location_uuid={resource['location_uuid']}")
    template = next((t for t in templates if t["os_value"] == "ubuntu" and t["version_value"] == args.version
                     and t["arch"] == "x86_64"), None)
    if template is None:
        sys.exit(f"no ubuntu {args.version} template for this server")
    if not template.get("script_allowed"):
        sys.exit("this template takes no user data")
    body = {"os_template": "ubuntu", "version": args.version, "arch": "x86_64",
            "userhostname": args.hostname or current.get("userhostname") or resource.get("user_desc") or "bro",
            "cloud_init_user_data": user_data}
    # The layout the server has now (a RAID1 of both disks by default); the API refuses a v2 template
    # install without one of its own kind.
    if current.get("partitions_config"):
        body["partitions_config"] = current["partitions_config"]
    if current.get("user_ssh_key"):
        body["user_ssh_key"] = current["user_ssh_key"]
    summary = {k: v for k, v in body.items() if k not in ("cloud_init_user_data", "user_ssh_key")}
    print(json.dumps({"server": resource.get("user_desc"), "ip": current.get("ipv4_address"), **summary,
                      "userDataBytes": len(user_data.encode())}, ensure_ascii=False))
    if not args.yes:
        print("dry run: add --yes to wipe the disks and install")
        return
    # The answer echoes the new root password and the user data (with the host's key): print neither.
    answer = api("POST", f"/boot/os/{args.uuid}", body)
    print(json.dumps({"reinstall": answer.get("reinstall"), "processing": answer.get("is_processing")}))


def chip_or_server(name):
    """(model, config) of the configuration called NAME: CL… are `serverchip`, the rest `server`."""
    for model in ("serverchip", "server"):
        found = next((c for c in api("GET", f"/service/{model}") if c["name"] == name), None)
        if found is not None:
            # The list leaves out the plans on offer: the configuration's own card has them.
            return model, api("GET", f"/service/{model}/{found['uuid']}")
    sys.exit(f"no configuration {name}")


def raid1_layout(service_uuid):
    """Every local drive of the configuration in RAID1: /boot 1 GB, / the rest (as bro-dedicated-1 has)."""
    drives = api("GET", f"/boot/partitions/local_drives?service_uuid={service_uuid}")
    if len(drives) != 2:
        sys.exit(f"expected two local drives, the configuration has {len(drives)}")
    layout = dict(drives)
    for suffix, drive in zip("ab", sorted(drives)):
        layout[f"boot_{suffix}"] = {"type": "partition", "device": drive, "size": 1.0, "priority": 0}
        layout[f"root_{suffix}"] = {"type": "partition", "device": drive, "size": -1.0, "priority": 1}
    for name, mount in (("boot", "/boot"), ("root", "/")):
        layout[f"md_{name}"] = {"type": "soft_raid", "members": [f"{name}_a", f"{name}_b"], "level": "raid1"}
        layout[f"fs_{name}"] = {"type": "filesystem", "device": f"md_{name}", "fstype": "ext4", "mount": mount}
    api("POST", f"/boot/partitions/validate?service_id={service_uuid}", {"partitions_config": layout})
    return layout


def cmd_order(args):
    user_data = Path(args.user_data).read_text()
    if len(user_data.encode()) > USER_DATA_LIMIT:
        sys.exit(f"user data is {len(user_data.encode())} bytes, the limit is {USER_DATA_LIMIT}")
    model, config = chip_or_server(args.config)
    location = next((l for l in api("GET", "/location") if l["name"] == args.location), None)
    if location is None:
        sys.exit(f"no location {args.location}")
    # Without a token the plans come by their English names ("1 day"); the account's language would rename them.
    _, plans, _ = request("GET", API + "/pub/plan", {"Accept-Language": "en-US"})
    plan = next((p for p in plans["result"] if p["name"] == args.plan), None)
    if plan is None or plan["uuid"] not in config.get("price_plan_available", []):
        sys.exit(f"no plan {args.plan!r} for {args.config}")
    stock = next((c["count"] for a in config.get("available", []) if a["location"] == location["uuid"]
                  for c in a["plan_count"] if c["plan_uuid"] == plan["uuid"]), 0)
    if stock < 1:
        sys.exit(f"{args.config} is out of stock in {args.location} on {args.plan!r}")
    billing = {"location_uuid": location["uuid"], "price_plan_uuid": plan["uuid"], "pay_currency": "main",
               "quantity": 1}
    quote = api("POST", f"/service/{model}/{config['uuid']}/billing", billing)
    print(json.dumps({"config": args.config, "location": args.location, "plan": args.plan,
                      "price": quote["price"]["amount_due"], "currency": quote["currency"],
                      "enoughBalance": quote["has_enough_balance"]}, ensure_ascii=False))
    if not quote["has_enough_balance"]:
        sys.exit("not enough on the balance")
    if not args.yes:
        print("not ordered: add --yes")
        return
    order = api("POST", f"/resource/{model}/billing", {
        **billing, "service_uuid": config["uuid"], "project_uuid": setting("SELECTEL_PROJECT"),
        "partitions_config": raid1_layout(config["uuid"]), "version": args.version, "os_template": "ubuntu",
        "arch": "x86_64", "userhostname": args.hostname, "user_desc": args.hostname,
        "cloud_init_user_data": user_data, "local_network_required": False})
    print(json.dumps({"uuid": order[0]["uuid"], "state": order[0]["state"]}))


def cmd_cancel(args):
    resource = api("GET", f"/resource/{args.uuid}")
    print(json.dumps({"uuid": args.uuid, "name": resource.get("user_desc"), "info": resource.get("info"),
                      "state": resource["state"]}, ensure_ascii=False))
    if not args.yes:
        print("not cancelled: add --yes")
        return
    call("DELETE", f"{API}/resource/billing/{args.uuid}", {"immediately": False}, ok=(200, 202, 204))
    print("renewal cancelled: the server goes when its paid period ends")


def cmd_wait(args):
    deadline = time.time() + args.minutes * 60
    started = time.time()
    while time.time() < deadline:
        config = os_config(args.uuid)
        resource = api("GET", f"/resource/{args.uuid}")
        print(f"{time.time() - started:5.0f} s reinstall={config.get('reinstall')} "
              f"processing={resource.get('is_processing')} state={resource['state']}", flush=True)
        if config.get("reinstall") == 0 and not resource.get("is_processing"):
            return
        time.sleep(30)
    sys.exit("still installing")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list").set_defaults(run=cmd_list)
    status = commands.add_parser("status")
    status.add_argument("uuid")
    status.set_defaults(run=cmd_status)
    reinstall = commands.add_parser("reinstall")
    reinstall.add_argument("uuid")
    reinstall.add_argument("--user-data", required=True)
    reinstall.add_argument("--version", default="2204")
    reinstall.add_argument("--hostname")
    reinstall.add_argument("--yes", action="store_true")
    reinstall.set_defaults(run=cmd_reinstall)
    wait = commands.add_parser("wait")
    wait.add_argument("uuid")
    wait.add_argument("--minutes", type=int, default=60)
    wait.set_defaults(run=cmd_wait)
    order = commands.add_parser("order")
    order.add_argument("config")
    order.add_argument("--user-data", required=True)
    order.add_argument("--hostname", required=True)
    order.add_argument("--location", default="SPB-4")
    order.add_argument("--plan", default="1 day")
    order.add_argument("--version", default="2204")
    order.add_argument("--yes", action="store_true")
    order.set_defaults(run=cmd_order)
    cancel = commands.add_parser("cancel")
    cancel.add_argument("uuid")
    cancel.add_argument("--yes", action="store_true")
    cancel.set_defaults(run=cmd_cancel)
    args = parser.parse_args(argv)
    args.run(args)


if __name__ == "__main__":
    main()
