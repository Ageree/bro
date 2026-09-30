"""Sandbox root tests: python -m unittest browser-vm/image/test_sandbox.py (stdlib only).

bro-sandbox-init reads the very units provision.sh writes, and runs fake ones here as the current user; the
systemctl shim reaches it over its socket like the worker's `sudo systemctl ... bro-chrome` in a sandbox.
"""

import importlib.machinery
import importlib.util
import os
import pwd
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).parent
PROVISION = (HERE / "provision.sh").read_text()
INIT = HERE / "sandbox" / "bro-sandbox-init"
SHIM = HERE / "sandbox" / "systemctl"


def load_init():
    loader = importlib.machinery.SourceFileLoader("bro_sandbox_init", str(INIT))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return module


def unit_text(name):
    return re.search(rf"cat > /etc/systemd/system/{name}.service <<'UNIT'\n(.*?)\nUNIT\n", PROVISION, re.S).group(1)


class UnitParseTest(unittest.TestCase):
    def test_chrome_runs_with_the_vm_units_command_line_user_and_environment(self):
        unit = load_init().parse_unit(unit_text("bro-chrome"))
        vm_line = next(line for line in PROVISION.splitlines() if line.startswith("ExecStart=/usr/bin/google-chrome"))
        self.assertEqual(unit["start"], vm_line.removeprefix("ExecStart=").split(" "))
        self.assertIn("--proxy-bypass-list=<-loopback>", unit["start"])
        self.assertEqual(unit["user"], "bro")
        self.assertEqual(unit["environment"], {"DISPLAY": ":99", "TZ": "Europe/Moscow", "LANG": "ru_RU.UTF-8",
                                               "LANGUAGE": "ru_RU:ru"})
        # The stale-lock cleanup before every start, as ExecStartPre on the VM.
        self.assertEqual(unit["pre"][0][:2], ["/bin/sh", "-c"])
        self.assertIn("SingletonLock", unit["pre"][0][2])
        self.assertEqual((unit["restart_sec"], unit["stop_timeout"]), (1.0, 30.0))

    def test_worker_and_xvfb_units(self):
        init = load_init()
        worker = init.parse_unit(unit_text("bro-worker"))
        self.assertEqual(worker["start"], ["/opt/bro/bu/.venv/bin/python", "/opt/bro/worker/worker.py"])
        self.assertEqual(worker["environment"]["ANONYMIZED_TELEMETRY"], "false")
        self.assertEqual(init.parse_unit(unit_text("bro-xvfb"))["start"][:2], ["/usr/bin/Xvfb", ":99"])

    def test_sandbox_mode_skips_caddy_firewall_and_systemd(self):
        caddy = PROVISION.index("retry apt-get install -yq caddy")
        guard = PROVISION.rindex('if [ "$SANDBOX" != 1 ]; then', 0, caddy)
        self.assertLess(PROVISION.index("\nfi\n", guard), PROVISION.index("stage caddy"))
        enable = PROVISION.index("systemctl enable bro-boot")
        self.assertGreater(enable, PROVISION.rindex('if [ "$SANDBOX" != 1 ]; then', 0, enable))


class InitTest(unittest.TestCase):
    """The init with fake units (sleep loops writing their start count) in a temp directory."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        units = self.tmp / "units"
        units.mkdir()
        for name in ("bro-xvfb", "bro-chrome", "bro-worker"):
            (units / f"{name}.service").write_text(
                "[Unit]\nDescription=fake\n[Service]\nUser=%s\nEnvironment=UNIT=%s\n"
                "ExecStart=/bin/sh -c 'echo \"$UNIT $BRO_WORKER_BIND $0\" >> %s/starts; exec sleep 1000' %s\n"
                "RestartSec=0.2\nTimeoutStopSec=5\n" % (pwd.getpwuid(os.getuid()).pw_name, name, self.tmp, name))
        self.env = {**os.environ, "BRO_UNIT_DIR": str(units), "BRO_INIT_SOCKET": str(self.tmp / "init.sock"),
                    "BRO_WORKER_BIND": "0.0.0.0"}
        self.init = subprocess.Popen([sys.executable, str(INIT)], env=self.env, stderr=subprocess.PIPE, text=True)
        self.wait_for(lambda: len(self.starts()) == 3)

    def tearDown(self):
        self.init.terminate()
        self.init.wait(10)
        self.init.stderr.close()

    def starts(self):
        path = self.tmp / "starts"
        return path.read_text().splitlines() if path.exists() else []

    def wait_for(self, condition, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.05)
        self.fail("condition not reached")

    def systemctl(self, *args):
        return subprocess.run([sys.executable, str(SHIM), *args], env=self.env, capture_output=True, text=True,
                              timeout=30)

    def test_units_start_in_order_with_bro_environment(self):
        self.assertEqual(self.starts(), ["bro-xvfb 0.0.0.0 bro-xvfb", "bro-chrome 0.0.0.0 bro-chrome",
                                         "bro-worker 0.0.0.0 bro-worker"])

    def test_stop_keeps_it_down_start_and_restart_bring_it_back(self):
        self.assertEqual(self.systemctl("stop", "bro-chrome").returncode, 0)
        time.sleep(0.6)  # past RestartSec: a stopped unit is not restarted
        self.assertEqual(len(self.starts()), 3)
        self.assertEqual(self.systemctl("start", "bro-chrome").returncode, 0)
        self.assertEqual(self.systemctl("restart", "bro-chrome").returncode, 0)
        self.assertEqual([line for line in self.starts() if line.startswith("bro-chrome")], ["bro-chrome 0.0.0.0 bro-chrome"] * 3)

    def test_a_unit_that_dies_is_restarted(self):
        pid = int(subprocess.check_output(["pgrep", "-f", "sleep 1000", "-P", str(self.init.pid)]).split()[0])
        os.kill(pid, 9)
        self.wait_for(lambda: len(self.starts()) == 4)

    def test_the_shim_takes_only_start_stop_restart_of_known_units(self):
        self.assertNotEqual(self.systemctl("enable", "bro-chrome").returncode, 0)
        refused = self.systemctl("start", "caddy")
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("error", refused.stderr)


if __name__ == "__main__":
    unittest.main()
