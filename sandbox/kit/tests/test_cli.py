"""`brokit <group> <cmd>`: one JSON line and an exit code the caller can act on."""

import contextlib
import io
import json
import unittest
from unittest import mock

from brokit import cli
from brokit.util import KitError


def many(argv):
    return {"items": list(range(250))}


def refuse(argv):
    raise KitError("encrypted", "the file is protected by a password", "brokit pdf decrypt")


def crash(argv):
    raise ValueError("a bug")


COMMANDS = {
    ("test", "many"): ("tests.test_cli", "many", "test many"),
    ("test", "refuse"): ("tests.test_cli", "refuse", "test refuse"),
    ("test", "crash"): ("tests.test_cli", "crash", "test crash"),
}


def run(argv):
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.dict(cli.COMMANDS, COMMANDS), mock.patch.object(cli, "GROUPS", cli.GROUPS + ["test"]):
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = cli.main(argv)
    lines = stdout.getvalue().splitlines()
    return code, lines, stderr.getvalue()


class Cli(unittest.TestCase):
    def test_success_is_one_line_with_long_lists_cut(self):
        code, lines, _ = run(["test", "many"])
        self.assertEqual(code, 0)
        self.assertEqual(len(lines), 1)
        payload = json.loads(lines[0])
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["items"]), 201)
        self.assertEqual(payload["items"][-1], {"more": 50})

    def test_a_refusal_exits_2_with_its_code_and_hint(self):
        code, lines, stderr = run(["test", "refuse"])
        self.assertEqual(code, 2)
        self.assertEqual(len(lines), 1)
        self.assertEqual(
            json.loads(lines[0]),
            {"ok": False, "code": "encrypted", "error": "the file is protected by a password", "hint": "brokit pdf decrypt"},
        )
        self.assertIn("brokit: the file is protected", stderr)

    def test_a_bug_exits_1_and_still_prints_one_line(self):
        code, lines, _ = run(["test", "crash"])
        self.assertEqual(code, 1)
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["code"], "bug")

    def test_unknown_commands_and_bad_flags_are_refusals(self):
        code, lines, _ = run(["pdf", "frobnicate"])
        self.assertEqual((code, json.loads(lines[0])["code"]), (2, "unknown_command"))
        code, lines, _ = run(["look", "--grid"])
        self.assertEqual((code, json.loads(lines[0])["code"]), (2, "bad_args"))


if __name__ == "__main__":
    unittest.main()
