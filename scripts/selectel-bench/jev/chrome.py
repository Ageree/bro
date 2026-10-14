"""A fresh Chrome per run (own profile, headed on Xvfb like the pool) and the end-state probe the tasks are judged by."""

import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request

import websocket

CDP = os.environ.get("CHROME_CDP", "http://127.0.0.1:9222")
PORT = CDP.rsplit(":", 1)[1]


def get(path, method="GET", timeout=5):
    return json.load(urllib.request.urlopen(urllib.request.Request(CDP + path, method=method), timeout=timeout))


class Chrome:
    def __enter__(self):
        self.profile = tempfile.mkdtemp(prefix="prof-")
        self.proc = subprocess.Popen(
            [os.environ.get("CHROME_BIN", "google-chrome"), *os.environ.get("CHROME_ARGS", "").split(), f"--user-data-dir={self.profile}", f"--remote-debugging-port={PORT}",
             "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
             "--password-store=basic", "--window-size=1366,900", "--lang=ru-RU", "--accept-lang=ru-RU,ru,en-US,en",
             "--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction",
             "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":99")})
        for _ in range(300):
            try:
                get("/json/version", timeout=1)
                return self
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("chrome did not start")

    def __exit__(self, *_):
        self.proc.terminate()
        try:
            self.proc.wait(10)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)


PROBE_JS = "({url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 30000)})"


def probe_pages():
    """Url, title and visible text of every page tab; a task is met if any tab satisfies its check."""
    pages = []
    for tab in get("/json"):
        if tab.get("type") != "page":
            continue
        try:
            ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
            ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": PROBE_JS, "returnByValue": True}}))
            while True:
                reply = json.loads(ws.recv())
                if reply.get("id") == 1:
                    break
            ws.close()
            pages.append(reply["result"]["result"]["value"])
        except Exception:
            pages.append({"url": tab.get("url"), "title": tab.get("title"), "text": ""})
    return pages
