"""Bro's own VM on Cloud.ru (scripts/cloudru-app-host/README.md), from the session: keys, artifacts in
Object Storage, the VM, releases, env, sites and logs. The VM side is host/ (provision.sh, deployd.py,
watchdog.py); the Compute API, serial console and S3 signing are the stand's
(scripts/cloudru-sandbox-probe), their caches in ~/.bro-app-host.

  python host.py key                            DEPLOY_SIGNING_KEY into ~/.bro-app-host/env/new-secrets.json
                                                (0600) when it is not there; host keys derive from it
  python host.py vendor                         Caddy, Node and the PostgreSQL client by their pins into
                                                ~/.bro-app-host/vendor, then into Object Storage (app/vendor/)
  python host.py create NAME [--flavor gen-2-8] [--disk 40] [--no-console] [--wait-minutes 25]
                                                the VM in CLOUDRU_ZONE with a public IP and cloud-init, then
                                                waits for https://<ip with dashes>.sslip.io/ops/v1/health
  python host.py status NAME [--stage]          state, address, deployd's status; --stage over the console
  python host.py reboot NAME | delete NAME      set-power reboot | the VM and its public IP
  python host.py build [--allow-dirty]          pnpm install, eve (Postgres world) and Next (standalone)
                                                builds, ops/migrate.mjs, one tar.zst in app/releases/
  python host.py deploy NAME [--version V]      build (unless --version), then release it on the VM: migrate,
                                                switch, health within 120 s or back to the previous release
  python host.py rollback NAME [--version V]    the release before the current one (or V)
  python host.py env NAME --profile stand|prod [--dry-run]
                                                compose /etc/bro/env and PUT it (names only are printed)
  python host.py sites NAME [--set D,D | --add D | --remove D]
  python host.py logs NAME UNIT [--lines 200]   bro-web, bro-eve, caddy, deployd, bro-watchdog
  python host.py restart NAME [UNIT ...] | stop NAME UNIT ...
  python host.py ops NAME SCRIPT [ARG ...]      ops/SCRIPT of the current release (db-dump.sh, db-restore.sh);
                                                an ARG s3get:KEY or s3put:KEY becomes a presigned link

VM names must match bro-app-[a-z0-9-]+: this script never acts on another VM of the project (the pool's
bro-host-*, the code host's sbx-*). Needs CLOUDRU_KEY_ID, CLOUDRU_KEY_SECRET and CLOUDRU_S3_TENANT_ID.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
STATE = Path(os.environ.get("BRO_APP_HOST_DIR", Path.home() / ".bro-app-host"))
STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
SECRETS = STATE / "env"
os.environ["PROBE_STATE_DIR"] = str(STATE)  # the stand's token, project and console caches live here too
sys.path.insert(0, str(REPO / "scripts" / "cloudru-sandbox-probe"))
sys.path.insert(0, str(HERE / "host"))
import boot  # noqa: E402
import cloudru  # noqa: E402
import deployd  # noqa: E402
import s3  # noqa: E402

NAME = re.compile(r"bro-app-[a-z0-9-]{1,55}")
VENDOR = STATE / "vendor"
BUILDS = STATE / "build"
LINK_SECONDS = 12 * 3600
STUB_ENV = {
    # env.ts validates while eve and Next evaluate the app; nothing of these lands in the output.
    "DATABASE_URL": "postgres://build:build@127.0.0.1:5432/build",
    "BETTER_AUTH_URL": "http://127.0.0.1:3000",
    "BETTER_AUTH_SECRET": "build-only-0123456789abcdef0123456789abcdef",
    "SECRET_ENCRYPTION_KEY": base64.b64encode(bytes(32)).decode(),
}


def host_name(name):
    if not NAME.fullmatch(name):
        sys.exit("VM names must match bro-app-[a-z0-9-]+ (this script touches no other VM)")
    return name


def write_private(path, text):
    cloudru.write_private(path, text)
    os.chmod(path, 0o600)


def clean(value):
    """Line breaks anywhere, whitespace and (typographic) quotes at the ends: what pasted keys carry."""
    return re.sub(r"[\r\n]", "", value).strip().strip("‘’“”'\"").strip()


# --- Keys ---------------------------------------------------------------------------------------------------


def new_secrets():
    path = SECRETS / "new-secrets.json"
    return path, (json.loads(path.read_text()) if path.exists() else {})


def signing_key(create=False):
    path, values = new_secrets()
    if "DEPLOY_SIGNING_KEY" not in values:
        if not create:
            sys.exit(f"no DEPLOY_SIGNING_KEY in {path}: python host.py key")
        values["DEPLOY_SIGNING_KEY"] = secrets.token_hex(32)
        SECRETS.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_private(path, json.dumps(values, indent=1) + "\n")  # the other keys stay as they were
        print(f"made a new DEPLOY_SIGNING_KEY in {path}")
    return bytes.fromhex(clean(values["DEPLOY_SIGNING_KEY"]))


def host_key(name):
    return hmac.new(signing_key(), f"bro-app-host:{name}".encode(), hashlib.sha256).digest()


def cmd_key(_args):
    signing_key(create=True)
    print("host keys: HMAC-SHA256(DEPLOY_SIGNING_KEY, 'bro-app-host:' + name), derived when needed")


# --- Object Storage -----------------------------------------------------------------------------------------


def stored(key):
    return next((size for found, size in s3.listing(key) if found == key), None)


def upload(key, path=None, data=None):
    data = Path(path).read_bytes() if data is None else data
    code, body = s3.send(urllib.request.Request(s3.presign("PUT", key, 3600), data, method="PUT"))
    if code != 200:
        sys.exit(f"put {key}: {code} {body[:200]!r}")
    print(f"uploaded {key} ({len(data)} bytes)")


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def vendor_key(name):
    return f"app/vendor/{name}"


def cmd_vendor(_args):
    boot.vendor(VENDOR)
    for name, pin in boot.vendor_objects():
        path = VENDOR / name
        if file_sha256(path) != pin:
            sys.exit(f"{path} is not the pinned file")
        if stored(vendor_key(name)) != path.stat().st_size:
            upload(vendor_key(name), path)
        else:
            print(f"{vendor_key(name)} is there")
    print(f"Caddy {boot.VENDOR['caddy']['version']} in {VENDOR / 'caddy'} (it travels in the host bundle)")


# --- The VM -------------------------------------------------------------------------------------------------


def console_password(name):
    password = secrets.token_urlsafe(18)
    write_private(STATE / f"{name}.password", password)
    salt = secrets.token_hex(8)
    result = subprocess.run(["openssl", "passwd", "-6", "-salt", salt, "-stdin"], input=password,
                            capture_output=True, text=True, check=True)
    return result.stdout.strip()


def full_vm(vm_id):
    for _ in range(5):  # GET /v1/vms/{id} answers 500 every so often (AZ-1, 30.09)
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


def found_vm(name):
    vm = cloudru.vm_by_name(host_name(name))
    if vm is None:
        sys.exit(f"no VM {name}")
    return full_vm(vm["id"])


def ops_domain(name):
    """<public IP with dashes>.sslip.io, cached per VM (the Compute API is slow and needs the key)."""
    cache = STATE / f"{name}.json"
    if cache.exists():
        return json.loads(cache.read_text())["domain"]
    ip, _ = public_ip(found_vm(name))
    if not ip:
        sys.exit(f"{name} has no public IP")
    domain = ip.replace(".", "-") + ".sslip.io"
    cache.write_text(json.dumps({"name": name, "ip": ip, "domain": domain}) + "\n")
    return domain


class LostAnswer(Exception):
    """A request that starts a job went out, but its answer did not come back."""


def call(name, method, path, body=None, timeout=60, retry=None):
    """deployd on the VM with a fresh 5-minute token; (status, JSON body).

    Only requests that change nothing on a repeat are retried (GET, PUT sites): a job-starting request whose
    answer was lost may be running already, and a repeat would get `busy` or run a finished job twice."""
    retry = method == "GET" if retry is None else retry
    token = deployd.sign_token(host_key(name), name, ttl=300)
    url = f"https://{ops_domain(name)}/ops/v1/{path}"
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data, {"Authorization": f"Bearer {token}",
                                                 "Content-Type": "application/json"}, method=method)
    attempts = 4 if retry else 1
    for attempt in range(attempts):  # the session's egress proxy drops a tunnel now and then
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            payload = error.read()
            try:
                return error.code, json.loads(payload)
            except ValueError:
                return error.code, {"error": payload[:300].decode(errors="replace")}
        except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
            if attempt == attempts - 1:
                if not retry:
                    raise LostAnswer(f"{method} {path}: {error}") from None
                sys.exit(f"{method} {path}: {error}")
            time.sleep(2 ** attempt)


def start_job(name, method, path, body):
    """Start a deployd job; when the answer is lost, follow the job deployd is running instead of repeating."""
    try:
        return checked(call(name, method, path, body))
    except LostAnswer as error:
        print(f"{error}; asking deployd what it runs", flush=True)
    status = checked(call(name, "GET", "status"), (200,))
    if status.get("job"):
        print(f"deployd runs job {status['job']}: following it", flush=True)
        return {"id": status["job"]}
    sys.exit(f"deployd runs no job now: the request may not have arrived, or it ended already. Check "
             f"`python host.py status {name}` and the logs before repeating it")


def checked(response, expected=(200, 202)):
    code, body = response
    if code not in expected:
        sys.exit(f"deployd {code}: {body.get('error', body)}")
    return body


def follow(name, job, timeout_s=1800):
    """Print a job's log as it grows until it ends; exit 1 when it failed."""
    seen, deadline = 0, time.time() + timeout_s
    while True:
        job = checked(call(name, "GET", f"jobs/{job['id']}"), (200,))
        for line in job["log"][seen:]:
            print(line, flush=True)
        seen = len(job["log"])
        if job["state"] != "running":
            if job.get("result"):
                print(json.dumps(job["result"], ensure_ascii=False))
            if job["state"] == "failed":
                sys.exit(1)
            return job
        if time.time() > deadline:
            sys.exit(f"job {job['id']} still running after {timeout_s} s: python host.py status {name}")
        time.sleep(3)


