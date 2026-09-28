"""Operator side of the pilot: Cloud.ru Compute API and the VM control endpoint.

State (control token, VM id, IP, timings) lives in $PILOT_STATE_DIR (default ~/.bro-pilot), never in git.

  python vm.py create               security group + VM, wait for the ready browser, print timings
  python vm.py health               /health of the VM
  python vm.py secrets              upload /etc/bro/secrets.env (SECRETS; with ROUTERAI_API_KEY set,
                                    the jev helper and browser-use go to RouterAI instead of OpenRouter)
  python vm.py runners              upload runner scripts to /opt/bro/runners
  python vm.py proxies FILE         upload `host:port:user:password` lines to /etc/bro/proxies.txt (600)
  python vm.py exec CMD [--user bro] [--timeout 120]
  python vm.py job NAME CMD         background command; `python vm.py job NAME` shows its status
  python vm.py get REMOTE LOCAL     download a file
  python vm.py power off|on         set-power and wait (on: until CDP is ready)
  python vm.py api METHOD URL [JSON]
"""

import argparse
import base64
import hashlib
import json
import os
import secrets as random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
STATE_DIR = Path(os.environ.get("PILOT_STATE_DIR", Path.home() / ".bro-pilot"))
STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
STATE = STATE_DIR / "state.json"
COMPUTE = "https://compute.api.cloud.ru/api"
ZONE = "ru.AZ-3"
RUNNERS = ["suite.py", "jev_run.py", "bu_agent_run.py", "bu_direct.py", "persist.py", "proxy_forward.py"]
# Keys the runners need on the VM (cleaned by clean()).
SECRETS = {
    "TYPESAFE_API_KEY": "JEV_API_KEY",
    "TEXT_MODEL_API_KEY": "OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY": "OPENROUTER_API_KEY",
}
ROUTERAI = "https://routerai.ru/api/v1"
RUNNER_ENV = {
    "TYPESAFE_MODEL": "jev-latest",
    "TEXT_MODEL_BASE_URL": "https://openrouter.ai/api/v1",
    "TEXT_MODEL": "inception/mercury-2.5",
    "TEXT_MODEL_REASONING": "none",
    "RESULTS_DIR": "/var/lib/bro/results",
}


def clean(value):
    """Keys arrive with line breaks inside or wrapped in typographic quotes; either breaks the header."""
    return "".join(value.split()).strip("\u2018\u2019\u201c\u201d'\"")


def load():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(state):
    fd = os.open(STATE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(state, f, indent=1)


def http(method, url, body=None, headers=None, timeout=60, raw=False):
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json", **(headers or {})}
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data, headers, method=method), timeout=timeout) as r:
                payload, code = r.read(), r.status
            break
        except urllib.error.HTTPError as e:
            payload, code = e.read(), e.code
            break
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if attempt == 4:
                raise
            time.sleep(2 ** (attempt + 1))
    if raw:
        return code, payload
    try:
        return code, json.loads(payload)
    except ValueError:
        return code, payload.decode(errors="replace")


def iam_token():
    state = load()
    if state.get("iam_token") and time.time() - state.get("iam_at", 0) < 3000:
        return state["iam_token"]
    code, out = http("POST", "https://iam.api.cloud.ru/api/v1/auth/token",
                     {"keyId": os.environ["CLOUDRU_KEY_ID"].strip(), "secret": os.environ["CLOUDRU_KEY_SECRET"].strip()})
    assert code == 200, (code, out)
    state.update(iam_token=out["access_token"], iam_at=time.time())
    save(state)
    return out["access_token"]


def api(method, url, body=None):
    return http(method, url, body, {"Authorization": "Bearer " + iam_token()})


def project_id():
    state = load()
    if "project_id" not in state:
        _, customers = api("GET", "https://organization.api.cloud.ru/v1/customers")
        customer = customers["customers"][0]["customer_id"]
        _, projects = api("GET", f"https://organization.api.cloud.ru/v1/projects?customer_ids={customer}")
        state["project_id"] = projects["projects"][0]["id"]
        save(state)
    return state["project_id"]


def host():
    return f"https://{load()['public_ip'].replace('.', '-')}.sslip.io"


def control(method, path, body=None, timeout=180, raw=False):
    return http(method, host() + path, body, {"Authorization": "Bearer " + load()["control_token"]}, timeout, raw)


def health():
    try:
        code, out = http("GET", host() + "/health", timeout=10)
        return out if code == 200 and isinstance(out, dict) else None
    except Exception:
        return None


