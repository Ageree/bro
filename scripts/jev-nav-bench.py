"""Jev arm of the navigation benchmark: browser-use/jev-ultrafast on the shared suite.

The Cloud arm is `scripts/nav-bench.ts`. Both arms run the same tasks, worded
identically, and are graded the same way: read the page the agent left behind
and believe only that. jev-ultrafast's own AGENTS.md is explicit about why —
"A DONE choice is not proof of success" — and a `BLOCKED` run that happened to
land on the right page still counts as solved here, because the page is the
deliverable.

Tasks are not restated here. They come from
`node --experimental-strip-types scripts/nav-bench.ts --dump-tasks`, so the two
arms cannot drift apart on the goal text, the start URL or the success check.

What is timed: `state["elapsed_ms"]`, which the agent starts on its first
prediction, after the constructor has already navigated and taken the first
observation. That is Browser Use's own published boundary (first prediction to
accepted DONE) and it is what the Cloud arm's `llm.request` -> `llm.response`
window is built to match. Browser connect and the opening navigation are
outside the clock in this arm; see the Cloud script's header for the one
residual that could not be removed from the other.

Usage (needs the jev-ultrafast checkout's env for TYPESAFE_API_KEY and the
text-helper key):

    uv run --project /home/user/browser-use/jev-ultrafast \
      --env-file /home/user/browser-use/jev-ultrafast/.env \
      python scripts/jev-nav-bench.py --repeat 3 --run

Costs real money (TypeSafe requests, plus an OpenRouter call per TYPE_TEXT).
Prints a dry plan unless `--run` is given.
"""

import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

BRO = Path(__file__).resolve().parent.parent


