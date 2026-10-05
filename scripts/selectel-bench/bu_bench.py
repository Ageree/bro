"""browser-use 0.13.10 errands with the Bro worker's settings: per-step LLM vs browser time, per model/host."""
import asyncio, json, os, sys, time, urllib.request
import httpx
from browser_use import Agent, BrowserSession, ChatOpenRouter

KEY = open("/etc/bench/routerai").read().strip()
OUT = "/var/www/bench/bu.jsonl"
CDP = "http://127.0.0.1:9222"
BUDGET_RUB = float(os.environ.get("BENCH_BUDGET_RUB", "70"))
EXTEND_SYSTEM = open("/opt/bench/extend_system.txt").read().strip()
DS = {"reasoning": {"enabled": False}, "provider": {"order": ["deepinfra"], "require_parameters": True}}
DST = {"reasoning": {"enabled": False}, "provider": {"order": ["together"], "allow_fallbacks": False}}
CONFIGS = {
    "ds_full": {"model": "deepseek/deepseek-v4.1-flash", "body": DS, "flash": False},
    "ds_flash": {"model": "deepseek/deepseek-v4.1-flash", "body": DS, "flash": True},
    "dst_full": {"model": "deepseek/deepseek-v4.1-flash", "body": DST, "flash": False},
    "dst_flash": {"model": "deepseek/deepseek-v4.1-flash", "body": DST, "flash": True},
    "luna": {"model": "openai/gpt-6-luna", "body": {"reasoning": {"effort": "low"}}, "flash": False},
    "gem36": {"model": "google/gemini-3.6-flash", "body": {"reasoning": {"effort": "low"}}, "flash": False},
    # browser-use waits 90 s (DeepSeek) or 75 s for a stuck call; the usual answer comes in 2–7 s.
    "dst_t20": {"model": "deepseek/deepseek-v4.1-flash", "body": DST, "flash": False, "llm_timeout": 20},
    "ds_t25": {"model": "deepseek/deepseek-v4.1-flash", "body": DS, "flash": False, "llm_timeout": 25},
}
FOOTER = ("\n\nTime budget: search for about 15 minutes at most, then report what you have. Do not sign in, do not add anything "
          "to a basket, submit nothing. End your final answer with labelled lines: RESULT: found, not_found or blocked; "
          "ITEMS: up to three options, each as name — price — link; LINKS: the pages you used.")
TASKS = {
    "market": "Найди на Яндекс Маркете три самых дешёвых предложения беспроводных наушников JBL Tune 520BT с доставкой в Москву: название, цена, ссылка.\nSite: https://market.yandex.ru",
    "wb": "Найди на Wildberries зарядное устройство Anker на 65 Вт: три варианта с ценой, рейтингом и ссылкой.\nSite: https://www.wildberries.ru",
    "avito": "Найди на Авито в Москве три объявления о продаже велосипеда Stels Navigator дешевле 15 000 ₽: цена, район, ссылка.\nSite: https://www.avito.ru/moskva",
    "rasp": "Когда ближайшие три электрички с Ярославского вокзала до Сергиева Посада после 18:00 сегодня? Время отправления и прибытия.\nSite: https://rasp.yandex.ru",
    "ozon": "Сколько стоит на Ozon Apple iPhone 15 128 ГБ чёрный? Найди три предложения с ценой и ссылкой.\nSite: https://www.ozon.ru",
}

def log(msg):
    line = f"BENCH {msg}"
    print(line, flush=True)
    with open("/var/www/bench/log.txt", "a") as f: f.write(line + "\n")

class Meter:
    def __init__(self): self.calls = []
    async def on_request(self, request):
        request.extensions["bench_t0"] = time.monotonic()
    async def on_response(self, response):
        if not response.request.url.path.endswith("/chat/completions"): return
        try:
            await response.aread(); a = response.json()
        except Exception: a = {}
        u = a.get("usage") or {}
        self.calls.append({"t0": response.request.extensions.get("bench_t0"), "t1": time.monotonic(), "status": response.status_code,
                           "host": a.get("provider"), "in": u.get("prompt_tokens"), "cached": (u.get("prompt_tokens_details") or {}).get("cached_tokens"),
                           "out": u.get("completion_tokens"), "cost": u.get("cost"), "err": (a.get("error") or {}).get("message") if isinstance(a.get("error"), dict) else a.get("error")})

def cdp_json(path, method="GET"):
    req = urllib.request.Request(CDP + path, method=method)
    return json.load(urllib.request.urlopen(req, timeout=5))

def fresh_tab():
    tab = cdp_json("/json/new?about:blank", "PUT")
    for t in cdp_json("/json"):
        if t["type"] == "page" and t["id"] != tab["id"]:
            try: urllib.request.urlopen(urllib.request.Request(f"{CDP}/json/close/{t['id']}", method="GET"), timeout=5)
            except Exception: pass
    return tab["id"]

