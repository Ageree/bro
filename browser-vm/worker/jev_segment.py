"""One bounded jev-ultrafast segment for the worker's `jev-then-agent` engine; prints one JSON line.

jev drives its own tab, brought to the front so that popups finish their fade-in animations (Bro's patch;
JEV_BACKGROUND_TAB=1 would keep upstream's background tab). The tab is left open and its id printed, so the
browser-use agent continues on the very page jev stopped on (a half-filled form stays filled) instead of
starting over. Runs in jev-ultrafast's own venv (commit 1231850 + image/jev-ultrafast.patch) with BU_CDP_URL
pointing at the VM's Chrome.
"""

import argparse
import faulthandler
import json
import time

from jev_ultrafast import Agent

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--goal", required=True)
parser.add_argument("--deadline", type=int, default=60)
args = parser.parse_args()
faulthandler.dump_traceback_later(args.deadline, exit=True)

started = time.perf_counter()
result = {"engine": "jev"}
agent = None
try:
    agent = Agent(args.url, args.goal)
    state = agent.state
    for state in agent.run():
        if time.perf_counter() - started > args.deadline - 5:
            result["stopped"] = "deadline"
            break
    result.update(
        status=state["status"],
        final_url=state["page"]["url"],
        title=state["page"].get("title"),
        actions=[{k: h.get(k) for k in ("action", "kind", "latency_ms")} for h in state["history"]],
        decisions=len(state["decisions"]),
        text_calls=len(state["text_calls"]),
        usage=[d.get("usage") for d in state["decisions"]],
        visible_text=(state["page"].get("text") or "")[:3000],
    )
except Exception as error:  # report, never hide
    result.update(status="error", error=f"{type(error).__name__}: {error}"[:1000])
finally:
    if agent is not None:
        result["target"] = agent.browser.target
        agent.browser.target = None  # keep the tab for the agent that takes over
result["seconds"] = round(time.perf_counter() - started, 2)
print(json.dumps(result, ensure_ascii=False))
