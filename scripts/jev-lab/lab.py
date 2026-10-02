"""jev-lab: run jev-ultrafast (decision model TypeSafe Jev) on Bro's browser tasks with full traces.

  python3 lab.py chrome --port 9231                 start a Chrome (own profile) for this port
  python3 lab.py serve                              serve fixtures/ on 127.0.0.1:8765 (LAB_FIXTURE_PORT)
  python3 lab.py run --jev DIR --port 9231 TASK [TASK ...] [--rounds N] [--tag NAME]
  python3 lab.py run --jev DIR --port 9231 --set dev|heldout|fresh|fixture|env|all
  python3 lab.py table runs/NAME.jsonl [...]        success table per task
  python3 lab.py rescore runs/NAME.jsonl [...]      recompute success with the current checks

Every run appends one JSON line (trace, success, final page) to runs/<tag>.jsonl and saves a final screenshot to
shots/. Use your own --port (and thereby your own Chrome profile and browser-harness daemon); never share one.
LAB_HEADED=1 starts a headed Chrome under Xvfb (display :port-9000), as on Bro's VM; a port keeps the mode its
Chrome was started with. LAB_CLEAN_PROFILE=1 gives every run a new Chrome profile. jev runs in DIR/.venv (or JEV_PYTHON) with DIR first on PYTHONPATH. Keys come from
TYPESAFE_API_KEY and OPENROUTER_API_KEY (the text helper); see README.md.
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from tasks import all_tasks  # noqa: E402

CHROME = os.environ.get("CHROME_BIN") or next(
    (p for p in ("/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/google-chrome") if Path(p).exists()),
    "google-chrome")


def python_for(jev_dir):
    """jev's interpreter: JEV_PYTHON, else the checkout's own .venv (uv sync in it)."""
    return os.environ.get("JEV_PYTHON") or str(Path(jev_dir).resolve() / ".venv" / "bin" / "python")
clean = lambda value: "".join((value or "").split())  # cloud env keys arrive with stray newlines


def chrome_up(port):
    try:
        urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
            f"http://127.0.0.1:{port}/json/version", timeout=2).read()
        return True
    except Exception:
        return False


def start_chrome(port):
    if chrome_up(port):
        return
    profile = HERE / "profiles" / str(port)
    profile.mkdir(parents=True, exist_ok=True)
    log = open(HERE / "profiles" / f"{port}.log", "w")
    env = dict(os.environ)
    # A cloud session's egress proxy re-terminates TLS: its CA must be in ~/.pki/nssdb (certutil) for Chrome.
    proxy = [f"--proxy-server={os.environ['HTTPS_PROXY']}"] if os.environ.get("HTTPS_PROXY") else []
    mode = ["--headless=new"]
    if os.environ.get("LAB_HEADED") == "1":  # headed Chrome under Xvfb, like Bro's VM (bro-xvfb + bro-chrome)
        display = f":{port - 9000}"
        if not Path(f"/tmp/.X11-unix/X{port - 9000}").exists():
            subprocess.Popen(["Xvfb", display, "-screen", "0", "1366x900x24", "-nolisten", "tcp"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            time.sleep(1)
        env["DISPLAY"] = display
        mode = []
    subprocess.Popen(
        [CHROME, *mode, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
         f"--remote-debugging-port={port}", "--remote-allow-origins=*", f"--user-data-dir={profile}",
         *proxy, "--no-first-run", "--no-default-browser-check",
         "--lang=ru-RU", "--window-size=1366,900", "about:blank"],
        stdout=log, stderr=log, start_new_session=True, env=env)
    for _ in range(50):
        if chrome_up(port):
            return
        time.sleep(0.2)
    sys.exit(f"Chrome on {port} did not start")


FIXTURE_PORT = int(os.environ.get("LAB_FIXTURE_PORT", "8765"))


def serve():
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", FIXTURE_PORT)) == 0:
            return
    subprocess.Popen([sys.executable, "-m", "http.server", str(FIXTURE_PORT), "--bind", "127.0.0.1", "-d",
                      str(HERE / "fixtures")],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    time.sleep(0.5)


def env_for(jev_dir, port):
    return {
        **os.environ,
        "PYTHONPATH": str(Path(jev_dir).resolve()),
        "BU_CDP_URL": f"http://127.0.0.1:{port}",
        "BU_NAME": f"lab{port}",
        "BH_UPDATE_CHECK": "0",
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
        "TYPESAFE_URL": "https://api.typesafe.ai/v1/systemone",
        "TYPESAFE_API_KEY": clean(os.environ["TYPESAFE_API_KEY"]),
        "TYPESAFE_MODEL": "jev-latest",
        "TEXT_MODEL_API_KEY": clean(os.environ["OPENROUTER_API_KEY"]),
        "TEXT_MODEL_BASE_URL": "https://openrouter.ai/api/v1",
        "TEXT_MODEL": "inception/mercury-2.5",
        "TEXT_MODEL_REASONING": "none",
    }


def clean_profile(jev_dir, port):
    """LAB_CLEAN_PROFILE=1: every run starts from a new Chrome profile, so no run inherits cookies, filled forms or
    'continue your search' state from the previous one. Stops this port's daemon and Chrome, wipes the profile."""
    subprocess.run([python_for(jev_dir), "-c", "import sys; from browser_harness.admin import restart_daemon; "
                    "restart_daemon(sys.argv[1])", f"lab{port}"], env=env_for(jev_dir, port), capture_output=True,
                   timeout=30)
    subprocess.run(["pkill", "-f", f"remote-debugging-port={port}"], capture_output=True)
    for _ in range(50):
        if not chrome_up(port):
            break
        time.sleep(0.1)
    shutil.rmtree(HERE / "profiles" / str(port), ignore_errors=True)
    start_chrome(port)


