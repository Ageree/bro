"""Bro's browser errands against a local copy of PREDUBEZHDAI's checkout (checkout_shop.py), with the real agent.

    python checkout_harness.py --scenario start --model luna          (in browser-vm/worker)
    python checkout_harness.py --scenario all --model all --out <dir>

Each scenario runs the worker's own agent (`Worker.start_run` → `run_agent`: the same tools with fill_card,
system extension, tuning, secrets and follow-up memory as on a VM) on a Chromium launched as the VM's
bro-chrome unit launches its Chrome, with the task text and the secret bindings Bro's `composeBrowserTask`,
`composeBrowserContinuation` and `browserSecretBindings` write (checkout_tasks.json, from
tests/agent/tools/checkout-harness-tasks.test.ts). The shop is served as https://predubezhdai.ru and its card
frame as https://yoomoney.ru, on loopback addresses this Chromium resolves those names to, with a certificate
of the harness's own: a run sees the addresses its task names (GPT Luna refused to pay «on a local site»
127.0.0.1 when the task said predubezhdai.ru, 04.10). The model is called through RouterAI with the tuning
`runTuning` gives it (agent/lib/browser-vm/runs.ts). Every model call is paid: a run costs a few roubles.

What a run did is read off the shop's own request log, not the agent's word: an order paid once, by the
person's phone, for the store pickup and the 2 100 ₽ the person said yes to. The report (JSON, one per
scenario and model) keeps each step's goal and actions with their parameters, the agent's memory of each
step's results, the shop's requests and the verdict.

Needs browser-use 0.13.10, a Chromium (BRO_CHECKOUT_CHROME, else Playwright's), openssl, ROUTERAI_API_KEY and
root (the shop listens on port 443 of 127.0.0.2 and 127.0.0.3).
"""

import argparse
import asyncio
import contextlib
import dataclasses
import json
import logging
import os
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import checkout_shop as shop_module  # noqa: E402

CHROME = os.environ.get("BRO_CHECKOUT_CHROME") or "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
TASKS = HERE / "checkout_tasks.json"
ROUTERAI = "https://routerai.ru/api/v1"
# `runTuning` in agent/lib/browser-vm/runs.ts for each model on RouterAI: DeepSeek's hosts are the main agent's
# (`providerRouting`, agent/lib/model/direct.ts) less those without structured outputs.
MODELS = {
    "luna": {"model": "openai/gpt-6-luna",
             "tuning": {"maxActionsPerStep": 8, "reasoning": "medium", "provider": {"requireParameters": True}}},
    "deepseek": {"model": "deepseek/deepseek-v4.1-flash",
                 "tuning": {"maxActionsPerStep": 8, "reasoning": "none", "provider": {
                     "order": ["deepinfra"],
                     "ignore": ["deepseek", "alibaba", "morph", "wafer", "sail-research", "modal", "parasail",
                                "phala", "inference-net", "open-inference", "relace", "streamlake", "gmicloud",
                                "novita", "siliconflow"],
                     "requireParameters": True}}},
}
MAX_STEPS = 60  # runMaxSteps
TIMEOUT_S = 1500  # runTimeoutSeconds

SHOP, SHOP_HOST, SHOP_PORT = shop_module.REAL["shop"]
PAY, PAY_HOST, PAY_PORT = shop_module.REAL["pay"]


def routerai_key():
    """The key as a cloud session's env has it: in typographic quotes, sometimes with spaces."""
    return re.sub(r"[\s‘’“”\"']", "", os.environ.get("ROUTERAI_API_KEY", ""))


def tls_context(directory):
    """A certificate of the harness's own for both names: this Chromium ignores certificate errors."""
    key, cert = Path(directory) / "tls.key", Path(directory) / "tls.crt"
    names = ",".join(f"DNS:{origin.split('://')[1]}" for origin in (SHOP, PAY))
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out",
                    str(cert), "-days", "2", "-subj", "/CN=checkout-harness", "-addext", f"subjectAltName={names}"],
                   check=True, capture_output=True)
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(cert, key)
    return context


