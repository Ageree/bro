"""Operator tool for the Yandex API discovery: drives one tab of the owner's pool browser over CDP.

The browser is signed in to Yandex (the owner's account). Each command opens its own keep-alive tab
(`POST /v1/tabs`), connects to it with a token scoped to that tab (`b:<target>`), and closes it at the end.
Nothing here reads cookies: requests are made from the page itself, so they carry the browser's cookies,
the page's CSRF tokens and the sandbox's exit address.

Needs the operator state (`host.py state restore`, see .claude/plan/yandex-api/PROTOCOL.md) for
BROWSER_VM_SIGNING_KEY, and `pip install websockets` in a venv. Output with the owner's data goes to a
directory you pass (keep it in the scratchpad, never in the repository).

  python -I cdp.py check  --url https://market.yandex.ru/
  python -I cdp.py record --url https://market.yandex.ru/my/orders --seconds 15 --out DIR [--js FILE]
  python -I cdp.py eval   --url https://market.yandex.ru/ --js FILE      # prints the JSON the script returns

`record` writes DIR/<n>.json per XHR/fetch/document response (method, url, request headers without
cookies, post data, status, response headers without set-cookie, body up to 2 MB) and DIR/index.jsonl.
`--js` runs after the page loaded (e.g. clicks, scrolls) while recording. `eval` runs an async JS
expression body (`return await fetch(...).then(r => r.json())`) in the page and prints its value.
"""
import argparse, asyncio, base64, hashlib, hmac, json, os, ssl, sys, time, urllib.request
from pathlib import Path

WS = os.environ.get("BRO_WORKSPACE", "personal:85be64ec145182e956a9e9d7b7a6d568")
HOST = os.environ.get("BRO_POOL_HOST", "94-26-248-148.sslip.io")
SANDBOX = "ws-" + hashlib.sha256(WS.encode()).hexdigest()[:40]  # browserSandboxId, agent/lib/browser-pool/keys.ts
BASE = f"https://{HOST}/g/{SANDBOX}"
STATE = Path(os.environ.get("BRO_APP_HOST_DIR", Path.home() / ".bro-app-host-selectel"))
CA = "/root/.ccr/ca-bundle.crt"
CTX = ssl.create_default_context(cafile=CA) if os.path.exists(CA) else ssl.create_default_context()
DROP_HEADERS = {"cookie", "set-cookie", "authorization", "x-csrf-token", "x-yandex-csrf-token"}


def key():
    secrets = json.loads((STATE / "env" / "new-secrets.json").read_text())
    return hmac.new(bytes.fromhex(secrets["BROWSER_VM_SIGNING_KEY"]), f"bro-browser-vm:{WS}".encode(),
                    hashlib.sha256).digest()


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def token(gen, ses=None, ttl=300):
    """signBrowserVmToken (agent/lib/browser-vm/token.ts): key order and compact JSON are signed bytes."""
    claims = {"env": WS, "gen": gen, "exp": int(time.time()) + ttl}
    if ses:
        claims["ses"] = ses
    signed = "v1." + b64(json.dumps(claims, separators=(",", ":")).encode())
    return signed + "." + b64(hmac.new(key(), signed.encode(), hashlib.sha256).digest())


def http(method, path, tok=None, body=None):
    headers = {"content-type": "application/json"}
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    request = urllib.request.Request(BASE + path, method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(request, timeout=30, context=CTX) as response:
        return json.loads(response.read() or b"{}")


def health():
    try:
        return http("GET", "/v1/health")
    except Exception as error:  # noqa: BLE001
        sys.exit(f"the sandbox does not answer ({error}); it may be parked: ask the coordinator to wake it")


def clean(headers):
    return {k: v for k, v in (headers or {}).items() if k.lower() not in DROP_HEADERS}


class Tab:
    def __init__(self):
        self.gen = health()["generation"]
        self.target = None
        self.ws = None
        self.n = 0
        self.pending = {}
        self.events = asyncio.Queue()

    async def __aenter__(self):
        import websockets
        self.target = http("POST", "/v1/tabs", token(self.gen))["targetId"]
        url = BASE.replace("https:", "wss:") + f"/v1/cdp/{token(self.gen, 'b:' + self.target)}/devtools/page/{self.target}"
        self.ws = await websockets.connect(url, max_size=64 << 20, ssl=CTX, proxy=os.environ.get("HTTPS_PROXY") or True)
        self.reader = asyncio.create_task(self.read())
        return self

    async def __aexit__(self, *exc):
        self.reader.cancel()
        if self.ws:
            await self.ws.close()
        if self.target:
            try:
                http("DELETE", f"/v1/tabs/{self.target}", token(self.gen))
            except Exception as error:  # noqa: BLE001
                print(f"could not close tab {self.target}: {error}", file=sys.stderr)

    async def read(self):
        async for raw in self.ws:
            message = json.loads(raw)
            if "id" in message and message["id"] in self.pending:
                self.pending.pop(message["id"]).set_result(message)
            elif "method" in message:
                await self.events.put(message)

    async def call(self, method, **params):
        self.n += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.n] = future
        await self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        message = await asyncio.wait_for(future, 60)
        if "error" in message:
            raise RuntimeError(f"{method}: {message['error']}")
        return message.get("result", {})

    async def goto(self, url, settle=3.0):
        await self.call("Page.enable")
        await self.call("Page.navigate", url=url)
        await asyncio.sleep(settle)

    async def evaluate(self, body):
        result = await self.call("Runtime.evaluate", expression=f"(async () => {{ {body} }})()",
                                 awaitPromise=True, returnByValue=True, timeout=55000)
        if "exceptionDetails" in result:
            raise RuntimeError(json.dumps(result["exceptionDetails"], ensure_ascii=False)[:2000])
        return result["result"].get("value")


