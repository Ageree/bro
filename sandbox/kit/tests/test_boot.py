"""The boot scripts that deliver and run the kit (sandbox/kit/boot, agent/lib/sandbox/kit.ts)."""

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The vector tests/agent/sandbox/kit.test.ts pins too: both sides hash the
# kit the same way, or a task sandbox would rewrite it on every message.
VECTOR = {"brokit/a.py": 'print("a")\n', "brokit/sub/b.py": "ПРИВЕТ = 1\n"}
VECTOR_VERSION = "134c8acff1cb4f27"


def boot(script, env, cwd=None):
    """A boot script run the way Bro runs it: the text in BROKIT_BOOT, `python3 -I -c`."""
    with open(os.path.join(KIT, "boot", script), encoding="utf-8") as handle:
        text = handle.read()
    environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "BROKIT_BOOT": text}
    environment.update(env)
    return subprocess.run(
        [sys.executable, "-I", "-c", "import os;exec(os.environ['BROKIT_BOOT'])"],
        env=environment,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=120,
    )


def package():
    """The kit's own files as Bro's manifest lists them, and their version."""
    root = os.path.join(KIT, "brokit")
    files = []
    for directory, subdirectories, names in os.walk(root):
        subdirectories[:] = [name for name in subdirectories if name != "__pycache__"]
        for name in names:
            if name.endswith(".py"):
                path = os.path.join(directory, name)
                with open(path, encoding="utf-8") as handle:
                    files.append(["brokit/" + os.path.relpath(path, root).replace(os.sep, "/"), handle.read()])
    files.sort()
    digest = hashlib.sha256()
    for relative, text in files:
        digest.update(relative.encode("utf-8") + b"\0" + text.encode("utf-8") + b"\0")
    return files, digest.hexdigest()[:16]


def last_json(output):
    return json.loads(output.strip().splitlines()[-1])