@dataclasses.dataclass
class Run:
    task: str  # a key of checkout_tasks.json's tasks
    secrets: str = "loginAndCard"  # a key of its secrets: what Bro binds for this run
    sign_out_before: bool = False  # the shop ends every session first (an expiry between two runs)


@dataclasses.dataclass
class Scenario:
    about: str
    runs: list
    shop: dict = dataclasses.field(default_factory=dict)  # Shop(...) options
    signed_in: bool = False  # the browser starts signed in to the person's account
    expect: str = "paid"  # "paid", or "stopped" (NEEDS: password or email_code, nothing paid)


SCENARIOS = {
    "start": Scenario("A fresh start, signed out: sign in, basket, checkout, store pickup, card.",
                      [Run("start")]),
    "continuation": Scenario(
        "The first run has no card yet and stops at payment; the shop signs everyone out; the follow-up "
        "(«карту в сейф добавил, запускай оплату») continues in the same session with the card.",
        [Run("startNoCard", secrets="login"), Run("continuation", sign_out_before=True)]),
    "guest": Scenario("No saved login: guest checkout is refused for the account's email (409).",
                      [Run("startGuest", secrets="card")], expect="stopped"),
    "phone": Scenario("Signed in, the basket filled, the city saved: the phone field with its fixed +7.",
                      [Run("start")], shop={"saved_city": True}, signed_in=True),
    "city": Scenario("Signed in, the basket filled, the phone saved: the city's late suggestions and the store.",
                     [Run("start")], shop={"saved_phone": True}, signed_in=True),
    "card": Scenario("Signed in, basket, phone and city saved: the store, СБП vs card, ЮKassa's frame.",
                     [Run("start")], shop={"saved_phone": True, "saved_city": True}, signed_in=True),
}


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


async def launch_chrome(profile):
    """Chromium as the VM's bro-chrome unit starts Chrome (browser-vm/image/provision.sh), headless and without
    the proxy: the agent reaches it over CDP through the worker, as on a VM."""
    port = free_port()
    args = [CHROME, f"--user-data-dir={profile}", "--remote-debugging-address=127.0.0.1",
            f"--remote-debugging-port={port}", "--no-proxy-server", "--no-first-run", "--no-default-browser-check",
            "--disable-dev-shm-usage", "--password-store=basic", "--window-size=1366,900", "--lang=ru-RU",
            "--accept-lang=ru-RU,ru,en-US,en", "--headless=new", "--site-per-process",
            f"--host-resolver-rules=MAP {SHOP.split('://')[1]} {SHOP_HOST}, MAP {PAY.split('://')[1]} {PAY_HOST}",
            "--ignore-certificate-errors", "about:blank"]
    if os.geteuid() == 0:
        args.insert(1, "--no-sandbox")
    process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return process, f"http://127.0.0.1:{port}"


def step_recorder(worker, trail):
    """The worker's step summary keeps only action names; the harness keeps each step's whole output too
    (actions with their parameters: secrets are placeholders there)."""
    # The worker's own, not a recorder an earlier scenario of this process put in its place.
    summary = getattr(worker.step_summary, "original", worker.step_summary)

    def recorded(state, output, number, tokens=None):
        entry = summary(state, output, number, tokens)
        with contextlib.suppress(Exception):
            full = output.model_dump(exclude_none=True, mode="json")
            trail.append({"number": number, "url": getattr(state, "url", None),
                          "evaluation": full.get("evaluation_previous_goal"), "memory": full.get("memory"),
                          "goal": full.get("next_goal"), "actions": full.get("action")})
        return entry

    recorded.original = summary
    return recorded


def agent_memory(agent_state):
    """The agent's own record of each step's results (errors and what actions returned)."""
    items = (((agent_state or {}).get("message_manager_state") or {}).get("agent_history_items") or [])
    return [{k: v for k, v in item.items() if v not in (None, "", [])} for item in items]


def needs_of(result):
    match = re.search(r"^NEEDS:\s*([a-z_]+)", result or "", re.M)
    return match[1] if match else None


