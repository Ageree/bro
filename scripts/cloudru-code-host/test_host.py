"""host.py tests: cd scripts/cloudru-code-host && python3 -m unittest (stdlib only, nothing reaches Cloud.ru)."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
STATE = tempfile.mkdtemp()
os.environ["BRO_CODE_HOST_DIR"] = STATE  # host.py keeps its state here, never in the real home
sys.path.insert(0, str(HERE))
import host  # noqa: E402


def tearDownModule():
    shutil.rmtree(STATE, True)


class SetHostsTest(unittest.TestCase):
    """set-hosts runs a line as root over the serial console: names are checked, values quoted."""

    def run_line(self, line, hosts, template=None):
        directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, directory, True)
        (directory / "hosts").write_text(hosts)
        if template is not None:
            (directory / "hosts.debian.tmpl").write_text(template)
        line = (line.replace("/etc/cloud/templates/hosts.debian.tmpl", str(directory / "hosts.debian.tmpl"))
                .replace("/etc/hosts", str(directory / "hosts")))
        subprocess.run(["bash", "-c", line], check=True, capture_output=True)
        tmpl = directory / "hosts.debian.tmpl"
        return (directory / "hosts").read_text(), tmpl.read_text() if tmpl.exists() else None

    def test_a_name_that_is_not_a_host_name_never_reaches_the_shell(self):
        for entry in ("brobro.tech';touch /tmp/pwned;'=10.0.1.7", "bro$(id).tech=10.0.1.7", "brobro.tech=10.0.1.7;id"):
            with self.subTest(entry), mock.patch.object(host.cloudru, "vm_by_name", return_value=None), \
                    self.assertRaises(SystemExit):
                host.hosts_entries([entry])
        with self.assertRaises(ValueError):
            host.set_hosts_command([("brobro.tech'; id; '", "10.0.1.7")])

    def test_a_name_is_pinned_once(self):
        with self.assertRaises(SystemExit):
            host.hosts_entries(["brobro.tech=10.0.1.7", "BroBro.tech=10.0.1.8"])

    def test_a_vm_name_is_read_as_its_private_address(self):
        vm = {"interfaces": [{"ip_address": "10.0.1.9", "floating_ip": {"ip_address": "176.109.0.9"}}]}
        with mock.patch.object(host.cloudru, "vm_by_name", return_value=vm) as found:
            self.assertEqual(host.hosts_entries(["brobro.tech=bro-app-1"]), [("brobro.tech", "10.0.1.9")])
        found.assert_called_once_with("bro-app-1")

    def test_pins_in_hosts_and_cloud_inits_template_as_at_first_boot(self):
        line = host.set_hosts_command([("brobro.tech", "10.0.1.7")])
        hosts, template = self.run_line(line, "127.0.0.1 localhost\n1.2.3.4 brobro.tech\n",
                                        "127.0.1.1 {{fqdn}} {{hostname}}\n")
        self.assertEqual(hosts, "127.0.0.1 localhost\n10.0.1.7 brobro.tech # bro-private\n")
        self.assertEqual(template, "127.0.1.1 {{fqdn}} {{hostname}}\n10.0.1.7 brobro.tech # bro-private\n")
        # Again, with another address: still one line per name.
        line = host.set_hosts_command([("brobro.tech", "10.0.1.8")])
        hosts, _ = self.run_line(line, hosts)
        self.assertEqual(hosts, "127.0.0.1 localhost\n10.0.1.8 brobro.tech # bro-private\n")

    def test_an_image_without_the_template_gets_none(self):
        hosts, template = self.run_line(host.set_hosts_command([("brobro.tech", "10.0.1.7")]), "127.0.0.1 localhost\n")
        self.assertEqual(hosts, "127.0.0.1 localhost\n10.0.1.7 brobro.tech # bro-private\n")
        self.assertIsNone(template)


if __name__ == "__main__":
    unittest.main()
