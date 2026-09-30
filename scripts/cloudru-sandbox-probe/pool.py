"""Stage 2 of docs/browser-pool.md from the session: a pool host booted the way Bro will boot one, driven
over its public HTTPS API (hostd under /h/, workers under /g/<sandbox>/) with the tokens Bro will mint.

  python pool.py artifacts                      the S3 keys and sha256 of the host bundle and rootfs in use
  python pool.py boot NAME [--flavor gen-2-8]   VM from stock ubuntu-22.04 with boot.py's cloud-init (presigned
                                                GETs of bundle and rootfs); waits for `ready` over HTTPS, prints
                                                timings. Adds a root password for the serial console (stand only)
  python pool.py host NAME health|capacity
  python pool.py create NAME SANDBOX [--restore|--profile GEN] [--memory MB] [--gen N]
  python pool.py park NAME SANDBOX GEN          worker POST /v1/park, then hostd park into sets/<ws>/<GEN>/
  python pool.py delete NAME SANDBOX GEN
  python pool.py worker NAME SANDBOX METHOD PATH [JSON]
  python pool.py session NAME SANDBOX GATEWAY   the stand's proxy on the host (proxy.py on :3130, hostd.json
                                                stand_host_ports [3130]) as the residential one
  python pool.py markers NAME SANDBOX set|check  cookie and localStorage markers on a page, through CDP
  python pool.py errand NAME SANDBOX            one short RU errand (Ruwiki), RouterAI key in the request
  python pool.py forget WORKSPACE               delete the workspace's sets in S3 (as Bro will)

The stand's signing key is random ($PROBE_STATE_DIR/pool-signing-key), never production's
BROWSER_VM_SIGNING_KEY; worker and data keys per sandbox live next to it (pool-<sandbox>.json). Sets go to
probe/stage2/sets/<workspace>/<generation>/ (test objects: delete them after the run).
Artifacts: pool/host/host-<sha12>.tgz and pool/rootfs/<version>.tar.zst (durable, see ARTIFACTS).
Needs CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET, CLOUDRU_S3_TENANT_ID; ROUTERAI_API_KEY for `errand`.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import cloudru
import s3

HERE = Path(__file__).resolve().parent
HOST_CODE = HERE.parent.parent / "browser-vm" / "host"
SETS = "probe/stage2/sets"
# The durable artifacts hosts boot from (docs/browser-pool.md, section 2); POOL_* variables override them.
ARTIFACTS = {
    "bundle": {"key": os.environ.get("POOL_BUNDLE_KEY", "pool/host/host-d9b5f3673fb6.tgz"),
               "sha256": os.environ.get("POOL_BUNDLE_SHA256",
                                         "d9b5f3673fb68db5c3ea158b2bf5c91dd7d134639c4b98de9bc78eec5af5f43e")},
    "rootfs": {"version": os.environ.get("POOL_ROOTFS_VERSION", "sandbox-20260930.3"),
               "key": os.environ.get("POOL_ROOTFS_KEY", "pool/rootfs/sandbox-20260930.3.tar.zst"),
               "sha256": os.environ.get("POOL_ROOTFS_SHA256",
                                         "604b9e820c8ffb889caedc9cb7c908268e5b16337bbcf5c29bf6930d822497b0")},
}
STATE = cloudru.STATE_DIR
ROUTERAI = "https://routerai.ru/api/v1"
MODEL = "deepseek/deepseek-v4.1-flash"
PROXY_PORT = 3130


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def token(key, env, **extra):
    payload = b64url(json.dumps({"env": env, "exp": int(time.time()) + 600, **extra}).encode())
    signature = hmac.new(key, f"v1.{payload}".encode(), hashlib.sha256).digest()
    return f"v1.{payload}.{b64url(signature)}"


def signing_key():
    path = STATE / "pool-signing-key"
    if not path.exists():
        cloudru.write_private(path, secrets.token_hex(32))
    return path.read_text().strip()


def host_key(host_id):
    return hmac.new(bytes.fromhex(signing_key()), f"bro-browser-host:{host_id}".encode(), hashlib.sha256).digest()


def sandbox_keys(sandbox):
    path = STATE / f"pool-{sandbox}.json"
    if not path.exists():
        cloudru.write_private(path, json.dumps({"workspace": f"personal:probe{secrets.token_hex(4)}",
                                                "workerKey": secrets.token_hex(32), "dataKey": secrets.token_hex(32)}))
    return json.loads(path.read_text())


def domain(name):
    path = STATE / f"pool-{name}.domain"
    return path.read_text().strip() if path.exists() else None


def request(method, url, body=None, headers=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data, {"Content-Type": "application/json", **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            payload = response.read()
            code = response.status
    except urllib.error.HTTPError as error:
        payload, code = error.read(), error.code
    try:
        return code, json.loads(payload or b"null")
    except ValueError:
        return code, payload[:300]


def hostd(name, method, path, body=None, timeout=180):
    auth = {"Authorization": "Bearer " + token(host_key(name), name)}
    return request(method, f"https://{domain(name)}/h{path}", body, auth, timeout)


def worker(name, sandbox, method, path, body=None, timeout=60):
    keys = sandbox_keys(sandbox)
    auth = {"Authorization": "Bearer " + token(bytes.fromhex(keys["workerKey"]), keys["workspace"], gen=0)}
    return request(method, f"https://{domain(name)}/g/{sandbox}{path}", body, auth, timeout)


def public_ip(vm_name):
    vm = cloudru.vm_by_name(vm_name)
    if vm is None:
        return None
    _, full = cloudru.api("GET", f"/v1/vms/{vm['id']}")
    addresses = {i.get("ip_address") for i in full.get("interfaces", [])}
    for ip in cloudru.floating_ips():
        if (ip.get("interface") or {}).get("ip_address") in addresses:
            return ip["ip_address"]
    return None


def cmd_boot(args):
    if args.name.startswith("bro-"):
        sys.exit("probe names must not start with bro-")
    bundle, rootfs = ARTIFACTS["bundle"], ARTIFACTS["rootfs"]
    environment = {**os.environ, "BROWSER_VM_SIGNING_KEY": signing_key()}
    user_data = subprocess.run(
        [sys.executable, str(HOST_CODE / "boot.py"), "cloud-init", "--host-id", args.name,
         "--bundle-url", s3.presign("GET", bundle["key"], 3 * 3600), "--bundle-sha256", bundle["sha256"],
         "--rootfs-version", rootfs["version"], "--rootfs-url", s3.presign("GET", rootfs["key"], 3 * 3600),
         "--rootfs-sha256", rootfs["sha256"]] + (["--runtime", args.runtime] if args.runtime != "runc" else []),
        env=environment, capture_output=True, text=True, check=True).stdout
    # Stand only: a root password for console.py (Bro's hosts have no login at all).
    password = "Pr" + secrets.token_hex(8) + "9!"
    cloudru.write_private(STATE / f"{args.name}.password", password)
    user_data += (f"chpasswd:\n  expire: false\n  users:\n    - {{name: root, password: \"{password}\", type: text}}\n"
                  "ssh_pwauth: false\n")
    vm = {"project_id": cloudru.project_id(), "name": args.name, "availability_zone_name": cloudru.ZONE,
          "flavor_name": args.flavor, "image_name": "ubuntu-22.04",
          "disks": [{"name": args.name + "-disk", "size": args.disk, "disk_type_name": "SSD"}],
          "interfaces": [{"type": "regular", "subnet_name": cloudru.SUBNET, "new_external_ip": True,
                          "security_group_names": [cloudru.SECURITY_GROUP]}],
          "cloud_init": base64.b64encode(user_data.encode()).decode()}
    started = time.time()
    code, body = cloudru.api("POST", "/v1.1/vms", [vm])
    if code != 201:
        sys.exit(f"create {code}: {body}")
    marks, ip, state = {}, None, None
    while time.time() - started < 900:
        if "running" not in marks:
            found = cloudru.vm_by_name(args.name)
            if found and found["state"] != state:
                state = found["state"]
                print(f"+{time.time() - started:.0f}s vm {state}", flush=True)
            if state == "running":
                marks["running"] = round(time.time() - started)
        if ip is None and "running" in marks:
            ip = public_ip(args.name)
            if ip:
                cloudru.write_private(STATE / f"pool-{args.name}.domain", ip.replace(".", "-") + ".sslip.io")
                print(f"+{time.time() - started:.0f}s ip {ip}", flush=True)
        if ip:
            try:
                code, health = request("GET", f"https://{domain(args.name)}/h/v1/health", timeout=8)
            except (urllib.error.URLError, OSError, ssl.SSLError):
                code, health = None, None
            if code == 200:
                stage = health.get("stage")
                if stage not in marks:
                    marks[stage] = round(time.time() - started)
                    print(f"+{marks[stage]}s stage {stage} {health.get('runtime')} {health.get('runtimeVersion')}",
                          flush=True)
                if stage == "ready" or (stage or "").startswith("failed"):
                    break
        time.sleep(5)
    print(json.dumps({"host": args.name, "domain": domain(args.name), "marksS": marks}))


def cmd_host(args):
    print(json.dumps(hostd(args.name, "GET", f"/v1/{args.what}"), indent=1))


def set_urls(sandbox, generation, method, count=None):
    keys = sandbox_keys(sandbox)
    prefix = f"{SETS}/{keys['workspace'].replace(':', '-')}/{generation}"
    if method == "PUT":
        chunks = [s3.presign("PUT", f"{prefix}/chunk-{i:04d}", 3600) for i in range(count)]
    else:
        names = sorted(key for key, _ in s3.listing(prefix + "/") if "/chunk-" in key)
        chunks = [s3.presign("GET", key, 3600) for key in names]
    return {"chunkUrls": chunks, "manifestUrl": s3.presign(method, f"{prefix}/manifest.json", 3600),
            "dataKey": keys["dataKey"]}


def cmd_create(args):
    keys = sandbox_keys(args.sandbox)
    body = {"id": args.sandbox, "workspace": keys["workspace"], "generation": args.gen,
            "workerKey": keys["workerKey"], "rootfsVersion": ARTIFACTS["rootfs"]["version"]}
    if args.memory:
        body["memoryMb"] = args.memory
    if args.restore is not None:
        body["restore"] = set_urls(args.sandbox, args.restore, "GET")
    elif args.profile is not None:
        body["profile"] = set_urls(args.sandbox, args.profile, "GET")
    started = time.monotonic()
    code, answer = hostd(args.name, "POST", "/v1/sandboxes", body)
    created = time.monotonic() - started
    ready = None
    while code in (200, 201) and time.monotonic() - started < 120:
        try:
            status, health = worker(args.name, args.sandbox, "GET", "/v1/health", timeout=5)
            if status == 200 and health.get("chrome"):
                ready = time.monotonic() - started
                break
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.2)
    print(json.dumps({"status": code, "answer": answer, "apiS": round(created, 2),
                      "chromeReadyS": ready and round(ready, 2)}, indent=1))


def cmd_park(args):
    code, answer = worker(args.name, args.sandbox, "POST", "/v1/park", {})
    print("worker park", code, answer)
    started = time.monotonic()
    code, answer = hostd(args.name, "POST", f"/v1/sandboxes/{args.sandbox}/park",
                         {"generation": args.gen, "dataKey": sandbox_keys(args.sandbox)["dataKey"],
                          "upload": set_urls(args.sandbox, args.gen, "PUT", 64)}, timeout=600)
    print(json.dumps({"status": code, "answer": answer, "wallS": round(time.monotonic() - started, 2)}, indent=1))


def cmd_delete(args):
    print(hostd(args.name, "DELETE", f"/v1/sandboxes/{args.sandbox}?generation={args.gen}"))


def cmd_worker(args):
    body = json.loads(args.body) if args.body else None
    print(json.dumps(worker(args.name, args.sandbox, args.method, args.path, body), indent=1, ensure_ascii=False))


def cmd_session(args):
    """The stand's proxy on the host (hostd's stand-only `stand_host_ports`) as the residential one."""
    print(worker(args.name, args.sandbox, "POST", "/v1/session", {"proxy": {
        "host": args.proxy_host, "port": PROXY_PORT, "username": "probe", "password": "none"}}, timeout=90))


def cdp(url, method, params=None):
    import websocket
    ca = {"ca_certs": os.environ["SSL_CERT_FILE"]} if os.environ.get("SSL_CERT_FILE") else None
    proxy = urllib.parse.urlparse(os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or "")
    options = {"http_proxy_host": proxy.hostname, "http_proxy_port": proxy.port, "proxy_type": "http"} \
        if proxy.hostname else {}
    ws = websocket.create_connection(url, timeout=60, sslopt=ca, **options)
    try:
        ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        while True:
            message = json.loads(ws.recv())
            if message.get("id") == 1:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})
    finally:
        ws.close()


MARKER_URL = "https://ya.ru/"


def cmd_markers(args):
    keys = sandbox_keys(args.sandbox)
    cdp_token = token(bytes.fromhex(keys["workerKey"]), keys["workspace"], gen=0)
    base = f"https://{domain(args.name)}/g/{args.sandbox}/v1/cdp/{cdp_token}"
    code, version = request("GET", base + "/json/version")
    browser = version["webSocketDebuggerUrl"]
    print("browser socket", browser.split("/v1/cdp/")[0])
    target = cdp(browser, "Target.createTarget", {"url": MARKER_URL})["targetId"]
    page = f"{browser.split('/devtools/')[0]}/devtools/page/{target}"
    state = None
    for _ in range(60):
        time.sleep(1)
        state = cdp(page, "Runtime.evaluate", {"expression": "document.readyState + ' ' + location.href",
                                               "returnByValue": True})["result"].get("value")
        if state and state.startswith("complete"):
            break
    marker_file = STATE / f"pool-{args.sandbox}.marker"
    if args.action == "set":
        marker = f"m{int(time.time())}"
        cloudru.write_private(marker_file, marker)
        expression = (f"document.cookie = 'bro_marker={marker}; max-age=86400; path=/'; "
                      f"localStorage.setItem('bro_marker', '{marker}'); 1")
        cdp(page, "Runtime.evaluate", {"expression": expression, "returnByValue": True})
    expression = ("({url: location.href, cookie: (document.cookie.match(/bro_marker=[^;]*/) || [null])[0], "
                  "local: localStorage.getItem('bro_marker')})")
    value = cdp(page, "Runtime.evaluate", {"expression": expression, "returnByValue": True})["result"].get("value")
    expected = marker_file.read_text() if marker_file.exists() else None
    print(json.dumps({"state": state, **(value or {}), "expected": expected,
                      "ok": bool(value) and value.get("cookie") == f"bro_marker={expected}"
                      and value.get("local") == expected}))
    cdp(browser, "Target.closeTarget", {"targetId": target})


def cmd_errand(args):
    key = s3.clean(os.environ["ROUTERAI_API_KEY"])
    run_id = f"probe-{int(time.time())}"
    task = ("Открой https://ru.ruwiki.ru/wiki/Казань и ответь одним числом: в каком году основан город по этой "
            "статье. Не входи ни в какие аккаунты и ничего не отправляй.")
    started = time.monotonic()
    code, answer = worker(args.name, args.sandbox, "POST", "/v1/runs", {
        "id": run_id, "sessionId": f"s-{run_id}", "task": task, "maxSteps": 6, "timeoutSeconds": 240,
        "vision": False, "llm": {"baseUrl": ROUTERAI, "apiKey": key, "model": MODEL}})
    print("start", code, answer if code not in (200, 202) else "")
    run = {}
    while code in (200, 202) and time.monotonic() - started < 300:
        time.sleep(3)
        status, run = worker(args.name, args.sandbox, "GET", f"/v1/runs/{run_id}")
        if status == 200 and run.get("status") in ("completed", "failed", "cancelled"):
            break
    print(json.dumps({"wallS": round(time.monotonic() - started, 1), "status": run.get("status"),
                      "success": run.get("success"), "steps": run.get("stepCount"), "finalUrl": run.get("finalUrl"),
                      "result": (run.get("result") or run.get("error") or "")[:300], "usage": run.get("usage")},
                     ensure_ascii=False, indent=1))


def cmd_forget(args):
    print("deleted", s3.delete_prefix(f"{SETS}/{args.workspace.replace(':', '-')}/"))
    print("left", s3.listing(f"{SETS}/{args.workspace.replace(':', '-')}/"))


def cmd_artifacts(_):
    print(json.dumps(ARTIFACTS, indent=1))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("artifacts").set_defaults(fn=cmd_artifacts)
    boot = sub.add_parser("boot")
    boot.add_argument("name")
    boot.add_argument("--flavor", default="gen-2-8")
    boot.add_argument("--disk", type=int, default=20)
    boot.add_argument("--runtime", default="runc")
    boot.set_defaults(fn=cmd_boot)
    host = sub.add_parser("host")
    host.add_argument("name")
    host.add_argument("what", choices=["health", "capacity"])
    host.set_defaults(fn=cmd_host)
    create = sub.add_parser("create")
    create.add_argument("name")
    create.add_argument("sandbox")
    create.add_argument("--gen", type=int, default=1)
    create.add_argument("--memory", type=int)
    create.add_argument("--restore", type=int)
    create.add_argument("--profile", type=int)
    create.set_defaults(fn=cmd_create)
    for command, function in (("park", cmd_park), ("delete", cmd_delete)):
        one = sub.add_parser(command)
        one.add_argument("name")
        one.add_argument("sandbox")
        one.add_argument("gen", type=int)
        one.set_defaults(fn=function)
    call = sub.add_parser("worker")
    call.add_argument("name")
    call.add_argument("sandbox")
    call.add_argument("method")
    call.add_argument("path")
    call.add_argument("body", nargs="?")
    call.set_defaults(fn=cmd_worker)
    session = sub.add_parser("session")
    session.add_argument("name")
    session.add_argument("sandbox")
    session.add_argument("proxy_host")
    session.set_defaults(fn=cmd_session)
    markers = sub.add_parser("markers")
    markers.add_argument("name")
    markers.add_argument("sandbox")
    markers.add_argument("action", choices=["set", "check"])
    markers.set_defaults(fn=cmd_markers)
    errand = sub.add_parser("errand")
    errand.add_argument("name")
    errand.add_argument("sandbox")
    errand.set_defaults(fn=cmd_errand)
    forget = sub.add_parser("forget")
    forget.add_argument("workspace")
    forget.set_defaults(fn=cmd_forget)
    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
