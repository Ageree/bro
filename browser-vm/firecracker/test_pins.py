"""Pin tests: cd browser-vm/firecracker && python -m unittest (stdlib only).

`pins.json` is what the host fetches from S3 (guest kernel and the Firecracker release); `firecracker.json` is where
the release comes from and what is inside; `kernel/build.sh` is where the kernel comes from. They must not drift.
"""

import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).parent
PINS = json.loads((HERE / "pins.json").read_text())
RELEASE = json.loads((HERE / "firecracker.json").read_text())
BUILD = (HERE / "kernel" / "build.sh").read_text()
HEX64 = re.compile(r"^[0-9a-f]{64}$")


def build_pin(name):
    return re.search(rf'^{name}="([^"]+)"', BUILD, re.MULTILINE).group(1)


class PinsShapeTest(unittest.TestCase):
    def test_top_level_and_fields(self):
        self.assertEqual(set(PINS), {"kernel", "firecracker"})
        self.assertEqual(set(PINS["kernel"]), {"version", "key", "sha256"})
        self.assertEqual(
            set(PINS["firecracker"]), {"version", "key", "sha256", "firecrackerSha256", "jailerSha256"}
        )

    def test_sha256_values_are_lowercase_hex(self):
        for value in (
            PINS["kernel"]["sha256"],
            PINS["firecracker"]["sha256"],
            PINS["firecracker"]["firecrackerSha256"],
            PINS["firecracker"]["jailerSha256"],
        ):
            self.assertRegex(value, HEX64)

    def test_keys_live_under_firecracker_prefix(self):
        for section in ("kernel", "firecracker"):
            key = PINS[section]["key"]
            self.assertTrue(key.startswith("firecracker/"), key)
            self.assertFalse(key.startswith("/"), key)
            self.assertNotIn("..", key)
            self.assertRegex(key, r"^[A-Za-z0-9._/+-]+$")

    def test_key_names_carry_version_and_hash(self):
        kernel = PINS["kernel"]
        self.assertRegex(kernel["version"], r"^6\.1\.\d+$")
        self.assertEqual(kernel["key"], f"firecracker/kernel/vmlinux-{kernel['version']}-{kernel['sha256'][:16]}")
        fc = PINS["firecracker"]
        self.assertRegex(fc["version"], r"^v\d+\.\d+\.\d+$")
        self.assertEqual(fc["key"], f"firecracker/release/firecracker-{fc['version']}-x86_64.tgz")


class PinsAgreeTest(unittest.TestCase):
    def test_release_json_matches_pins(self):
        fc = PINS["firecracker"]
        self.assertEqual(RELEASE["version"], fc["version"])
        self.assertEqual(RELEASE["sha256"], fc["sha256"])
        self.assertEqual(RELEASE["binaries"]["firecracker"]["sha256"], fc["firecrackerSha256"])
        self.assertEqual(RELEASE["binaries"]["jailer"]["sha256"], fc["jailerSha256"])

    def test_release_json_paths_and_url(self):
        version = RELEASE["version"]
        self.assertEqual(
            RELEASE["url"],
            f"https://github.com/firecracker-microvm/firecracker/releases/download/{version}/firecracker-{version}-x86_64.tgz",
        )
        self.assertEqual(
            RELEASE["binaries"]["firecracker"]["path"], f"release-{version}-x86_64/firecracker-{version}-x86_64"
        )
        self.assertEqual(RELEASE["binaries"]["jailer"]["path"], f"release-{version}-x86_64/jailer-{version}-x86_64")

    def test_kernel_build_script_builds_the_pinned_version(self):
        self.assertEqual(build_pin("KERNEL_VERSION"), PINS["kernel"]["version"])
        self.assertEqual(build_pin("FIRECRACKER_TAG"), PINS["firecracker"]["version"])
        self.assertRegex(build_pin("KERNEL_SHA256"), HEX64)
        self.assertRegex(build_pin("BASE_CONFIG_SHA256"), HEX64)

    def test_committed_config_is_monolithic_and_has_vmgenid(self):
        config = (HERE / "kernel" / "config").read_text().splitlines()
        self.assertIn("# CONFIG_MODULES is not set", config)
        self.assertIn("CONFIG_VMGENID=y", config)
        self.assertIn("CONFIG_ACPI=y", config)
        self.assertFalse([line for line in config if line.endswith("=m")])


if __name__ == "__main__":
    unittest.main()
