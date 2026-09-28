"""Steel browser sessions for the pilot: Steel Cloud (api.steel.dev) or self-hosted steel-browser (:3000).

  python steel_session.py create cloud|local [--proxy-index N]   → JSON {id, cdp_url, viewer}
  python steel_session.py release cloud|local ID

--captcha turns on Steel's captcha solving and --stealth its fingerprint masking (owner's decision
28.09.2026: Bro handles captchas itself, the person never does).
"""

import argparse
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

API = {"cloud": "https://api.steel.dev/v1", "local": "http://127.0.0.1:3000/v1"}


def call(target, method, path, body=None):
    # Cloudflare in front of api.steel.dev answers the default Python-urllib agent with 403 (error 1010).
    headers = {"Content-Type": "application/json", "User-Agent": "bro-cloudru-pilot/1.0"}
    if target == "cloud":
        headers["steel-api-key"] = os.environ["STEEL_API_KEY"]
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(API[target] + path, data, headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Steel {method} {path}: HTTP {e.code} {e.read()[:500].decode(errors='replace')}")


parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["create", "release"])
parser.add_argument("target", choices=["cloud", "local"])
parser.add_argument("session_id", nargs="?")
parser.add_argument("--proxy-index", type=int, help="line of /etc/bro/proxies.txt to use as the session proxy")
parser.add_argument("--captcha", action="store_true")
parser.add_argument("--stealth", action="store_true")
args = parser.parse_args()

if args.action == "release":
    print(json.dumps(call(args.target, "POST", f"/sessions/{args.session_id}/release", {})))
else:
    # Captcha solving on Steel Cloud needs ≥ $10 of paid balance (403 otherwise); own proxy and stealth do not.
    body = {"blockAds": False, "solveCaptcha": args.captcha, "dimensions": {"width": 1366, "height": 900}}
    if args.stealth:
        body["stealthConfig"] = {"humanizeInteractions": True, "skipFingerprintInjection": False}
    if args.target == "cloud":
        body.update(useProxy=False, timeout=900000)
    if args.proxy_index is not None:
        lines = [x for x in Path("/etc/bro/proxies.txt").read_text().splitlines() if x.strip()]
        host, port, user, password = lines[args.proxy_index].split(":", 3)
        body["proxyUrl"] = f"http://{user}:{password}@{host}:{port}"
    session = call(args.target, "POST", "/sessions", body)
    cdp = session.get("websocketUrl") or ""
    if args.target == "cloud":
        cdp += ("&" if "?" in cdp else "?") + "apiKey=" + os.environ["STEEL_API_KEY"]
    print(json.dumps({"id": session["id"], "cdp_url": cdp, "viewer": session.get("sessionViewerUrl"),
                      "raw_keys": sorted(session)}))