def verdict(scenario, shop, runs):
    """Pass or fail, read off the shop: what was paid, by which details, and what the run tried on the way."""
    paid = shop.paid_orders()
    orders = list(shop.orders.values())
    refused = [(r["path"], r["status"], r["answer"]) for r in shop.log if r["path"].startswith("/api/")
               and r["status"] >= 400 and r["path"] != "/api/pay"]
    card_refusals = [r for r in shop.requests("/api/pay") if r["status"] != 200]
    facts = {
        "paid": len(paid), "orders": len(orders), "refused": refused, "cardRefusals": len(card_refusals),
        "legacyOrderPage": len(shop.requests("/order")) + len(shop.requests("/api/order")),
        "guestRefused": len([r for r in shop.requests("/api/orders") if r["status"] == 409]),
        "signIns": len([r for r in shop.requests("/api/auth/login") if r["status"] == 200]),
        "needs": needs_of(runs[-1].get("result")), "status": runs[-1].get("status"),
    }
    problems = []
    if scenario.expect == "paid":
        if len(paid) != 1:
            problems.append(f"{len(paid)} paid orders")
        for order in paid:
            customer = order["customer"]
            if customer.get("phone") != shop_module.PHONE or customer.get("countryCode") != "RU":
                problems.append(f"phone {customer.get('phone')} {customer.get('countryCode')}")
            if order["deliveryMethod"] != "pickup" or order["storeId"] != "chistoprudny":
                problems.append(f"delivery {order['deliveryMethod']} {order['storeId']}")
            if order["items"] != {"vam-i-ne-snilos-30": 1} or order["total"] != 2100:
                problems.append(f"items {order['items']} total {order['total']}")
            if order["email"] != shop_module.EMAIL:
                problems.append(f"order email {order['email']}")
    else:
        if paid:
            problems.append(f"{len(paid)} paid orders")
        if any(order["email"] != shop_module.EMAIL for order in orders):
            problems.append("an order under another email")
        if facts["needs"] not in ("password", "email_code"):
            problems.append(f"stopped with NEEDS: {facts['needs']}")
    if len(orders) > max(1, len(paid)):
        problems.append(f"{len(orders)} orders created")
    return {"pass": not problems, "problems": problems, **facts}


async def prepare_signed_in(worker, session, shop):
    """The browser already signed in. The basket stays empty: Bro's task text has a run take anything already
    in it out of the order, and GPT Luna emptied it and gave up."""
    sid = shop.new_session(shop_module.EMAIL)
    await worker.cdp_command(await worker.browser_socket(), "Storage.setCookies", {"cookies": [
        {"name": "sid", "value": sid, "domain": SHOP.split("://")[1], "path": "/", "httpOnly": True,
         "secure": True}]})


