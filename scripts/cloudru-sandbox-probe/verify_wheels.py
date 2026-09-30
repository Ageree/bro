"""Check wheels a probe VM took from a PyPI mirror against PyPI's own sha256 (the session reaches pypi.org), and
write the hash-pinned requirements the rootfs build installs them with.

  python console.py run NAME 'cat /srv/bro/wheels.sha256' > wheels.sha256
  python verify_wheels.py wheels.sha256 requirements.txt   exit 1 unless every wheel's digest is PyPI's
  python console.py push NAME requirements.txt /srv/bro/wheels/requirements.txt

The requirements pin every wheel (all dependencies too) with PyPI's digest, not the mirror's: `wheels.sh
install` runs `pip install --no-index --require-hashes -r` on them, so a wheel the mirror or the way from it
changed fails the build, and without the file the build does not start.
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


def requirement(filename, digest):
    name, version = filename.split("-")[:2]
    return f"{re.sub(r'[-_.]+', '-', name).lower()}=={version} --hash=sha256:{digest}"


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    bad = 0
    lines = [line.split() for line in open(sys.argv[1]) if re.match(r"^[0-9a-f]{64}\s", line)]
    pinned = []
    for digest, path in lines:
        filename = path.rsplit("/", 1)[-1]
        official = pypi_digest(filename)
        if official != digest:
            bad += 1
            print("MISMATCH" if official else "NOT ON PYPI", filename)
        else:
            pinned.append(requirement(filename, official))
    print(f"{len(lines) - bad} of {len(lines)} wheels match PyPI")
    if bad or not lines:
        sys.exit(1)
    with open(sys.argv[2], "w") as output:
        output.write("".join(f"{line}\n" for line in sorted(pinned)))
    print(f"{len(pinned)} pins written to {sys.argv[2]}")


if __name__ == "__main__":
    main()
