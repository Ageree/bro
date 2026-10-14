"""Box grounding on real pages: can Jev 1.14 find a labelled element on a screenshot?

For each page a few visible, uniquely labelled controls are taken from the DOM (the truth: their rectangles), the page
is screenshotted at 1120x780 and Jev is asked `Where is the <role> "<label>" in screen?` (a Box question).
A hit is a box whose centre lies inside the element. Reported per page: hits, IoU, request latency, tokens.

    python box_bench.py OUT.jsonl [per_page]
"""

import base64
import json
import os
import sys
import time
import uuid

import httpx

from chrome import Chrome

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/shim")
from browser_harness import helpers  # noqa: E402
from browser_harness.helpers import cdp  # noqa: E402

KEY = open("/etc/bench/typesafe").read().strip()
OUT = sys.argv[1]
PER_PAGE = int(sys.argv[2]) if len(sys.argv) > 2 else 8
URL = os.environ.get("TYPESAFE_URL", "https://api.typesafe.ai/v1/systemone")
MODEL = os.environ.get("BOX_MODEL", "jev-1.14.0")
PAGES = os.environ["BOX_PAGES"].split(",") if os.environ.get("BOX_PAGES") else [
    "https://ru.wikipedia.org/", "https://en.wikipedia.org/wiki/Moscow", "https://www.saucedemo.com/",
    "https://www.selenium.dev/selenium/web/web-form.html", "https://books.toscrape.com/", "https://news.ycombinator.com/",
    "https://github.com/browser-use/browser-use", "https://rasp.yandex.ru/", "https://market.yandex.ru/",
    "https://www.google.com/travel/flights?hl=en", "https://www.wildberries.ru/",
]
FIND = """(() => {
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 8 && r.top >= 0 && r.left >= 0 &&
    r.bottom <= innerHeight && r.right <= innerWidth && e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
    e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); };
  const name = e => (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || '').trim().replace(/\\s+/g, ' ');
  const role = e => e.getAttribute('role') || (e.tagName === 'A' ? 'link' : e.tagName === 'BUTTON' ? 'button' : e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' ? 'text field' : e.tagName === 'SELECT' ? 'dropdown' : 'control');
  const all = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab]')].filter(vis);
  const counts = {}; all.forEach(e => { const n = name(e); counts[n] = (counts[n] || 0) + 1; });
  return all.map(e => ({label: name(e), role: role(e), r: e.getBoundingClientRect().toJSON()}))
    .filter(x => x.label && x.label.length <= 60 && counts[x.label] === 1);
})()"""


def screenshot(session):
    return cdp("Page.captureScreenshot", session_id=session, format="png")["data"]


def ask(shot_b64, label, role):
    ref = str(uuid.uuid4())
    body = {"model": MODEL, "state": {"screen": ref}, "assets": {ref: {"type": "image", "format": "png", "data_base64": shot_b64}},
            "questions": {"where": {"type": "box", "instructions": f'Where is the {role} labelled "{label}" in `screen`?'}}}
    t0 = time.perf_counter()
    r = httpx.post(URL, json=body, timeout=40,
                   headers={"Authorization": f"Bearer {KEY}", "TypeSafe-Danger-Zone-Images": "true"})
    ms = round((time.perf_counter() - t0) * 1000)
    r.raise_for_status()
    j = r.json()
    return j["answers"]["where"], ms, j.get("usage", {})


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0


for url in PAGES:
    with Chrome():
        helpers._state["ws"] = None
        target = cdp("Target.createTarget", url="about:blank")["targetId"]
        session = cdp("Target.attachToTarget", targetId=target, flatten=True)["sessionId"]
        cdp("Emulation.setDeviceMetricsOverride", session_id=session, width=1120, height=780, deviceScaleFactor=1, mobile=False)
        cdp("Page.navigate", session_id=session, url=url)
        time.sleep(7)
        found = cdp("Runtime.evaluate", session_id=session, expression=FIND, returnByValue=True)["result"].get("value") or []
        title = cdp("Runtime.evaluate", session_id=session, expression="document.title", returnByValue=True)["result"].get("value")
        step = max(1, len(found) // PER_PAGE)
        picked = found[::step][:PER_PAGE]
        shot = screenshot(session)
        for item in picked:
            r = item["r"]
            truth = (r["x"] / 1120, r["y"] / 780, (r["x"] + r["width"]) / 1120, (r["y"] + r["height"]) / 780)
            rec = {"url": url, "title": title, "label": item["label"], "role": item["role"], "candidates": len(found), "truth": [round(v, 3) for v in truth]}
            try:
                ans, ms, usage = ask(shot, item["label"], item["role"])
                b = ans["box"]
                pred = (b["left"], b["top"], b["right"], b["bottom"])
                cx, cy = (pred[0] + pred[2]) / 2, (pred[1] + pred[3]) / 2
                rec.update(ms=ms, conf=ans.get("confidence"), pred=[round(v, 3) for v in pred], hit=truth[0] <= cx <= truth[2] and truth[1] <= cy <= truth[3],
                           iou=round(iou(truth, pred), 3), tokens=usage.get("input_tokens"))
            except Exception as e:
                rec.update(err=f"{type(e).__name__}: {str(e)[:200]}")
            with open(OUT, "a") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            print("BOX", url[:40], item["label"][:30], rec.get("hit"), rec.get("ms"), rec.get("iou"), flush=True)
