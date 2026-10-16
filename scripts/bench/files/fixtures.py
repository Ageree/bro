"""Build the input files of the f-* suite and their truth (local only: nothing here ships to the sandbox).

    python3 fixtures.py [--case ID,…] [--out DIR] [--jobs N] [--python PATH]   build (default: every case)
    python3 fixtures.py --verify [--case ID,…]                                  build twice in temp dirs, compare sha256
    python3 fixtures.py --list                                                  case ids and their generators

DIR defaults to $BENCH_FILES_FIXTURES or ~/.bro-bench/files-fixtures: DIR/<case>/ holds the files the driver sends,
DIR/truth/ the data the checks compare with, DIR/manifest.json the sha256 of every file plus the libraries, tools and
fonts that made them (no timestamps). Each case runs gen/<id with - → _>.py → build(out_dir, truth_dir) in its own
interpreter, so module state never leaks between cases and cases build in parallel. A generator that lacks a system tool
raises common.MissingTool: the case is reported unbuilt (the driver skips it). After a build every file a turn sends must
exist and fit the web chat (≤ 10 files and ≤ 40 MiB per message, ≤ 20 MiB per file). Exit 1 when a case fails.
A JSON summary goes to stdout.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time

HERE = pathlib.Path(__file__).resolve().parent
GEN = HERE / "gen"
CASES = HERE.parents[2] / "docs" / "benchmarks" / "files" / "cases.json"
VOICE = (".ogg", ".m4a", ".mp3", ".wav")
MAX_FILE = 20 * 1024 * 1024
MAX_MESSAGE = 40 * 1024 * 1024
MAX_FILES = 10
LIBS = ("pypdf", "reportlab", "PIL", "numpy", "openpyxl", "docx", "pptx", "cryptography")
TOOLS = {"pdftoppm": "-v", "soffice": "--version", "ffmpeg": "-version"}
MARK = "@@FIXTURES@@"

RUNNER = r"""
import importlib, json, pathlib, sys
gen, module, out_dir, truth_dir, mark = sys.argv[1:6]
sys.path.insert(0, gen)
sys.path.insert(1, str(pathlib.Path(gen).parent))
import common
try:
    mod = importlib.import_module(module)
    paths = mod.build(pathlib.Path(out_dir), pathlib.Path(truth_dir))
except common.MissingTool as e:
    print(mark + json.dumps({"missing_tool": e.tool}))
    sys.exit(3)
print(mark + json.dumps({"written": [str(p) for p in (paths or [])]}, ensure_ascii=False))
"""

LIB_PROBE = r"""
import importlib, json, platform, sys
out = {}
for name in sys.argv[1:]:
    try:
        mod = importlib.import_module(name)
    except Exception:
        out[name] = None
        continue
    out[name] = str(getattr(mod, "__version__", getattr(mod, "Version", getattr(mod, "VERSION", "?"))))
