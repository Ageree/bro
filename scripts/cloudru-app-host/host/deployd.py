"""deployd: releases, env and sites of Bro's own VM on Cloud.ru (scripts/cloudru-app-host/README.md).

Python stdlib only (Ubuntu 22.04's 3.10). Listens on 127.0.0.1:8095; Caddy routes /ops/v1/* to it on the
ops host (<public IP with dashes>.sslip.io) and on no other site. Runs as root: it writes /etc/bro/env and
the Caddyfile, unpacks releases and restarts units.

Auth: `Authorization: Bearer v1.<payload>.<sig>`, the format of sandboxd and hostd: payload
{"env": <host id>, "exp": <unix seconds>} at most 15 minutes ahead, signed with HMAC-SHA256 under the host
key HMAC-SHA256(DEPLOY_SIGNING_KEY, "bro-app-host:" + host id), which cloud-init leaves in
/etc/bro/deployd.json (0600). The session derives the same key (host.py); the VM never sees
DEPLOY_SIGNING_KEY itself.

Routes (all but /ops/v1/health need a token; long work runs as a job, one at a time):
  GET  /ops/v1/health                 {"ok": true, "version"}
  GET  /ops/v1/status                 release, releases, units, health of web and eve, sites, disk, the
                                      Telegram path and the watchdog's checks that are down
  POST /ops/v1/release                {version, url, sha256} -> 202 {job}: download from Object Storage,
                                      check, unpack, migrate (ops/migrate.mjs app world), switch `current`,
                                      restart, wait up to 120 s for health, or switch back; then the
                                      path to Telegram (tg_egress.py --check, when tg-egress is installed)
  POST /ops/v1/rollback               {version?} -> 202 {job}: the previous (or named) release
  GET  /ops/v1/env                    the names in /etc/bro/env and the file's sha256, never values
  PUT  /ops/v1/env                    {env: {NAME: value}, opsEnv?: {NAME: value}, migrate?: true} -> 202
                                      {job}: the whole file, then a restart; opsEnv (only OPS_ONLY_ENV names)
                                      goes to /etc/bro/ops-env, which only ops scripts get, and is removed
                                      without it; migrate: the current release's migrations on the env's
                                      databases first (a new database has no schema; the world fails without)
  GET  /ops/v1/sites                  the app's domains
  PUT  /ops/v1/sites                  {sites: [domain, ...]} the whole list: Caddyfile, reload; www.<site>
                                      next to <site> redirects to it (308)
  GET  /ops/v1/logs?unit=&lines=      the tail of journald for one of the units
  POST /ops/v1/restart                {units: [...]} -> 202 {job}
  POST /ops/v1/stop                   {units: [bro-web, bro-eve]} -> 202 {job} (before a restore); marks
                                      the stop planned (/var/lib/bro/maintenance) until a restart of the
                                      units, so the watchdog stays quiet about them (watchdog.py)
  POST /ops/v1/ops                    {script, args?} -> 202 {job}: ops/<script> of the current release, as
                                      bro; ROOT_OPS (tg-bridge.sh) from the host bundle, as root

Every restart of eve (release, rollback, env, restart) with tg-bridge enabled: stop the bridge, give eve
BRIDGE_DRAIN_S to finish what it took, restart, health, start the bridge again whatever happened
(scripts/cloudru-app-host/tg-bridge/README.md, «Что должен сделать сервер»): an update eve took a moment
before its restart is not lost, and the bridge, which reads the token and the secret once, gets a new env.
  GET  /ops/v1/jobs/<id>              {kind, state: running|done|failed, log, result}

A job's log never holds a request's URL or an env value.

  python3 deployd.py serve        the daemon (deployd.service)
  python3 deployd.py caddyfile    renders /etc/caddy/Caddyfile from the ops domain and sites.json (provision.sh)
"""

import base64
import contextlib
import hashlib
import hmac
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

VERSION = "2026-10-02.5"
MAX_TOKEN_LIFETIME_S = 900
LISTEN = ("127.0.0.1", 8095)
RELEASE_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
SHA256 = re.compile(r"[0-9a-f]{64}")
ENV_NAME = re.compile(r"[A-Z][A-Z0-9_]{0,127}")
DOMAIN = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+")
SCRIPT = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\.(sh|mjs)")
ARGUMENT = re.compile(r"[A-Za-z0-9._:/=@%?&+-]{1,2048}")
# Releases come only from the project's Object Storage (host.py build): a presigned GET.
RELEASE_HOSTS = ("s3.cloud.ru",)
UNITS = ("bro-web", "bro-eve", "caddy", "deployd", "bro-watchdog", "bro-backup", "bro-tg-egress", "bro-tg-bridge")
RESTARTABLE = ("bro-web", "bro-eve", "caddy", "bro-tg-egress", "bro-tg-bridge")
BRIDGE = "bro-tg-bridge"
# What eve still does for an update it took (waitUntil: download, transcription) before it is restarted.
BRIDGE_DRAIN_S = 15
# Scripts of the host bundle that deployd runs as root, never a release's copy: bro owns a release's files.
ROOT_OPS = ("tg-bridge.sh",)
OPS_ACTION = {"tg-bridge.sh": re.compile(r"status|hold|switch-to-bridge|switch-to-webhook https://[a-z0-9.-]+/eve/v1/telegram")}
# Stopped for a restore (ops/db-restore.sh); a restart or the next release starts them again.
STOPPABLE = ("bro-web", "bro-eve")
KEEP_RELEASES = 5
# A release is a few hundred MB; a bigger download is cut off before it can fill the disk.
MAX_RELEASE_BYTES = 2 << 30
HEALTH_WAIT_S = 120


