"""vnc.py without a VM: the RFB exchange against a fake console, and the shell it makes run for real, with
file:// links standing in for Object Storage's."""

import hashlib
import io
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vnc  # noqa: E402

SERVER_INIT = struct.pack(">HH", 2, 1) + bytes(16) + struct.pack(">I", 4) + b"QEMU"


class FakeSocket:
    """What the console sends, in pieces (and empty frames, as the real one does); what the client sent."""

    def __init__(self, *chunks):
        self.chunks = [b""] + [bytes([b]) if isinstance(b, int) else b for b in chunks]
        self.sent = []
        self.closed = False

    def recv(self):
        return self.chunks.pop(0)

    def send_binary(self, data):
        self.sent.append(data)

    def close(self):
        self.closed = True


def console(*extra):
    return FakeSocket(b"RFB 003.008\n", 1, 1, struct.pack(">I", 0), SERVER_INIT, *extra)


def unpng(data):
    width, height = struct.unpack(">II", data[16:24])
    start = data.index(b"IDAT")
    size = struct.unpack(">I", data[start - 4:start])[0]
    raw = zlib.decompress(data[start + 4:start + 4 + size])
    rows = [raw[y * (width * 3 + 1):(y + 1) * (width * 3 + 1)] for y in range(height)]
    assert all(row[0] == 0 for row in rows)
    return width, height, b"".join(row[1:] for row in rows)


class KeysTest(unittest.TestCase):
    def test_shifted_keys_hold_shift_and_return_ends_the_line(self):
        self.assertEqual(vnc.keystrokes("a%A_\r\n"), [
            (ord("a"), None), (ord("%"), vnc.SHIFT), (ord("A"), vnc.SHIFT), (ord("_"), vnc.SHIFT),
            (vnc.RETURN, None), (vnc.RETURN, None)])
        self.assertEqual(vnc.keystrokes("\x15"), [(ord("u"), vnc.CONTROL)])

    def test_keys_off_the_layout_are_refused(self):
        for text in ("я", "\t", "\x03", "\x1b"):
            with self.assertRaises(ValueError, msg=repr(text)):
                vnc.keystrokes(text)


class RfbTest(unittest.TestCase):
    def test_the_handshake_takes_no_security_and_asks_for_raw_32_bit_pixels(self):
        ws = console()
        rfb = vnc.RFB(ws)
        self.assertEqual((rfb.width, rfb.height), (2, 1))
        self.assertEqual(ws.sent[:3], [b"RFB 003.008\n", b"\x01", b"\x01"])
        self.assertEqual(ws.sent[3][:8], bytes([0, 0, 0, 0, 32, 24, 0, 1]))  # SetPixelFormat, little-endian
        self.assertEqual(ws.sent[4], struct.pack(">BxHi", 2, 1, 0))

    def test_a_console_that_wants_a_password_is_refused(self):
        with self.assertRaisesRegex(ConnectionError, "password or another security type"):
            vnc.RFB(FakeSocket(b"RFB 003.008\n", 1, 2))
        with self.assertRaisesRegex(ConnectionError, "not an RFB server"):
            vnc.RFB(FakeSocket(b"HTTP/1.1 400"))

    def test_typing_releases_stale_modifiers_first_and_paces_every_event(self):
        ws = console()
        rfb = vnc.RFB(ws)
        ws.sent.clear()
        with mock.patch("time.sleep") as sleep:
            rfb.type("a:")
        events = [struct.unpack(">BBxxI", m)[1:] for m in ws.sent]
        self.assertEqual(events, [(0, vnc.SHIFT), (0, vnc.CONTROL), (1, ord("a")), (0, ord("a")),
                                  (1, vnc.SHIFT), (1, ord(":")), (0, ord(":")), (0, vnc.SHIFT)])
        self.assertEqual(sleep.call_count, len(events))

    def test_the_screen_comes_back_as_a_png(self):
        # A bell, then the update: two BGRX pixels, red and blue.
        update = struct.pack(">BxH", 0, 1) + struct.pack(">HHHHi", 0, 0, 2, 1, 0) + bytes([0, 0, 255, 0, 255, 0, 0, 0])
        ws = console(2, update)
        self.assertEqual(unpng(vnc.RFB(ws).screen()), (2, 1, bytes([255, 0, 0, 0, 0, 255])))
        self.assertEqual(ws.sent[-1], struct.pack(">BBHHHH", 3, 0, 0, 0, 2, 1))


