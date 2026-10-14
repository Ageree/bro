"""One browser-use 0.13.10 run with the Bro worker's settings (bu_bench.py of this directory's parent), judged by the same end-state check.

    python run_bu.py ARM TASK REP OUT.jsonl      ARM: bu_dst_flash (pilot prod: Together, flash) | bu_ds_full (prod: DeepInfra, full)
"""

import asyncio
import json
import os
import sys
import time

import httpx
from browser_use import Agent, BrowserSession, ChatOpenRouter

from chrome import CDP, Chrome, probe_pages
from tasks import TASKS

arm, task_id, rep, out = sys.argv[1:5]
KEY = open("/etc/bench/routerai").read().strip()
EXTEND_SYSTEM = open("/opt/bench/extend_system.txt").read().strip()
DS = {"reasoning": {"enabled": False}, "provider": {"order": ["deepinfra"], "require_parameters": True}}
DST = {"reasoning": {"enabled": False}, "provider": {"order": ["together"], "allow_fallbacks": False}}
CONFIGS = {"bu_ds_full": (DS, False), "bu_dst_flash": (DST, True)}
body, flash = CONFIGS[arm]
DEADLINE_S = float(os.environ.get("RUN_DEADLINE_S", "150"))
url, goal, check = TASKS[task_id][0], TASKS[task_id][1], TASKS[task_id][2]
TASK = f"{goal}\nSite: {url}\n\nStop as soon as the goal is visibly achieved on screen. End your final answer with RESULT: found, not_found or blocked."


class Meter:
    def __init__(self):
        self.calls = []

    async def on_request(self, request):
        request.extensions["t0"] = time.monotonic()

    async def on_response(self, response):
        if not response.request.url.path.endswith("/chat/completions"):
            return
        try:
            await response.aread()
            a = response.json()
        except Exception:
            a = {}
        u = a.get("usage") or {}
        self.calls.append({"t0": response.request.extensions.get("t0"), "t1": time.monotonic(), "status": response.status_code,
                           "host": a.get("provider"), "in": u.get("prompt_tokens"), "out": u.get("completion_tokens"), "cost": u.get("cost")})


async def run(rec):
    meter = Meter()
    http = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10), event_hooks={"request": [meter.on_request], "response": [meter.on_response]})
    llm = ChatOpenRouter(model="deepseek/deepseek-v4.1-flash", base_url="https://routerai.ru/api/v1", api_key=KEY, http_client=http,
                         extra_body={"extra_body": body})
    browser = BrowserSession(cdp_url=CDP, keep_alive=True)
    t0 = time.monotonic()
    await browser.start()
    agent = Agent(task=TASK, llm=llm, browser_session=browser, use_vision=False, calculate_cost=False, use_judge=False,
                  extend_system_message=EXTEND_SYSTEM, max_failures=4, enable_signal_handler=False, max_actions_per_step=8,
                  flash_mode=flash, file_system_path=f"/home/bench/agent-files/{task_id}-{arm}-{rep}")
    try:
        hist = await asyncio.wait_for(agent.run(max_steps=25), timeout=DEADLINE_S)
        rec["own_success"] = hist.is_successful()
        rec["steps"] = hist.number_of_steps()
    except Exception as e:
        rec["err"] = f"{type(e).__name__}: {str(e)[:300]}"
    rec["wall_s"] = round(time.monotonic() - t0, 2)
    rec["probe_pages"] = probe_pages()
    try:
        await browser.stop()
    except Exception:
        pass
    await http.aclose()
    calls = [c for c in meter.calls if c["t0"]]
    rec.update(llm_calls=len(calls), llm_s=round(sum(c["t1"] - c["t0"] for c in calls), 1), cost_rub=round(sum(c["cost"] or 0 for c in meter.calls), 3),
               tokens_in=sum(c["in"] or 0 for c in meter.calls), tokens_out=sum(c["out"] or 0 for c in meter.calls),
               per_call_s=[round(c["t1"] - c["t0"], 2) for c in calls], hosts=sorted({c["host"] for c in meter.calls if c["host"]}))


rec = {"arm": arm, "task": task_id, "rep": int(rep), "err": None, "steps": 0}
with Chrome():
    asyncio.run(run(rec))
pages = rec.pop("probe_pages", [])
rec["success"] = any(check(p) for p in pages)
rec["urls"] = [p["url"][:160] for p in pages]
if not rec["success"] and pages:
    rec["end_text"] = pages[-1]["text"][:300]
with open(out, "a") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
print(f"BENCH {arm} {task_id}#{rep} ok={rec['success']} wall={rec.get('wall_s')} steps={rec['steps']} llm={rec.get('llm_s')}s cost={rec.get('cost_rub')} err={rec['err']}", flush=True)
