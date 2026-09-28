"""Pilot control endpoint on the VM: 127.0.0.1:8080 behind Caddy (TLS on <ip>.sslip.io).

The cloud session reaches the VM only over HTTPS:443, so this replaces SSH for the pilot.
Every route except /health needs `Authorization: Bearer <token>`; the VM keeps only the
token's SHA-256 (/etc/bro/control.sha256), so cloud-init user data never carries the token.

  GET  /health                  uptime, CDP readiness, provisioning stage (no secrets)
  POST /exec   {cmd, timeout?, user?}   run `bash -lc cmd`, return rc/stdout/stderr
  POST /jobs   {name, cmd, user?}       start a background command, log to /var/lib/bro/jobs
  GET  /jobs/<name>                     running flag, exit code, log tail
  PUT  /files?path=&mode=&owner=        write the request body to a file
  GET  /files?path=                     read a file
"""

import hashlib
import hmac
import json
import os
import shutil
import subprocess
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

TOKEN_SHA256 = Path("/etc/bro/control.sha256").read_text().strip()
STATE = Path("/var/lib/bro")
JOBS = STATE / "jobs"
JOBS.mkdir(parents=True, exist_ok=True)
running = {}


def as_user(user, cmd):
    return ["bash", "-lc", cmd] if user == "root" else ["sudo", "-u", user, "-H", "bash", "-lc", cmd]


def cdp_ready():
    try:
        urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=1).read()
        return True
    except Exception:
        return False


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        header = self.headers.get("Authorization", "")
        given = hashlib.sha256(header.removeprefix("Bearer ").encode()).hexdigest()
        if header.startswith("Bearer ") and hmac.compare_digest(given, TOKEN_SHA256):
            return True
        self.send(401, {"error": "unauthorized"})
        return False

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            stage = STATE / "stage"
            return self.send(200, {
                "uptime_s": float(Path("/proc/uptime").read_text().split()[0]),
                "cdp": cdp_ready(),
                "stage": stage.read_text().strip() if stage.exists() else None,
            })
        if not self.authorized():
            return
        if url.path.startswith("/jobs/"):
            name = url.path.removeprefix("/jobs/")
            proc = running.get(name)
            log = JOBS / f"{name}.log"
            tail = log.read_bytes()[-20000:].decode(errors="replace") if log.exists() else ""
            return self.send(200, {"running": bool(proc and proc.poll() is None),
                                   "rc": proc.poll() if proc else None, "log_tail": tail})
        if url.path == "/files":
            path = Path(parse_qs(url.query)["path"][0])
            if not path.is_file():
                return self.send(404, {"error": "not found"})
            return self.send(200, path.read_bytes(), "application/octet-stream")
        self.send(404, {"error": "no route"})

    def do_POST(self):
        if not self.authorized():
            return
        url = urlparse(self.path)
        request = json.loads(self.body() or b"{}")
        user = request.get("user", "root")
        if url.path == "/exec":
            started = time.perf_counter()
            try:
                p = subprocess.run(as_user(user, request["cmd"]), capture_output=True, text=True,
                                   timeout=request.get("timeout", 120))
                result = {"rc": p.returncode, "stdout": p.stdout[-200000:], "stderr": p.stderr[-50000:]}
            except subprocess.TimeoutExpired as e:
                result = {"rc": None, "timeout": True, "stdout": str(e.stdout or "")[-20000:]}
            result["ms"] = round((time.perf_counter() - started) * 1000)
            return self.send(200, result)
        if url.path == "/jobs":
            name = request["name"]
            if running.get(name) and running[name].poll() is None:
                return self.send(409, {"error": "already running"})
            log = open(JOBS / f"{name}.log", "wb")
            running[name] = subprocess.Popen(as_user(user, request["cmd"]), stdout=log, stderr=subprocess.STDOUT,
                                             start_new_session=True)
            return self.send(202, {"started": name, "pid": running[name].pid})
        self.send(404, {"error": "no route"})

    def do_PUT(self):
        if not self.authorized():
            return
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path != "/files":
            return self.send(404, {"error": "no route"})
        path = Path(query["path"][0])
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, int(query.get("mode", ["0644"])[0], 8))
        with os.fdopen(fd, "wb") as f:
            f.write(self.body())
        os.chmod(path, int(query.get("mode", ["0644"])[0], 8))
        if "owner" in query:
            shutil.chown(path, query["owner"][0], query["owner"][0])
        self.send(200, {"written": str(path)})

    def log_message(self, fmt, *args):  # no request log: bodies and paths may carry secrets
        pass


ThreadingHTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
