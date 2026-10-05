import json, sys, time, subprocess, urllib.request, websocket, os
PROFILE = sys.argv[1]; LABEL = sys.argv[2]; URLS = sys.argv[3:]
def ready():
    try: return json.load(urllib.request.urlopen("http://127.0.0.1:9333/json/version", timeout=1))
    except Exception: return None
t0 = time.time()
p = subprocess.Popen(["google-chrome", f"--user-data-dir={PROFILE}", "--remote-debugging-port=9333", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--password-store=basic", "--window-size=1366,900",
    "--lang=ru-RU", "--accept-lang=ru-RU,ru,en-US,en", "--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=open(f"/tmp/chrome-{LABEL}.err", "w"), env={**os.environ, "DISPLAY": ":98"})
while not ready():
    if time.time() - t0 > 30 or p.poll() is not None:
        print(json.dumps({"label": LABEL, "error": "chrome not ready", "rc": p.poll()})); sys.exit(0)
    time.sleep(0.02)
t_cdp = time.time() - t0
tabs = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json", timeout=2))
page = [t for t in tabs if t["type"] == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
mid = [0]
def call(method, **params):
    mid[0] += 1; ws.send(json.dumps({"id": mid[0], "method": method, "params": params})); return mid[0]
call("Page.enable"); call("Network.enable")
res = {"label": LABEL, "cdp_ready_s": round(t_cdp, 3), "pages": []}
for url in URLS:
    t1 = time.time(); call("Page.navigate", url=url); dcl = load = None; reqs = 0; last_net = time.time(); inflight = set(); nbytes = 0
    deadline = t1 + 45
    while time.time() < deadline:
        ws.settimeout(max(0.05, deadline - time.time()))
        try: m = json.loads(ws.recv())
        except Exception: break
        meth = m.get("method")
        if meth == "Network.requestWillBeSent": reqs += 1; inflight.add(m["params"]["requestId"]); last_net = time.time()
        elif meth == "Network.loadingFinished": nbytes += m["params"].get("encodedDataLength", 0); inflight.discard(m["params"]["requestId"]); last_net = time.time()
        elif meth == "Network.loadingFailed": inflight.discard(m["params"]["requestId"]); last_net = time.time()
        elif meth == "Page.domContentEventFired" and dcl is None: dcl = time.time() - t1
        elif meth == "Page.loadEventFired" and load is None: load = time.time() - t1
        if load is not None and len(inflight) <= 2 and time.time() - last_net > 0.5: break
    idle = time.time() - t1
    res["pages"].append({"url": url, "dcl_s": dcl and round(dcl, 2), "load_s": load and round(load, 2), "idle_s": round(idle, 2), "requests": reqs, "kb": nbytes // 1024})
ws.close(); p.terminate()
try: p.wait(10)
except Exception: p.kill()
print(json.dumps(res, ensure_ascii=False))
