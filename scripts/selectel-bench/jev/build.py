"""Fills userdata.tpl.sh for one bench VM (gzip: Nova caps user data at 65535 bytes after base64): this directory and jev-ultrafast's source go in as a tarball.

    JEV_SRC=/path/to/jev-ultrafast-checkout [JEV_VIA=routerai] python3 build.py OUT [ARMS] [TASKS] [REPS]
    git clone https://github.com/browser-use/jev-ultrafast && git -C jev-ultrafast checkout 1231850

Keys come from TYPESAFE_API_KEY and ROUTERAI_API_KEY and land in the VM's metadata: the script shreds its copies when it
ends; delete the VM afterwards (sel.py down).
"""

import base64
import gzip
import io
import os
import re
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
out = sys.argv[1]
arms = sys.argv[2] if len(sys.argv) > 2 else "ju_114,ju_114_img,ju_113"
tasks = sys.argv[3] if len(sys.argv) > 3 else "wiki,books,form,shop,rasp,flights,market"
reps = sys.argv[4] if len(sys.argv) > 4 else "3"
src = Path(os.environ["JEV_SRC"])
via_routerai = os.environ.get("JEV_VIA") == "routerai"  # the Jev key then is the RouterAI one


def clean(name):
    return re.sub(r"[^A-Za-z0-9._\-]", "", os.environ[name])


buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    for path in sorted(HERE.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.name not in {"userdata.tpl.sh", "build.py"}:
            tar.add(path, arcname="jev/" + str(path.relative_to(HERE)))
    for path in sorted((src / "jev_ultrafast").rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            tar.add(path, arcname="src/jev_ultrafast/" + str(path.relative_to(src / "jev_ultrafast")))
worker = (HERE.parent.parent.parent / "browser-vm/worker/worker.py").read_text()
extension = "\n\n".join(re.search(rf'{n} = """(.*?)"""', worker, re.S).group(1).strip() for n in ("EXTEND_SYSTEM", "BATCH_HINT"))


def b64(data):
    return base64.b64encode(data if isinstance(data, bytes) else data.encode()).decode()


script = (
    (HERE / "userdata.tpl.sh").read_text()
    .replace("__ROLE__", "jev114")
    .replace("__TS_B64__", b64(clean("ROUTERAI_API_KEY" if via_routerai else "TYPESAFE_API_KEY")))
    .replace("__JEV_ENV__", "TYPESAFE_URL=https://routerai.ru/api/v1/systemone TYPESAFE_MODEL_PREFIX=typesafe/ BOX_MODEL=typesafe/jev-1.14" if via_routerai else "")
    .replace("__KEY_B64__", b64(clean("ROUTERAI_API_KEY")))
    .replace("__PKG_B64__", b64(buf.getvalue()))
    .replace("__EXT_B64__", b64(extension + "\n"))
    .replace("__EXTRA_PIP__", "browser-use==0.13.10" if "bu_" in arms else "")
    .replace("__ARMS__", arms).replace("__TASKS__", tasks).replace("__REPS__", reps)
    .replace("__BOX__", os.environ.get("BOX", "1")).replace("__BOX_PER_PAGE__", os.environ.get("BOX_PER_PAGE", "8"))
)
packed = gzip.compress(script.encode(), 9)  # cloud-init takes gzip user data as is
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, packed)
os.close(fd)
encoded = len(base64.b64encode(packed))
print(f"{out}: {len(script)} bytes, {len(packed)} gzipped, {encoded} as base64 (Nova limit 65535)")
if encoded > 65535:
    raise SystemExit("user data too large")
