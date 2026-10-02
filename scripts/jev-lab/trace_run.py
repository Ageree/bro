"""One jev-ultrafast run with a full decision trace; prints one JSON line. Runs in jev's venv; PYTHONPATH picks
the jev checkout under test."""

import argparse
import base64
import faulthandler
import json
import sys
import time

import jev_ultrafast
from jev_ultrafast import Agent

parser = argparse.ArgumentParser()
parser.add_argument("--url", required=True)
parser.add_argument("--goal", required=True)
parser.add_argument("--deadline", type=int, default=120)
parser.add_argument("--shot")
args = parser.parse_args()
faulthandler.dump_traceback_later(args.deadline + 40, exit=True)  # hard stop only if the soft one fails


def decision_row(d):
    body = d.get("request") or {}
    questions = body.get("questions", {})
    head = (d.get("operation") or "").lower() + "_target"
    target = d.get("target")
    label = None
    if target and head in questions:
        label = questions[head]["criteria"].get(target, {}).get("element")
    return {
        "operation": d.get("operation"),
        "target": target,
        "label": label,
        "op_conf": round(d.get("confidence") or 0, 3),
        "target_conf": round(d["target_confidence"], 3) if d.get("target_confidence") is not None else None,
        "operations": list(questions.get("operation", {}).get("criteria", {})),
        "elements": len((body.get("state") or {}).get("elements", [])),
        "latency_ms": d.get("latency_ms"),
        "elapsed_ms": d.get("elapsed_ms"),
        **({"unapplied": len(body["state"]["unapplied_inputs"]["inputs"])}
           if (body.get("state") or {}).get("unapplied_inputs") else {}),
        **({"unapplied_recheck": d["unapplied_recheck"]} if d.get("unapplied_recheck") else {}),
    }


started = time.perf_counter()
result = {"url": args.url, "goal": args.goal, "jev": jev_ultrafast.__file__}
agent = None
try:
    with Agent(args.url, args.goal) as agent:
        result["open_ms"] = round((time.perf_counter() - started) * 1000)
        state = None
        for state in agent.run():
            if time.perf_counter() - started > args.deadline - 10:  # soft stop keeps the trace
                state = {**state, "status": "soft_deadline"}
                break
        result["status"] = state["status"]
        if args.shot:
            try:
                from browser_harness.helpers import cdp

                cdp("Target.activateTarget", targetId=agent.browser.target)
                shot = agent.browser.call("Page.captureScreenshot", format="jpeg", quality=60)
                open(args.shot, "wb").write(base64.b64decode(shot["data"]))
                result["shot"] = args.shot
            except Exception as error:  # a failed shot must not turn a finished run into an error
                result["shot_error"] = repr(error)
except Exception as error:  # report, never hide, with the steps made before the failure
    result.update(status="error", error=f"{type(error).__name__}: {error}")
live = agent.state if agent else None
if live:
    result.update(
        final_url=live["page"]["url"],
        title=live["page"].get("title"),
        loop_ms=live.get("elapsed_ms"),
        actions=[{k: h.get(k) for k in ("step", "operation", "action", "kind", "text", "page_changed", "url", "effect")
                  if k != "effect" or h.get(k)} | ({"tab": h["tab"]} if h.get("tab") else {})
                 for h in live["history"]],
        decisions=[decision_row(d) for d in live["decisions"]],
        text_calls=len(live["text_calls"]),
        visible_text=(live["page"].get("text") or "")[:4000],
        final_elements=[{k: a.get(k) for k in ("kind", "label", "role", "value", "current_value") if k in a}
                        for a in live["page"].get("actions", [])][:150],
    )
result["total_ms"] = round((time.perf_counter() - started) * 1000)
print(json.dumps(result, ensure_ascii=False))
sys.stdout.flush()