class Paths:
    """Every path deployd touches, under one root so the tests can run it in a temporary directory."""

    def __init__(self, root="/"):
        root = Path(root)
        self.config = root / "etc/bro/deployd.json"
        self.env = root / "etc/bro/env"
        self.ops_env = root / "etc/bro/ops-env"
        self.sites = root / "etc/bro/sites.json"
        self.caddyfile = root / "etc/caddy/Caddyfile"
        self.domain = root / "var/lib/bro/domain"
        self.srv = root / "srv/bro"
        self.releases = self.srv / "releases"
        self.current = self.srv / "current"
        self.downloads = self.srv / "downloads"
        self.history = self.srv / "history.json"
        self.backups = root / "var/backups/bro"
        self.host_ops = root / "opt/bro/app-host/ops"
        self.tg_egress = root / "opt/bro/tg-egress/tg_egress.py"
        self.watchdog_state = root / "var/lib/bro/watchdog.json"
        # {"since", "units"}: a planned stop (POST /stop) until a restart; the watchdog does not count them down.
        self.maintenance = root / "var/lib/bro/maintenance"
        # Unix seconds of ops/tg-bridge.sh hold: Telegram keeps the updates 24 hours, nobody takes them.
        self.tg_hold = root / "var/lib/bro/tg-hold"


class Unauthorized(Exception):
    pass


class Refused(Exception):
    """A request deployd will not do: 400 with the message."""


def unb64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify_token(token, identity, now=None):
    """The payload of a valid token, or Unauthorized (hostd's verify_token, the same format)."""
    now = time.time() if now is None else now
    try:
        version, payload_part, signature_part = token.split(".")
    except ValueError:
        raise Unauthorized("malformed token") from None
    if version != "v1":
        raise Unauthorized("unknown token version")
    expected = hmac.new(identity["key"], f"{version}.{payload_part}".encode(), hashlib.sha256).digest()
    try:
        signature = unb64url(signature_part)
        payload = json.loads(unb64url(payload_part))
    except ValueError:
        raise Unauthorized("malformed token") from None
    if not hmac.compare_digest(signature, expected):
        raise Unauthorized("bad signature")
    if not isinstance(payload, dict) or payload.get("env") != identity["host"]:
        raise Unauthorized("token for another host")
    expires = payload.get("exp")
    if not isinstance(expires, (int, float)) or expires <= now or expires > now + MAX_TOKEN_LIFETIME_S:
        raise Unauthorized("expired token")
    return payload


def sign_token(key, host, ttl=300, now=None):
    """The session's side (host.py); here for the tests."""
    payload = base64.urlsafe_b64encode(json.dumps({"env": host, "exp": int((now or time.time()) + ttl)})
                                       .encode()).rstrip(b"=").decode()
    signed = f"v1.{payload}"
    signature = base64.urlsafe_b64encode(hmac.new(key, signed.encode(), hashlib.sha256).digest()) \
        .rstrip(b"=").decode()
    return f"{signed}.{signature}"


# --- The env file -------------------------------------------------------------------------------------------
# systemd reads it (EnvironmentFile=), and so do deployd and the watchdog. Every value is written double
# quoted with \ " $ ` escaped, the subset of systemd's syntax both sides agree on; a value with a line break
# is refused rather than written in a form the readers might split.


def render_env(values):
    lines = ["# Written by deployd (PUT /ops/v1/env); edits here are overwritten by the next PUT."]
    for name in sorted(values):
        value = values[name]
        if not ENV_NAME.fullmatch(name):
            raise Refused(f"bad env name {name[:40]!r}")
        if not isinstance(value, str) or any(c in value for c in "\n\r\0"):
            raise Refused(f"{name}: a value is one line of text")
        escaped = re.sub(r'([\\"$`])', r"\\\1", value)
        lines.append(f'{name}="{escaped}"')
    return "\n".join(lines) + "\n"


def parse_env(text):
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, _, raw = line.partition("=")
        name = name.strip()
        if not ENV_NAME.fullmatch(name):
            continue
        raw = raw.strip()
        if len(raw) >= 2 and raw[0] == raw[-1] == '"':
            values[name] = re.sub(r"\\(.)", r"\1", raw[1:-1])
        elif len(raw) >= 2 and raw[0] == raw[-1] == "'":
            values[name] = raw[1:-1]
        else:
            values[name] = raw
    return values


def read_env(paths):
    try:
        return parse_env(paths.env.read_text())
    except FileNotFoundError:
        return {}


