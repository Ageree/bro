"""Run commands on a probe VM over the Cloud.ru serial console — no SSH, no open port.

  python console.py run NAME 'command' [--timeout 120]    prints the output, exits with the command's status
  python console.py push NAME LOCAL REMOTE                copies a small file (scripts) in base64 chunks

The serial login is root with the password cloudru.py create stored in $PROBE_STATE_DIR/<name>.password.
The console websocket URL is cached per VM and asked for again when it stops working (after a reboot, or
when Cloud.ru closes it after a while). `set-password` of the Compute API does not work on the stock
Ubuntu image: it needs the guest agent ("Guest agent is unavailable for vm"), hence cloud-init chpasswd.
Needs `pip install websocket-client`.
"""

import argparse
import base64
import os
import re
import secrets
import sys
import time

import websocket

import cloudru

PROMPTS = [r"login: $", r"Password: $", r"# $"]


def console_url(name, fresh):
    cache = cloudru.STATE_DIR / f"{name}.console"
    if not fresh and cache.exists():
        return cache.read_text()
    vm = cloudru.vm_by_name(name)
    if vm is None:
        sys.exit("no such VM")
    cloudru.api("POST", f"/v1/vms/{vm['id']}/remote-console", {"protocol": "serial"})
    url = None
    for _ in range(10):  # the address shows up a moment after the POST; never cache an empty one
        time.sleep(2)
        url = cloudru.api("GET", f"/v1/vms/{vm['id']}")[1].get("remote_console_ws")
        if url and url.startswith("wss://"):
            break
    cloudru.write_private(cache, url)
    return url


class Console:
    def __init__(self, name):
        self.name = name
        self.buf = ""
        self.ws = self.connect()

    def connect(self, only_fresh=False):
        error = None
        for fresh in (True,) if only_fresh else (False, True):
            try:
                # websocket-client ignores SSL_CERT_FILE; the cloud session proxy needs its CA bundle.
                ca = {"ca_certs": os.environ["SSL_CERT_FILE"]} if os.environ.get("SSL_CERT_FILE") else None
                ws = websocket.create_connection(console_url(self.name, fresh), subprotocols=["binary"], timeout=2,
                                                 sslopt=ca)
                ws.send_binary(b"\r")
                return ws
            except (websocket.WebSocketException, OSError) as e:
                error = e
        raise error

    def send(self, text):
        self.ws.send_binary(text.encode())

    def wait(self, patterns, seconds):
        end = time.time() + seconds
        while time.time() < end:
            for pattern in patterns:
                match = re.search(pattern, self.buf)
                if match:
                    return match
            try:
                data = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except (websocket.WebSocketConnectionClosedException, OSError):
                # Cloud.ru drops the console now and then; the command keeps running on the VM, and
                # whatever it prints after the reconnect (the end marker included) still arrives.
                self.ws = self.connect()
                continue
            self.buf += data.decode(errors="replace") if isinstance(data, bytes) else data
        return None

    def login(self):
        password = (cloudru.STATE_DIR / f"{self.name}.password").read_text()
        match = self.wait(PROMPTS, 15)
        if match is None:
            # A cached console URL can go silent without failing to connect: ask Cloud.ru for a new one.
            self.ws = self.connect(only_fresh=True)
            match = self.wait(PROMPTS, 15)
        if match and match.re.pattern.startswith("login"):
            self.send("root\r")
            self.wait([r"Password: "], 10)
            self.send(password + "\r")
            self.wait([r"# $"], 20)
        elif match and match.re.pattern.startswith("Password"):
            self.send(password + "\r")
            self.wait([r"# $"], 20)

    def run(self, command, seconds):
        tag = secrets.token_hex(3)
        self.buf = ""
        self.send(f"stty -echo cols 250; export TERM=dumb PAGER=cat; echo S{tag}S; ( {command} ) 2>&1; "
                  f"echo E{tag}E $?\r")
        match = self.wait([rf"E{tag}E \d+"], seconds)
        start = self.buf.find(f"S{tag}S")
        body = self.buf[start + len(tag) + 2:] if start >= 0 else self.buf
        body = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", body).replace("\r", "")
        return body.split(f"E{tag}E")[0].strip(), int(match.group(0).split()[-1]) if match else None


def run(name, command, seconds):
    console = Console(name)
    console.login()
    return console.run(command, seconds)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    one = sub.add_parser("run")
    one.add_argument("name")
    one.add_argument("command")
    one.add_argument("--timeout", type=int, default=120)
    push = sub.add_parser("push")
    push.add_argument("name")
    push.add_argument("local")
    push.add_argument("remote")
    args = parser.parse_args()
    if args.cmd == "run":
        output, status = run(args.name, args.command, args.timeout)
        print(output)
        sys.exit(1 if status is None else status)
    data = base64.b64encode(open(args.local, "rb").read()).decode()
    # The serial line takes about a kilobyte per command reliably.
    chunks = [f"rm -f {args.remote}.b64"] + [f"printf %s '{data[i:i + 900]}' >> {args.remote}.b64"
                                             for i in range(0, len(data), 900)]
    chunks.append(f"base64 -d {args.remote}.b64 > {args.remote} && chmod +x {args.remote} && rm {args.remote}.b64 "
                  f"&& wc -c {args.remote}")
    console = Console(args.name)
    console.login()
    for i in range(0, len(chunks), 6):
        output, status = console.run("; ".join(chunks[i:i + 6]), 60)
        if status != 0:
            sys.exit(f"push failed: {output}")
    print(output)


if __name__ == "__main__":
    main()
