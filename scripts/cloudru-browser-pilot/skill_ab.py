"""A/B of a skill for Browser Use Agent on the VM's Chrome: each task runs without and with `--skill`.

  python skill_ab.py --python <venv with browser-use>/bin/python --skill SKILL.md --out results.json [--only a,b]

Runs are sequential (one Chrome); results.json is rewritten after every run. Success is judged later
from `final_result` against the page, not from the agent's own verdict.
"""

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
# Read-only list extraction: many items per page, the case the skill targets.
TASKS = {
    "hn": ("https://news.ycombinator.com/",
           "Collect rank, title and points of the first 90 stories on Hacker News (pages 1-3). "
           "Answer with a JSON array of {rank, title, points} and nothing else."),
    "github": ("https://github.com/trending",
               "List every repository on this page with owner/name, total stars and stars today. "
               "Answer with a JSON array of {repo, stars, stars_today} and nothing else."),
    "wiki": ("https://ru.wikipedia.org/wiki/Список_городов_России",
             "Найди в таблице все города с населением больше 500 000 человек. Ответь JSON-массивом "
             "{город, население}, отсортированным по убыванию населения, и больше ничего."),
    "rasp": ("https://rasp.yandex.ru/search/train/?fromId=c213&toId=c2&when=2026-11-20",
             "Выпиши все поезда из Москвы в Санкт-Петербург на 20 ноября 2026 года с этой страницы: номер, "
             "время отправления и прибытия. Ответь JSON-массивом {номер, отправление, прибытие} и больше ничего."),
}

parser = argparse.ArgumentParser()
parser.add_argument("--python", required=True)
parser.add_argument("--skill", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--model", default="deepseek/deepseek-v4.1-flash")
parser.add_argument("--only")
parser.add_argument("--repeat", type=int, default=1)
args = parser.parse_args()

cdp = subprocess.run([sys.executable, str(HERE / "vm.py"), "cdp"], capture_output=True, text=True, check=True).stdout.strip()
pricing = next(m["pricing"] for m in json.load(urllib.request.urlopen("https://openrouter.ai/api/v1/models"))["data"]
               if m["id"] == args.model)
out = Path(args.out)
results = json.loads(out.read_text()) if out.exists() else []


def cost(usage):
    if not usage or usage.get("total_prompt_tokens") is None:
        return None
    cached = usage.get("total_prompt_cached_tokens") or 0
    return round((usage["total_prompt_tokens"] - cached) * float(pricing["prompt"])
                 + cached * float(pricing.get("input_cache_read") or pricing["prompt"])
                 + usage["total_completion_tokens"] * float(pricing["completion"]), 5)


tasks = {k: v for k, v in TASKS.items() if not args.only or k in args.only.split(",")}
for attempt in range(args.repeat):
    for name, (url, goal) in tasks.items():
        for variant in ("baseline", "skill"):
            argv = [args.python, str(HERE / "bu_remote_run.py"), "--cdp", cdp, "--url", url, "--goal", goal,
                    "--model", args.model]
            if variant == "skill":
                argv += ["--skill", args.skill]
            started = time.time()
            p = subprocess.run(argv, capture_output=True, text=True, timeout=900)
            lines = [line for line in p.stdout.splitlines() if line.startswith("{")]
            result = json.loads(lines[-1]) if lines else {"status": "no_output", "stderr_tail": p.stderr[-3000:]}
            result.update(task=name, variant=variant, attempt=attempt, wall_s=round(time.time() - started, 1),
                          cost_usd=cost(result.get("usage")))
            results.append(result)
            out.write_text(json.dumps(results, ensure_ascii=False, indent=1))
            print(f"{name:7} {variant:8} {result.get('status'):9} steps={result.get('steps')} "
                  f"{result['wall_s']:6.1f}s ${result['cost_usd']} {result.get('actions')}", flush=True)
