"""Bro browser pilot suite. Run once per boot as user `bro` (vm.py starts it over the control endpoint).

Results go to $RESULTS_DIR/boot-<n>.json, updated after every step, so progress is visible while the
suite runs; screenshots of the final pages sit next to it for independent success checks.
"""

import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

RESULTS = Path(os.environ["RESULTS_DIR"])
STATE = Path("/var/lib/bro/state")
JEV_DIR = "/opt/bro/jev-ultrafast"
RUNNERS = "/opt/bro/runners"
ENV = {
    **os.environ,
    "BU_CDP_URL": "http://127.0.0.1:9222",
    "BH_UPDATE_CHECK": "0",
    "ANONYMIZED_TELEMETRY": "false",
    "BROWSER_USE_CLOUD_SYNC": "false",
}

STATE.mkdir(parents=True, exist_ok=True)
boot_file = STATE / "boots"
boot = int(boot_file.read_text()) + 1 if boot_file.exists() else 1
boot_file.write_text(str(boot))
out = RESULTS / f"boot-{boot}.json"
report = {"boot": boot, "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "steps": {}}


def save():
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1))
    index = sorted(p.name for p in RESULTS.glob("boot-*.json"))
    (RESULTS / "index.json").write_text(json.dumps(index))


def uptime():
    return float(Path("/proc/uptime").read_text().split()[0])


def llm_spent():
    """Spend on the model key (OpenRouter-style GET /key); the per-step delta is that step's model cost."""
    base, key = os.environ.get("BU_LLM_BASE_URL"), os.environ.get("BU_LLM_API_KEY")
    if not (base and key):
        return None
    try:
        request = urllib.request.Request(base + "/key", headers={"Authorization": "Bearer " + key})
        return json.load(urllib.request.urlopen(request, timeout=10))["data"]["usage"]
    except Exception:
        return None


def proxy_bytes():
    """Residential traffic so far (proxy_forward.py); the per-step delta is what the step cost in GB."""
    try:
        data = json.loads(Path("/var/lib/bro/proxy-bytes.json").read_text())
        return data["up"] + data["down"]
    except Exception:
        return None


def run(name, argv, cwd=None, timeout=480):
    spent_before = llm_spent()
    bytes_before = proxy_bytes()
    started = time.perf_counter()
    try:
        p = subprocess.run(argv, cwd=cwd, env=ENV, capture_output=True, text=True, timeout=timeout)
        lines = [line for line in p.stdout.splitlines() if line.startswith("{")]
        result = json.loads(lines[-1]) if lines else {"status": "no_output"}
        if p.returncode:
            result["exit_code"] = p.returncode
            result["stderr_tail"] = p.stderr[-3000:]
    except subprocess.TimeoutExpired:
        result = {"status": "suite_timeout"}
    except Exception as e:
        result = {"status": "suite_error", "error": repr(e)}
    result["wall_ms"] = round((time.perf_counter() - started) * 1000)
    result["started_at"], result["finished_at"] = time.time() - result["wall_ms"] / 1000, time.time()
    bytes_after = proxy_bytes()
    if bytes_before is not None and bytes_after is not None:
        result["proxy_mb"] = round((bytes_after - bytes_before) / 1e6, 2)
    if spent_before is not None:
        time.sleep(3)  # the key's usage counter trails the last generation
        spent_after = llm_spent()
        if spent_after is not None:
            result["llm_spent"] = round(spent_after - spent_before, 4)
    report["steps"][name] = result
    save()
    return result


# 1. Boot and browser readiness.
report["uptime_at_suite_start_s"] = uptime()
cdp_ready = None
deadline = time.time() + 120
while time.time() < deadline:
    try:
        urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=2).read()
        cdp_ready = uptime()
        break
    except Exception:
        time.sleep(0.5)
report["uptime_at_cdp_ready_s"] = cdp_ready
report["machine"] = {
    "memory": subprocess.run(["free", "-m"], capture_output=True, text=True).stdout,
    "disk": subprocess.run(["df", "-h", "/"], capture_output=True, text=True).stdout,
    "chrome": subprocess.run(["google-chrome", "--version"], capture_output=True, text=True).stdout.strip(),
    "profile_size": subprocess.run(["du", "-sh", "/var/lib/bro/profile"], capture_output=True, text=True).stdout.strip(),
}
save()

