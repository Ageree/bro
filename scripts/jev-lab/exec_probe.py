"""Drive a jev checkout's own executor (Browser.observe/act) by element label, with no model or helper calls.

  <jev>/.venv/bin/python exec_probe.py --jev ../jev-ultrafast --port 9251 URL "label" ["label" | sleep:0.5 | type:label=text ...]

After each step it prints what jev's snapshot observes. Useful to tell an observation/execution problem from a
decision problem for free. --activate brings jev's background target to the front first (for comparison).
Use only your own port, and not while a run is using it.
"""

import argparse
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lab  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--jev", required=True)
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--activate", action="store_true")
parser.add_argument("url")
parser.add_argument("steps", nargs="*")
args = parser.parse_args()
os.environ.update(lab.env_for(args.jev, args.port))
sys.path.insert(0, str(Path(args.jev).resolve()))
from jev_ultrafast.browser import Browser  # noqa: E402


def show(prefix, page):
    labels = [f"{a['kind']}:{a['label'][:40]}" for a in page["actions"] if a["kind"] not in ("wait",)]
    print(f"{prefix}: {len(labels)} actions | " + "; ".join(labels))


browser = Browser(args.url)
try:
    if args.activate:
        from browser_harness.helpers import cdp

        cdp("Target.activateTarget", targetId=browser.target)
    page = browser.observe(screenshot=False)
    show("start", page)
    for step in args.steps:
        if step.startswith("sleep:"):
            time.sleep(float(step[6:]))
            page = browser.observe(screenshot=False)
        else:
            kind, label, text = "click", step, None
            if step.startswith("type:"):
                kind, (label, text) = "fill", step[5:].split("=", 1)
            action = next(a for a in page["actions"] if a["kind"] == kind and a["label"] == label)
            browser.act(action, page, text=text)
            page = browser.observe(screenshot=False)
        show(f"after {step!r}", page)
finally:
    browser.close()
