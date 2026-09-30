"""Driver on the probe host: talks to the worker of one sandbox the way Bro does (signed tokens, the same API),
runs the errand set, checks sites and the parked form, samples the sandbox's memory.

  python3 bench.py health ID IDX
  python3 bench.py wait ID IDX                     seconds until the worker answers with Chrome up
  python3 bench.py session ID IDX                  the stand's proxy (10.200.IDX.1:3130) as the "residential" one
  python3 bench.py errands ID IDX LABEL [NAMES]    the RU set (ERRANDS below) → /root/results/LABEL/
  python3 bench.py sites ID IDX LABEL              WB and Avito search pages: title, text, screenshot
  python3 bench.py form ID IDX                     a form page with a typed value, cookie and localStorage markers
  python3 bench.py check ID IDX                    after a restore: the same tab and value, markers, clock, new tab
  python3 bench.py mem ID                          memory of the sandbox now

ID is the sandbox (/srv/sandboxes/ID/worker.json holds the stand's random worker key), IDX its network
(worker at 10.200.IDX.2:8080). The RouterAI key is read from /root/.routerai (600) and goes to the worker
in the run request, as Bro sends it. Needs python3-websocket.
"""

import base64
import contextlib
import hashlib
import hmac
import json
import os
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import websocket

MODEL = "deepseek/deepseek-v4.1-flash"
ROUTERAI = "https://routerai.ru/api/v1"
# A sign-in form to type into and never submit (httpbin.org did not answer from Cloud.ru).
FORM_URL = "https://passport.yandex.ru/auth"
FIELD = ("[...document.querySelectorAll('input')].find(e => ['text', 'tel', 'email'].includes(e.type) "
         "&& e.offsetParent !== null)")
TYPED = "probe-login-482913"
ERRANDS = {
    "rasp": "Открой https://rasp.yandex.ru и найди поезда из Москвы в Санкт-Петербург на 7 октября 2026 года. "
            "Назови первые три отправления: время и номер или название поезда.",
    # 2gis.ru and ru.wikipedia.org did not answer from Cloud.ru on 30.09.2026: Yandex Maps and Ruwiki instead.
    "barber": "Открой https://yandex.ru/maps/213/moscow/ и найди барбершопы рядом с метро Таганская. Назови три "
              "барбершопа и рейтинг каждого.",
    "flight": "Открой https://www.aviasales.ru и найди самый дешёвый рейс Москва — Казань в одну сторону на "
              "8 октября 2026 года. Назови цену и авиакомпанию.",
    "wiki": "Открой https://ru.ruwiki.ru и узнай из статьи «Казань», в каком году основан город. Ответь годом.",
    "gosuslugi": "Открой https://www.gosuslugi.ru и без входа в аккаунт найди страницу услуги «Замена паспорта "
                 "гражданина РФ». Верни адрес этой страницы.",
    "wb": "Открой https://www.wildberries.ru, найди «корм для кошек» и назови цены первых трёх товаров выдачи.",
    "avito": "Открой https://www.avito.ru/moskva и найди объявления «велосипед» в Москве. Назови цены первых "
             "трёх объявлений.",
}
RULES = ("\n\nНе входи ни в какие аккаунты, не вводи личных данных и ничего не отправляй и не заказывай. "
         "Если сайт не пускает (капча, «доступ ограничен»), так и ответь.")