def wait_ready(since, want_stage="ready", limit=1800):
    seen = None
    while time.time() - since < limit:
        h = health()
        stage = h and h.get("stage")
        if stage != seen:
            print(f"+{time.time() - since:6.1f}s stage={stage} cdp={h and h.get('cdp')}", flush=True)
            seen = stage
        if h and h.get("cdp") and stage == want_stage:
            return time.time() - since, h
        if stage and str(stage).startswith("failed"):
            sys.exit(f"provisioning failed: {stage}")
        time.sleep(3)
    sys.exit("timed out waiting for the VM")


def vm_ip(vm_id):
    _, vm = api("GET", f"{COMPUTE}/v1/vms/{vm_id}")
    for iface in vm.get("interfaces", []):
        fip = iface.get("floating_ip") or {}
        if fip.get("ip_address"):
            return vm, fip["ip_address"]
    return vm, None


def create(args):
    state = load()
    if state.get("vm_id"):
        sys.exit(f"VM already exists: {state['vm_id']}")
    project = project_id()
    token = random.token_hex(32)
    state["control_token"] = token
    save(state)

    _, groups = api("GET", f"{COMPUTE}/v1/security-groups?project_id={project}")
    group = next((g for g in groups["items"] if g["name"] == args.sg), None)
    if not group:
        code, group = api("POST", f"{COMPUTE}/v1/security-groups",
                          {"project_id": project, "name": args.sg, "availability_zone_name": ZONE,
                           "description": "Bro browser pilot: HTTPS control, all egress"})
        assert code < 300, (code, group)
        for rule in [{"direction": "ingress", "ip_protocol": "tcp", "port_range": "80:80"},
                     {"direction": "ingress", "ip_protocol": "tcp", "port_range": "443:443"},
                     {"direction": "egress", "ip_protocol": "any", "port_range": "any"}]:
            code, out = api("POST", f"{COMPUTE}/v1/security-groups/{group['id']}/rules",
                            {**rule, "ether_type": "IPv4", "remote_ip_prefix": "0.0.0.0/0"})
            print("rule", rule["direction"], rule["port_range"], code, "" if code < 300 else out)
    state["security_group_id"] = group["id"]

    cloud_init = (HERE / "cloud-init.yaml").read_text()
    cloud_init = cloud_init.replace("__TOKEN_SHA256__", hashlib.sha256(token.encode()).hexdigest())
    cloud_init = cloud_init.replace("__CONTROL_PY__", base64.b64encode((HERE / "control.py").read_bytes()).decode())
    cloud_init = cloud_init.replace("__PROVISION_SH__", base64.b64encode((HERE / "provision.sh").read_bytes()).decode())
    body = [{
        "project_id": project, "name": args.name, "availability_zone_name": ZONE,
        "flavor_name": args.flavor, "image_name": "ubuntu-22.04",
        "disks": [{"name": f"{args.name}-boot", "size": args.disk, "disk_type_name": "SSD"}],
        "interfaces": [{"type": "regular", "subnet_name": f"Default_{ZONE}", "new_external_ip": True,
                        "security_group_names": [args.sg]}],
        # The API takes user data base64-encoded, not as plain YAML.
        "cloud_init": base64.b64encode(cloud_init.encode()).decode(),
    }]
    started = time.time()
    code, out = api("POST", f"{COMPUTE}/v1.1/vms", body)
    print("create", code, json.dumps(out, ensure_ascii=False)[:1500])
    assert code < 300, code
    state.update(created_at=started, create_response=out)
    save(state)
    vm_id = None
    while not vm_id and time.time() - started < 300:
        _, vms = api("GET", f"{COMPUTE}/v1/vms?project_id={project}")
        vm_id = next((v["id"] for v in vms["items"] if v["name"] == args.name), None)
        time.sleep(3)
    state["vm_id"] = vm_id
    save(state)
    ip = None
    while not ip:
        vm, ip = vm_ip(vm_id)
        time.sleep(3)
    state["public_ip"] = ip
    state["vm_state_at_ip"] = vm.get("state")
    save(state)
    print(f"vm {vm_id} ip {ip} after {time.time() - started:.1f}s", flush=True)
    seconds, h = wait_ready(started)
    state["create_to_ready_s"] = round(seconds, 1)
    state["uptime_at_ready_s"] = h["uptime_s"]
    save(state)
    print(json.dumps({"create_to_ready_s": state["create_to_ready_s"], "vm_uptime_s": h["uptime_s"]}))