# 2. Network from Cloud.ru: egress IP, latency to model APIs and target sites.
probes = {}
for name, url in {
    "egress_ip": "https://ipinfo.io/json",
    "typesafe": "https://api.typesafe.ai/",
    "openrouter": "https://openrouter.ai/api/v1/models",
    "openai": "https://api.openai.com/v1/models",
    "anthropic": "https://api.anthropic.com/v1/models",
    "inception": "https://api.inceptionlabs.ai/v1/models",
    "vercel_ai_gateway": "https://ai-gateway.vercel.sh/v1/models",
    "cloudru_foundation_models": "https://foundation-models.api.cloud.ru/v1/models",
    "neon": "https://console.neon.tech/",
    "composio": "https://backend.composio.dev/",
    "browser_use_cloud": "https://api.browser-use.com/",
    "wikipedia_en": "https://en.wikipedia.org/wiki/Main_Page",
    "wikipedia_ru": "https://ru.wikipedia.org/",
    "google_flights": "https://www.google.com/travel/flights?hl=en",
    "yandex_rasp": "https://rasp.yandex.ru/",
    "ozon": "https://www.ozon.ru/",
    "avito": "https://www.avito.ru/",
    "gosuslugi": "https://www.gosuslugi.ru/",
    "rzd": "https://www.rzd.ru/",
}.items():
    p = subprocess.run(
        ["curl", "-sS", "-m", "20", "-o", "/tmp/probe.body", "-w",
         '{"code":%{http_code},"connect_s":%{time_connect},"ttfb_s":%{time_starttransfer},"total_s":%{time_total}}', url],
        capture_output=True, text=True,
    )
    try:
        probes[name] = json.loads(p.stdout)
    except ValueError:
        probes[name] = {"error": p.stderr.strip()[:300]}
    if name == "egress_ip":
        try:
            info = json.loads(Path("/tmp/probe.body").read_text())
            probes[name].update({k: info.get(k) for k in ("ip", "city", "region", "country", "org")})
        except Exception:
            pass
report["network"] = probes
save()

# 3. Profile persistence across stop/start.
run("persist", [f"{JEV_DIR}/.venv/bin/python", f"{RUNNERS}/persist.py", f"boot-{boot}-{int(time.time())}"],
    cwd=JEV_DIR, timeout=90)

# 4. Browser tasks. Read-only goals: nothing is submitted, bought or signed in to.
JEV_TASKS = {
    "wiki_en": ("https://en.wikipedia.org/wiki/Main_Page",
                "Find and open the Wikipedia article about Gödel's incompleteness theorems."),
    "wiki_ru": ("https://ru.wikipedia.org/",
                "Найди и открой статью Википедии о теоремах Гёделя о неполноте."),
    "flights": ("https://www.google.com/travel/flights?hl=en",
                "Find one-way flights from Moscow to Kazan on November 20, 2026, for one adult in economy. "
                "Stop when matching flight options are visible."),
    "rasp": ("https://rasp.yandex.ru/",
             "Найди расписание поездов из Москвы в Санкт-Петербург на 20 ноября 2026 года. "
             "Остановись, когда видны варианты поездов."),
    "ozon": ("https://www.ozon.ru/",
             "Найди беспроводные наушники. Остановись, когда видны результаты поиска с ценами."),
}
# Click-only goals: no TYPE_TEXT, so they need TypeSafe but not the text helper (OpenRouter refuses RU).
JEV_CLICK_TASKS = {
    "wiki_en_click": ("https://en.wikipedia.org/wiki/Main_Page",
                      "Open the full article of today's featured article. Do not type anything."),
    "rasp_click": ("https://rasp.yandex.ru/",
                   "Открой расписание из Москвы в Санкт-Петербург по ссылке в популярных направлениях. "
                   "Ничего не вводи с клавиатуры."),
}
DIRECT = {**{name: url for name, (url, _) in JEV_TASKS.items()}, "gosuslugi": "https://www.gosuslugi.ru/"}

BU_MODELS = os.environ.get("BU_AGENT_MODELS", "openai/gpt-5.6-luna").split(",")

