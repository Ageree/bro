"""End-to-end check of a live code host's sandboxd (sandbox/README.md) with real tokens, stdlib only.

  python e2e.py NAME [--origin https://<ip-with-dashes>.sslip.io] [--keep-snapshot]

Signs host tokens with the key `host.py key NAME` wrote, then: health and refused tokens; PUT a sandbox
with presigned snapshot links for sandbox/workspaces/e2e-<NAME>.snap; exec and its NDJSON; files written,
read and deleted; sandbox/image/verify.py inside (python-pptx, openpyxl, python-docx, pptx -> pdf in
soffice); no network (curl, Python, DNS); the tools socket; killing a process; keepalive pings in a silent
command; a process that overruns the memory budget dying alone (exit 137); stop with a snapshot in Object
Storage; PUT again restoring /workspace; DELETE. Prints one line per step with its time and a JSON summary;
exits 1 if any step failed. Never prints a token, a key or a presigned link.
"""

import argparse
import base64
import hashlib
import hmac
import json
import secrets
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import host as code_host
import s3

VERIFY = code_host.REPO / "sandbox" / "image" / "verify.py"
SANDBOX = "sb-e2e-" + secrets.token_hex(4)
TEXT = "Привет из песочницы Бро — ёлка 🌲\n"


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def token(host, key_hex, seconds=300, env=None):
    """hostd's format: v1.<base64url JSON {"env", "exp"}>.<base64url HMAC-SHA256 of "v1.<payload>">."""
    payload = b64url(json.dumps({"env": env or host, "exp": int(time.time()) + seconds},
                                separators=(",", ":")).encode())
    signed = f"v1.{payload}"
    return f"{signed}.{b64url(hmac.new(bytes.fromhex(key_hex), signed.encode(), hashlib.sha256).digest())}"


