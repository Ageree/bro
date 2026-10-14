"""`cdp(method, session_id=None, **params)` of browser-harness over one browser-level websocket to the
bench Chrome (CHROME_CDP, default http://127.0.0.1:9222). Events are dropped; replies are matched by id."""

import json
import os
import urllib.request

import websocket

_state = {"ws": None, "id": 0}


def _socket():
    if _state["ws"] is None:
        base = os.environ.get("CHROME_CDP", "http://127.0.0.1:9222")
        url = json.load(urllib.request.urlopen(base + "/json/version", timeout=5))["webSocketDebuggerUrl"]
        _state["ws"] = websocket.create_connection(url, timeout=60, suppress_origin=True)
    return _state["ws"]


def cdp(method, session_id=None, **params):
    ws = _socket()
    _state["id"] += 1
    mid = _state["id"]
    message = {"id": mid, "method": method, "params": params}
    if session_id:
        message["sessionId"] = session_id
    ws.send(json.dumps(message))
    while True:
        reply = json.loads(ws.recv())
        if reply.get("id") == mid:
            if "error" in reply:
                raise RuntimeError(f"CDP {method}: {reply['error']}")
            return reply.get("result", {})