class Boot(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="brokit-boot-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.home = os.path.join(self.root, "bro")
        self.user = os.path.join(self.root, "user")
        os.makedirs(self.user)

    def lay_out(self, files, version):
        """A delivered kit as unpack.py leaves it."""
        for relative, text in files.items():
            path = os.path.join(self.home, "kit", *relative.split("/"))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text)
        with open(os.path.join(self.home, "kit", "VERSION"), "w", encoding="utf-8") as handle:
            handle.write(version + "\n")
        os.makedirs(os.path.join(self.home, "bin"))
        wrapper = os.path.join(self.home, "bin", "brokit")
        with open(wrapper, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\n")
        os.chmod(wrapper, 0o755)

    def check(self, expect, token=None):
        env = {"BROKIT_HOME": self.home, "BROKIT_EXPECT": expect, "HOME": self.user}
        if token:
            env["BROKIT_TOKEN"] = token
        result = boot("check.py", env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return last_json(result.stdout)["state"]

    def test_check_hashes_the_files_as_bro_does_and_sees_a_change(self):
        self.lay_out(VECTOR, VECTOR_VERSION)
        self.assertEqual(self.check(VECTOR_VERSION), "current")
        # VERSION still says the right thing: the files decide.
        with open(os.path.join(self.home, "kit", "brokit", "a.py"), "a", encoding="utf-8") as handle:
            handle.write("import os\n")
        self.assertEqual(self.check(VECTOR_VERSION), "stale")

    def test_check_sees_a_compiled_module_put_beside_the_sources(self):
        # Python imports a.cpython-….so before a.py: the sources hashing right is not enough.
        self.lay_out(VECTOR, VECTOR_VERSION)
        os.makedirs(os.path.join(self.home, "kit", "brokit", "__pycache__"))
        self.assertEqual(self.check(VECTOR_VERSION), "current")
        with open(os.path.join(self.home, "kit", "brokit", "a.cpython-310-x86_64-linux-gnu.so"), "wb") as handle:
            handle.write(b"\x7fELF")
        self.assertEqual(self.check(VECTOR_VERSION), "stale")

    def test_check_keeps_the_token_and_the_path_line_once(self):
        token = "0123456789abcdef0123456789abcdef"
        self.check(VECTOR_VERSION, token)
        self.check(VECTOR_VERSION, token)
        path = os.path.join(self.home, "mark-token")
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read().strip(), token)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        with open(os.path.join(self.user, ".bash_profile"), encoding="utf-8") as handle:
            lines = handle.read().splitlines()
        self.assertEqual(lines.count('export PATH="%s/bin:$PATH"' % self.home), 1)
        self.assertIn("[ -f ~/.profile ] && . ~/.profile", lines)

    def test_parallel_unpacks_leave_one_complete_kit(self):
        files, version = package()
        manifests = []
        for name in ("one", "two"):
            path = os.path.join(self.root, "kit-%s.json" % name)
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"version": version, "files": files}, handle)
            manifests.append(path)
        with open(os.path.join(KIT, "boot", "unpack.py"), encoding="utf-8") as handle:
            script = handle.read()
        runs = [
            subprocess.Popen(
                [sys.executable, "-I", "-c", "import os;exec(os.environ['BROKIT_BOOT'])"],
                env={
                    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                    "BROKIT_BOOT": script,
                    "BROKIT_HOME": self.home,
                    "BROKIT_EXPECT": version,
                    "BROKIT_MANIFEST": manifest,
                },
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for manifest in manifests
        ]
        states = []
        for run in runs:
            stdout, stderr = run.communicate(timeout=120)
            self.assertEqual(run.returncode, 0, stderr)
            states.append(last_json(stdout)["state"])
        self.assertIn("written", states)
        self.assertEqual(self.check(version), "current")
        self.assertEqual(sorted(os.listdir(self.home)), ["bin", "kit", "kit.lock"])
        for manifest in manifests:
            self.assertFalse(os.path.exists(manifest))
        wrapper = subprocess.run([os.path.join(self.home, "bin", "brokit"), "nothing"], capture_output=True, text=True, timeout=60)
        self.assertEqual(wrapper.returncode, 2)
        self.assertEqual(last_json(wrapper.stdout)["code"], "unknown_command")

    def test_unpack_refuses_a_manifest_that_does_not_hash_to_its_version(self):
        files, version = package()
        files[0][1] += "# changed\n"
        manifest = os.path.join(self.root, "kit-x.json")
        with open(manifest, "w", encoding="utf-8") as handle:
            json.dump({"version": version, "files": files}, handle)
        result = boot("unpack.py", {"BROKIT_HOME": self.home, "BROKIT_EXPECT": version, "BROKIT_MANIFEST": manifest})
        self.assertEqual(result.returncode, 1)
        self.assertFalse(os.path.exists(os.path.join(self.home, "kit")))

    def test_run_asks_for_delivery_while_the_kit_is_missing_or_another(self):
        args = json.dumps(["nothing"])
        result = boot("run.py", {"BROKIT_HOME": self.home, "BROKIT_EXPECT": "0" * 16, "BROKIT_ARGS": args})
        self.assertEqual(result.returncode, 3)
        files, version = package()
        self.lay_out(dict(files), version)
        result = boot("run.py", {"BROKIT_HOME": self.home, "BROKIT_EXPECT": "1" * 16, "BROKIT_ARGS": args})
        self.assertEqual(result.returncode, 3)
        result = boot("run.py", {"BROKIT_HOME": self.home, "BROKIT_EXPECT": version, "BROKIT_ARGS": args})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(last_json(result.stdout)["code"], "unknown_command")


class Fresh(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="bro-sign-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.files, self.version = package()

    def run_fresh(self, files, version, expect=None):
        with open(os.path.join(self.dir, "kit.json"), "w", encoding="utf-8") as handle:
            json.dump({"version": version, "files": files}, handle)
        return boot(
            "fresh.py",
            {"BROKIT_DIR": self.dir, "BROKIT_EXPECT": expect or version, "BROKIT_ARGS": json.dumps(["nothing", "here"])},
            cwd=self.dir,
        )

    def test_runs_a_command_from_the_copy_it_wrote(self):
        result = self.run_fresh(self.files, self.version)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(last_json(result.stdout)["code"], "unknown_command")
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "kit", "brokit", "cli.py")))

    def test_refuses_a_kit_directory_already_there(self):
        os.mkdir(os.path.join(self.dir, "kit"))
        result = self.run_fresh(self.files, self.version)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stdout, "")

    def test_refuses_a_manifest_other_than_expected(self):
        files = [list(entry) for entry in self.files]
        files[0][1] += "# changed\n"
        self.assertEqual(self.run_fresh(files, self.version).returncode, 3)
        self.assertEqual(self.run_fresh(self.files, self.version, expect="f" * 16).returncode, 3)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "kit")))


if __name__ == "__main__":
    unittest.main()