async def one(task_id, cfg_id, spent):
    cfg = CONFIGS[cfg_id]; meter = Meter()
    http = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=10), event_hooks={"request": [meter.on_request], "response": [meter.on_response]})
    llm = ChatOpenRouter(model=cfg["model"], base_url="https://routerai.ru/api/v1", api_key=KEY, http_client=http, extra_body={"extra_body": cfg["body"]})
    tab = fresh_tab()
    t_run = time.monotonic()
    browser = BrowserSession(cdp_url=CDP, keep_alive=True)
    await browser.start()
    try:
        from browser_use.browser.events import SwitchTabEvent
        await browser.event_bus.dispatch(SwitchTabEvent(target_id=tab))
    except Exception: pass
    steps = []; cur = {}
    async def on_start(agent): cur.clear(); cur["t0"] = time.monotonic(); cur["n"] = agent.state.n_steps
    async def on_end(agent):
        t1 = time.monotonic(); t0 = cur.get("t0", t1)
        llm_s = sum(c["t1"] - c["t0"] for c in meter.calls if c["t0"] and c["t0"] >= t0 - 0.01 and c["t1"] <= t1 + 0.01)
        acts = []
        try:
            mo = agent.state.last_model_output
            acts = [list(a.model_dump(exclude_none=True).keys())[0] for a in (mo.action if mo else [])]
        except Exception: pass
        steps.append({"n": cur.get("n"), "step_s": round(t1 - t0, 2), "llm_s": round(llm_s, 2), "actions": acts})
    agent = Agent(task=TASKS[task_id] + FOOTER, llm=llm, browser_session=browser, use_vision=False, calculate_cost=False, use_judge=False,
                  extend_system_message=EXTEND_SYSTEM, max_failures=4, enable_signal_handler=False, max_actions_per_step=8,
                  flash_mode=cfg["flash"], **({"llm_timeout": cfg["llm_timeout"]} if "llm_timeout" in cfg else {}), file_system_path=f"/home/bench/agent-files/{task_id}-{cfg_id}")
    err = None; final = None; success = None
    try:
        hist = await asyncio.wait_for(agent.run(max_steps=25, on_step_start=on_start, on_step_end=on_end), timeout=420)
        final = hist.final_result(); success = hist.is_successful()
    except Exception as e:
        err = f"{type(e).__name__}: {str(e)[:300]}"
    wall = time.monotonic() - t_run
    try: url = await asyncio.wait_for(browser.get_current_page_url(), 3)
    except Exception: url = None
    try: await browser.stop()
    except Exception: pass
    await http.aclose()
    cost = sum(c["cost"] or 0 for c in meter.calls)
    llm_total = sum(c["t1"] - c["t0"] for c in meter.calls if c["t0"])
    rec = {"task": task_id, "cfg": cfg_id, "wall_s": round(wall, 1), "steps": len(steps), "llm_s": round(llm_total, 1),
           "non_llm_s": round(wall - llm_total, 1), "llm_calls": len(meter.calls), "cost_rub": round(cost, 3), "success": success,
           "final": (final or "")[-3000:], "url": url, "err": err, "hosts": sorted({c["host"] for c in meter.calls if c["host"]}),
           "tokens_in": sum(c["in"] or 0 for c in meter.calls), "tokens_cached": sum(c["cached"] or 0 for c in meter.calls),
           "tokens_out": sum(c["out"] or 0 for c in meter.calls), "call_errs": [c["err"] for c in meter.calls if c["err"]][:3],
           "per_call_s": [round(c["t1"] - c["t0"], 2) for c in meter.calls if c["t0"]], "step_detail": steps}
    with open(OUT, "a") as f: f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    log(f"bu task={task_id} cfg={cfg_id} wall={rec['wall_s']} steps={rec['steps']} llm={rec['llm_s']} nonllm={rec['non_llm_s']} cost={rec['cost_rub']} ok={success} err={err}")
    return cost

async def main():
    cfgs = sys.argv[1].split(","); tasks = sys.argv[2].split(",")
    spent = 0.0; by_cfg = {}
    for i, task in enumerate(tasks):
        order = cfgs[i % len(cfgs):] + cfgs[:i % len(cfgs)]
        for cfg in order:
            if spent > BUDGET_RUB or by_cfg.get(cfg, 0) > BUDGET_RUB / len(cfgs) * 1.5:
                log(f"bu skip task={task} cfg={cfg} spent={spent:.1f} cfg_spent={by_cfg.get(cfg, 0):.1f}"); continue
            try:
                c = await one(task, cfg, spent); spent += c; by_cfg[cfg] = by_cfg.get(cfg, 0) + c
            except Exception as e: log(f"bu crash task={task} cfg={cfg} {type(e).__name__}: {str(e)[:200]}")
    log(f"bu-done spent={spent:.2f}")

asyncio.run(main())