class ShellTest(unittest.TestCase):
    """The script and the typed line in bash, /root moved to a temporary directory."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def bash(self, text):
        return subprocess.run(["bash", "-c", text.replace("/root/", f"{self.root}/")], capture_output=True,
                              text=True, stdin=subprocess.DEVNULL, timeout=30)

    def test_the_script_sends_the_output_and_the_status_whatever_the_command_does(self):
        out = self.root / "out"
        script = vnc.command_script("echo one\nread x || echo no-input\necho two >&2; exit 3", "abcd1234",
                                    out.as_uri())
        self.bash(script)
        self.assertEqual(vnc.parse_output(out.read_text(), "abcd1234"), ("one\nno-input\ntwo", 3))
        self.assertEqual([p.name for p in self.root.iterdir()], ["out"])  # its temporary file is gone

    def test_the_typed_line_runs_the_script_only_when_it_is_the_one_written(self):
        script = self.root / "served.sh"
        script.write_text(f"touch {self.root}/ran\n")
        digest = hashlib.sha256(script.read_bytes()).hexdigest()
        line = vnc.typed_line("abcd1234", script.as_uri(), digest)
        # A cleared line, and the shell's history off before anything else runs.
        self.assertTrue(line.startswith("\x15 unset HISTFILE; curl ") and line.endswith("\r"))
        vnc.keystrokes(line)  # every character can be typed
        self.bash(line[1:-1])
        self.assertTrue((self.root / "ran").exists())
        (self.root / "ran").unlink()
        script.write_text(f"touch {self.root}/ran; echo another command\n")
        self.bash(line[1:-1])
        self.assertFalse((self.root / "ran").exists())
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["served.sh"])  # the fetched copy is gone

    def test_a_line_too_long_for_the_tty_is_refused(self):
        with self.assertRaisesRegex(ValueError, "typed line"):
            vnc.typed_line("abcd1234", "https://s3.example/" + "x" * vnc.MAX_LINE, "ab" * 32)

    def test_output_without_the_end_marker_has_no_status(self):
        self.assertEqual(vnc.parse_output("half\n", "abcd1234"), ("half", None))
        self.assertEqual(vnc.parse_output("x\nEabcd1234E 0\n", "ffff0000"), ("x\nEabcd1234E 0", None))


class ConsoleTest(unittest.TestCase):
    def setUp(self):
        self.state = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.state)
        patches = [mock.patch.object(vnc, "STATE_DIR", self.state), mock.patch("time.sleep"),
                   mock.patch.object(vnc.s3, "presign", side_effect=lambda m, k, e: f"https://s3.example/{m}/{k}")]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.console = vnc.Console("bro-app-x", server_id="id-1")

    def run_with(self, answer):
        """Console.run with S3 faked: `answer(tag)` is the output object's text, or None for no object."""
        objects, deleted, typed = {}, [], []

        def send(request):
            objects[request.full_url.split("/PUT/")[1]] = request.data
            return 200, b""

        def signed(method, key):
            if method == "DELETE":
                deleted.append(key)
                return 204, b""
            tag = key.rsplit("/", 1)[1].split(".")[0]
            text = answer(tag)
            return (404, b"") if text is None else (200, text.encode())

        with mock.patch.object(vnc.s3, "send", side_effect=send), \
                mock.patch.object(vnc.s3, "signed", side_effect=signed), \
                mock.patch.object(self.console, "keys", side_effect=lambda *steps: typed.extend(steps)), \
                mock.patch("time.time", side_effect=[0, 0, 1000]):
            result = self.console.run("uptime", 60)
        return result, objects, deleted, typed

    def test_run_types_one_line_for_the_script_and_reads_its_output(self):
        result, objects, deleted, typed = self.run_with(lambda tag: f"up 2 days\nE{tag}E 0\n")
        self.assertEqual(result, ("up 2 days", 0))
        [(key, script)] = objects.items()
        self.assertTrue(key.startswith("app/console/bro-app-x/") and key.endswith(".sh"))
        self.assertIn(b"\nuptime\n", script)
        self.assertIn(hashlib.sha256(script).hexdigest(), typed[0])
        self.assertIn(f"/GET/{key}", typed[0])
        self.assertEqual(sorted(deleted), sorted([key, key.replace(".sh", ".out")]))

    def test_no_output_in_time_is_no_status(self):
        result, _, deleted, _ = self.run_with(lambda tag: None)
        self.assertEqual(result, ("", None))
        self.assertEqual(len(deleted), 1)  # the script; the output may still come and lapses with its link

    def test_a_missed_delete_is_retried_then_reported_by_key_alone(self):
        answers = [OSError("reset"), (500, b""), (204, b"")]
        with mock.patch.object(vnc.s3, "signed", side_effect=answers):
            self.console.forget("app/console/bro-app-x/ab.out")
        with mock.patch.object(vnc.s3, "signed", return_value=(500, b"")), \
                mock.patch("sys.stderr", new_callable=io.StringIO) as err:
            self.console.forget("app/console/bro-app-x/ab.out")
        self.assertIn("app/console/bro-app-x/ab.out", err.getvalue())
        self.assertNotIn("https://", err.getvalue())

    def test_the_console_is_checked_before_anything_is_held(self):
        with mock.patch("importlib.util.find_spec", return_value=None):
            with self.assertRaisesRegex(SystemExit, "websocket-client"):
                vnc.require()

    def login_with(self, asks, proofs):
        """login() against a fake console: whether the screen asks for a password, what each proof answers;
        what was typed on the console and how it ended."""
        typed = []
        rfb = mock.Mock()
        rfb.type.side_effect = typed.append
        answers = list(proofs)
        with mock.patch.object(self.console, "connect", return_value=rfb), \
                mock.patch.object(vnc, "asks_password", return_value=asks), \
                mock.patch.object(self.console, "run", side_effect=lambda c, s: answers.pop(0)), \
                mock.patch.object(self.console, "save_screen", return_value="the screen is in x.png"):
            try:
                self.console.login()
            except SystemExit as stop:
                return typed, str(stop)
        return typed, "in"

    def test_no_password_is_typed_where_the_screen_echoes(self):
        # Root with no password: a shell at once, which echoes. No password file is read.
        typed, outcome = self.login_with(False, [("console-ok", 0)])
        self.assertEqual((typed, outcome), (["\x15exit\r", "\r", "root\r"], "in"))
        # A shell whose proof lost a key: the second proof, still no password typed.
        typed, outcome = self.login_with(False, [("", None), ("console-ok", 0)])
        self.assertEqual((typed, outcome), (["\x15exit\r", "\r", "root\r"], "in"))
        typed, outcome = self.login_with(False, [("", None), ("", None)])
        self.assertIn("no root shell", outcome)
        self.assertEqual(typed, ["\x15exit\r", "\r", "root\r"])

    def test_the_password_goes_in_once_when_the_prompt_does_not_echo(self):
        console = "-_" + os.urandom(6).hex()  # made here: a written-out one reads as a leaked secret to scanners
        (self.state / "bro-app-x.password").write_text(console + "\n")
        typed, outcome = self.login_with(True, [("", None), ("Last login: …\nconsole-ok", 0)])
        self.assertEqual(outcome, "in")
        self.assertEqual(typed, ["\x15exit\r", "\r", "root\r", console + "\r"])

    def test_a_prompt_is_one_that_does_not_echo(self):
        blank = bytes(640 * 480 * 3)
        cursor = bytearray(blank)
        cursor[:8 * 16 * 3] = b"\xff" * (8 * 16 * 3)  # a block cursor blinked: one cell
        echoed = bytearray(blank)
        echoed[:16 * 40 * 3] = b"\xff" * (16 * 40 * 3)  # sixteen glyphs drawn
        for after, asks in ((blank, True), (bytes(cursor), True), (bytes(echoed), False)):
            rfb = mock.Mock()
            rfb.frame.side_effect = [blank, after]
            self.assertEqual(vnc.asks_password(rfb), asks)
            self.assertEqual(rfb.type.call_args_list, [mock.call(vnc.ECHO_PROBE), mock.call("\x15")])

if __name__ == "__main__":
    unittest.main()