def load_tasks(path: str | None) -> list[dict]:
    """One source of truth: the TypeScript suite, dumped as JSON."""
    if path:
        return json.loads(Path(path).read_text())
    out = subprocess.run(
        ["node", "--experimental-strip-types", "scripts/nav-bench.ts", "--dump-tasks"],
        cwd=BRO, capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def reset_origins(cdp, origins: list[str]) -> None:
    """Wipe cookies and storage for the task's origins before the attempt.

    Required, not tidiness: this arm reuses one long-lived Chrome profile, and
    saucedemo keeps the cart in localStorage and the login in a cookie. Without
    this, attempt two starts already logged in holding attempt one's cart and
    every cart assertion passes for free.
    """
    scratch = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
    session = cdp("Target.attachToTarget", targetId=scratch, flatten=True)["sessionId"]
    try:
        for origin in origins:
            try:
                cdp("Storage.clearDataForOrigin", session_id=session,
                    origin=origin, storageTypes="all")
            except Exception:
                pass
        try:
            cdp("Network.clearBrowserCookies", session_id=session)
        except Exception:
            pass
    finally:
        try:
            cdp("Target.closeTarget", targetId=scratch)
        except Exception:
            pass


def verify(cdp, target_id: str, check: str) -> dict:
    """Independent outcome read: fresh CDP session on the agent's own tab.

    A separate session from the one the agent drove, so nothing the agent left
    in its session can colour the answer. The check expression catches its own
    exceptions and reports what the page actually held.
    """
    session = cdp("Target.attachToTarget", targetId=target_id, flatten=True)["sessionId"]
    res = cdp("Runtime.evaluate", session_id=session, expression=check, returnByValue=True)
    if res.get("exceptionDetails"):
        return {"ok": False, "got": "check raised in page"}
    value = res.get("result", {}).get("value")
    if not isinstance(value, dict) or not isinstance(value.get("ok"), bool):
        return {"ok": False, "got": f"check returned {value!r}"[:200]}
    return value


def run_one(Agent, cdp, task: dict, action_budget: int) -> dict:
    attempt = {
        "arm": "jev", "model": "jev", "task": task["id"], "status": "error", "ok": False,
        "got": None, "decisionMs": 0, "wallMs": 0, "modelRequests": 0, "jevRequests": 0,
        "textCalls": 0, "actions": 0, "inputTokens": 0, "outputTokens": 0, "error": None,
    }
    reset_origins(cdp, task.get("resetOrigins") or [])
    started = time.perf_counter()
    agent = None
    try:
        agent = Agent(task["startUrl"], task["goal"])
        state = None
        for state in agent.run():
            if state.get("history") and len(state["history"]) > action_budget:
                break
        attempt["wallMs"] = round((time.perf_counter() - started) * 1000)
        if state is None:
            attempt["error"] = "agent produced no state"
            return attempt

        decisions = state.get("decisions") or []
        text_calls = state.get("text_calls") or []
        attempt.update(
            status=str(state.get("status")),
            # The agent's own clock: first prediction -> accepted DONE.
            decisionMs=int(state.get("elapsed_ms") or 0),
            jevRequests=len(decisions),
            textCalls=len(text_calls),
            # Every paid round trip: one Jev call per decision cycle plus one
            # text-helper call per TYPE_TEXT. This is the number Jev's design
            # claim is actually about.
            modelRequests=len(decisions) + len(text_calls),
            actions=len(state.get("history") or []),
            inputTokens=sum(int((d.get("usage") or {}).get("input_tokens") or 0) for d in decisions),
            outputTokens=sum(int((d.get("usage") or {}).get("output_tokens") or 0) for d in decisions),
            # Per-decision model latency, so the vendor's headline claim
            # (a 178 ms median Jev request) can be checked against our own
            # traffic rather than taken on faith.
            jevLatenciesMs=[int(d.get("latency_ms") or 0) for d in decisions],
        )
        verdict = verify(cdp, agent.browser.target, task["check"])
        attempt["ok"] = bool(verdict.get("ok"))
        attempt["got"] = verdict.get("got")
        return attempt
    except Exception as exc:  # a budget stop or a provider error is a data point, not a crash
        attempt["wallMs"] = round((time.perf_counter() - started) * 1000)
        attempt["error"] = f"{type(exc).__name__}: {exc}"[:300]
        if agent is not None:
            # Read the counters off the agent rather than leaving them at zero.
            # `agent.run()` raising means the generator never yielded a final
            # state, and a report showing "0 model requests" for a run that
            # really made several would understate exactly the arm being
            # measured.
            try:
                st = agent.state
                decisions = st.get("decisions") or []
                text_calls = st.get("text_calls") or []
                attempt.update(
                    status=str(st.get("status")),
                    decisionMs=int(st.get("elapsed_ms") or 0),
                    jevRequests=len(decisions),
                    textCalls=len(text_calls),
                    modelRequests=len(decisions) + len(text_calls),
                    actions=len(st.get("history") or []),
                    inputTokens=sum(int((d.get("usage") or {}).get("input_tokens") or 0) for d in decisions),
                    outputTokens=sum(int((d.get("usage") or {}).get("output_tokens") or 0) for d in decisions),
                )
            except Exception:
                pass
            try:
                verdict = verify(cdp, agent.browser.target, task["check"])
                attempt["ok"] = bool(verdict.get("ok"))
                attempt["got"] = verdict.get("got")
            except Exception:
                pass
        return attempt
    finally:
        if agent is not None:
            try:
                agent.close()
            except Exception:
                pass


def median(xs: list[float]) -> float:
    return statistics.median(xs) if xs else 0.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", help="task JSON (default: dumped from scripts/nav-bench.ts)")
    ap.add_argument("--only", default="", help="comma-separated task ids")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--action-budget", type=int, default=40,
                    help="stop an attempt after this many executed actions")
    ap.add_argument("--run", action="store_true", help="actually run; otherwise print a dry plan")
    args = ap.parse_args()

    tasks = load_tasks(args.tasks)
    only = [t.strip() for t in args.only.split(",") if t.strip()]
    if only:
        tasks = [t for t in tasks if t["id"] in only]
    if not tasks:
        print("no task matched", file=sys.stderr)
        return 2

    print("# Navigation benchmark — jev-ultrafast arm\n")
    print(f"tasks:     {', '.join(t['id'] for t in tasks)}")
    print(f"repeats:   {args.repeat}   runs: {len(tasks) * args.repeat}")
    print("graded by: final page state read over CDP, not the agent's DONE\n")

    if not args.run:
        print("Dry plan — no browser driven, no model called. Add --run to execute.\n")
        for t in tasks:
            print(f"  {t['id']:<22} {t['stresses']}")
            print(f"  {'':<22} start: {t['startUrl']}")
            print(f"  {'':<22} goal:  {t['goal'][:130]}")
        return 0

    # Imported only for a real run: `--dry` must not need the package, a
    # browser, or credentials.
    from browser_harness.admin import ensure_daemon
    from browser_harness.helpers import cdp
    from jev_ultrafast import Agent

    # `cdp()` is the raw channel and does not self-heal; the Agent constructor
    # calls this itself, but the harness resets origin state *before* the first
    # Agent exists. Without it, a daemon still holding a socket to a Chrome that
    # has since restarted fails with a bare "no close frame received or sent".
    ensure_daemon()

    attempts: list[dict] = []
    for task in tasks:
        for _ in range(args.repeat):
            a = run_one(Agent, cdp, task, args.action_budget)
            attempts.append(a)
            mark = "PASS" if a["ok"] else "FAIL"
            extra = "" if a["ok"] else f"  got={json.dumps(a['got'])[:120]}"
            err = f"  err={a['error']}" if a.get("error") else ""
            print(f"  {mark} jev            {a['task']:<22} "
                  f"decide {a['decisionMs'] / 1000:.1f}s  wall {a['wallMs'] / 1000:.0f}s  "
                  f"{a['modelRequests']} req ({a['jevRequests']} jev + {a['textCalls']} text)  "
                  f"{a['actions']} actions{extra}{err}")

    solved = sum(1 for a in attempts if a["ok"])
    print("\n## Jev arm\n")
    print("| model | solved | median decision time | median model requests | median actions |")
    print("|---|---|---|---|---|")
    print(f"| `jev-ultrafast` | {solved}/{len(attempts)} | "
          f"{median([a['decisionMs'] for a in attempts]) / 1000:.1f}s | "
          f"{median([a['modelRequests'] for a in attempts]):.0f} | "
          f"{median([a['actions'] for a in attempts]):.0f} |")

    out = BRO / f"bench-nav-jev-{int(time.time() * 1000)}.json"
    out.write_text(json.dumps({"arm": "jev", "attempts": attempts}, indent=2))
    print(f"\nRaw attempts: {out.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