# Credentials only the ops scripts need, never the app (whose env the model's tools run with): Neon's owner
# URL while moving off it and for the week of a possible rollback (db-copy.sh).
OPS_ONLY_ENV = ("NEON_DATABASE_URL",)


def read_ops_env(paths):
    try:
        return parse_env(paths.ops_env.read_text())
    except FileNotFoundError:
        return {}


def write_private(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix="." + path.name)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise


# --- Caddy --------------------------------------------------------------------------------------------------

APP_SNIPPET = """(bro_app) {
\t# The Workflow queue's entry points answer without auth; the world reaches them over loopback only.
\thandle /.well-known/workflow/* {
\t\trespond 404
\t}
\t# The app's health runs a query: for deployd and the watchdog over loopback, not for the internet.
\thandle /api/health {
\t\trespond 404
\t}
\t# Long event streams of eve go straight to it, with no encoder to hold chunks back: Next's proxy cuts
\t# them at 30 s.
\thandle /eve/* {
\t\treverse_proxy 127.0.0.1:4274 {
\t\t\tflush_interval -1
\t\t}
\t}
\thandle {
\t\tencode zstd gzip
\t\treverse_proxy 127.0.0.1:3000
\t}
}
"""


def render_caddyfile(ops_domain, sites):
    if not DOMAIN.fullmatch(ops_domain or ""):
        raise Refused("no ops domain")
    parts = ["{\n\tadmin unix//run/caddy/admin.sock\n}\n", APP_SNIPPET,
             f"{ops_domain} {{\n\thandle /ops/v1/* {{\n\t\treverse_proxy {LISTEN[0]}:{LISTEN[1]}\n\t}}\n"
             "\timport bro_app\n}\n"]
    for site in sites:
        apex = site[4:] if site.startswith("www.") else None
        if apex in sites:
            # www is the apex's alias, as on Vercel (308): one origin for Better Auth's cookies and checks.
            parts.append(f"{site} {{\n\tredir https://{apex}{{uri}} 308\n}}\n")
        else:
            parts.append(f"{site} {{\n\timport bro_app\n}}\n")
    return "\n".join(parts)


def read_sites(paths):
    try:
        sites = json.loads(paths.sites.read_text())["sites"]
    except FileNotFoundError:
        return []
    return [site for site in sites if DOMAIN.fullmatch(site)]


def checked_sites(sites):
    if not isinstance(sites, list) or len(sites) > 10:
        raise Refused("sites: a list of at most 10 domains")
    clean = []
    for site in sites:
        if not isinstance(site, str) or not DOMAIN.fullmatch(site) or site.endswith(".sslip.io"):
            raise Refused(f"bad site {str(site)[:80]!r}")
        if site not in clean:
            clean.append(site)
    return clean


# --- Commands -----------------------------------------------------------------------------------------------


class Runner:
    """Every command and HTTP probe goes through here (the tests put a fake in its place)."""

    def run(self, argv, *, env=None, cwd=None, user=None, timeout=600):
        if user:
            argv = ["setpriv", f"--reuid={user}", f"--regid={user}", "--init-groups", *argv]
        result = subprocess.run(argv, env=env, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True,
                                text=True, timeout=timeout)
        return result.returncode, (result.stdout + result.stderr)

    def healthy(self, url, timeout=5):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                return response.status == 200
        except (OSError, urllib.error.URLError, ValueError):
            return False

    def download(self, url, out, sha256, timeout=60, limit=None):
        limit = MAX_RELEASE_BYTES if limit is None else limit
        digest, size = hashlib.sha256(), 0
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response, open(out, "wb") as f:
                declared = response.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > limit:
                    raise Refused(f"the release is {declared} bytes, more than {limit}")
                while True:
                    block = response.read(1 << 20)
                    if not block:
                        break
                    size += len(block)
                    if size > limit:
                        raise Refused(f"the release is more than {limit} bytes")
                    digest.update(block)
                    f.write(block)
            if digest.hexdigest() != sha256:
                raise Refused("the release does not match its sha256")
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(out)
            raise


WEB_HEALTH = "http://127.0.0.1:3000/api/health"
EVE_HEALTH = "http://127.0.0.1:4274/eve/v1/health"
NODE = "/usr/local/bin/node"
PG_BIN = "/usr/lib/postgresql/18/bin"
# bro's home: bro may not write /srv/bro, where root deployd works (provision.sh).
BRO_HOME = "/var/lib/bro-home"


