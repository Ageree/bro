"""Summarize bu.jsonl from the bench VMs: per config and per task.

    python3 analyze.py hfl=<ip> prc10=<ip>
"""
import json, statistics as st, sys, urllib.request
rows = []
VMS = [arg.split("=", 1) for arg in sys.argv[1:]]
for label, ip in VMS:
    try:
        txt = urllib.request.urlopen(f"http://{ip}/bu.jsonl", timeout=10).read().decode()
        open(f"bu-{label}.jsonl", "w").write(txt)
    except Exception:
        try: txt = open(f"bu-{label}.jsonl").read()
        except Exception: txt = ""
    for line in txt.splitlines():
        r = json.loads(line); r["vm"] = label; rows.append(r)
def med(xs): xs = [x for x in xs if x is not None]; return round(st.median(xs), 2) if xs else None
def found(r): return bool(r.get("success")) or "RESULT: found" in (r.get("final") or "")
def hung(step): return not step["llm_s"] and step["step_s"] >= 30
print(f"{'vm':6} {'cfg':10} {'n':>2} {'wall_med':>8} {'steps':>5} {'llm_call':>8} {'llm_p90':>7} {'browser':>7} {'hangs':>5} {'found':>5} {'₽/run':>6} {'₽/step':>6}")
for vm in [label for label, _ in VMS]:
    for cfg in sorted({r["cfg"] for r in rows if r["vm"] == vm}):
        rs = [r for r in rows if r["vm"] == vm and r["cfg"] == cfg]
        calls = sorted(c for r in rs for c in r["per_call_s"])
        steps = [s for r in rs for s in r["step_detail"]]
        browser = [s["step_s"] - s["llm_s"] for s in steps if not hung(s)]
        p90 = calls[int(len(calls) * 0.9)] if calls else None
        cost_step = sum(r["cost_rub"] for r in rs) / max(1, sum(r["steps"] for r in rs))
        print(f"{vm:6} {cfg:10} {len(rs):>2} {med([r['wall_s'] for r in rs]):>8} {med([r['steps'] for r in rs]):>5} {med(calls):>8} {p90:>7} {med(browser):>7} "
              f"{sum(hung(s) for s in steps):>5} {sum(found(r) for r in rs):>2}/{len(rs):<2} {med([r['cost_rub'] for r in rs]):>6} {cost_step:>6.2f}")
print()
for r in rows:
    fin = (r.get("final") or "").replace("\n", " ")
    res = fin[fin.find("RESULT:"):][:28] if "RESULT:" in fin else fin[:28]
    hangs = sum(hung(s) for s in r["step_detail"])
    print(f"{r['vm']:6} {r['task']:7} {r['cfg']:10} wall={r['wall_s']:6} steps={r['steps']:3} llm={r['llm_s']:6} hangs={hangs} cost={r['cost_rub']:6} ok={r['success']} {res} {r['err'] or ''} {r.get('call_errs') or ''}"[:240])
