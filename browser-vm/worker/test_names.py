"""Every name the worker's code uses is defined: a helper removed with others it sat among (26.10, worker
2026-10-26.5's site_search_results_only) failed only the path that called it, on the production browser, and no
other test went down that path. pyflakes reads the file without running it; CI installs it."""

import pathlib
import unittest

try:
    from pyflakes import api, reporter
except ImportError:  # a stand without it; CI has it
    api = None


class NamesTest(unittest.TestCase):
    def test_the_worker_uses_no_undefined_name(self):
        if api is None:
            self.skipTest("pyflakes is not installed")
        found = []

        class Collect(reporter.Reporter):
            def __init__(self):
                super().__init__(None, None)

            def flake(self, message):
                if "undefined name" in str(message):
                    found.append(str(message))

            def syntaxError(self, filename, msg, lineno, offset, text):
                found.append(f"{filename}:{lineno}: {msg}")

            def unexpectedError(self, filename, msg):
                found.append(f"{filename}: {msg}")

        source = pathlib.Path(__file__).with_name("worker.py")
        api.checkPath(str(source), Collect())
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
