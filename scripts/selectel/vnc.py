"""Run commands on a Selectel cloud VM through its VNC console: no SSH, no open port, no serial console.

  python vnc.py screen NAME OUT.png                   what the VM's screen shows now (read only)
  python vnc.py run NAME 'command' [--timeout 120]    prints the output, exits with the command's status

Selectel's cloud (OpenStack) gives no serial console ("Unavailable console type serial", 13.10), only noVNC:
POST /servers/{id}/remote-consoles {protocol: vnc, type: novnc} returns a page whose `path` query is the
websocket (wss://<api host>/console/v1/<path>), RFB 3.8 with no security of its own (the token in the path is
the access, one connection each). A VNC console takes keys and shows pixels, it gives no text back, so:

  - keys: tty1's login as root (with the password `host.py create` set by cloud-init and kept in
    $PROBE_STATE_DIR/<name>.password, only when the screen shows a prompt that does not echo the keys
    typed), then one line per command, starting with `unset HISTFILE`, typed as
    RFB key events, slowly (KEY_PAUSE_S: a line of ~700 characters takes ~40 s);
  - the command itself travels as a script in Object Storage: the typed line fetches it by a presigned GET
    and runs it only when its sha256 matches, so a key the console dropped can break the line but never
    run a different command;
  - the output comes back the same way: the script PUTs it, with the end marker and the exit status, to a
    presigned link, and this side polls for that object. Both objects are deleted once read.

The login is blind: whatever tty1 shows (a login prompt, a password prompt, a shell left open), the keys
first bring it back to `login:`, and a first command (`echo`) proves the shell (Console.login). When something
does not answer, `screen` shows what tty1 shows (login saves it next to the password). The shell is logged out at
the end (close); a command still running when this gives up reads that `exit` only once it ends.
Needs `pip install websocket-client` (only to connect); S3_* and PROBE_BUCKET as for s3.py.
"""

import argparse
import hashlib
import os
import re
import secrets
import struct
import sys
import time
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "cloudru-sandbox-probe"))
import s3  # noqa: E402