def health(domain, timeout=15):
    try:
        with urllib.request.urlopen(f"https://{domain}/ops/v1/health", timeout=timeout) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, error.read()[:200]
    except (urllib.error.URLError, OSError, ValueError) as error:
        return None, str(error)[:200]


def deliver_bundle():
    if not (VENDOR / "caddy").exists():
        sys.exit("no vendored Caddy: python host.py vendor")
    data = boot.bundle(VENDOR)
    digest = boot.sha256(data)
    key = f"app/host/app-host-{digest[:16]}.tgz"
    if stored(key) != len(data):
        upload(key, data=data)
    return key, digest


def cmd_create(args):
    name = host_name(args.name)
    if cloudru.vm_by_name(name):
        sys.exit(f"{name} exists already")
    objects = {}
    for file_name, pin in boot.vendor_objects():
        if stored(vendor_key(file_name)) is None:
            sys.exit(f"no {vendor_key(file_name)} in Object Storage: python host.py vendor")
        objects[file_name] = {"url": s3.presign("GET", vendor_key(file_name), LINK_SECONDS), "sha256": pin}
    bundle_key, bundle_sha = deliver_bundle()
    user_data = boot.cloud_init(
        host_id=name, key=host_key(name), bundle_url=s3.presign("GET", bundle_key, LINK_SECONDS),
        bundle_sha256=bundle_sha, objects=objects,
        console_password_hash=None if args.no_console else console_password(name))
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
    print(f"create {name} ({args.flavor}, SSD {args.disk} GB) in {cloudru.ZONE}", flush=True)
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
            sys.exit(f"{name} is {state} after {args.wait_minutes} minutes: python host.py status {name}")
        time.sleep(10)
    domain = ip.replace(".", "-") + ".sslip.io"
    (STATE / f"{name}.json").write_text(json.dumps({"name": name, "ip": ip, "domain": domain}) + "\n")
    print(f"running at {ip}; waiting for https://{domain}/ops/v1/health (the network comes ~3 min late)",
          flush=True)
    deadline = time.time() + args.wait_minutes * 60
    while time.time() < deadline:
        code, body = health(domain)
        if code == 200:
            print(f"+{time.time() - started:.0f}s deployd: {json.dumps(body)}")
            return
        print(f"+{time.time() - started:.0f}s health: {code or body}", flush=True)
        time.sleep(15)
    sys.exit(f"no health after {args.wait_minutes} minutes: python host.py status {name} --stage "
             f"(a first boot stuck in initramfs: python host.py reboot {name})")


