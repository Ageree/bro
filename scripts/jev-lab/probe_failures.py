"""Count requests Chrome could not load on a page (proxy rejections, ORB) — to tell lab breakage from jev failures."""
import asyncio, json, sys, urllib.request
import websockets

PORT = int(sys.argv[1]); URLS = sys.argv[2:]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

async def probe(url):
    target = json.loads(opener.open(urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?about:blank", method="PUT")).read())
    async with websockets.connect(target["webSocketDebuggerUrl"], max_size=None) as ws:
        n = 0
        async def send(method, **params):
            nonlocal n; n += 1
            await ws.send(json.dumps({"id": n, "method": method, "params": params}))
        await send("Network.enable"); await send("Page.navigate", url=url)
        failed, scripts = [], 0
        loop = asyncio.get_event_loop(); end = loop.time() + 15
        while loop.time() < end:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=end - loop.time()))
            except asyncio.TimeoutError:
                break
            if msg.get("method") == "Network.loadingFailed":
                p = msg["params"]
                if p.get("errorText") != "net::ERR_ABORTED":
                    failed.append((p.get("type"), p.get("errorText"), p.get("blockedReason")))
            if msg.get("method") == "Network.requestWillBeSent" and msg["params"].get("type") == "Script":
                scripts += 1
    opener.open(f"http://127.0.0.1:{PORT}/json/close/{target['id']}")
    kinds = {}
    for t, e, b in failed:
        kinds[f"{t}:{e}:{b}"] = kinds.get(f"{t}:{e}:{b}", 0) + 1
    print(f"{url[:45]:47s} scripts={scripts:3d} failed={len(failed):3d} {dict(sorted(kinds.items(), key=lambda kv: -kv[1])[:4])}", flush=True)

async def main():
    for u in URLS:
        await probe(u)
asyncio.run(main())
