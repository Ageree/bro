"""Selectel VM lifecycle: stop→SHUTOFF, start→ACTIVE→service up, reboot→service up.

The VM runs `life-userdata.sh`: a systemd unit appends each boot's uptime to
boots.txt and serves it on :80, so «service up» is the first answer of a
unit started after network-online.target (what a browser host's hostd is).

    python3 sel.py up bench-life SL1.2-4096-32 ru-7a life-userdata.sh
    python3 life.py bench-life <ip>
"""

import json
import sys
import time
import urllib.request

from sel import api, server_by_name

name, ip = sys.argv[1], sys.argv[2]
sid = server_by_name(name)["id"]


def status():
    _, answer = api("GET", "compute", f"/servers/{sid}")
    return answer["server"]["status"]


def boots():
    try:
        return urllib.request.urlopen(f"http://{ip}/boots.txt", timeout=3).read().decode().count("boot ")
    except Exception:
        return -1


def wait(check, started, limit=900):
    while time.time() - started < limit:
        if check():
            return round(time.time() - started, 1)
        time.sleep(0.5)


result = {}
while boots() < 1:
    time.sleep(2)
for i in range(2):
    time.sleep(20)
    started = time.time()
    api("POST", "compute", f"/servers/{sid}/action", {"os-stop": None})
    result[f"stop{i}_shutoff_s"] = wait(lambda: status() == "SHUTOFF", started)
    time.sleep(5)
    seen = boots() if boots() > 0 else i + 1
    started = time.time()
    api("POST", "compute", f"/servers/{sid}/action", {"os-start": None})
    result[f"start{i}_active_s"] = wait(lambda: status() == "ACTIVE", started)
    result[f"start{i}_service_s"] = wait(lambda: boots() > seen, started)
    print(json.dumps(result), flush=True)
time.sleep(10)
seen = boots()
started = time.time()
api("POST", "compute", f"/servers/{sid}/action", {"reboot": {"type": "SOFT"}})
result["reboot_service_s"] = wait(lambda: boots() > seen, started)
print(json.dumps(result))