STATE_DIR = Path(os.environ.get("PROBE_STATE_DIR", Path.home() / ".bro-probe"))
PREFIX = "app/console"
# Keys a US layout types with Shift: QEMU maps a keysym to the scancode of its key and leaves the modifiers
# as the client holds them, so '%' without a held Shift would come out as '5'.
SHIFTED = set('~!@#$%^&*()_+{}|:"<>?') | set("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
RETURN, SHIFT, CONTROL = 0xFF0D, 0xFFE1, 0xFFE3
# QEMU plays VNC key events to the guest one by one with a delay of its own and drops what overflows its
# queue: at 8 ms a key the first live line (13.10) came out whole for ~150 characters, then a lost Shift release
# turned the rest into capitals and symbols. A pause after every event keeps the queue short.
KEY_PAUSE_S = 0.025
# A tty line in canonical mode holds 4095 characters; the typed lines here are well under a thousand.
MAX_LINE = 3000
# The probe for a password prompt: keys a prompt does not echo, and pixels they change when echoed. Sixteen
# '#' light ~500 pixels of a 640x480 text console; a blinking cursor changes a cell, at most 128.
ECHO_PROBE = "#" * 16
ECHO_PIXELS = 300


def keystrokes(text):
    """[(keysym, modifier or None)] for text: printable ASCII, '\\r' or '\\n' as Return, ^U (\\x15, the tty's
    kill of the line) with Control. Anything else is refused: a keysym outside the layout might type another key."""
    keys = []
    for char in text:
        if char in "\r\n":
            keys.append((RETURN, None))
        elif char == "\x15":
            keys.append((ord("u"), CONTROL))
        elif " " <= char <= "~":
            keys.append((ord(char), SHIFT if char in SHIFTED else None))
        else:
            raise ValueError(f"cannot type {char!r} on the console")
    return keys


def key_event(keysym, down):
    return struct.pack(">BBxxI", 4, 1 if down else 0, keysym)


def png(width, height, rgb):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


class RFB:
    """An RFB 3.8 client over a websocket-like object (send_binary, recv), as much as typing and one screenshot
    need: security type None only, raw encoding only, a 32-bit little-endian pixel format of its own."""

    def __init__(self, ws):
        self.ws = ws
        self.buf = b""
        version = self.read(12)
        if not version.startswith(b"RFB 003."):
            raise ConnectionError(f"not an RFB server: {version!r}")
        self.ws.send_binary(b"RFB 003.008\n")
        types = self.read(self.read(1)[0])
        if 1 not in types:
            raise ConnectionError(f"the console wants a password or another security type: {list(types)}")
        self.ws.send_binary(bytes([1]))
        if struct.unpack(">I", self.read(4))[0] != 0:
            raise ConnectionError("the console refused the connection")
        self.ws.send_binary(bytes([1]))  # shared: noVNC in a browser may watch at the same time
        self.width, self.height = struct.unpack(">HH", self.read(4))
        self.read(16)  # the server's pixel format: replaced below
        self.read(struct.unpack(">I", self.read(4))[0])  # the desktop's name
        self.ws.send_binary(struct.pack(">BxxxBBBBHHHBBBxxx", 0, 32, 24, 0, 1, 255, 255, 255, 16, 8, 0))
        self.ws.send_binary(struct.pack(">BxHi", 2, 1, 0))  # raw

    def read(self, count):
        while len(self.buf) < count:
            data = self.ws.recv()  # empty frames come too; a closed socket raises
            self.buf += data if isinstance(data, bytes) else data.encode()
        out, self.buf = self.buf[:count], self.buf[count:]
        return out

    def type(self, text, pause=KEY_PAUSE_S):
        # A modifier an earlier connection left down (its release lost) would change every key below.
        events = [(SHIFT, False), (CONTROL, False)]
        for keysym, modifier in keystrokes(text):
            events += [(modifier, True)] if modifier else []
            events += [(keysym, True), (keysym, False)]
            events += [(modifier, False)] if modifier else []
        for keysym, down in events:
            self.ws.send_binary(key_event(keysym, down))
            time.sleep(pause)

    def screen(self):
        """The whole screen as a PNG."""
        return png(self.width, self.height, self.frame())

    def frame(self):
        """The whole screen, RGB bytes row by row."""
        self.ws.send_binary(struct.pack(">BBHHHH", 3, 0, 0, 0, self.width, self.height))
        rgb = bytearray(self.width * self.height * 3)
        while True:
            kind = self.read(1)[0]
            if kind == 0:  # FramebufferUpdate: the first one answers the request
                self.read(1)
                for _ in range(struct.unpack(">H", self.read(2))[0]):
                    x, y, w, h, encoding = struct.unpack(">HHHHi", self.read(12))
                    if encoding != 0:
                        raise ConnectionError(f"unexpected encoding {encoding}")
                    data = self.read(w * h * 4)
                    for row in range(h):
                        line = data[row * w * 4:(row + 1) * w * 4]
                        start = ((y + row) * self.width + x) * 3
                        rgb[start:start + w * 3:3] = line[2::4]
                        rgb[start + 1:start + w * 3:3] = line[1::4]
                        rgb[start + 2:start + w * 3:3] = line[0::4]
                return bytes(rgb)
            if kind == 1:  # SetColourMapEntries
                self.read(3)
                self.read(struct.unpack(">H", self.read(2))[0] * 6)
            elif kind == 3:  # ServerCutText
                self.read(3)
                self.read(struct.unpack(">I", self.read(4))[0])
            elif kind != 2:  # Bell has no body
                raise ConnectionError(f"unexpected RFB message {kind}")


def require():
    """What the console needs, checked before host.py holds anything: websocket-client and the project's key."""
    import importlib.util

    from api import api_key, setting

    if importlib.util.find_spec("websocket") is None:
        sys.exit("the VNC console needs the websocket-client package (pip install websocket-client)")
    api_key()
    setting("SELECTEL_PROJECT")


def console_websocket(server_id):
    """A fresh noVNC token for the server (each one opens a single connection) and its websocket."""
    try:
        import websocket  # websocket-client: only to connect
    except ImportError:
        sys.exit("the VNC console needs the websocket-client package (pip install websocket-client)")

    import cloud
    from api import project_token, request

    status, body, _ = request("POST", f"{cloud.COMPUTE}/servers/{server_id}/remote-consoles",
                              {"X-Auth-Token": project_token(), **cloud.NOVA},
                              {"remote_console": {"protocol": "vnc", "type": "novnc"}})
    if status != 200:
        sys.exit(f"remote console: {status} {str(body)[:300]}")
    page = urllib.parse.urlsplit(body["remote_console"]["url"])
    path = dict(urllib.parse.parse_qsl(page.query)).get("path")
    if not path:
        sys.exit("the console page has no websocket path")
    # websocket-client ignores SSL_CERT_FILE; the cloud session's proxy needs its CA bundle.
    ca = {"ca_certs": os.environ["SSL_CERT_FILE"]} if os.environ.get("SSL_CERT_FILE") else None
    return websocket.create_connection(f"wss://{page.netloc}/console/v1/{path}", subprotocols=["binary"],
                                       timeout=30, sslopt=ca)


def asks_password(rfb):
    """True when the screen shows a prompt that does not echo: the probe keys change (almost) no pixels. ^U
    then drops them, from the prompt's buffer or from a shell's line alike."""
    before = rfb.frame()
    rfb.type(ECHO_PROBE)
    time.sleep(1.5)
    after = rfb.frame()
    rfb.type("\x15")
    changed = sum(a != b for a, b in zip(before[::3], after[::3]))
    return changed < ECHO_PIXELS


def command_script(command, tag, put_url):
    """What the VM runs for one command: the command with no input, its output and the end marker in a file,
    that file PUT to the presigned link (a few tries: the console keeps no other copy)."""
    return "\n".join([
        "#!/bin/bash",
        f"out=$(mktemp /root/.bro-console-{tag}.XXXXXX)",
        "(",
        command,
        ') </dev/null >"$out" 2>&1',
        # The marker on a line of its own: output that ends without a line break (`curl` of a health check,
        # 13.10) would otherwise carry it at the end of its last line.
        f"printf '\\nE{tag}E %s\\n' \"$?\" >>\"$out\"",
        f"for i in 1 2 3 4 5; do curl -fsS -m 60 -T \"$out\" '{put_url}' && break; sleep 5; done",
        'rm -f "$out"',
        "",
    ])


def typed_line(tag, get_url, digest):
    """The one line typed for a command. ^U clears what the line may hold already; `unset HISTFILE` first, so the
    shell never writes its history (the presigned links, anything typed) whatever HISTCONTROL says; the
    script runs only when it is the one this side wrote."""
    script = f"/root/.bro-console-{tag}.sh"
    line = (f"\x15 unset HISTFILE; curl -fsS -m 60 -o {script} '{get_url}' && echo '{digest}  {script}' | sha256sum -c --quiet - "
            f"&& bash {script}; rm -f {script}\r")
    if len(line) > MAX_LINE:
        raise ValueError(f"a typed line of {len(line)} characters")
    return line


def parse_output(text, tag):
    """(output, exit status) of an output object; status None without the end marker. The last marker counts,
    at the start of its line or not: the tag is random, and a script written before the marker had a line of
    its own glued it to output that ended without a line break."""
    matches = list(re.finditer(rf"E{tag}E (\d+)[ \t]*$", text, re.M))
    if not matches:
        return text.strip(), None
    return text[:matches[-1].start()].strip(), int(matches[-1].group(1))


class Console:
    """console.Console's interface for a Selectel VM: login(), run(command, seconds) -> (output, status or None),
    close() (logs the shell out)."""

    def __init__(self, name, server_id=None):
        self.name = name
        if server_id is None:
            import cloud
            found = cloud.server_by_name(name)
            if found is None:
                sys.exit("no such VM")
            server_id = found["id"]
        self.server_id = server_id

    def connect(self):
        return RFB(console_websocket(self.server_id))

    def keys(self, *steps):
        """Type the steps on one connection: a text, or a number of seconds to wait."""
        ws = None
        try:
            rfb = self.connect()
            ws = rfb.ws
            for step in steps:
                if isinstance(step, str):
                    rfb.type(step)
                else:
                    time.sleep(step)
            time.sleep(1)  # the last keys on their way before the close
        finally:
            if ws is not None:
                ws.close()

    def screen(self):
        rfb = self.connect()
        try:
            return rfb.screen()
        finally:
            rfb.ws.close()

    def save_screen(self):
        """The screen for the operator to look at, when the keys did not get the expected answer."""
        path = STATE_DIR / f"{self.name}.screen.png"
        try:
            path.write_bytes(self.screen())
        except (ConnectionError, OSError, SystemExit) as error:
            return f"(no screenshot: {error})"
        return f"the console's screen is in {path}"

    def login(self):
        """From any state of tty1 to a root shell, proved by a command. ^U clears a half-typed line, `exit`
        logs a shell out (a login prompt takes it for a user name), the empty line after it ends a password
        prompt ("Login incorrect" comes ~3 s later); then `login:` is certain, and `root` goes in. No ^C: tty1
        may still run the install of an update whose answer was lost, and these keys wait for it instead.

        The password goes in only when the screen shows a prompt that does not echo (asks_password): on
        bro-app-sel-2 (13.10) root had none and tty1 opened a shell at once, where a password typed blind landed
        in the shell, on the screen and in its history."""
        rfb = self.connect()
        try:
            for step in ("\x15exit\r", 3, "\r", 6, "root\r", 4):
                if isinstance(step, str):
                    rfb.type(step)
                else:
                    time.sleep(step)
            if asks_password(rfb):
                password = (STATE_DIR / f"{self.name}.password").read_text().strip()
                rfb.type(password + "\r")
                time.sleep(8)
            time.sleep(1)
        finally:
            rfb.ws.close()
        # Twice: one key the console lost breaks a line, not the shell.
        if self.proved() or self.proved():
            return
        sys.exit(f"no root shell on the console of {self.name}: {self.save_screen()}")

    def proved(self):
        output, status = self.run("echo console-ok", 60)
        return status == 0 and output.endswith("console-ok")

    def run(self, command, seconds):
        tag = secrets.token_hex(4)
        base = f"{PREFIX}/{self.name}/{tag}"
        script = command_script(command, tag, s3.presign("PUT", f"{base}.out", seconds + 900)).encode()
        code, body = s3.send(urllib.request.Request(s3.presign("PUT", f"{base}.sh", 600), script, method="PUT"))
        if code != 200:
            sys.exit(f"put the command script: {code} {body[:200]!r}")
        try:
            self.keys(typed_line(tag, s3.presign("GET", f"{base}.sh", 600), hashlib.sha256(script).hexdigest()))
            text = self.wait_for(f"{base}.out", seconds)
        finally:
            self.forget(f"{base}.sh")
        if text is None:
            return "", None
        self.forget(f"{base}.out")
        return parse_output(text, tag)

    def wait_for(self, key, seconds):
        deadline = time.time() + seconds
        while True:
            code, body = s3.signed("GET", key)
            if code == 200:
                return body.decode(errors="replace")
            if code != 404:
                print(f"get {key}: {code}", file=sys.stderr, flush=True)
            if time.time() > deadline:
                return None
            time.sleep(3)

    def forget(self, key):
        """Deletes an object of the console. One that stays is not reachable by its links once they expire,
        but stays in the bucket: its key is reported (never a link) for the operator to delete."""
        for attempt in range(3):
            try:
                code, _ = s3.signed("DELETE", key)
                if code in (200, 204):
                    return
            except OSError:
                pass
            time.sleep(2 ** attempt)
        print(f"could not delete {key} from Object Storage: delete it by hand", file=sys.stderr, flush=True)

    def close(self):
        """Logs the shell out: typed now, read by the shell only when it is at its prompt again."""
        self.keys("exit\r")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    screen = sub.add_parser("screen")
    screen.add_argument("name")
    screen.add_argument("out")
    one = sub.add_parser("run")
    one.add_argument("name")
    one.add_argument("command")
    one.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    console = Console(args.name)
    if args.cmd == "screen":
        Path(args.out).write_bytes(console.screen())
        print(args.out)
        return
    console.login()
    try:
        output, status = console.run(args.command, args.timeout)
    finally:
        console.close()
    print(output)
    sys.exit(1 if status is None else status)


if __name__ == "__main__":
    main()