class Deployd:
    def __init__(self, paths, runner, identity):
        self.paths = paths
        self.runner = runner
        self.identity = identity
        self.jobs = {}
        self.busy = threading.Lock()  # one job that changes the host at a time

    # -- releases

    def current_version(self):
        try:
            return os.readlink(self.paths.current).rstrip("/").rsplit("/", 1)[-1]
        except OSError:
            return None

    def releases(self):
        if not self.paths.releases.is_dir():
            return []
        found = [p for p in self.paths.releases.iterdir() if p.is_dir() and RELEASE_VERSION.fullmatch(p.name)]
        return [p.name for p in sorted(found, key=lambda p: p.stat().st_mtime)]

    def release_info(self, version):
        try:
            return json.loads((self.paths.releases / version / "release.json").read_text())
        except (OSError, ValueError):
            return None

    def history(self):
        """The releases that went live, oldest first. A rollback cuts the list after its target, so a second
        rollback goes further back instead of returning to the release just left."""
        try:
            return [v for v in json.loads(self.paths.history.read_text()) if isinstance(v, str)]
        except (OSError, ValueError):
            return []

    def remember(self, version):
        history = [v for v in self.history() if v != version][-19:] + [version]
        write_private(self.paths.history, json.dumps(history) + "\n", mode=0o644)

    def switch(self, version):
        """Point `current` at the release, atomically (a new symlink renamed over the old)."""
        link = self.paths.current
        temporary = link.with_name(".current.new")
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
        os.symlink(f"releases/{version}", temporary)
        os.replace(temporary, link)

    def bridge_enabled(self):
        code, _ = self.runner.run(["systemctl", "is-enabled", "--quiet", BRIDGE], timeout=10)
        return code == 0

    @contextlib.contextmanager
    def bridge_paused(self, log):
        """With tg-bridge enabled, stopped around the restart of eve and started again however it went. Yields
        whether it paused the bridge."""
        if not self.bridge_enabled():
            yield False
            return
        self.stop(log, [BRIDGE])
        time.sleep(BRIDGE_DRAIN_S)
        try:
            yield True
        finally:
            code, output = self.runner.run(["systemctl", "start", BRIDGE], timeout=120)
            log(f"start {BRIDGE}: {'ok' if code == 0 else 'exit ' + str(code)}")
            if code != 0:
                log(output[-300:])

    def telegram_path(self, log):
        """tg_egress.py --check once eve and web are up: "ok", "down" (after one restart of tg-egress), or None
        without tg-egress. Reported, not a reason to go back: the path is the host's, not the release's."""
        if not self.paths.tg_egress.exists():
            return None
        for attempt in (1, 2):
            code, output = self.runner.run(["python3", str(self.paths.tg_egress), "--check"], timeout=60)
            if code == 0:
                log("api.telegram.org answers through tg-egress")
                return "ok"
            log(f"tg_egress.py --check: {(output.strip().splitlines() or ['exit ' + str(code)])[-1][:200]}")
            if attempt == 1:
                self.restart(log, ["bro-tg-egress"])
                time.sleep(3)
        log("WARNING: api.telegram.org does not answer through tg-egress: the bot neither hears nor answers "
            "(scripts/cloudru-app-host/tg-egress/README.md, «Если адрес закрыли»)")
        return "down"

    def restart(self, log, units=("bro-eve", "bro-web")):
        planned = self.planned_stop()
        if set(planned.get("units", [])) & set(units):
            left = sorted(set(planned["units"]) - set(units))
            if left:
                write_private(self.paths.maintenance, json.dumps({**planned, "units": left}))
            else:
                self.paths.maintenance.unlink()
            log(f"planned stop over for {', '.join(u for u in units if u in planned['units'])}: watched again")
        for unit in units:
            code, output = self.runner.run(["systemctl", "restart", unit], timeout=120)
            log(f"restart {unit}: {'ok' if code == 0 else 'exit ' + str(code)}")
            if code != 0:
                log(output[-500:])

    def stop(self, log, units):
        """Stop the units; False when one does not stop (its output is in the log)."""
        stopped = True
        for unit in units:
            code, output = self.runner.run(["systemctl", "stop", unit], timeout=120)
            log(f"stop {unit}: {'ok' if code == 0 else 'exit ' + str(code)}")
            if code != 0:
                log(output[-300:])
                stopped = False
        return stopped

    def wait_healthy(self, log, seconds=None):
        seconds = HEALTH_WAIT_S if seconds is None else seconds
        deadline = time.monotonic() + seconds
        while True:
            web, eve = self.runner.healthy(WEB_HEALTH), self.runner.healthy(EVE_HEALTH)
            if web and eve:
                log("web and eve are healthy")
                return True
            if time.monotonic() >= deadline:
                log(f"not healthy after {seconds} s: web {'ok' if web else 'down'}, eve {'ok' if eve else 'down'}")
                return False
            time.sleep(2)

    def migrate(self, version, log):
        """Bro's migrations and the world's schema, with the env of the services, as the user bro."""
        env = {"PATH": f"/usr/local/bin:/usr/bin:/bin:{PG_BIN}", "HOME": BRO_HOME, "NODE_ENV": "production",
               **read_env(self.paths)}
        if not env.get("WORKFLOW_POSTGRES_URL"):
            raise Refused("WORKFLOW_POSTGRES_URL is not in /etc/bro/env: PUT /ops/v1/env first")
        release = self.paths.releases / version
        code, output = self.runner.run([NODE, "ops/migrate.mjs", "app", "world"], env=env, cwd=str(release),
                                       user="bro", timeout=900)
        for line in output.strip().splitlines()[-20:]:
            log(line[:500])
        if code != 0:
            raise Refused(f"migrations failed (exit {code}); current is unchanged")

    def unpack(self, version, url, sha256, log):
        release = self.paths.releases / version
        info = self.release_info(version)
        if info is not None and info.get("sha256") == sha256:
            log(f"{version} is unpacked already")
            return
        if release.exists():
            raise Refused(f"{version} exists with another sha256: a new build needs a new version")
        self.paths.downloads.mkdir(parents=True, exist_ok=True)
        archive = self.paths.downloads / f"{version}.tar.zst"
        started = time.monotonic()
        self.runner.download(url, archive, sha256)
        log(f"downloaded {archive.stat().st_size} bytes in {time.monotonic() - started:.0f} s, sha256 ok")
        partial = self.paths.releases / f".{version}.partial"
        shutil.rmtree(partial, ignore_errors=True)
        partial.mkdir(parents=True)
        code, output = self.runner.run(["tar", "--no-same-owner", "-I", "zstd", "-xf", str(archive), "-C",
                                        str(partial)], timeout=600)
        archive.unlink()
        if code != 0:
            shutil.rmtree(partial, ignore_errors=True)
            raise Refused(f"unpack failed: {output[-300:]}")
        packed = json.loads((partial / "release.json").read_text())
        if packed.get("version") != version:
            shutil.rmtree(partial, ignore_errors=True)
            raise Refused(f"the archive is release {packed.get('version')!r}, not {version!r}")
        packed["sha256"] = sha256
        (partial / "release.json").write_text(json.dumps(packed, indent=1) + "\n")
        # Next writes its cache under .next; the services run as bro, who could not read a root-owned tree.
        code, output = self.runner.run(["chown", "-R", "bro:bro", str(partial)], timeout=300)
        if code != 0:
            shutil.rmtree(partial, ignore_errors=True)
            raise Refused(f"chown of the release failed: {output[-300:]}")
        os.rename(partial, release)
        log(f"unpacked {version}")

    def activate(self, version, log, went_live=None):
        """Switch to the release; back to the one before if it does not come up healthy. `went_live` records
        it in the history (remember by default)."""
        previous = self.current_version()
        with self.bridge_paused(log):
            result = self.switch_and_restart(version, previous, log, went_live)
        telegram = self.telegram_path(log)
        return result if telegram is None else {**result, "telegram": telegram}

    def switch_and_restart(self, version, previous, log, went_live):
        self.switch(version)
        log(f"current: {previous or '-'} -> {version}")
        self.restart(log)
        if self.wait_healthy(log):
            (went_live or self.remember)(version)
            return {"version": version, "previous": previous}
        if previous is None:
            # The first release: no `current` and nothing running is a clearer state than an unhealthy one,
            # and the next release starts from it the same way.
            self.paths.current.unlink()
            self.stop(log, STOPPABLE)
            raise Refused(f"{version} is not healthy and there is no release to go back to: current is cleared "
                          "and the services are stopped")
        if previous == version:
            raise Refused(f"{version} is not healthy and there is no release to go back to")
        self.switch(previous)
        log(f"rolled back to {previous}")
        self.restart(log)
        healthy = self.wait_healthy(log)
        raise Refused(f"{version} was not healthy; back on {previous} ({'healthy' if healthy else 'NOT healthy'})")

    def prune(self, log):
        """Keep the current release and the last few that went live; drop the rest."""
        keep = {self.current_version(), *self.history()[-KEEP_RELEASES:]}
        for version in [v for v in self.releases() if v not in keep]:
            shutil.rmtree(self.paths.releases / version, ignore_errors=True)
            log(f"removed old release {version}")

    def do_release(self, body, log):
        version, url, sha256 = body.get("version"), body.get("url"), body.get("sha256")
        if not isinstance(version, str) or not RELEASE_VERSION.fullmatch(version):
            raise Refused("version must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}")
        if not isinstance(sha256, str) or not SHA256.fullmatch(sha256):
            raise Refused("sha256 must be 64 lower-case hex characters")
        parsed = urllib.parse.urlsplit(url if isinstance(url, str) else "")
        if parsed.scheme != "https" or parsed.hostname not in RELEASE_HOSTS:
            raise Refused(f"the release URL must be https on {', '.join(RELEASE_HOSTS)}")
        self.unpack(version, url, sha256, log)
        # Before the switch: migrations stay compatible with the release still running (db/README.md).
        self.migrate(version, log)
        result = self.activate(version, log)
        self.prune(log)
        return result

    def do_rollback(self, body, log):
        current = self.current_version()
        target = body.get("version")
        history = self.history()
        if target is None:
            # The release that went live before current (or the latest other one when current is not in
            # the history); the history then ends at it, and the release left behind drops out of it.
            present = set(self.releases())
            before = history[:history.index(current)] if current in history else history
            older = [v for v in before if v != current and v in present]
            if not older:
                raise Refused("no earlier release to go back to")
            target = older[-1]
            kept = history[:history.index(target) + 1]

            def went_live(_version):
                write_private(self.paths.history, json.dumps(kept) + "\n", mode=0o644)
        else:
            went_live = None  # a named release, older or newer, goes to the end like a release
        if not isinstance(target, str) or target not in self.releases():
            raise Refused(f"no release {str(target)[:64]!r}")
        if target == current:
            raise Refused(f"{target} is current already")
        return self.activate(target, log, went_live)

    # -- env, sites, ops

    def do_env(self, body, log):
        values = body.get("env")
        if not isinstance(values, dict) or not values:
            raise Refused("env: an object of NAME: value")
        text = render_env(values)
        ops_values = body.get("opsEnv") or {}
        if not isinstance(ops_values, dict) or any(name not in OPS_ONLY_ENV for name in ops_values):
            raise Refused(f"opsEnv: an object with some of {', '.join(OPS_ONLY_ENV)}")
        if any(name in values for name in OPS_ONLY_ENV):
            raise Refused(f"{', '.join(OPS_ONLY_ENV)} only in opsEnv: the app never gets them")
        if ops_values:
            write_private(self.paths.ops_env, render_env(ops_values))
            log(f"wrote {len(ops_values)} names for ops scripts only")
        elif self.paths.ops_env.exists():
            self.paths.ops_env.unlink()
            log("removed the ops scripts' own names")
        previous = self.paths.env.with_name("env.previous")
        had_env = self.paths.env.exists()
        if had_env:
            shutil.copy2(self.paths.env, previous)
        write_private(self.paths.env, text)
        log(f"wrote {len(values)} names")
        if self.current_version() is None:
            log("no release yet: nothing to restart")
            return {"names": sorted(values), "healthy": None}
        if body.get("migrate") is True:
            try:
                self.migrate(self.current_version(), log)
            except Refused:
                # Nothing restarted yet: the services still run on the previous env, so it goes back as it was.
                if had_env:
                    os.replace(previous, self.paths.env)
                else:
                    self.paths.env.unlink()
                log("the previous env is back")
                raise
        with self.bridge_paused(log):
            return self.restart_with_env(values, previous, had_env, log)

    def restart_with_env(self, values, previous, had_env, log):
        self.restart(log)
        if self.wait_healthy(log):
            return {"names": sorted(values), "healthy": True}
        if not had_env:
            raise Refused("not healthy with the new env, and there was no env before it")
        os.replace(previous, self.paths.env)
        log("the previous env is back")
        self.restart(log)
        healthy = self.wait_healthy(log)
        raise Refused(f"not healthy with the new env; the previous one is back ({'healthy' if healthy else 'NOT healthy'})")

    def ops_domain(self):
        try:
            return self.paths.domain.read_text().strip()
        except FileNotFoundError:
            return ""

    def write_caddyfile(self, sites):
        write_private(self.paths.caddyfile, render_caddyfile(self.ops_domain(), sites), mode=0o644)

    def put_sites(self, body):
        sites = checked_sites(body.get("sites"))
        before = self.paths.caddyfile.read_text() if self.paths.caddyfile.exists() else None
        self.write_caddyfile(sites)
        code, output = self.runner.run(["systemctl", "reload", "caddy"], timeout=60)
        if code != 0:
            # Caddy keeps its running config when a reload fails; the file goes back to match it.
            if before is not None:
                write_private(self.paths.caddyfile, before, mode=0o644)
            raise Refused(f"caddy reload failed: {output[-400:]}")
        write_private(self.paths.sites, json.dumps({"sites": sites}) + "\n", mode=0o644)
        return {"sites": sites}

    def do_ops(self, body, log):
        script, args = body.get("script"), body.get("args", [])
        if not isinstance(script, str) or not SCRIPT.fullmatch(script):
            raise Refused("script: a file name in ops/ of the current release")
        if not isinstance(args, list) or len(args) > 16 or \
                not all(isinstance(a, str) and ARGUMENT.fullmatch(a) for a in args):
            raise Refused("args: at most 16 plain arguments")
        if script in ROOT_OPS:
            return self.root_ops(script, args, log)
        version = self.current_version()
        if version is None:
            raise Refused("no current release")
        path = self.paths.releases / version / "ops" / script
        if not path.is_file():
            raise Refused(f"release {version} has no ops/{script}")
        interpreter = NODE if script.endswith(".mjs") else "/bin/bash"
        env = {"PATH": f"/usr/local/bin:/usr/bin:/bin:{PG_BIN}", "HOME": BRO_HOME, "NODE_ENV": "production",
               **read_env(self.paths), **read_ops_env(self.paths)}
        log(f"run ops/{script} of {version} with {len(args)} arguments")
        code, output = self.runner.run([interpreter, str(path), *args], env=env, cwd=str(path.parent.parent),
                                       user="bro", timeout=6 * 3600)
        for line in output.strip().splitlines()[-200:]:
            log(line[:1000])
        if code != 0:
            raise Refused(f"ops/{script} exited {code}")
        return {"script": script, "version": version}

    def root_ops(self, script, args, log):
        """A script of the host bundle as root, with no env of the app: tg-bridge.sh reads /etc/bro/env itself."""
        if not OPS_ACTION[script].fullmatch(" ".join(args)):
            raise Refused(f"{script}: status, hold, switch-to-bridge or switch-to-webhook https://<host>/eve/v1/telegram")
        path = self.paths.host_ops / script
        if not path.is_file():
            raise Refused(f"the host bundle has no ops/{script}: host.py update-host first")
        log(f"run ops/{script} of the host bundle as root: {args[0]}")
        code, output = self.runner.run(["/bin/bash", str(path), *args],
                                       env={"PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}, timeout=600)
        for line in output.strip().splitlines()[-100:]:
            log(line[:1000])
        if code != 0:
            raise Refused(f"ops/{script} exited {code}")
        return {"script": script, "action": args[0]}

    def do_restart(self, body, log):
        units = body.get("units") or ["bro-eve", "bro-web"]
        if not isinstance(units, list) or not all(u in RESTARTABLE for u in units):
            raise Refused(f"units: some of {', '.join(RESTARTABLE)}")
        if "bro-eve" not in units:
            self.restart(log, units)
            if "bro-web" in units and self.current_version():
                return {"healthy": self.wait_healthy(log)}
            return {}
        with self.bridge_paused(log) as paused:
            # A paused bridge comes back after this anyway: restarting it here too would only start it early.
            self.restart(log, [u for u in units if not (paused and u == BRIDGE)])
            healthy = self.wait_healthy(log) if self.current_version() else None
        return {} if healthy is None else {"healthy": healthy}

    def do_stop(self, body, log):
        units = body.get("units")
        if not isinstance(units, list) or not units or not all(u in STOPPABLE for u in units):
            raise Refused(f"units: some of {', '.join(STOPPABLE)}")
        # Before the stop: the watchdog must not take a planned stop for a fall (window, rollback, restore).
        planned = self.planned_stop()
        write_private(self.paths.maintenance, json.dumps(
            {"since": planned.get("since", int(time.time())), "units": sorted({*planned.get("units", []), *units})}))
        if not self.stop(log, units):
            raise Refused("a unit did not stop: see the log")
        return {"stopped": units}

    def planned_stop(self):
        try:
            planned = json.loads(self.paths.maintenance.read_text())
        except (OSError, ValueError):
            return {}
        return planned if isinstance(planned, dict) else {}

    # -- read-only

    def status(self):
        units = {}
        for unit in UNITS:
            _, output = self.runner.run(["systemctl", "is-active", unit], timeout=10)
            units[unit] = output.strip() or "unknown"
        disk = shutil.disk_usage(self.paths.srv if self.paths.srv.exists() else "/")
        version = self.current_version()
        return {
            "deployd": VERSION, "host": self.identity["host"], "release": version,
            "releaseInfo": self.release_info(version) if version else None, "releases": self.releases(),
            "units": units, "health": {"web": self.runner.healthy(WEB_HEALTH), "eve": self.runner.healthy(EVE_HEALTH)},
            "opsDomain": self.ops_domain(), "sites": read_sites(self.paths),
            "telegram": {"egressInstalled": self.paths.tg_egress.exists(), "bridgeEnabled": self.bridge_enabled()},
            "watchdog": self.watchdog_alarms(), "plannedStop": self.planned_stop() or None,
            "off": self.switched_off(),
            "diskFreeGb": round(disk.free / 1e9, 1), "busy": self.busy.locked(), "job": self.running_job(),
        }

    def watchdog_alarms(self):
        """The watchdog's checks that are down now, and alerts it could not deliver (watchdog.json): the one
        place an operator sees that the owner may not have heard, when Telegram itself is the trouble."""
        try:
            state = json.loads(self.paths.watchdog_state.read_text())
        except (OSError, ValueError):
            return {}
        down = {name: entry["downSince"] for name, entry in state.items()
                if isinstance(entry, dict) and isinstance(entry.get("downSince"), int)}
        undelivered = state.get("undelivered") if isinstance(state.get("undelivered"), dict) else {}
        return {"down": down, "undelivered": undelivered}

    def switched_off(self):
        """EVE_SCHEDULES and BACKUPS that /etc/bro/env turns off: on production only for the move's window."""
        values = parse_env(self.paths.env.read_text()) if self.paths.env.exists() else {}
        return [name for name in ("EVE_SCHEDULES", "BACKUPS") if values.get(name) == "off"]

    def env_names(self):
        text = self.paths.env.read_text() if self.paths.env.exists() else ""
        return {"names": sorted(parse_env(text)), "sha256": hashlib.sha256(text.encode()).hexdigest(),
                "opsOnly": sorted(read_ops_env(self.paths))}

    def logs(self, query):
        unit = (query.get("unit") or [""])[0]
        if unit not in UNITS:
            raise Refused(f"unit: one of {', '.join(UNITS)}")
        try:
            lines = max(1, min(int((query.get("lines") or ["200"])[0]), 2000))
        except ValueError:
            raise Refused("lines: a number") from None
        _, output = self.runner.run(["journalctl", "-u", unit, "-n", str(lines), "--no-pager", "-o", "short-iso"],
                                    timeout=30)
        return {"unit": unit, "lines": output.splitlines()[-lines:]}

    # -- jobs

    def running_job(self):
        """The id of the job that runs now: host.py follows it when a job-starting answer got lost."""
        return next((j for j, v in self.jobs.items() if v["state"] == "running"), None)

    def start_job(self, kind, work, body):
        if not self.busy.acquire(blocking=False):
            raise Refused(f"busy with job {self.running_job()}")
        job_id = uuid.uuid4().hex[:12]
        job = {"id": job_id, "kind": kind, "state": "running", "log": [], "result": None,
               "started": int(time.time())}
        self.jobs[job_id] = job
        # Old finished jobs go: the log is for the operator's next look, not history.
        for old in [j for j, v in self.jobs.items() if v["state"] != "running"][:-20]:
            del self.jobs[old]

        def log(line):
            job["log"].append(f"+{int(time.time()) - job['started']}s {line}")
            print(f"[{kind} {job_id}] {line}", flush=True)

        def run():
            try:
                job["result"] = work(body, log)
                job["state"] = "done"
            except Refused as error:
                log(f"failed: {error}")
                job["state"] = "failed"
            except Exception as error:  # reported in the job, deployd stays up
                log(f"failed: {type(error).__name__}: {error}")
                job["state"] = "failed"
            finally:
                job["finished"] = int(time.time())
                self.busy.release()

        threading.Thread(target=run, daemon=True).start()
        return job


def make_handler(deployd):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "deployd"
        sys_version = ""

        def log_message(self, format, *args):  # the path only: a query may hold nothing secret, but stay short
            print(f"{self.command} {self.path.split('?', 1)[0]} {args[1] if len(args) > 1 else ''}", flush=True)

        def answer(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1 << 20:
                raise Refused("body too large")
            if not length:
                return {}
            try:
                value = json.loads(self.rfile.read(length))
            except ValueError:
                raise Refused("body: JSON") from None
            if not isinstance(value, dict):
                raise Refused("body: a JSON object")
            return value

        def authorize(self):
            header = self.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                raise Unauthorized("no token")
            verify_token(header[7:].strip(), deployd.identity)

        def route(self):
            url = urllib.parse.urlsplit(self.path)
            path, query = url.path, urllib.parse.parse_qs(url.query)
            if not path.startswith("/ops/v1/"):
                return self.answer(404, {"error": "not found"})
            name = path[len("/ops/v1/"):]
            if self.command == "GET" and name == "health":
                return self.answer(200, {"ok": True, "version": VERSION})
            try:
                self.authorize()
            except Unauthorized as error:
                return self.answer(401, {"error": str(error)})
            try:
                routes = {
                    ("GET", "status"): lambda: (200, deployd.status()),
                    ("GET", "env"): lambda: (200, deployd.env_names()),
                    ("GET", "sites"): lambda: (200, {"sites": read_sites(deployd.paths),
                                                     "opsDomain": deployd.ops_domain()}),
                    ("PUT", "sites"): lambda: (200, deployd.put_sites(self.body())),
                    ("GET", "logs"): lambda: (200, deployd.logs(query)),
                    ("POST", "release"): lambda: (202, deployd.start_job("release", deployd.do_release, self.body())),
                    ("POST", "rollback"): lambda: (202, deployd.start_job("rollback", deployd.do_rollback,
                                                                          self.body())),
                    ("PUT", "env"): lambda: (202, deployd.start_job("env", deployd.do_env, self.body())),
                    ("POST", "restart"): lambda: (202, deployd.start_job("restart", deployd.do_restart, self.body())),
                    ("POST", "stop"): lambda: (202, deployd.start_job("stop", deployd.do_stop, self.body())),
                    ("POST", "ops"): lambda: (202, deployd.start_job("ops", deployd.do_ops, self.body())),
                }
                if self.command == "GET" and name.startswith("jobs/"):
                    job = deployd.jobs.get(name[5:])
                    return self.answer(200, job) if job else self.answer(404, {"error": "no such job"})
                handler = routes.get((self.command, name))
                if handler is None:
                    return self.answer(404, {"error": "not found"})
                code, body = handler()
                return self.answer(code, body)
            except Refused as error:
                return self.answer(400, {"error": str(error)})
            except Exception as error:  # an answer, not a dropped connection
                print(f"error: {type(error).__name__}: {error}", flush=True)
                return self.answer(500, {"error": type(error).__name__})

        do_GET = do_POST = do_PUT = route

    return Handler


def load_identity(paths):
    config = json.loads(paths.config.read_text())
    if not re.fullmatch(r"[a-z0-9-]{1,63}", config.get("host", "")) or not SHA256.fullmatch(config.get("key", "")):
        raise SystemExit(f"{paths.config}: host and a 64-hex key are required")
    return {"host": config["host"], "key": bytes.fromhex(config["key"])}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    paths = Paths(os.environ.get("DEPLOYD_ROOT", "/"))
    if argv[:1] == ["caddyfile"]:
        deployd = Deployd(paths, Runner(), {"host": "", "key": b""})
        deployd.write_caddyfile(read_sites(paths))
        print(f"wrote {paths.caddyfile}")
        return
    if argv[:1] != ["serve"]:
        raise SystemExit(__doc__)
    deployd = Deployd(paths, Runner(), load_identity(paths))
    server = http.server.ThreadingHTTPServer(LISTEN, make_handler(deployd))
    server.daemon_threads = True
    print(f"deployd {VERSION} on {LISTEN[0]}:{LISTEN[1]} for {deployd.identity['host']}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