class Client:
    def __init__(self, origin, host, key):
        self.origin, self.host, self.key = origin.rstrip("/"), host, key

    def request(self, method, path, body=None, raw=None, auth=True, timeout=180, bearer=None):
        headers = {}
        if auth:
            headers["Authorization"] = "Bearer " + (bearer or token(self.host, self.key))
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.origin + path, data, headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            return error.code, error.read()
        with response:
            return response.status, response.read()

    def json(self, method, path, body=None, expect=200, **kw):
        code, data = self.request(method, path, body, **kw)
        if code != expect:
            raise AssertionError(f"{method} {path}: {code} {data[:300]!r}")
        return json.loads(data) if data else None

    def exec(self, command, timeout_ms=600000, on_start=None, timeout=900):
        """Run a command; returns (exit code, stdout, stderr, events) from the NDJSON stream."""
        path = f"/v1/sandboxes/{SANDBOX}/exec"
        request = urllib.request.Request(
            self.origin + path, json.dumps({"command": command, "cwd": "/workspace", "timeoutMs": timeout_ms}).encode(),
            {"Authorization": "Bearer " + token(self.host, self.key), "Content-Type": "application/json"},
            method="POST")
        out, err, events, code = bytearray(), bytearray(), [], None
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "")
            assert content_type.startswith("application/x-ndjson"), content_type
            for line in response:
                event = json.loads(line)
                events.append(event["type"])
                if event["type"] == "start" and on_start:
                    on_start(event["pid"])
                elif event["type"] == "stdout":
                    out += base64.b64decode(event["data"])
                elif event["type"] == "stderr":
                    err += base64.b64decode(event["data"])
                elif event["type"] == "exit":
                    code = event["code"]
                elif event["type"] == "error":
                    raise AssertionError(f"exec error event: {event.get('message')}")
        return code, out.decode(errors="replace"), err.decode(errors="replace"), events


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("name")
    parser.add_argument("--origin")
    parser.add_argument("--keep-snapshot", action="store_true")
    args = parser.parse_args()
    host = code_host.host_name(args.name)
    key = json.loads((code_host.STATE / f"{host}.json").read_text())["key"]
    origin = args.origin
    if not origin:
        ip, _ = code_host.public_ip(code_host.found_vm(host))
        origin = f"https://{ip.replace('.', '-')}.sslip.io"
    api = Client(origin, host, key)
    snapshot_key = f"sandbox/workspaces/e2e-{host}.snap"
    s3.delete_prefix(snapshot_key)
    snapshot_secret = secrets.token_hex(32)

    def put_body():
        return {"workspace": "e2e:" + host, "memoryMb": 1536,
                "tools": {"url": "https://example.invalid/api/sandbox/graphql", "token": "v1.e2e.e2e", "headers": {}},
                "snapshot": {"get": s3.presign("GET", snapshot_key, 3600), "put": s3.presign("PUT", snapshot_key, 3600),
                             "key": snapshot_secret}}

    results, failed = [], []

    def step(name):
        def run(fn):
            started = time.monotonic()
            try:
                detail = fn()
                ok = True
            except Exception as error:  # every step reports, the next ones still run where they can
                detail, ok = f"{type(error).__name__}: {error}", False
                traceback.print_exc(file=sys.stderr)
            ms = round((time.monotonic() - started) * 1000)
            results.append({"step": name, "ok": ok, "ms": ms, "detail": detail})
            (failed.append(name) if not ok else None)
            print(f"{'ok  ' if ok else 'FAIL'} {name:<22} {ms:>7} ms  {json.dumps(detail, ensure_ascii=False)[:400]}",
                  flush=True)
            return detail
        return run

    @step("health")
    def _():
        code, data = api.request("GET", "/v1/health", auth=False)
        assert code == 200, (code, data[:200])
        return json.loads(data)

    @step("refuses bad tokens")
    def _():
        codes = {}
        for label, bearer in (("none", None), ("other host", token("sbx-other", key)),
                              ("wrong key", token(host, secrets.token_hex(32))),
                              ("too long", token(host, key, seconds=3600))):
            if bearer is None:
                codes[label] = api.request("GET", f"/v1/sandboxes/{SANDBOX}", auth=False)[0]
            else:
                codes[label] = api.request("GET", f"/v1/sandboxes/{SANDBOX}", bearer=bearer)[0]
        assert all(code == 401 for code in codes.values()), codes
        return codes

    @step("put (new)")
    def _():
        result = api.json("PUT", f"/v1/sandboxes/{SANDBOX}", put_body())
        assert result["created"] and not result["restored"], result
        return result

    @step("get")
    def _():
        return api.json("GET", f"/v1/sandboxes/{SANDBOX}")

    @step("exec python")
    def _():
        code, out, err, events = api.exec("python3 -c 'print(1+1)'")
        assert (code, out) == (0, "2\n"), (code, out, err)
        assert events[0] == "start" and events[-1] == "exit", events
        return {"events": events}

    @step("exec env")
    def _():
        code, out, err, _ = api.exec("id -u; id -g; echo $HOME; pwd; which python3; date +%Z; nproc; "
                                     "sudo -n true 2>&1 | head -c 60; echo; stat -c %U /workspace")
        assert code == 0, (code, err)
        lines = out.splitlines()
        assert lines[:5] == ["1000", "1000", "/home/sandbox", "/workspace", "/opt/py/bin/python3"], lines
        return lines

    @step("exec stderr+exit")
    def _():
        code, out, err, _ = api.exec("echo out; echo err >&2; exit 7")
        assert (code, out, err) == (7, "out\n", "err\n"), (code, out, err)
        return {"code": code}

    @step("exec timeout")
    def _():
        code, _, _, _ = api.exec("sleep 30", timeout_ms=2000)
        assert code == 124, code
        return {"code": code}

    @step("kill")
    def _():
        pids = []

        def kill(pid):
            pids.append(pid)
            threading.Timer(1.0, lambda: api.request("POST", f"/v1/sandboxes/{SANDBOX}/procs/{pid}/kill")).start()

        started = time.monotonic()
        code, _, _, events = api.exec("sleep 60", on_start=kill)
        took = time.monotonic() - started
        assert took < 20 and code != 0, (code, took)
        again = api.request("POST", f"/v1/sandboxes/{SANDBOX}/procs/{pids[0]}/kill")[0]
        return {"code": code, "seconds": round(took, 1), "kill again": again}

    @step("exec ping")
    def _():
        code, _, _, events = api.exec("sleep 20")
        assert code == 0 and "ping" in events, (code, events)
        return {"code": code, "pings": events.count("ping")}

    @step("memory overrun")
    def _():
        assert api.request("PUT", f"/v1/sandboxes/{SANDBOX}/files?path=/workspace/before-oom.txt", raw=b"kept")[0] == 204
        # Twice the guest's 1536 MB, every page touched: the process dies alone, the sandbox stays.
        code, _, err, _ = api.exec("python3 -c \"b = b'\\x01' * (3072 << 20); print(len(b))\"")
        assert code == 137, (code, err[-300:])
        alive, out, _, _ = api.exec("cat /workspace/before-oom.txt; echo; echo alive")
        assert alive == 0 and out == "kept\nalive\n", (alive, out)
        return {"overrun exit": code, "after": out.split()}

    @step("file write+read")
    def _():
        code, data = api.request("PUT", f"/v1/sandboxes/{SANDBOX}/files?path=" +
                                 urllib.parse.quote("/workspace/notes/привет.txt"), raw=TEXT.encode())
        assert code == 204, (code, data[:200])
        code, data = api.request("GET", f"/v1/sandboxes/{SANDBOX}/files?path=" +
                                 urllib.parse.quote("/workspace/notes/привет.txt"))
        assert code == 200 and data.decode() == TEXT, (code, data[:200])
        binary = secrets.token_bytes(3 << 20)
        assert api.request("PUT", f"/v1/sandboxes/{SANDBOX}/files?path=/workspace/blob.bin", raw=binary)[0] == 204
        code, back = api.request("GET", f"/v1/sandboxes/{SANDBOX}/files?path=/workspace/blob.bin")
        assert code == 200 and back == binary, (code, len(back))
        missing = api.request("GET", f"/v1/sandboxes/{SANDBOX}/files?path=/workspace/nope.txt")[0]
        directory = api.request("GET", f"/v1/sandboxes/{SANDBOX}/files?path=/workspace/notes")[0]
        assert (missing, directory) == (404, 404), (missing, directory)
        return {"text bytes": len(TEXT.encode()), "binary bytes": len(binary)}

    @step("file delete")
    def _():
        assert api.request("PUT", f"/v1/sandboxes/{SANDBOX}/files?path=/workspace/tmp/x.txt", raw=b"x")[0] == 204
        codes = [api.request("DELETE", f"/v1/sandboxes/{SANDBOX}/files?path=/workspace/tmp&recursive=1")[0],
                 api.request("DELETE", f"/v1/sandboxes/{SANDBOX}/files?path=/workspace/tmp")[0],
                 api.request("DELETE", f"/v1/sandboxes/{SANDBOX}/files?path=/workspace/tmp&force=1")[0]]
        assert codes == [204, 404, 204], codes
        return codes

    @step("office in sandbox")
    def _():
        assert api.request("PUT", f"/v1/sandboxes/{SANDBOX}/files?path=/tmp/verify.py", raw=VERIFY.read_bytes())[0] == 204
        code, out, err, _ = api.exec("python3 /tmp/verify.py /workspace/office && ls /workspace/office")
        assert code == 0, (code, out[-500:], err[-1500:])
        report = json.loads(out.splitlines()[0])
        assert report["ok"] and report["checks"]["soffice"]["pages"] >= 1, report
        code, pdf = api.request("GET", f"/v1/sandboxes/{SANDBOX}/files?path=/workspace/office/deck.pdf")
        assert code == 200 and pdf.startswith(b"%PDF-"), (code, pdf[:20])
        return {name: check for name, check in report["checks"].items()}

    @step("no network")
    def _():
        code, out, err, _ = api.exec("curl -sS -m 10 https://ya.ru -o /dev/null")
        assert code != 0, (code, out, err)
        py, py_out, py_err, _ = api.exec("python3 -c \"import urllib.request; urllib.request.urlopen('https://ya.ru', "
                                         "timeout=5)\"")
        assert py != 0, (py, py_out)
        ip_code, ip_out, ip_err, _ = api.exec("curl -sS -m 10 http://77.88.55.242 -o /dev/null; "
                                              "curl -sS -m 5 http://169.254.169.254/ -o /dev/null")
        assert ip_code != 0, (ip_code, ip_out)
        dns, _, _, _ = api.exec("getent hosts ya.ru")
        assert dns != 0, dns
        links, links_out, _, _ = api.exec("cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d ' '")
        return {"curl": (code, err.strip()[-120:]), "python": (py, (py_err.strip().splitlines() or [""])[-1][-120:]),
                "ip": (ip_code, ip_err.strip()[-160:]), "dns": dns, "interfaces": links_out.split()}

    @step("network policy")
    def _():
        deny = api.request("POST", f"/v1/sandboxes/{SANDBOX}/network", {"policy": "deny-all"})[0]
        allow = api.request("POST", f"/v1/sandboxes/{SANDBOX}/network", {"policy": "allow-all"})
        assert deny == 204 and allow[0] == 409, (deny, allow)
        return {"deny-all": deny, "allow-all": [allow[0], json.loads(allow[1]).get("error")]}

    @step("tools socket")
    def _():
        code, out, err, _ = api.exec("ls -l /run/bro; tools; echo \"exit=$?\"")
        # The router is https://example.invalid: the CLI reaches sandboxd's socket (not exit 2, "no socket")
        # and the broker's forward fails.
        assert "tools.sock" in out and "exit=1" in out, (out, err)
        return {"stdout": out.strip()[-200:], "stderr": err.strip()[-200:]}

    @step("snapshot (running)")
    def _():
        result = api.json("POST", f"/v1/sandboxes/{SANDBOX}/snapshot")
        assert result["bytes"] > 0, result
        return result

    @step("stop")
    def _():
        result = api.json("POST", f"/v1/sandboxes/{SANDBOX}/stop")
        listed = dict(s3.listing(snapshot_key))
        code, head = s3.send(urllib.request.Request(s3.presign("GET", snapshot_key, 300), headers={"Range": "bytes=0-7"}))
        assert listed.get(snapshot_key) == result["bytes"] and head == b"BROSNAP1", (result, listed, code, head)
        gone = api.request("GET", f"/v1/sandboxes/{SANDBOX}")[0]
        return {**result, "s3 bytes": listed[snapshot_key], "magic": head.decode(), "get after stop": gone}

    @step("put (restore)")
    def _():
        result = api.json("PUT", f"/v1/sandboxes/{SANDBOX}", put_body())
        assert result["created"] and result["restored"], result
        code, data = api.request("GET", f"/v1/sandboxes/{SANDBOX}/files?path=" +
                                 urllib.parse.quote("/workspace/notes/привет.txt"))
        assert code == 200 and data.decode() == TEXT, (code, data[:200])
        code, out, _, _ = api.exec("ls -la /workspace /workspace/office | head -30; stat -c '%U %s' /workspace/blob.bin")
        assert code == 0 and "deck.pdf" in out and "sandbox 3145728" in out, out
        return {**result, "file": "restored"}

    @step("put (live)")
    def _():
        result = api.json("PUT", f"/v1/sandboxes/{SANDBOX}", put_body())
        assert not result["created"], result
        return result

    @step("delete")
    def _():
        code = api.request("DELETE", f"/v1/sandboxes/{SANDBOX}")[0]
        gone = api.request("GET", f"/v1/sandboxes/{SANDBOX}")[0]
        assert (code, gone) == (204, 404), (code, gone)
        return {"delete": code, "get after": gone}

    @step("health after")
    def _():
        return json.loads(api.request("GET", "/v1/health", auth=False)[1])

    if not args.keep_snapshot:
        s3.delete_prefix(snapshot_key)
    print(json.dumps({"sandbox": SANDBOX, "origin": origin, "failed": failed, "steps": results}, ensure_ascii=False))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
