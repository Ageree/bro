"""Runs on the bench VM: every task x rep x arm as its own process (fresh Chrome, hard timeout), then the Box grounding bench.

    ARMS=ju_114,ju_114_img,ju_113 TASKS=wiki,books,... REPS=3 python orchestrate.py

Arms in rotation order per task and rep, so drift of the network or the sites hits every arm alike. browser-use arms
(bu_dst_flash, bu_ds_full) are off unless named in ARMS.
"""

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
R = "/var/www/bench"
ARMS = os.environ.get("ARMS", "ju_114,ju_114_img,ju_113").split(",")
TASKS = os.environ.get("TASKS", "wiki,books,form,shop,rasp,flights,market").split(",")
REPS = int(os.environ.get("REPS", "3"))


def log(message):
    line = f"BENCH {message}"
    print(line, flush=True)
    with open(f"{R}/log.txt", "a") as f:
        f.write(line + "\n")


def run(script, *args, timeout):
    t0 = time.time()
    try:
        done = subprocess.run([sys.executable, os.path.join(HERE, script), *args], timeout=timeout, capture_output=True, text=True, cwd=HERE)
        tail = (done.stdout.strip().splitlines() or [""])[-1] if done.returncode == 0 else f"rc={done.returncode} {done.stderr.strip()[-300:]}"
    except subprocess.TimeoutExpired:
        tail = "timeout"
    log(tail if tail.startswith("BENCH") else f"{script} {' '.join(args)} {tail}")
    return time.time() - t0


log(f"start arms={ARMS} tasks={TASKS} reps={REPS}")
for rep in range(REPS):
    for i, task in enumerate(TASKS):
        order = ARMS[(i + rep) % len(ARMS):] + ARMS[:(i + rep) % len(ARMS)]
        for arm in order:
            script = "run_bu.py" if arm.startswith("bu_") else "run_jev.py"
            run(script, arm, task, str(rep), f"{R}/runs.jsonl", timeout=260)
if os.environ.get("BOX", "1") == "1":
    run("box_bench.py", f"{R}/box.jsonl", os.environ.get("BOX_PER_PAGE", "8"), timeout=1500)
log("all-done")