async def run_scenario(name, model_key, out_dir, fixture):
    """One scenario on one model; `fixture` is checkout_tasks.json: the task texts and Bro's secret bindings."""
    scenario, model = SCENARIOS[name], MODELS[model_key]
    state = Path(tempfile.mkdtemp(prefix=f"checkout-{name}-{model_key}-", dir=out_dir))
    os.environ["BRO_STATE_DIR"] = str(state / "worker")
    import worker  # noqa: PLC0415 - reads BRO_STATE_DIR when imported

    worker.ROOT = state / "worker"
    worker.RUNS, worker.SESSIONS, worker.UPLOADS = (worker.ROOT / p for p in ("runs", "sessions", "uploads"))
    worker.GENERATION_FILE, worker.TABS_FILE = worker.ROOT / "generation", worker.ROOT / "tabs.json"
    trail = []
    worker.step_summary = step_recorder(worker, trail)

    shop = shop_module.Shop(**scenario.shop, shop=SHOP, pay=PAY)
    await shop.start((SHOP_HOST, SHOP_PORT), (PAY_HOST, PAY_PORT), tls_context(state))
    chrome, cdp = await launch_chrome(state / "profile")
    worker.CDP_HTTP = cdp
    report = {"scenario": name, "about": scenario.about, "model": model["model"], "runs": []}
    try:
        if not await worker.wait_chrome(30):
            raise RuntimeError("Chromium did not start")
        bro = worker.Worker()
        # The VM's Chrome goes out through the worker's forwarder, which a run needs configured; this Chromium
        # talks to the local shop directly and never uses it.
        bro.forwarder.upstream = ("127.0.0.1", 9, None)
        session_id = f"checkout-{name}"
        session = bro.sessions.setdefault(session_id, worker.Session(session_id))
        if scenario.signed_in:
            await prepare_signed_in(worker, session, shop)
        llm = {"baseUrl": ROUTERAI, "apiKey": routerai_key(), "model": model["model"]}
        for index, step in enumerate(scenario.runs):
            if step.sign_out_before:
                shop.sign_out_everyone()
            trail.clear()
            started = time.monotonic()
            # The first run as Bro's `POST /v1/runs`, a follow-up as `POST /v1/sessions/<id>/messages` makes it.
            body = {"id": f"{session_id}-{index}", "sessionId": session_id, "task": fixture["tasks"][step.task],
                    "llm": llm, "tuning": model["tuning"], "maxSteps": MAX_STEPS, "timeoutSeconds": TIMEOUT_S,
                    "secrets": fixture["secrets"][step.secrets]}
            run, _ = await bro.start_run(body)
            while run.status not in worker.TERMINAL:
                await asyncio.sleep(1)
            report["runs"].append({
                "task": step.task, "status": run.status, "error": run.error, "result": run.result,
                "seconds": round(time.monotonic() - started), "usage": run.usage, "finalUrl": run.final_url,
                "steps": list(trail), "memory": agent_memory(session.agent_state)})
            log_line(f"{name}/{model_key} run {index + 1} ({step.task}): {run.status}, "
                     f"{len(trail)} steps, {report['runs'][-1]['seconds']} s, NEEDS: {needs_of(run.result)}")
    finally:
        chrome.terminate()
        with contextlib.suppress(Exception):
            chrome.wait(10)
        await shop.stop()
    report["verdict"] = verdict(scenario, shop, report["runs"])
    report["orders"] = list(shop.orders.values())
    report["shop"] = [r for r in shop.log if r["path"].startswith("/api/") or r["method"] == "GET"
                      and not r["path"].startswith("/api/")]
    path = Path(out_dir) / f"{name}-{model_key}-{time.strftime('%H%M%S')}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=1))
    log_line(f"{name}/{model_key}: {'PASS' if report['verdict']['pass'] else 'FAIL'} "
             f"{report['verdict']['problems']} → {path}")
    return report


def log_line(text):
    print(text, flush=True)


def trail_text(report):
    """The runs' steps, one line each: where, what for and which actions."""
    lines = []
    for number, run in enumerate(report["runs"], 1):
        lines.append(f"--- run {number} ({run['task']}): {run['status']}")
        for step in run["steps"]:
            actions = "; ".join(
                f"{name}({json.dumps(params, ensure_ascii=False)[:120]})"
                for action in step.get("actions") or [] for name, params in action.items())
            path = re.sub(r"^https?://[^/]+", "", step.get("url") or "")
            lines.append(f"{step['number']:>2} {path} | {(step.get('goal') or '')[:160]} | {actions}")
        lines.append(f"RESULT: {(run.get('result') or run.get('error') or '')[-900:]}")
    return "\n".join(lines)


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scenario", default="start", help=f"one of {', '.join(SCENARIOS)} or all")
    parser.add_argument("--model", default="luna", help=f"one of {', '.join(MODELS)} or all")
    parser.add_argument("--out", default=str(Path(tempfile.gettempdir()) / "bro-checkout"))
    parser.add_argument("--trail", action="store_true", help="print each run's steps")
    options = parser.parse_args()
    if not routerai_key():
        sys.exit("ROUTERAI_API_KEY is not set")
    # The model's calls go through the session's proxy; the shop must not.
    os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
    Path(options.out).mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=str(Path(options.out) / "browser-use.log"), level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    fixture = json.loads(TASKS.read_text())
    names = list(SCENARIOS) if options.scenario == "all" else options.scenario.split(",")
    models = list(MODELS) if options.model == "all" else options.model.split(",")
    for name in names:
        for model_key in models:
            report = await run_scenario(name, model_key, options.out, fixture)
            if options.trail:
                print(trail_text(report), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