async def check(args):
    async with Tab() as tab:
        started = time.monotonic()
        await tab.goto(args.url)
        value = await tab.evaluate("""return {host: location.host, path: location.pathname,
          signedIn: /(^|; )yandex_login=[^;]+/.test(document.cookie)}""")
        print(json.dumps({"ms": round((time.monotonic() - started) * 1000), **value}))


async def evaluate(args):
    async with Tab() as tab:
        await tab.goto(args.url)
        started = time.monotonic()
        value = await tab.evaluate(Path(args.js).read_text())
        print(json.dumps({"ms": round((time.monotonic() - started) * 1000), "value": value}, ensure_ascii=False))


async def record(args):
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    async with Tab() as tab:
        await tab.call("Network.enable", maxPostDataSize=1 << 20)
        seen, kept = {}, 0
        index = (out / "index.jsonl").open("a")

        async def drain(until):
            nonlocal kept
            while (left := until - time.monotonic()) > 0:
                try:
                    event = await asyncio.wait_for(tab.events.get(), left)
                except asyncio.TimeoutError:
                    return
                method, params = event["method"], event.get("params", {})
                if method == "Network.requestWillBeSent":
                    request = params["request"]
                    seen[params["requestId"]] = {"type": params.get("type"), "method": request["method"],
                                                 "url": request["url"], "requestHeaders": clean(request.get("headers")),
                                                 "postData": request.get("postData")}
                elif method == "Network.responseReceived" and params["requestId"] in seen:
                    seen[params["requestId"]].update(status=params["response"]["status"],
                                                     mimeType=params["response"].get("mimeType"),
                                                     responseHeaders=clean(params["response"].get("headers")))
                elif method == "Network.loadingFinished" and params["requestId"] in seen:
                    entry = seen.pop(params["requestId"])
                    if entry.get("type") not in ("XHR", "Fetch", "Document"):
                        continue
                    try:
                        body = await tab.call("Network.getResponseBody", requestId=params["requestId"])
                        text = body.get("body", "")
                        entry["body"] = text[:2_000_000] if not body.get("base64Encoded") else "<base64 omitted>"
                    except Exception as error:  # noqa: BLE001
                        entry["body"] = f"<unavailable: {error}>"
                    kept += 1
                    (out / f"{kept:04d}.json").write_text(json.dumps(entry, ensure_ascii=False, indent=1))
                    index.write(json.dumps({"n": kept, "method": entry["method"], "status": entry.get("status"),
                                            "url": entry["url"][:300]}, ensure_ascii=False) + "\n")
                    index.flush()

        await tab.call("Page.enable")
        await tab.call("Page.navigate", url=args.url)
        await drain(time.monotonic() + 4)
        if args.js:
            asyncio.create_task(tab.evaluate(Path(args.js).read_text()))
        await drain(time.monotonic() + args.seconds)
        print(f"{kept} responses in {out}")


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("check", "eval", "record"):
        command = commands.add_parser(name)
        command.add_argument("--url", required=True)
        if name != "check":
            command.add_argument("--js", required=name == "eval")
        if name == "record":
            command.add_argument("--seconds", type=float, default=10)
            command.add_argument("--out", required=True)
    args = parser.parse_args()
    asyncio.run({"check": check, "eval": evaluate, "record": record}[args.command](args))


if __name__ == "__main__":
    main()
