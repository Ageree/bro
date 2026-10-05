"""Fills `userdata.tpl.sh` for one bench VM. The worker's own system message
extension (EXTEND_SYSTEM and BATCH_HINT of browser-vm/worker/worker.py) goes
in as is, so the agent runs with Bro's rules. The RouterAI key comes from
ROUTERAI_API_KEY and lands in the VM's metadata: the script shreds its copy
when the runs end; delete the VM afterwards (`sel.py down`).

    python3 build_userdata.py OUT ROLE CONFIGS TASKS BUDGET_RUB
    python3 build_userdata.py /tmp/ud-hfl.sh hfl dst_full,ds_full market,wb,avito,rasp,ozon 55
"""

import base64
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
out, role, configs, tasks, budget = sys.argv[1:6]
worker = (HERE.parent.parent / "browser-vm/worker/worker.py").read_text()
extension = "\n\n".join(
    re.search(rf'{name} = """(.*?)"""', worker, re.S).group(1).strip()
    for name in ("EXTEND_SYSTEM", "BATCH_HINT")
)
key = os.environ["ROUTERAI_API_KEY"].strip().strip("“”‘’«»\"' ")


def b64(data):
    return base64.b64encode(data if isinstance(data, bytes) else data.encode()).decode()


script = (
    (HERE / "userdata.tpl.sh").read_text()
    .replace("__ROLE__", role)
    .replace("__KEY_B64__", b64(key))
    .replace("__BU_B64__", b64((HERE / "bu_bench.py").read_bytes()))
    .replace("__CDP_B64__", b64((HERE / "cdp.py").read_bytes()))
    .replace("__EXT_B64__", b64(extension + "\n"))
    .replace("__CONFIGS__", configs)
    .replace("__TASKS__", tasks)
    .replace("__BUDGET__", budget)
)
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, script.encode())
os.close(fd)
print(f"{out}: {len(script)} bytes")
