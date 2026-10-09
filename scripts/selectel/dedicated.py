"""Selectel dedicated servers from the session (stdlib only): list them, reinstall the OS with cloud-init
user data, follow the install. The session reaches a server over HTTP(S) only (SSH is closed), so a server
gets its whole setup as cloud-init at install time and is updated later over hostd's signed API.

  python dedicated.py list
  python dedicated.py status UUID
  python dedicated.py reinstall UUID --user-data FILE [--version 2204] [--hostname NAME] [--yes]
      wipes every disk and installs Ubuntu with FILE as cloud-init user data (at most 16 KB), keeping the
      server's current partition layout. Without --yes it only prints what it would do.
  python dedicated.py wait UUID [--minutes 60]   until the install is done (`reinstall` back to 0)

Keys and the project: api.py.
"""

import argparse
import json
import sys
import time
from pathlib import Path

from api import call

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
    args = parser.parse_args(argv)
    args.run(args)


if __name__ == "__main__":
    main()
