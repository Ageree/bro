"""Direct-control probe: Browser Use state extraction without Agent.run(), as the main Bro would drive it."""

import argparse
import asyncio
import json
import os
import time

from browser_use import BrowserSession

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--repeat", type=int, default=3)
parser.add_argument("--screenshot")
parser.add_argument("--settle", type=float, default=5, help="seconds for interstitials (Gosuslugi) to pass")
args = parser.parse_args()


async def main():
    result = {"engine": "browser-use-direct", "url": args.url}
    session = BrowserSession(cdp_url=os.environ.get("BU_CDP_URL", "http://127.0.0.1:9222"), keep_alive=True)
    try:
        t = time.perf_counter()
        await session.start()
        result["connect_ms"] = round((time.perf_counter() - t) * 1000)
        t = time.perf_counter()
        await session.navigate_to(args.url)
        result["navigate_ms"] = round((time.perf_counter() - t) * 1000)
        await asyncio.sleep(args.settle)
        timings = []
        for _ in range(args.repeat):
            t = time.perf_counter()
            state = await session.get_browser_state_summary(include_screenshot=False)
            timings.append(round((time.perf_counter() - t) * 1000))
        result.update(
            status="ok",
            state_ms=timings,
            final_url=state.url,
            title=state.title,
            interactive_elements=len(state.dom_state.selector_map),
            llm_text_chars=len(state.dom_state.llm_representation()),
            llm_text_head=state.dom_state.llm_representation()[:1500],
        )
        if args.screenshot:
            await session.take_screenshot(path=args.screenshot, format="jpeg", quality=70)
    except Exception as e:  # report, never hide
        result.update(status="error", error=f"{type(e).__name__}: {e}"[:2000])
    finally:
        try:
            await session.stop()
        except Exception:
            pass
    print(json.dumps(result, ensure_ascii=False, default=str))


asyncio.run(main())
