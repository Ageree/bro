"""Selectel API access shared by the operator scripts here (stdlib only).

SELECTEL_TOKEN (the account's static API key; SELECTEL_API_KEY is taken too) and SELECTEL_PROJECT (project id)
come from the environment or from ~/.bro-selectel/api.env (KEY=value lines, 0600). The cloud, DBaaS and dedicated servers APIs take a
Keystone project token in X-Auth-Token, which the static key buys from api.selectel.ru/vpc/resell/v2/tokens;
it is cached for 6 hours in ~/.bro-selectel/ptoken.json (0600).
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

STATE = Path(os.environ.get("SELECTEL_STATE", Path.home() / ".bro-selectel"))


def setting(name, default=None):
    if os.environ.get(name):
        return os.environ[name].strip().strip("‘’“”'\"")
    path = STATE / "api.env"
    if path.exists():
        for line in path.read_text().splitlines():
            key, _, value = line.partition("=")
            if key.strip() == name:
                return value.strip()
    if default is not None:
        return default
    sys.exit(f"{name} is not set (env or {path})")


def request(method, url, headers, body=None, timeout=60):
    """(status, parsed JSON or text, headers). Only reads repeat after a network error: a POST whose answer
    was lost may have done its work."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data, {"Content-Type": "application/json", "Accept": "application/json",
                                             **headers}, method=method)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw.strip() else None, response.headers
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                return error.code, json.loads(raw), error.headers
            except ValueError:
                return error.code, raw[:500].decode(errors="replace"), error.headers
        except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
            if method not in ("GET", "HEAD") or attempt == 3:
                sys.exit(f"{method} {url}: {error}")
            time.sleep(2 ** attempt)


def api_key():
    """The account's static API key, under either name a session's environment may give it."""
    return setting("SELECTEL_TOKEN", "") or setting("SELECTEL_API_KEY")


def project_token():
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    cache = STATE / "ptoken.json"
    if not cache.exists() or time.time() - cache.stat().st_mtime > 6 * 3600:
        status, body, _ = request("POST", "https://api.selectel.ru/vpc/resell/v2/tokens",
                                  {"X-Token": api_key()},
                                  {"token": {"project_id": setting("SELECTEL_PROJECT")}})
        if status != 200:
            sys.exit(f"project token: {status} {body}")
        fd = os.open(cache, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump(body, file)
    return json.loads(cache.read_text())["token"]["id"]


def call(method, url, body=None, ok=(200, 201, 202, 204), extra_headers=None):
    """A project-token call that exits on any status outside `ok`."""
    status, answer, _ = request(method, url, {"X-Auth-Token": project_token(), **(extra_headers or {})}, body)
    if status not in ok:
        sys.exit(f"{method} {url.split('?')[0]}: {status} {json.dumps(answer, ensure_ascii=False)[:500]}")
    return answer