SITES = {
    "wb": "https://www.wildberries.ru/catalog/0/search.aspx?search=%D0%BA%D0%BE%D1%80%D0%BC%20%D0%B4%D0%BB%D1%8F%20%D0%BA%D0%BE%D1%88%D0%B5%D0%BA",
    "avito": "https://www.avito.ru/moskva?q=%D0%B2%D0%B5%D0%BB%D0%BE%D1%81%D0%B8%D0%BF%D0%B5%D0%B4",
}


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class Worker:
    def __init__(self, sid, idx):
        config = json.loads(Path(f"/srv/sandboxes/{sid}/worker.json").read_text())
        self.env, self.key = config["environment"], bytes.fromhex(config["key"])
        self.base = f"http://10.200.{idx}.2:8080"
        self.sid, self.idx = sid, idx

    def token(self):
        payload = b64url(json.dumps({"env": self.env, "gen": 0, "exp": int(time.time()) + 600}).encode())
        signature = hmac.new(self.key, f"v1.{payload}".encode(), hashlib.sha256).digest()
        return f"v1.{payload}.{b64url(signature)}"

    def call(self, method, path, body=None, timeout=60, raw=False):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data, method=method, headers={
            "Authorization": "Bearer " + self.token(), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
                return response.status, payload if raw else json.loads(payload or b"null")
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode(errors="replace")[:500]

    # CDP through the worker (/v1/cdp/<token>/…), the path Bro's cdp.ts takes.
    def targets(self):
        return self.call("GET", f"/v1/cdp/{self.token()}/json")[1]

    def socket(self, url):
        # The worker writes wss://<host>/v1/cdp/… (Caddy's TLS on the VM); here it is plain HTTP.
        tail = url.split("/v1/cdp/", 1)[1]
        return websocket.create_connection(self.base.replace("http://", "ws://") + "/v1/cdp/" + tail, timeout=60)

    def cdp(self, url, method, params=None):
        ws = self.socket(url)
        try:
            ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
            while True:
                message = json.loads(ws.recv())
                if message.get("id") == 1:
                    if "error" in message:
                        raise RuntimeError(f"{method}: {message['error']}")
                    return message.get("result", {})
        finally:
            ws.close()

    def browser_url(self):
        return self.call("GET", f"/v1/cdp/{self.token()}/json/version")[1]["webSocketDebuggerUrl"]

    def open_tab(self, url):
        target = self.cdp(self.browser_url(), "Target.createTarget", {"url": url})["targetId"]
        return target

    def page_url(self, target):
        for t in self.targets():
            if t["id"] == target:
                return t["webSocketDebuggerUrl"]
        raise LookupError("tab is gone")

    def evaluate(self, target, expression):
        result = self.cdp(self.page_url(target), "Runtime.evaluate",
                          {"expression": expression, "returnByValue": True, "awaitPromise": True})
        return result.get("result", {}).get("value")

    def screenshot(self, target, path):
        shot = self.cdp(self.page_url(target), "Page.captureScreenshot", {"format": "jpeg", "quality": 60})
        Path(path).write_bytes(base64.b64decode(shot["data"]))


def cgroup(sid):
    for base in (Path(f"/sys/fs/cgroup/probe-{sid}"),):
        if base.exists():
            return base
    found = list(Path("/sys/fs/cgroup").rglob(f"probe-{sid}"))
    return found[0] if found else None


def mem(sid):
    """What the sandbox costs the host, three ways: `hostUsedMb` = MemTotal − MemAvailable of the host (the
    sandbox is the only tenant during a run: it counts gVisor's memory file, which is shmem and cannot be
    reclaimed, but not the rootfs page cache, which can); `cgroupMb` = memory.current of its cgroup (anon, shmem
    and the file cache it touched); `runscMb` = the sandbox's own accounting (`runsc events --stats`). Plus Σ PSS
    and RSS of its host processes."""
    info = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    host_used = (int(info["MemTotal"].split()[0]) - int(info["MemAvailable"].split()[0])) // 1024
    group = cgroup(sid)
    pids = set()
    current = None
    if group is not None:
        current = int((group / "memory.current").read_text()) // 2**20
        pids |= {int(p) for p in (group / "cgroup.procs").read_text().split()}
    runsc = None
    if not Path(f"/srv/sandboxes/{sid}/native.pid").exists():
        with contextlib.suppress(Exception):
            stats = subprocess.run(["runsc", "--root", "/run/runsc", "events", "--stats", sid], capture_output=True,
                                   text=True, timeout=10).stdout
            runsc = json.loads(stats)["data"]["memory"]["usage"]["usage"] // 2**20
    rss = pss = 0
    for pid in pids:
        try:
            rollup = dict(line.split(":", 1) for line in Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines()[1:])
            rss += int(rollup["Rss"].split()[0])
            pss += int(rollup["Pss"].split()[0])
        except (OSError, KeyError, ValueError):
            continue
    return {"hostUsedMb": host_used, "cgroupMb": current, "runscMb": runsc, "rssMb": rss // 1024,
            "pssMb": pss // 1024, "pids": len(pids)}


class Sampler(threading.Thread):
    def __init__(self, sid):
        super().__init__(daemon=True)
        self.sid, self.samples, self.stop = sid, [], threading.Event()

    def run(self):
        while not self.stop.is_set():
            self.samples.append(mem(self.sid))
            self.stop.wait(2)


def percentile(values, q):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    return values[min(len(values) - 1, int(round(q * (len(values) - 1))))]


def routerai_key():
    return "".join(Path("/root/.routerai").read_text().split()).strip("‘’“”'\"")


def credits():
    request = urllib.request.Request(ROUTERAI + "/credits", headers={"Authorization": "Bearer " + routerai_key()})
    for _ in range(3):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.loads(response.read())["data"]["credits"]
        except OSError:
            time.sleep(2)
    return None


def cmd_errands(worker, label, names=None):
    out = Path(f"/root/results/{label}")
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for name in (names.split(",") if names else ERRANDS):
        before = credits()
        run_id, session = f"{label}-{name}", f"s-{label}-{name}"
        sampler = Sampler(worker.sid)
        sampler.start()
        started = time.monotonic()
        code, answer = worker.call("POST", "/v1/runs", {
            "id": run_id, "sessionId": session, "task": ERRANDS[name] + RULES, "maxSteps": 25, "timeoutSeconds": 420,
            "vision": False, "llm": {"baseUrl": ROUTERAI, "apiKey": routerai_key(), "model": MODEL}})
        run = {"status": "failed", "error": f"start {code}: {answer}"}
        if code in (200, 202):
            while True:
                time.sleep(3)
                code, run = worker.call("GET", f"/v1/runs/{run_id}")
                if code == 200 and run["status"] in ("completed", "failed", "cancelled"):
                    break
        wall = round(time.monotonic() - started, 1)
        sampler.stop.set()
        sampler.join()
        code, shot = worker.call("GET", f"/v1/sessions/{session}/screenshot", raw=True)
        if code == 200:
            (out / f"{name}.jpg").write_bytes(shot)
        worker.call("POST", f"/v1/sessions/{session}/release")
        after = credits()
        host_mb = [s["hostUsedMb"] for s in sampler.samples]
        record = {"errand": name, "status": run.get("status"), "success": run.get("success"),
                  "wallS": wall, "steps": run.get("stepCount"), "finalUrl": run.get("finalUrl"),
                  "result": (run.get("result") or run.get("error") or "")[:600],
                  "costRub": round(before - after, 2) if before is not None and after is not None else None,
                  "usage": run.get("usage"),
                  "memMb": {"hostP50": percentile(host_mb, 0.5), "hostP95": percentile(host_mb, 0.95),
                            "hostMax": percentile(host_mb, 1.0),
                            "cgroupP50": percentile([s["cgroupMb"] for s in sampler.samples], 0.5),
                            "runscP50": percentile([s["runscMb"] for s in sampler.samples], 0.5),
                            "pssP50": percentile([s["pssMb"] for s in sampler.samples], 0.5)},
                  "samples": sampler.samples}
        results.append(record)
        (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
        print(json.dumps({k: v for k, v in record.items() if k not in ("samples", "usage")}, ensure_ascii=False),
              flush=True)
    samples = [s for r in results for s in r["samples"]]
    summary = {key: {"p50": percentile([s[key] for s in samples], 0.5), "p95": percentile([s[key] for s in samples], 0.95)}
               for key in ("hostUsedMb", "cgroupMb", "runscMb", "pssMb")}
    print(json.dumps({"label": label, "medianWallS": statistics.median(r["wallS"] for r in results), "mem": summary,
                      "costRub": round(sum(r["costRub"] or 0 for r in results), 2)}), flush=True)


def page_summary(worker, target):
    return worker.evaluate(target, "({url: location.href, title: document.title, "
                                   "text: (document.body ? document.body.innerText : '').slice(0, 400)})")


def cmd_sites(worker, label):
    out = Path(f"/root/results/{label}")
    out.mkdir(parents=True, exist_ok=True)
    for name, url in SITES.items():
        started = time.monotonic()
        target = worker.open_tab(url)
        time.sleep(25)
        try:
            summary = page_summary(worker, target)
            worker.screenshot(target, out / f"site-{name}.jpg")
        except Exception as error:
            summary = {"error": str(error)}
        worker.cdp(worker.browser_url(), "Target.closeTarget", {"targetId": target})
        print(json.dumps({"site": name, "s": round(time.monotonic() - started, 1), **(summary or {})},
                         ensure_ascii=False), flush=True)


def cmd_form(worker):
    target = worker.open_tab(FORM_URL)
    for _ in range(40):
        time.sleep(1)
        if worker.evaluate(target, f"!!({FIELD})"):
            break
    # The field is marked so the check after a restore reads the very element typed into.
    worker.evaluate(target, f"(() => {{ const e = {FIELD}; e.setAttribute('data-bro-probe', '1'); e.focus(); }})()")
    worker.cdp(worker.page_url(target), "Input.insertText", {"text": TYPED})
    marker = f"m{int(time.time())}"
    worker.evaluate(target, f"document.cookie = 'bro_marker={marker}; max-age=86400; path=/'; "
                            f"localStorage.setItem('bro_marker', '{marker}'); 1")
    state = worker.evaluate(target, "({value: document.querySelector('[data-bro-probe]').value, "
                                    "cookie: document.cookie, local: localStorage.getItem('bro_marker')})")
    print(json.dumps({"target": target, "marker": marker, **state}, ensure_ascii=False))


def cmd_check(worker):
    result = {}
    started = time.monotonic()
    while time.monotonic() - started < 60:
        try:
            code, health = worker.call("GET", "/v1/health", timeout=5)
            if code == 200:
                result["health"] = health
                result["healthAfterS"] = round(time.monotonic() - started, 2)
                break
        except OSError:
            pass
        time.sleep(0.2)
    tabs = [t for t in worker.targets() if t.get("type") == "page"]
    result["tabs"] = [t.get("url") for t in tabs]
    form = next((t for t in tabs if FORM_URL.split("/")[2] in t.get("url", "")), None)
    if form:
        result["form"] = worker.evaluate(form["id"], (
            "({value: document.querySelector('[data-bro-probe]').value, cookie: document.cookie, "
            "local: localStorage.getItem('bro_marker'), pageNow: Date.now()})"))
        result["clockSkewS"] = round(result["form"]["pageNow"] / 1000 - time.time(), 2)
    else:
        # A cold start (profile archive only): no page survives, but the site's cookie and storage should.
        target = worker.open_tab(FORM_URL)
        time.sleep(8)
        result["coldSite"] = worker.evaluate(target, "({cookie: document.cookie.includes('bro_marker=') ? "
                                                     "document.cookie.match(/bro_marker=[^;]*/)[0] : null, "
                                                     "local: localStorage.getItem('bro_marker'), pageNow: Date.now()})")
        result["clockSkewS"] = round(result["coldSite"]["pageNow"] / 1000 - time.time(), 2)
    started = time.monotonic()
    target = worker.open_tab("https://rasp.yandex.ru/")
    for _ in range(60):
        time.sleep(0.25)
        title = worker.evaluate(target, "document.readyState === 'complete' ? document.title : ''")
        if title:
            break
    result["newTab"] = {"title": title, "s": round(time.monotonic() - started, 2)}
    worker.cdp(worker.browser_url(), "Target.closeTarget", {"targetId": target})
    print(json.dumps(result, ensure_ascii=False))


def main():
    command, args = sys.argv[1], sys.argv[2:]
    if command == "mem":
        print(json.dumps(mem(args[0])))
        return
    worker = Worker(args[0], args[1])
    if command == "health":
        print(worker.call("GET", "/v1/health?machine=1"))
    elif command == "wait":
        # From now until the worker answers with Chrome up: the start of a sandbox as Bro would see it.
        started = time.monotonic()
        while time.monotonic() - started < 120:
            with contextlib.suppress(OSError):
                code, health = worker.call("GET", "/v1/health", timeout=3)
                if code == 200 and health.get("chrome"):
                    break
            time.sleep(0.2)
        print(json.dumps({"readyS": round(time.monotonic() - started, 2)}))
    elif command == "session":
        print(worker.call("POST", "/v1/session", {"proxy": {
            "host": f"10.200.{worker.idx}.1", "port": 3130, "username": "probe-{session}", "password": "none"}}))
    elif command == "errands":
        cmd_errands(worker, args[2], args[3] if len(args) > 3 else None)
    elif command == "sites":
        cmd_sites(worker, args[2])
    elif command == "form":
        cmd_form(worker)
    elif command == "check":
        cmd_check(worker)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