def upload(remote, data, mode="0644", owner="bro"):
    code, out = control("PUT", f"/files?path={remote}&mode={mode}&owner={owner}", data)
    assert code == 200, (code, out)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create")
    c.add_argument("--name", default="bro-browser-pilot")
    c.add_argument("--sg", default="bro-browser-pilot")
    c.add_argument("--flavor", default="gen-2-4")
    c.add_argument("--disk", type=int, default=20)
    sub.add_parser("health")
    sub.add_parser("secrets")
    sub.add_parser("runners")
    px = sub.add_parser("proxies")
    px.add_argument("file")
    e = sub.add_parser("exec")
    e.add_argument("command")
    e.add_argument("--user", default="root")
    e.add_argument("--timeout", type=int, default=120)
    j = sub.add_parser("job")
    j.add_argument("name")
    j.add_argument("command", nargs="?")
    j.add_argument("--user", default="bro")
    g = sub.add_parser("get")
    g.add_argument("remote")
    g.add_argument("local")
    p = sub.add_parser("power")
    p.add_argument("state", choices=["on", "off"])
    a = sub.add_parser("api")
    a.add_argument("method")
    a.add_argument("url")
    a.add_argument("body", nargs="?")
    args = parser.parse_args()

    if args.cmd == "create":
        create(args)
    elif args.cmd == "health":
        print(json.dumps(health()))
    elif args.cmd == "secrets":
        env = {k: clean(os.environ[v]) for k, v in SECRETS.items()} | RUNNER_ENV
        if os.environ.get("ROUTERAI_API_KEY"):
            # RouterAI (OpenAI-compatible, hosted in RU) answers Cloud.ru; OpenRouter does not.
            key = clean(os.environ["ROUTERAI_API_KEY"])
            env.update(TEXT_MODEL_API_KEY=key, BU_LLM_API_KEY=key, TEXT_MODEL_BASE_URL=ROUTERAI,
                       BU_LLM_BASE_URL=ROUTERAI,
                       TEXT_MODEL=os.environ.get("PILOT_TEXT_MODEL", "deepseek/deepseek-v4.1-flash"))
        lines = [f"{k}={v}" for k, v in env.items()]
        upload("/etc/bro/secrets.env", ("\n".join(lines) + "\n").encode(), "0600", "bro")
        print("secrets.env written:", ", ".join(k for k in env if "KEY" in k))
    elif args.cmd == "runners":
        for name in RUNNERS:
            upload(f"/opt/bro/runners/{name}", (HERE / name).read_bytes())
        print("uploaded", ", ".join(RUNNERS))
    elif args.cmd == "proxies":
        lines = [line.strip() for line in Path(args.file).read_text().splitlines() if line.strip()]
        assert all(len(line.split(":", 3)) == 4 for line in lines), "expected host:port:user:password"
        upload("/etc/bro/proxies.txt", ("\n".join(lines) + "\n").encode(), "0600", "bro")
        print(f"{len(lines)} proxies written")
    elif args.cmd == "exec":
        code, out = control("POST", "/exec", {"cmd": args.command, "user": args.user, "timeout": args.timeout},
                            timeout=args.timeout + 30)
        if isinstance(out, dict):
            sys.stdout.write(out.get("stdout") or "")
            sys.stderr.write(out.get("stderr") or "")
            print(f"[rc={out.get('rc')} {out.get('ms')} ms]", file=sys.stderr)
        else:
            print(code, out)
    elif args.cmd == "job":
        if args.command:
            print(control("POST", "/jobs", {"name": args.name, "cmd": args.command, "user": args.user}))
        else:
            _, out = control("GET", f"/jobs/{args.name}")
            print(json.dumps({k: v for k, v in out.items() if k != "log_tail"}))
            print(out.get("log_tail", "")[-4000:])
    elif args.cmd == "get":
        code, data = control("GET", f"/files?path={args.remote}", raw=True)
        assert code == 200, (code, data[:200])
        Path(args.local).write_bytes(data)
        print(f"{len(data)} bytes -> {args.local}")
    elif args.cmd == "power":
        state = load()
        started = time.time()
        code, out = api("POST", f"{COMPUTE}/v1/vms/{state['vm_id']}/set-power", {"state": f"power_{args.state}"})
        print("set-power", code, json.dumps(out, ensure_ascii=False)[:500], flush=True)
        assert code < 300, code
        if args.state == "off":
            seen = None
            while True:
                _, vm = api("GET", f"{COMPUTE}/v1/vms/{state['vm_id']}")
                if vm.get("state") != seen:
                    seen = vm.get("state")
                    print(f"+{time.time() - started:6.1f}s state={seen}", flush=True)
                if seen in ("stopped", "shutoff"):
                    break
                time.sleep(3)
        else:
            seconds, h = wait_ready(started)
            print(json.dumps({"power_on_to_ready_s": round(seconds, 1), "vm_uptime_s": h["uptime_s"]}))
    elif args.cmd == "api":
        print(json.dumps(api(args.method, args.url, json.loads(args.body) if args.body else None),
                         ensure_ascii=False, indent=1)[:20000])


main()