def cmd_status(args):
    vm = found_vm(args.name)
    ip, _ = public_ip(vm)
    print(json.dumps({"name": vm["name"], "id": vm["id"], "state": vm["state"],
                      "flavor": (vm.get("flavor") or {}).get("name"), "ip": ip}))
    if ip:
        code, body = health(ops_domain(args.name))
        print(f"deployd health: {code} {json.dumps(body) if code == 200 else body}")
        if code == 200:
            print(json.dumps(checked(call(args.name, "GET", "status"), (200,)), indent=1, ensure_ascii=False))
    if args.stage:
        import console  # websocket-client, only here
        output, _ = console.run(args.name, "cat /var/lib/bro/stage; cat /var/lib/bro/timeline; "
                                           "tail -n 15 /var/log/bro-provision.log", 60)
        print(output)


def cmd_reboot(args):
    vm = found_vm(args.name)
    code, body = cloudru.api("POST", f"/v1/vms/{vm['id']}/set-power", {"state": "reboot"})
    print("set-power reboot", code, body if code >= 300 else "")


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
    if floating_id and any(ip["id"] == floating_id for ip in cloudru.floating_ips()):
        print("delete ip", cloudru.api("DELETE", f"/v1/floating-ips/{floating_id}")[0])
    (STATE / f"{args.name}.json").unlink(missing_ok=True)
    print(f"{args.name} deleted")


