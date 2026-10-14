"""One jev-ultrafast run (its own agent loop, browser.py and snapshot.js unchanged; only the CDP transport is the shim).

    python run_jev.py ARM TASK REP OUT.jsonl      ARM: ju_113 | ju_114 | ju_114_img

ju_114_img adds the page screenshot to the `state` of every TypeSafe request (TypeSafe-Danger-Zone-Images). The text
helper is inception/mercury-2.5 on RouterAI, the model of the jev-ultrafast README.
"""

import json
import os
import sys
import time
import uuid

import httpx

from chrome import Chrome, probe_pages
from tasks import TASKS

arm, task_id, rep, out = sys.argv[1:5]
MODELS = {"ju_113": "jev-1.13.0", "ju_114": "jev-1.14.0", "ju_114_img": "jev-1.14.0"}
IMG = arm.endswith("_img")
os.environ["TYPESAFE_MODEL"] = MODELS[arm]
os.environ["TYPESAFE_API_KEY"] = open("/etc/bench/typesafe").read().strip()
os.environ["TEXT_MODEL_API_KEY"] = open("/etc/bench/routerai").read().strip()
os.environ["TEXT_MODEL_BASE_URL"] = "https://routerai.ru/api/v1"
os.environ["TEXT_MODEL"] = "inception/mercury-2.5"
os.environ["TEXT_MODEL_REASONING"] = "none"
DEADLINE_S = float(os.environ.get("RUN_DEADLINE_S", "150"))

import jev_ultrafast.agent as A  # noqa: E402
import jev_ultrafast.model as M  # noqa: E402

calls, shot = [], {}


def post_json(url, key, body):
    headers = {"Authorization": f"Bearer {key}"}
    if IMG and url.endswith("/systemone") and shot.get("data"):
        ref = str(uuid.uuid4())
        body["state"]["screenshot"] = ref
        body["assets"] = {ref: {"type": "image", "format": "jpg", "data_base64": shot["data"]}}
        headers["TypeSafe-Danger-Zone-Images"] = "true"
    for attempt in range(3):
        t0 = time.perf_counter()
        try:
            response = M.CLIENT.post(url, json=body, headers=headers)
        except httpx.HTTPError:
            raise RuntimeError("Model connection failed; no action executed.") from None
        calls.append({"kind": "jev" if url.endswith("/systemone") else "text", "ms": round((time.perf_counter() - t0) * 1000),
                      "status": response.status_code})
        if response.status_code in {429, 529, 503} and attempt < 2:
            time.sleep(0.5 * 2**attempt)
            continue
        if response.is_error:
            raise RuntimeError(f"Model provider returned HTTP {response.status_code}; no action executed. {response.text[:200]}")
        return response.json()
    raise RuntimeError("Model unavailable")


def choose(page, goal, history):
    shot["data"] = page.get("screenshot")
    return M.choose(page, goal, history)


M.post_json = post_json
A.choose = choose
if IMG:
    M.NEXT_ACTION += "\nA screenshot of the current page is attached as `screenshot`: use it to see the layout and what is selected, open or filled."

url, goal, check = TASKS[task_id][0], TASKS[task_id][1], TASKS[task_id][2]
rec = {"arm": arm, "task": task_id, "rep": int(rep), "err": None, "status": None, "steps": 0}
with Chrome():
    t_start = time.perf_counter()
    agent = None
    try:
        agent = A.Agent(url, goal, screenshots=IMG)
        rec["init_s"] = round(time.perf_counter() - t_start, 2)
        for state in agent.run():
            if time.perf_counter() - t_start > DEADLINE_S:
                rec["err"] = "deadline"
                break
        rec["status"] = agent.state["status"]
    except Exception as e:
        rec["err"] = f"{type(e).__name__}: {str(e)[:300]}"
    rec["wall_s"] = round(time.perf_counter() - t_start, 2)
    if agent:
        h = agent.state["history"]
        rec["steps"] = len(h)
        rec["per_step"] = [{"op": s["operation"], "act": s["action"][:60], "jev_ms": s["latency_ms"], "text_ms": s["text_latency_ms"],
                            "changed": s["page_changed"], "at_ms": s["executed_ms"]} for s in h]
        rec["decisions"] = len(agent.state["decisions"])
    time.sleep(0.5)
    pages = probe_pages()
    rec["success"] = any(check(p) for p in pages)
    rec["urls"] = [p["url"][:160] for p in pages]
    if not rec["success"] and pages:
        rec["end_text"] = pages[-1]["text"][:300]
jev = [c for c in calls if c["kind"] == "jev"]
text = [c for c in calls if c["kind"] == "text"]
rec.update(jev_calls=len(jev), jev_ms=sum(c["ms"] for c in jev), text_calls=len(text), text_ms=sum(c["ms"] for c in text),
           http_errors=[c["status"] for c in calls if c["status"] >= 400][:5])
rec["jev_ms_median"] = sorted(c["ms"] for c in jev)[len(jev) // 2] if jev else None
with open(out, "a") as f:
    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
print(f"BENCH {arm} {task_id}#{rep} ok={rec['success']} wall={rec['wall_s']} steps={rec['steps']} jev={rec['jev_ms']}ms text={rec['text_ms']}ms err={rec['err']}", flush=True)
