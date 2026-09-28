"""Run one bounded jev-ultrafast segment and print a JSON summary."""

import argparse
import faulthandler
import json
import sys
import time

from jev_ultrafast import Agent

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--goal", required=True)
parser.add_argument("--screenshot")
parser.add_argument("--deadline", type=int, default=240)
args = parser.parse_args()
# A hung browser or model call dumps the stack and exits instead of stalling the suite.
faulthandler.dump_traceback_later(args.deadline, exit=True)

started = time.perf_counter()
result = {"engine": "jev", "url": args.url, "goal": args.goal}
try:
    with Agent(args.url, args.goal) as agent:
        opened_ms = round((time.perf_counter() - started) * 1000)
        state = None
        for state in agent.run():
            print(f"{state['elapsed_ms']:>6} ms {len(state['history'])} actions {state['status']}", file=sys.stderr)
        result.update(
            status=state["status"],
            open_ms=opened_ms,
            loop_ms=state["elapsed_ms"],
            final_url=state["page"]["url"],
            title=state["page"].get("title"),
            actions=[
                {k: h.get(k) for k in ("step", "choice", "action", "kind", "text", "latency_ms", "text_latency_ms")}
                for h in state["history"]
            ],
            decisions=len(state["decisions"]),
            text_calls=len(state["text_calls"]),
            usage=[d.get("usage") for d in state["decisions"]],
            visible_text=(state["page"].get("text") or "")[:3000],
        )
        if args.screenshot:
            import base64

            shot = agent.browser.call("Page.captureScreenshot", format="jpeg", quality=70)
            open(args.screenshot, "wb").write(base64.b64decode(shot["data"]))
except Exception as e:  # report, never hide
    result.update(status="error", error=f"{type(e).__name__}: {e}")
result["total_ms"] = round((time.perf_counter() - started) * 1000)
print(json.dumps(result, ensure_ascii=False))