def run_one(jev_dir, port, name, deadline, tag):
    if os.environ.get("LAB_CLEAN_PROFILE") == "1":
        clean_profile(jev_dir, port)
    kind, url, goal, check = all_tasks()[name]
    if kind == "fixture":
        serve()
    for folder in ("runs", "shots"):
        (HERE / folder).mkdir(exist_ok=True)
    stamp = time.strftime("%H%M%S")
    shot = HERE / "shots" / f"{tag}-{name}-{stamp}.jpg"
    started = time.perf_counter()
    try:
        proc = subprocess.run([python_for(jev_dir), str(HERE / "trace_run.py"), "--url", url, "--goal", goal,
                               "--deadline", str(deadline), "--shot", str(shot)],
                              env=env_for(jev_dir, port), capture_output=True, text=True, timeout=deadline + 60,
                              cwd=str(Path(jev_dir).resolve()))
        line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
        result = json.loads(line) if line.startswith("{") else {"status": "crash", "error": proc.stderr[-1500:]}
    except subprocess.TimeoutExpired:
        result = {"status": "timeout"}
    try:
        result["success"] = bool(check(result))
    except Exception as error:
        result.update(success=False, check_error=repr(error))
    result.update(task=name, set=kind, tag=tag, jev_dir=str(jev_dir), wall_ms=round((time.perf_counter() - started) * 1000))
    out = HERE / "runs" / f"{tag}.jsonl"
    with out.open("a") as f:
        f.write(json.dumps(result, ensure_ascii=False) + "\n")
    ops = " ".join(f"{d['operation']}{'→' + str(d['label'])[:28] if d.get('label') else ''}"
                   for d in (result.get("decisions") or [])[:14])
    print(f"{name:16s} {result.get('status'):8s} success={result['success']!s:5s} loop={result.get('loop_ms')}ms "
          f"actions={len(result.get('actions') or [])} decisions={len(result.get('decisions') or [])} "
          f"final={(result.get('final_url') or '')[:80]} | {ops} {(result.get('error') or '')[:200]}", flush=True)
    return result


def table(paths):
    rows = [json.loads(l) for p in paths for l in Path(p).open() if l.strip()]
    by = {}
    for r in rows:
        by.setdefault((r.get("set"), r["task"]), []).append(r)
    total = {}
    for (kind, task), rs in sorted(by.items()):
        ok = sum(r["success"] for r in rs)
        total.setdefault(kind, [0, 0])
        total[kind][0] += ok
        total[kind][1] += len(rs)
        statuses = ",".join(r.get("status", "?") for r in rs)
        print(f"{kind:8s} {task:16s} {ok}/{len(rs)}  [{statuses}]")
    for kind, (ok, n) in total.items():
        print(f"TOTAL {kind}: {ok}/{n}")


def rescore(paths):
    tasks = all_tasks()
    for path in paths:
        rows = [json.loads(l) for l in Path(path).open() if l.strip()]
        changed = 0
        for r in rows:
            if r["task"] in tasks:
                try:
                    ok = bool(tasks[r["task"]][3](r))
                except Exception:
                    ok = False
                changed += ok != r.get("success")
                r["success"] = ok
        Path(path).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        print(f"{path}: {changed} verdicts changed")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("chrome")
    c.add_argument("--port", type=int, required=True)
    sub.add_parser("serve")
    r = sub.add_parser("run")
    r.add_argument("--jev", required=True)
    r.add_argument("--port", type=int, required=True)
    r.add_argument("--set", choices=["dev", "heldout", "fresh", "fixture", "env", "all"])
    r.add_argument("--rounds", type=int, default=1)
    r.add_argument("--deadline", type=int, default=120)
    r.add_argument("--tag", default="scratch")
    r.add_argument("tasks", nargs="*")
    t = sub.add_parser("table")
    t.add_argument("paths", nargs="+")
    rs = sub.add_parser("rescore")
    rs.add_argument("paths", nargs="+")
    args = parser.parse_args()
    if args.cmd == "chrome":
        start_chrome(args.port)
        print(f"chrome up on {args.port}")
    elif args.cmd == "serve":
        serve()
    elif args.cmd == "run":
        start_chrome(args.port)
        names = args.tasks or [n for n, v in all_tasks().items() if args.set in ("all", v[0])]
        for _ in range(args.rounds):
            for name in names:
                run_one(args.jev, args.port, name, args.deadline, args.tag)
    elif args.cmd == "rescore":
        rescore(args.paths)
    else:
        table(args.paths)


if __name__ == "__main__":
    main()
