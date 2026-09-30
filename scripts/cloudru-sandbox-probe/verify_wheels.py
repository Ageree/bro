"""Check wheels a probe VM took from a PyPI mirror against PyPI's own sha256 (the session reaches pypi.org).

  python console.py run NAME 'cat /srv/bro/wheels.sha256' > wheels.sha256
  python verify_wheels.py wheels.sha256        exit 1 unless every wheel's digest is PyPI's
"""

import json
import re
import sys
import urllib.request


def pypi_digest(filename):
    name, version = filename.split("-")[:2]
    project = re.sub(r"[-_.]+", "-", name).lower()
    with urllib.request.urlopen(f"https://pypi.org/pypi/{project}/{version}/json", timeout=30) as response:
        release = json.load(response)
    return next((u["digests"]["sha256"] for u in release["urls"] if u["filename"] == filename), None)


def main():
    bad = 0
    lines = [line.split() for line in open(sys.argv[1]) if re.match(r"^[0-9a-f]{64}\s", line)]
    for digest, path in lines:
        filename = path.rsplit("/", 1)[-1]
        official = pypi_digest(filename)
        if official != digest:
            bad += 1
            print("MISMATCH" if official else "NOT ON PYPI", filename)
    print(f"{len(lines) - bad} of {len(lines)} wheels match PyPI")
    sys.exit(1 if bad or not lines else 0)


if __name__ == "__main__":
    main()