print(json.dumps({"python": platform.python_version(), "libs": out}))
"""


def default_out() -> pathlib.Path:
    return pathlib.Path(os.environ.get("BENCH_FILES_FIXTURES") or pathlib.Path.home() / ".bro-bench" / "files-fixtures")


def load_suite() -> list:
    return json.loads(CASES.read_text(encoding="utf-8"))


def module_for(case_id: str) -> str:
    return case_id.replace("-", "_")


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_case(case: dict, out_root: pathlib.Path, truth_dir: pathlib.Path, python: str, timeout: int) -> dict:
    case_id = case["id"]
    out_dir = out_root / case_id
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    started = time.monotonic()
    try:
        proc = subprocess.run([python, "-c", RUNNER, str(GEN), module_for(case_id), str(out_dir), str(truth_dir), MARK],
                              capture_output=True, text=True, timeout=timeout, cwd=str(GEN))
    except subprocess.TimeoutExpired:
        return {"case": case_id, "ok": False, "error": f"timed out after {timeout} s", "files": {}, "truth": {}}
    report = {}
    for line in proc.stdout.splitlines():
        if line.startswith(MARK):
            report = json.loads(line[len(MARK):])
    result = {"case": case_id, "ok": proc.returncode == 0, "seconds": round(time.monotonic() - started, 1),
              "files": {}, "truth": {}, "error": None}
    if report.get("missing_tool"):
        result.update(ok=False, missing_tool=report["missing_tool"], error=f"needs {report['missing_tool']}")
        return result
    if proc.returncode != 0:
        result["error"] = (proc.stderr or proc.stdout)[-3000:]
        return result
    for path in sorted(out_dir.rglob("*")):
        if path.is_file():
            result["files"][path.relative_to(out_dir).as_posix()] = {"sha256": sha256(path), "bytes": path.stat().st_size}
    for name in report.get("written", []):
        path = pathlib.Path(name).resolve()
        if truth_dir.resolve() in path.parents and path.is_file():
            result["truth"][path.relative_to(truth_dir.resolve()).as_posix()] = {"sha256": sha256(path),
                                                                                 "bytes": path.stat().st_size}
    problems = message_problems(case, out_dir)
    if problems:
        result.update(ok=False, error="; ".join(problems))
    return result


def message_problems(case: dict, out_dir: pathlib.Path) -> list:
    problems = []
    for index, turn in enumerate(case.get("turns", [])):
        sent = []
        for name in turn.get("files", []):
            path = out_dir / name
            if not path.is_file():
                problems.append(f"turn {index}: {name} was not built")
                continue
            if name.lower().endswith(VOICE):
                continue
            size = path.stat().st_size
            if size > MAX_FILE:
                problems.append(f"turn {index}: {name} is {size} bytes (> 20 MiB)")
            sent.append(size)
        if len(sent) > MAX_FILES:
            problems.append(f"turn {index}: {len(sent)} files (> {MAX_FILES})")
        if sum(sent) > MAX_MESSAGE:
            problems.append(f"turn {index}: {sum(sent)} bytes in one message (> 40 MiB)")
    return problems


def environment(python: str) -> dict:
    probe = subprocess.run([python, "-c", LIB_PROBE, *LIBS], capture_output=True, text=True, timeout=120)
    info = json.loads(probe.stdout) if probe.returncode == 0 else {"python": None, "libs": {}}
    tools = {}
    for name, flag in TOOLS.items():
        path = shutil.which(name)
        if path is None:
            tools[name] = None
            continue
        res = subprocess.run([path, flag], capture_output=True, text=True, timeout=120)
        lines = (res.stdout or res.stderr).strip().splitlines()
        tools[name] = lines[0][:80] if lines else "?"
    sys.path.insert(0, str(GEN))
    import common

    fonts = {}
    for path in sorted(set(common._FF_FONT_FILES.values())):
        if pathlib.Path(path).exists():
            fonts[path] = sha256(pathlib.Path(path))
    return {"python": info["python"], "libs": info["libs"], "tools": tools, "fonts": fonts}


def build(cases: list, out_root: pathlib.Path, python: str, jobs: int, timeout: int) -> list:
    truth_dir = out_root / "truth"
    truth_dir.mkdir(parents=True, exist_ok=True)
    results = []
    with cf.ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        futures = {pool.submit(build_case, c, out_root, truth_dir, python, timeout): c["id"] for c in cases}
        for future in cf.as_completed(futures):
            res = future.result()
            results.append(res)
            state = "ok  " if res["ok"] else "FAIL"
            print(f"{state} {res['case']} ({res.get('seconds', '?')} s)", file=sys.stderr)
            if not res["ok"]:
                print(res.get("error") or "", file=sys.stderr)
    order = [c["id"] for c in cases]
    results.sort(key=lambda r: order.index(r["case"]))
    return results


def write_manifest(out_root: pathlib.Path, results: list, env: dict) -> pathlib.Path:
    path = out_root / "manifest.json"
    manifest = {"cases": {}}
    if path.exists():
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            manifest = {"cases": {}}
    for res in results:
        if res["ok"]:
            manifest.setdefault("cases", {})[res["case"]] = {"files": res["files"], "truth": res["truth"]}
        else:
            manifest.setdefault("cases", {}).pop(res["case"], None)
    manifest.update(env)
    manifest["cases"] = dict(sorted(manifest["cases"].items()))
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=False) + "\n", encoding="utf-8")
    return path


def verify(cases: list, python: str, jobs: int, timeout: int) -> dict:
    runs = []
    with tempfile.TemporaryDirectory(prefix="bench-fixtures-") as td:
        for n in (1, 2):
            runs.append(build(cases, pathlib.Path(td) / f"run{n}", python, jobs, timeout))
    diff = []
    total = 0
    for a, b in zip(*runs):
        if not (a["ok"] and b["ok"]):
            diff.append({"case": a["case"], "error": a.get("error") or b.get("error")})
            continue
        for key in ("files", "truth"):
            names = set(a[key]) | set(b[key])
            total += len(names)
            for name in sorted(names):
                if (a[key].get(name) or {}).get("sha256") != (b[key].get(name) or {}).get("sha256"):
                    diff.append({"case": a["case"], "file": f"{key}/{name}"})
    return {"identical": not diff, "files": total, "differences": diff}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--case", default="", help="comma-separated case ids (default: every case of cases.json)")
    ap.add_argument("--out", type=pathlib.Path, default=None, help="fixtures directory")
    ap.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    ap.add_argument("--python", default=sys.executable, help="interpreter that runs the generators")
    ap.add_argument("--timeout", type=int, default=1800, help="seconds per case")
    ap.add_argument("--verify", action="store_true", help="build twice into temp dirs and compare every sha256")
    ap.add_argument("--list", action="store_true", help="list the cases and their generators")
    args = ap.parse_args(argv)

    suite = load_suite()
    known = {c["id"]: c for c in suite}
    wanted = [c.strip() for c in args.case.split(",") if c.strip()] or list(known)
    unknown = [c for c in wanted if c not in known]
    if unknown:
        print(json.dumps({"unknown_cases": unknown}), file=sys.stderr)
        return 1
    cases = [known[c] for c in wanted]
    if args.list:
        rows = [{"case": c["id"], "generator": f"gen/{module_for(c['id'])}.py",
                 "exists": (GEN / f"{module_for(c['id'])}.py").exists()} for c in cases]
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        return 0
    missing = [c["id"] for c in cases if not (GEN / f"{module_for(c['id'])}.py").exists()]
    if missing:
        print(json.dumps({"missing_generators": missing}), file=sys.stderr)
        return 1
    if args.verify:
        report = verify(cases, args.python, args.jobs, args.timeout)
        print(json.dumps(report, ensure_ascii=False, indent=1))
        return 0 if report["identical"] else 1
    out_root = (args.out or default_out()).expanduser().resolve()
    results = build(cases, out_root, args.python, args.jobs, args.timeout)
    manifest = write_manifest(out_root, results, environment(args.python))
    summary = {"out": str(out_root), "manifest": str(manifest),
               "cases": [{k: r.get(k) for k in ("case", "ok", "seconds", "error", "missing_tool") if r.get(k) is not None}
                         for r in results]}
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