# SUITE_PROXY=1: Chrome goes through the residential proxy; the sites that refuse Cloud.ru plus controls.
PROXY_TASKS = {
    "ozon": JEV_TASKS["ozon"],
    "avito": ("https://www.avito.ru/moskva",
              "Найди объявления о продаже велосипедов в Москве. Остановись, когда видны объявления с ценами."),
    "rzd": ("https://www.rzd.ru/",
            "Найди поезда из Москвы в Санкт-Петербург на 20 ноября 2026 года. "
            "Остановись, когда видны варианты поездов с ценами."),
    "rasp": JEV_TASKS["rasp"],
    "flights": JEV_TASKS["flights"],
}
PROXY_DOMAINS = {"ozon": "ozon.ru,*.ozon.ru", "avito": "avito.ru,*.avito.ru", "rzd": "rzd.ru,*.rzd.ru",
                 "rasp": "rasp.yandex.ru,*.yandex.ru,yandex.ru", "flights": "www.google.com,google.com"}

if os.environ.get("SUITE_PROXY"):
    run("leak_check", [f"{JEV_DIR}/.venv/bin/python", f"{RUNNERS}/leak_check.py"], cwd=JEV_DIR, timeout=90)
    for name, (url, _) in {**PROXY_TASKS, "gosuslugi": (DIRECT["gosuslugi"], None),
                           "wiki_ru": JEV_TASKS["wiki_ru"]}.items():
        run(f"direct_{name}", ["/opt/bro/bu/.venv/bin/python", f"{RUNNERS}/bu_direct.py", "--url", url,
                               "--screenshot", str(RESULTS / f"boot-{boot}-direct_{name}.jpg")], timeout=120)
    for name in ("ozon", "avito", "rzd"):
        url, goal = PROXY_TASKS[name]
        run(f"jev_{name}", [f"{JEV_DIR}/.venv/bin/python", f"{RUNNERS}/jev_run.py", "--url", url, "--goal", goal,
                            "--screenshot", str(RESULTS / f"boot-{boot}-jev_{name}.jpg")], cwd=JEV_DIR, timeout=300)
    for model in BU_MODELS:
        short = model.split("/")[-1]
        for name, (url, goal) in PROXY_TASKS.items():
            run(f"bu_{short}_{name}", ["/opt/bro/bu/.venv/bin/python", f"{RUNNERS}/bu_agent_run.py", "--model",
                                       model, "--url", url, "--goal", goal, "--max-steps", "20",
                                       "--allowed-domains", PROXY_DOMAINS[name],
                                       "--screenshot", str(RESULTS / f"boot-{boot}-bu_{short}_{name}.jpg")],
                timeout=480)
    report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    save()
    raise SystemExit

# SUITE_FULL=1 repeats the full set on a later boot (e.g. after switching the model provider).

if boot == 1 or os.environ.get("SUITE_FULL"):
    for name, (url, goal) in {**JEV_TASKS, **JEV_CLICK_TASKS}.items():
        run(f"jev_{name}", [f"{JEV_DIR}/.venv/bin/python", f"{RUNNERS}/jev_run.py", "--url", url, "--goal", goal,
                            "--screenshot", str(RESULTS / f"boot-{boot}-jev_{name}.jpg")], cwd=JEV_DIR, timeout=300)
    for name, url in DIRECT.items():
        run(f"direct_{name}", ["/opt/bro/bu/.venv/bin/python", f"{RUNNERS}/bu_direct.py", "--url", url,
                               "--screenshot", str(RESULTS / f"boot-{boot}-direct_{name}.jpg")], timeout=120)
    for model in BU_MODELS:
        short = model.split("/")[-1]
        for name, (url, goal) in JEV_TASKS.items():
            run(f"bu_{short}_{name}", ["/opt/bro/bu/.venv/bin/python", f"{RUNNERS}/bu_agent_run.py", "--model",
                                       model, "--url", url, "--goal", goal, "--max-steps", "20",
                                       "--screenshot", str(RESULTS / f"boot-{boot}-bu_{short}_{name}.jpg")],
                timeout=480)
else:
    # After a stop/start: short tasks on the restarted machine, with the profile left by the previous boot.
    for name, (url, goal) in JEV_CLICK_TASKS.items():
        run(f"jev_{name}", [f"{JEV_DIR}/.venv/bin/python", f"{RUNNERS}/jev_run.py", "--url", url, "--goal", goal,
                            "--screenshot", str(RESULTS / f"boot-{boot}-jev_{name}.jpg")], cwd=JEV_DIR, timeout=300)
    for name in ("rasp", "gosuslugi"):
        run(f"direct_{name}", ["/opt/bro/bu/.venv/bin/python", f"{RUNNERS}/bu_direct.py", "--url", DIRECT[name],
                               "--screenshot", str(RESULTS / f"boot-{boot}-direct_{name}.jpg")], timeout=120)

report["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
report["uptime_at_finish_s"] = uptime()
save()