# --- Releases -----------------------------------------------------------------------------------------------


def run(argv, env, cwd=REPO):
    print("$ " + " ".join(argv), flush=True)
    subprocess.run(argv, env=env, cwd=cwd, check=True)


def build_env(**extra):
    """A clean env: the session's secrets break env.ts (TELEGRAM_BOT_USERNAME with an @, real keys)."""
    env = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/root"), "NODE_ENV": "production",
           **STUB_ENV, **extra}
    for name in ("SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
                 "https_proxy", "http_proxy", "no_proxy"):
        if os.environ.get(name):
            env[name] = os.environ[name]
    return env


def git(*args):
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()


def assemble(stage, version, commit):
    """The release tree: web (Next standalone), eve (.output), db/migrations, ops/, release.json."""
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    shutil.copytree(REPO / ".next/standalone", stage / "web", symlinks=True)
    shutil.copytree(REPO / ".next/static", stage / "web/.next/static")
    shutil.copytree(REPO / "public", stage / "web/public")
    shutil.copytree(REPO / ".output", stage / "eve", symlinks=True)
    shutil.copytree(REPO / "db/migrations", stage / "db/migrations")
    world = REPO / "node_modules/@workflow/world-postgres"
    shutil.copytree(world / "src/drizzle/migrations", stage / "ops/world-migrations")
    for script in sorted((HERE / "ops").glob("*.sh")):
        shutil.copy2(script, stage / "ops" / script.name)
    shutil.copy2(BUILDS / "migrate.mjs", stage / "ops/migrate.mjs")
    node = subprocess.run(["node", "--version"], capture_output=True, text=True, check=True).stdout.strip()
    world_version = json.loads((world / "package.json").read_text())["version"]
    (stage / "release.json").write_text(json.dumps({
        "version": version, "commit": commit, "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "node": node, "workflowWorld": world_version}, indent=1) + "\n")


def local_env_files():
    """The .env files Next and eve's Nitro read during a build, whatever the env: real values would reach
    the artifact."""
    return sorted(p.name for p in REPO.glob(".env*") if p.is_file() and p.name != ".env.example")


def cmd_build(args):
    if local_env_files():
        sys.exit(f"move {', '.join(local_env_files())} out of {REPO}: Next and eve read them during the build")
    status = git("status", "--porcelain", "--untracked-files=no")
    if status and not args.allow_dirty:
        sys.exit("the working tree has changes: commit them (or --allow-dirty for a test build)")
    commit = git("rev-parse", "HEAD")
    version = time.strftime("%Y%m%d-%H%M%S", time.gmtime()) + "-" + commit[:8] + ("-dirty" if status else "")
    BUILDS.mkdir(parents=True, exist_ok=True)
    env = build_env()
    run(["pnpm", "install", "--frozen-lockfile"], env)
    run(["pnpm", "build:eve"], build_env(WORKFLOW_WORLD="postgres"))
    # next directly, not turbo: a cached Vercel-shaped build must never stand in for the standalone one.
    run(["pnpm", "exec", "next", "build"], build_env(NEXT_OUTPUT="standalone", EVE_NEXT_PRODUCTION_PORT="4274"))
    run(["pnpm", "exec", "esbuild", "scripts/cloudru-app-host/ops/migrate.ts", "--bundle", "--platform=node",
         "--target=node24", "--format=esm", f"--outfile={BUILDS / 'migrate.mjs'}", "--external:typescript",
         "--external:pg-native", "--log-level=warning",
         "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"],
        env)
    stage = BUILDS / "stage"
    assemble(stage, version, commit)
    archive = BUILDS / f"{version}.tar.zst"
    run(["tar", "-C", str(stage), "-I", "zstd -19 -T0", "-cf", str(archive), "."], env)
    digest = file_sha256(archive)
    key = f"app/releases/{version}.tar.zst"
    upload(key, archive)
    upload(key + ".sha256", data=f"{digest}  {version}.tar.zst\n".encode())
    record = {"version": version, "commit": commit, "key": key, "sha256": digest, "size": archive.stat().st_size}
    (BUILDS / "last.json").write_text(json.dumps(record, indent=1) + "\n")
    shutil.rmtree(stage)
    archive.unlink()
    print(json.dumps(record))
    return record


def release_record(version):
    key = f"app/releases/{version}.tar.zst"
    code, body = s3.send(urllib.request.Request(s3.presign("GET", key + ".sha256", 300)))
    if code != 200:
        sys.exit(f"no {key}.sha256 in Object Storage ({code}): python host.py build")
    return {"version": version, "key": key, "sha256": body.decode().split()[0]}


def cmd_deploy(args):
    host_name(args.name)
    record = release_record(args.version) if args.version else cmd_build(args)
    body = {"version": record["version"], "sha256": record["sha256"],
            "url": s3.presign("GET", record["key"], 1800)}
    job = start_job(args.name, "POST", "release", body)
    print(f"release {record['version']}: job {job['id']}")
    follow(args.name, job)


def cmd_rollback(args):
    job = start_job(host_name(args.name), "POST", "rollback", {"version": args.version} if args.version else {})
    follow(args.name, job)


# --- Env ----------------------------------------------------------------------------------------------------

# The app's own names: every key of the server schema in shared/environment/env.ts.
APP_NAMES = set(re.findall(r"^    ([A-Z][A-Z0-9_]+):", (REPO / "shared/environment/env.ts").read_text(), re.M))
# Build-time or Vercel's own: never in the VM's env.
NOT_RUNTIME = {"NODE_ENV", "WORKFLOW_WORLD", "DATABASE_DRIVER", "VERCEL_BRANCH_URL", "VERCEL_ENV",
               "VERCEL_PROJECT_ID", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"}
# Neon's: the VM's databases come from the profile file only.
FROM_PROFILE_ONLY = {"DATABASE_URL", "DATABASE_URL_UNPOOLED", "WORKFLOW_POSTGRES_URL"}
REQUIRED = ("DATABASE_URL", "WORKFLOW_POSTGRES_URL", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET",
            "SECRET_ENCRYPTION_KEY")
# The rehearsal stand runs on a copy of production's data and is reachable from the internet, so it gets no
# key that reaches people or production's stores: no messengers or payments; no Vercel Blob (the same paths
# as production's), Supermemory or Composio (connected accounts copied from production could send mail);
# nothing that bills with no scheduler to settle it: Browser Use, the browser VM and pool pilots, the code
# sandbox pilot. The operator brings one back in stand.json when a rehearsal needs it on purpose.
STAND_DROPPED = re.compile(r"(TELEGRAM_|IMESSAGE_|YOOKASSA_|BLOB_|EVE_MEMORY_BLOB_|BROWSER_USE_|BROWSER_HOST_).*|"
                           r"SUPERMEMORY_API_KEY|COMPOSIO_API_KEY|BROWSER_VM_TWOCAPTCHA_API_KEY|"
                           r"BROWSER_POOL_WORKSPACES|BROWSER_VM_WORKSPACES|SANDBOX_WORKSPACES")
# Keys of production's own stores and accounts: on the stand each is named when it is there (from stand.json).
PRODUCTION_STORES = re.compile(r"(BLOB_|EVE_MEMORY_BLOB_|BROWSER_USE_API_KEY).*|SUPERMEMORY_API_KEY|"
                               r"COMPOSIO_API_KEY")
# SCHEDULES=off makes every schedule's tick do nothing (agent/lib/schedules/enabled.ts). Not TEST=1: Better
# Auth reads it too and turns its origin check off.
PROFILES = {
    "stand": {"BETTER_AUTH_URL": "https://cloud.brobro.tech", "SCHEDULES": "off"},
    "prod": {"BETTER_AUTH_URL": "https://brobro.tech", "SCHEDULES": "on"},
}
# graphile wants a pool at least its concurrency + 2. WORKFLOW_WORLD as the build had it: agent.ts reads it
# again when the bundle loads.
# Sensitive on Vercel (never readable back): the session or the profile file must bring them.
EXPECTED = ("MODEL_PROVIDER", "ROUTERAI_API_KEY", "COMPOSIO_API_KEY", "BROWSER_USE_API_KEY", "SANDBOX_SIGNING_KEY",
            "BROWSER_VM_SIGNING_KEY", "BROWSER_VM_PROXY", "BROWSER_VM_LLM_API_KEY", "SUPERMEMORY_API_KEY")
EXPECTED_PROD = ("TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET_TOKEN",
                 "TELEGRAM_OWNER_CHAT_ID", "IMESSAGE_PROJECT_ID", "IMESSAGE_PROJECT_SECRET", "IMESSAGE_WEBHOOK_SECRET",
                 "YOOKASSA_SHOP_ID", "YOOKASSA_SECRET_KEY")
WORLD_DEFAULTS = {"WORKFLOW_POSTGRES_WORKER_CONCURRENCY": "20", "WORKFLOW_POSTGRES_MAX_POOL_SIZE": "24",
                  "WORKFLOW_WORLD": "postgres"}


def read_json(name):
    path = SECRETS / name
    return json.loads(path.read_text()) if path.exists() else {}


def compose_env(profile, session=None):
    """{name: value} and {name: source}: Vercel production, the vault keys, the session, the profile file."""
    session = os.environ if session is None else session
    values, sources = {}, {}

    def put(name, value, source):
        if value is None:
            values.pop(name, None)
            sources.pop(name, None)
            return
        value = clean(str(value))
        if name == "TELEGRAM_BOT_USERNAME":
            value = value.lstrip("@")  # the handle, as env.ts wants it; pasted with its @ at times
        if value:
            values[name], sources[name] = value, source

    runtime = APP_NAMES - NOT_RUNTIME - FROM_PROFILE_ONLY
    for name, value in read_json("vercel-production.json").items():
        if name in runtime:
            put(name, value, "vercel")
    for name, value in read_json("installation-secrets.json").items():
        if name in ("BETTER_AUTH_SECRET", "SECRET_ENCRYPTION_KEY"):
            put(name, value, "installation-secrets")
    for name in sorted(runtime):
        if name not in values and session.get(name):
            put(name, session[name], "session")
    for name, value in WORLD_DEFAULTS.items():
        put(name, value, "default")
    for name, value in PROFILES[profile].items():
        put(name, value, profile)
    if profile == "stand":
        for name in [n for n in values if STAND_DROPPED.fullmatch(n)]:
            put(name, None, "")
        # The owner hears the stand's watchdog through the bot, which the stand's app does not get.
        if session.get("TELEGRAM_BOT_TOKEN"):
            put("OPS_ALERT_BOT_TOKEN", session["TELEGRAM_BOT_TOKEN"], "session")
    for name, value in read_json(f"{profile}.json").items():
        if not deployd.ENV_NAME.fullmatch(name):
            sys.exit(f"{SECRETS / (profile + '.json')}: bad name {name[:40]!r}")
        put(name, value, f"{profile}.json")
    if values.get("OPS_ALERT_BOT_TOKEN") and not values.get("OPS_ALERT_CHAT_ID"):
        values.pop("OPS_ALERT_BOT_TOKEN")
        sources.pop("OPS_ALERT_BOT_TOKEN")
    return values, sources


def cmd_env(args):
    host_name(args.name)
    values, sources = compose_env(args.profile)
    by_source = {}
    for name in sorted(values):
        by_source.setdefault(sources[name], []).append(name)
    for source, names in by_source.items():
        print(f"{source}: {' '.join(names)}")
    absent = [n for n in EXPECTED + (EXPECTED_PROD if args.profile == "prod" else ()) if n not in values
              and not (args.profile == "stand" and STAND_DROPPED.fullmatch(n))]
    if absent:
        print(f"not found anywhere (Vercel keeps them sensitive): {' '.join(absent)}")
    if args.profile == "stand":
        for name in sorted(n for n in values if PRODUCTION_STORES.fullmatch(n)):
            print(f"warning: the stand keeps {name} ({sources[name]}): it acts on production's store or accounts")
    if "OPS_ALERT_CHAT_ID" not in values:
        print(f"note: no OPS_ALERT_CHAT_ID in {args.profile}.json: the watchdog alerts nobody")
    missing = [name for name in REQUIRED if name not in values]
    if missing:
        sys.exit(f"missing {', '.join(missing)}: put them in {SECRETS / (args.profile + '.json')} (0600)")
    if args.dry_run:
        return
    job = start_job(args.name, "PUT", "env", {"env": values})
    follow(args.name, job)


# --- Sites, logs, restart, ops ------------------------------------------------------------------------------


def cmd_sites(args):
    current = checked(call(host_name(args.name), "GET", "sites"), (200,))
    sites = list(current["sites"])
    if args.set is not None:
        sites = [s for s in args.set.split(",") if s]
    if args.add:
        sites.append(args.add)
    if args.remove:
        sites = [s for s in sites if s != args.remove]
    if args.set is not None or args.add or args.remove:
        current = checked(call(args.name, "PUT", "sites", {"sites": sites}, retry=True), (200,))
    print(json.dumps(current))


def cmd_logs(args):
    body = checked(call(host_name(args.name), "GET", f"logs?unit={args.unit}&lines={args.lines}"), (200,))
    print("\n".join(body["lines"]))


def cmd_restart(args):
    follow(args.name, start_job(host_name(args.name), "POST", "restart", {"units": args.units}))


def cmd_stop(args):
    follow(args.name, start_job(host_name(args.name), "POST", "stop", {"units": args.units}))


def cmd_ops(args):
    host_name(args.name)
    arguments = []
    for argument in args.args:
        if argument.startswith(("s3get:", "s3put:")):
            method, key = argument[2:5].upper(), argument[6:]
            arguments.append(s3.presign(method, key, 6 * 3600))
        else:
            arguments.append(argument)
    follow(args.name, start_job(args.name, "POST", "ops", {"script": args.script, "args": arguments}),
           timeout_s=6 * 3600)


def parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("key").set_defaults(fn=cmd_key)
    sub.add_parser("vendor").set_defaults(fn=cmd_vendor)
    create = sub.add_parser("create")
    create.add_argument("name")
    create.add_argument("--flavor", default="gen-2-8")
    create.add_argument("--disk", type=int, default=40)
    create.add_argument("--no-console", action="store_true")
    create.add_argument("--wait-minutes", type=int, default=25)
    create.set_defaults(fn=cmd_create)
    status = sub.add_parser("status")
    status.add_argument("name")
    status.add_argument("--stage", action="store_true")
    status.set_defaults(fn=cmd_status)
    for name, fn in (("reboot", cmd_reboot), ("delete", cmd_delete)):
        command = sub.add_parser(name)
        command.add_argument("name")
        command.set_defaults(fn=fn)
    build = sub.add_parser("build")
    build.add_argument("--allow-dirty", action="store_true")
    build.set_defaults(fn=cmd_build)
    deploy = sub.add_parser("deploy")
    deploy.add_argument("name")
    deploy.add_argument("--version")
    deploy.add_argument("--allow-dirty", action="store_true")
    deploy.set_defaults(fn=cmd_deploy)
    rollback = sub.add_parser("rollback")
    rollback.add_argument("name")
    rollback.add_argument("--version")
    rollback.set_defaults(fn=cmd_rollback)
    env = sub.add_parser("env")
    env.add_argument("name")
    env.add_argument("--profile", choices=sorted(PROFILES), required=True)
    env.add_argument("--dry-run", action="store_true")
    env.set_defaults(fn=cmd_env)
    sites = sub.add_parser("sites")
    sites.add_argument("name")
    group = sites.add_mutually_exclusive_group()
    group.add_argument("--set")
    group.add_argument("--add")
    group.add_argument("--remove")
    sites.set_defaults(fn=cmd_sites)
    logs = sub.add_parser("logs")
    logs.add_argument("name")
    logs.add_argument("unit", choices=deployd.UNITS)
    logs.add_argument("--lines", type=int, default=200)
    logs.set_defaults(fn=cmd_logs)
    restart = sub.add_parser("restart")
    restart.add_argument("name")
    restart.add_argument("units", nargs="*", help=" ".join(deployd.RESTARTABLE))
    restart.set_defaults(fn=cmd_restart)
    stop = sub.add_parser("stop")
    stop.add_argument("name")
    stop.add_argument("units", nargs="+", choices=deployd.STOPPABLE)
    stop.set_defaults(fn=cmd_stop)
    ops = sub.add_parser("ops")
    ops.add_argument("name")
    ops.add_argument("script")
    # REMAINDER: the script's own options (db-restore.sh --replace) are its arguments, not host.py's.
    ops.add_argument("args", nargs=argparse.REMAINDER)
    ops.set_defaults(fn=cmd_ops)
    return parser


def main(argv=None):
    args = parser().parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
