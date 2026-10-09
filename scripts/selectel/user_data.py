"""Turn cloud-config user data into a form Selectel's dedicated-server install passes through intact.

The servers API stores user data HTML-escaped (it answers `&quot;`, `&#x27;`, `&gt;` where the request had
`"`, `'`, `>`). A host booted with such text gets a broken boot script, so what goes to a dedicated server
carries none of those characters: every file of `write_files` goes base64 (`encoding: b64`), permissions
as plain octal numbers, and `runcmd` as argument lists of bare words.

  python user_data.py IN.yaml [--debug-token HEX] > OUT.yaml

--debug-token adds a read-only status page on :8099/<token>/ (stage, provision and cloud-init log tails,
failed units) until the host is ready, for a session that has no SSH to the server.
"""

import argparse
import base64
import re
import sys

import yaml

SAFE = re.compile(r"^[A-Za-z0-9 _./:=+\-\n#\[\],]*$")

BEACON = """#!/bin/bash
# Read-only provisioning status on :8099 under a secret path until the host is ready.
D=/run/bro-debug/{token}
mkdir -p "$D"
: > /run/bro-debug/index.html
cd /run/bro-debug
python3 -m http.server 8099 >/dev/null 2>&1 &
SERVER=$!
for i in $(seq 1 720); do
  {{ date -u; cat /srv/bro/stage 2>/dev/null; uname -r; ls -la /dev/kvm 2>&1; }} > "$D/stage.txt"
  tail -n 150 /var/log/bro-provision.log > "$D/provision.txt" 2>&1
  tail -n 150 /var/log/cloud-init-output.log > "$D/cloud-init.txt" 2>&1
  {{ systemctl --failed --no-pager; journalctl -u bro-hostd -u caddy -n 80 --no-pager; }} > "$D/units.txt" 2>&1
  if [ "$(cat /srv/bro/stage 2>/dev/null)" = ready ] && [ "$i" -gt 60 ]; then break; fi
  sleep 10
done
kill "$SERVER"
"""


def b64_files(config):
    files = []
    for item in config.get("write_files", []):
        content = item.get("content", "")
        perms = int(str(item.get("permissions", "0644")), 8)
        files.append({"path": item["path"], "permissions": perms, "encoding": "b64",
                      "content": base64.b64encode(content.encode()).decode()})
    return files


def render(files, runcmd):
    lines = ["#cloud-config", "write_files:"]
    for item in files:
        lines += [f"  - path: {item['path']}", f"    permissions: 0{item['permissions']:o}",
                  "    encoding: b64", f"    content: {item['content']}"]
    if runcmd:
        lines.append("runcmd:")
        lines += [f"  - [{', '.join(argv)}]" for argv in runcmd]
    text = "\n".join(lines) + "\n"
    if not SAFE.match(text):
        bad = sorted(set(re.sub(r"[A-Za-z0-9 _./:=+\-\n#\[\],]", "", text)))
        raise SystemExit(f"characters the API would escape: {bad}")
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("input")
    parser.add_argument("--debug-token")
    args = parser.parse_args()
    config = yaml.safe_load(open(args.input))
    files = b64_files(config)
    runcmd = []
    if args.debug_token:
        if not re.fullmatch(r"[0-9a-f]{16,64}", args.debug_token):
            raise SystemExit("the debug token is 16-64 lowercase hex characters")
        files.append({"path": "/usr/local/sbin/bro-debug-beacon", "permissions": 0o700,
                      "content": base64.b64encode(BEACON.format(token=args.debug_token).encode()).decode()})
        runcmd.append(["systemd-run", "--unit=bro-debug-beacon", "/usr/local/sbin/bro-debug-beacon"])
    sys.stdout.write(render(files, runcmd))


if __name__ == "__main__":
    main()
