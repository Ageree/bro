/**
 * Cloud arm of the navigation benchmark: Browser Use Cloud V4 against
 * `scripts/lib/nav-tasks.ts`, graded only by the state of the page it left.
 *
 * The Jev arm lives in `scripts/jev-nav-bench.py` and reads its task list from
 * this script's `--dump-tasks`, so neither arm can drift from the other's
 * definition of the job or of success.
 *
 * ## What is timed, and why not wall clock
 *
 * Total run time is not comparable between the arms and is never the headline
 * here. Cloud provisions a remote browser behind a proxy and cold-starts a
 * worker; `jev-ultrafast` talks to a Chrome already running on this machine.
 * Timing that would hand Jev several seconds it never earned.
 *
 * So both arms are timed by Browser Use's own published boundary
 * (docs/performance.md in jev-ultrafast): *from the first prediction to the
 * accepted DONE*, with browser bring-up outside the clock.
 *
 *   Cloud: first `llm.request` event -> last `llm.response` event.
 *   Jev:   `state["elapsed_ms"]`, which the agent starts on its first predict.
 *
 * One asymmetry is not removable and is therefore measured and printed.
 * `RunCreateRequest` has no field for an already-open page (only `sessionId`,
 * which drags the previous run's conversation history along), so the Cloud
 * agent navigates to the start URL *inside* its own clock, while the Jev agent
 * is constructed on the page and starts timing after that.
 *
 * `toFirstBrowserActionMs` bounds that from above: first `llm.request` until
 * the first browser tool call returns. Read it as a ceiling, not as the cost
 * of the navigation — most of the interval is the agent loading its browser
 * skill and reasoning for a turn or two, which is real agent work and belongs
 * in the clock. The navigation-only part is a fraction of it and is not
 * separately observable in the event stream. Either way the bias runs against
 * Cloud, so it cannot manufacture a Jev win.
 *
 * Model requests are counted separately from time: one number is the bill, the
 * other is the wait, and Jev's whole claim is about the shape of the first.
 *
 * ## Modes
 *
 *   node --experimental-strip-types scripts/nav-bench.ts              # dry plan + estimate
 *   node --experimental-strip-types scripts/nav-bench.ts --validate   # prove the checks locally, free
 *   node --experimental-strip-types scripts/nav-bench.ts --dump-tasks # task JSON for the Jev arm
 *   node --experimental-strip-types scripts/nav-bench.ts --run --models gpt-5.6-luna --repeat 3
 *
 * `--run` spends real money. Everything else touches neither the API nor the
 * wallet.
 */

import { Cdp, listTargets, pickPage } from "./lib/cdp-eval.ts";
import { NAV_TASKS, RESET_STORAGE_JS, type NavTask } from "./lib/nav-tasks.ts";
import { V4_MODELS } from "./model-bench.ts";

const BASE = process.env.BROWSER_USE_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://api.browser-use.com/api/v4";

/** Local Chrome the Jev arm drives; used here only by `--validate`. */
const LOCAL_CDP = process.env.LOCAL_CDP_URL?.trim() || "http://127.0.0.1:9222";

function key(): string {
  // Same whitespace strip as scripts/model-bench.ts: the secret store hands
  // this key back with a newline inside the value, and `fetch` refuses such a
  // header before the request leaves the process.
  const k = process.env.BROWSER_USE_API_KEY?.replace(/\s+/g, "");
  if (!k) throw new Error("BROWSER_USE_API_KEY missing");
  return k;
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "X-Browser-Use-API-Key": key(),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * The prompt handed to the Cloud agent: the shared goal, plus the one line of
 * arm-specific scaffolding it needs that the Jev arm gets from its
 * constructor argument. Nothing about *how* to do the task, and no answer
 * format — the page is the answer.
 */
export function cloudPrompt(task: NavTask): string {
  return `Open ${task.startUrl} in the browser. ${task.goal}`;
}

export type Verdict = { ok: boolean; got: unknown };

/** Independent grading: read the page the agent left, believe nothing else. */
export async function verifyOnCdp(cdpUrl: string, task: NavTask): Promise<Verdict> {
  const cdp = await Cdp.connect(cdpUrl);
  try {
    const page = pickPage(await listTargets(cdpUrl));
    if (!page) return { ok: false, got: "no page target in the browser" };
    const sid = await cdp.attach(page.id);
    const raw = await cdp.evaluate(sid, task.check);
    if (!raw || typeof raw !== "object" || typeof (raw as Verdict).ok !== "boolean") {
      return { ok: false, got: `check returned ${JSON.stringify(raw)?.slice(0, 200)}` };
    }
    return raw as Verdict;
  } finally {
    cdp.close();
  }
}

/** The browser that served a run, so its final page can be read back. */
async function browserForSession(sessionId: string): Promise<any | undefined> {
  const list = await api(`/browsers?limit=50`).catch(() => ({}));
  const items: any[] = Array.isArray(list?.items) ? list.items : [];
  return items.find((b) => (b?.agentSessionId ?? b?.agent_session_id) === sessionId);
}

type Ev = { ts: string; type: string; data?: any };

function ms(ts: string): number {
  return new Date(ts).getTime();
}

/**
 * Pull the decision window out of a run's event stream.
 *
 * The event types were read off a live run before this was written: queueing,
 * `run.dispatching`, `browser.ready`, `worker.started`, `workspace.ready` and
 * `core.spawn` all land before the first `llm.request` — in the probe run that
 * was 3.2 s of the 14.6 s total, none of it the model's thinking.
 */
export function decisionWindow(events: readonly Ev[]): {
  decisionMs: number;
  setupMs: number;
  modelRequests: number;
  toFirstBrowserActionMs: number | null;
  firstRequestAt: number | null;
} {
  const created = events.find((e) => e.type === "run.created");
  const requests = events.filter((e) => e.type === "llm.request");
  const responses = events.filter((e) => e.type === "llm.response");
  const first = requests[0] ? ms(requests[0].ts) : null;
  const last = responses.length ? ms(responses[responses.length - 1].ts) : null;

  // Upper bound on the boundary difference between the arms: how long after
  // its first prediction the agent first finished touching the browser. Most
  // of this is start-up reasoning and skill loading, not the navigation.
  let toFirstBrowserActionMs: number | null = null;
  if (first !== null) {
    for (const e of events) {
      const part = e.data?.part;
      if (part?.type !== "tool" || part?.tool !== "browser_execute") continue;
      const end = Number(part?.state?.time?.end);
      if (Number.isFinite(end) && end >= first) {
        toFirstBrowserActionMs = end - first;
        break;
      }
    }
  }

  return {
    decisionMs: first !== null && last !== null && last > first ? last - first : 0,
    setupMs: created && first !== null ? first - ms(created.ts) : 0,
    modelRequests: requests.length,
    toFirstBrowserActionMs,
    firstRequestAt: first,
  };
}

async function allEvents(runId: string): Promise<Ev[]> {
  const out: Ev[] = [];
  let after = 0;
  for (let page = 0; page < 20; page++) {
    const body = await api(`/runs/${runId}/events?limit=200&after=${after}`).catch(() => ({}));
    const batch: Ev[] = Array.isArray(body?.events) ? body.events : [];
    out.push(...batch);
    if (!body?.hasMore || typeof body?.nextAfter !== "number" || !batch.length) break;
    after = body.nextAfter;
  }
  return out;
}

export type Attempt = {
  arm: "cloud";
  model: string;
  task: string;
  status: string;
  ok: boolean;
  got: unknown;
  decisionMs: number;
  wallMs: number;
  setupMs: number;
  toFirstBrowserActionMs: number | null;
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  browserCostUsd: number;
  result: string;
  runId?: string;
  error?: string;
};

async function runOne(model: string, task: NavTask, maxCostUsd: number, timeoutMs: number): Promise<Attempt> {
  const base: Attempt = {
    arm: "cloud", model, task: task.id, status: "error", ok: false, got: null,
    decisionMs: 0, wallMs: 0, setupMs: 0, toFirstBrowserActionMs: null, modelRequests: 0,
    inputTokens: 0, outputTokens: 0, costUsd: 0, browserCostUsd: 0, result: "",
  };
  const started = Date.now();
  try {
    const run = await api("/runs", {
      method: "POST",
      body: JSON.stringify({ task: cloudPrompt(task), model, maxCostUsd }),
    });
    const id = run?.id;
    if (!id) throw new Error(`no run id: ${JSON.stringify(run).slice(0, 200)}`);
    const sessionId = run?.sessionId;

    let summary: any = run;
    while (!["completed", "failed", "cancelled"].includes(String(summary?.status))) {
      if (Date.now() - started > timeoutMs) {
        await api(`/runs/${id}/cancel`, { method: "POST" }).catch(() => {});
        summary = { ...summary, status: "timeout" };
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
      summary = await api(`/runs/${id}`);
    }

    const events = await allEvents(id);
    const win = decisionWindow(events);
    const browser = sessionId ? await browserForSession(sessionId) : undefined;

    // Grade the browser, not the run's prose. A `completed` status with a
    // confident summary and an untouched page is exactly the failure the whole
    // suite exists to catch.
    let verdict: Verdict = { ok: false, got: "no cdp url for the run's browser" };
    if (browser?.cdpUrl) {
      verdict = await verifyOnCdp(browser.cdpUrl, task)
        .catch((e) => ({ ok: false, got: `verify failed: ${String((e as Error).message).slice(0, 160)}` }));
    }
    // A finished run does NOT stop its cloud browser, and an abandoned one
    // bills until the 4-hour cap — the same trap `stopBrowserForSession` in
    // agent/lib/browseruse.ts exists for. Left unstopped, a 21-run sweep costs
    // more in idle browsers than in the models it was measuring: this suite's
    // first pass billed $0.13 of model time and left $1.68 of browsers alive.
    // Stop it now that the page has been read back.
    if (browser?.id) {
      await api(`/browsers/${browser.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "stop" }),
      }).catch(() => {});
    }

    return {
      ...base,
      status: String(summary?.status ?? "unknown"),
      ok: verdict.ok,
      got: verdict.got,
      decisionMs: win.decisionMs,
      setupMs: win.setupMs,
      toFirstBrowserActionMs: win.toFirstBrowserActionMs,
      modelRequests: win.modelRequests,
      wallMs: Date.now() - started,
      inputTokens: Number(summary?.totalInputTokens ?? 0),
      outputTokens: Number(summary?.totalOutputTokens ?? 0),
      costUsd: Number(summary?.totalCostUsd ?? 0),
      browserCostUsd: Number(browser?.browserCost ?? 0),
      result: String(summary?.result ?? "").slice(0, 300),
      runId: id,
    };
  } catch (err) {
    return { ...base, wallMs: Date.now() - started, error: String((err as Error).message).slice(0, 300) };
  }
}

/* ------------------------------------------------------------------ *
 * --validate: prove the checks against the live sites, for free.
 *
 * These scripted solutions are HARNESS code, never agent input. They exist so
 * a green benchmark cannot come from a check that is true on any page, and a
 * red one cannot come from a check that is true on none. Each task must read
 * false before and true after.
 * ------------------------------------------------------------------ */

/** Type into a React-controlled input the way a user would, not via `.value`. */
function typeJs(selector: string, value: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("no " + ${JSON.stringify(selector)});
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  })()`;
}

const clickJs = (selector: string) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("no " + ${JSON.stringify(selector)}); el.click(); return true; })()`;

const SAUCE_LOGIN = [
  typeJs("#user-name", "standard_user"),
  typeJs("#password", "secret_sauce"),
  clickJs("#login-button"),
];

const addToCartJs = (name: string) => `(() => {
  const card = [...document.querySelectorAll(".inventory_item")]
    .find((i) => i.querySelector(".inventory_item_name").textContent.includes(${JSON.stringify(name)}));
  if (!card) throw new Error("no card " + ${JSON.stringify(name)});
  card.querySelector("button").click();
  return true;
})()`;

const SOLUTIONS: Record<string, string[]> = {
  "sauce-login": SAUCE_LOGIN,
  "sauce-cart": [...SAUCE_LOGIN, addToCartJs("Fleece Jacket"), clickJs(".shopping_cart_link")],
  "sauce-checkout": [
    ...SAUCE_LOGIN, addToCartJs("Onesie"), clickJs(".shopping_cart_link"), clickJs("#checkout"),
    typeJs("#first-name", "Ivan"), typeJs("#last-name", "Petrov"), typeJs("#postal-code", "101000"),
    clickJs("#continue"),
  ],
  "internet-login": [
    typeJs("#username", "tomsmith"),
    typeJs("#password", "SuperSecretPassword!"),
    clickJs("button[type=submit]"),
  ],
  "internet-checkboxes": [
    `(() => { const b = [...document.querySelectorAll("#checkboxes input")];
       b.forEach((x) => { if (!x.checked) x.click(); }); return true; })()`,
  ],
  "internet-dropdown": [
    `(() => { const s = document.querySelector("#dropdown"); s.value = "2";
       s.dispatchEvent(new Event("change", { bubbles: true })); return s.value; })()`,
  ],
  "webscraper-product": [
    `(() => { const a = [...document.querySelectorAll("a.title")]
       .find((x) => (x.getAttribute("title") || x.textContent).includes("ThinkPad T540p"));
       if (!a) throw new Error("no ThinkPad T540p link"); a.click(); return true; })()`,
  ],
};

/** Wipe an origin's cookies and storage so an attempt starts clean. */
export async function resetOrigins(cdp: Cdp, sid: string, origins: readonly string[]): Promise<void> {
  for (const origin of origins) {
    await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }, sid).catch(() => {});
  }
  await cdp.send("Network.clearBrowserCookies", {}, sid).catch(() => {});
}

async function validate(only: string[]): Promise<number> {
  const tasks = only.length ? NAV_TASKS.filter((t) => only.includes(t.id)) : NAV_TASKS;
  console.log(`# Validating ${tasks.length} checks against the live sites (no model calls, no cost)\n`);
  let bad = 0;
  const cdp = await Cdp.connect(LOCAL_CDP);
  try {
    for (const task of tasks) {
      const target = await cdp.send("Target.createTarget", { url: "about:blank" });
      const sid = await cdp.attach(target.targetId);
      try {
        await resetOrigins(cdp, sid, task.resetOrigins);
        await cdp.send("Page.navigate", { url: task.startUrl }, sid);
        await settle(cdp, sid);
        await cdp.evaluate(sid, RESET_STORAGE_JS).catch(() => {});
        await cdp.send("Page.navigate", { url: task.startUrl }, sid);
        await settle(cdp, sid);

        const before = (await cdp.evaluate(sid, task.check)) as Verdict;
        for (const step of SOLUTIONS[task.id] ?? []) {
          await cdp.evaluate(sid, step);
          await settle(cdp, sid, 900);
        }
        const after = (await cdp.evaluate(sid, task.check)) as Verdict;

        const good = before?.ok === false && after?.ok === true;
        if (!good) bad++;
        console.log(
          `  ${good ? "ok  " : "FAIL"} ${task.id.padEnd(22)} before=${before?.ok} after=${after?.ok}` +
            (good ? "" : `\n         before.got=${JSON.stringify(before?.got)}\n         after.got=${JSON.stringify(after?.got)}`),
        );
      } catch (e) {
        bad++;
        console.log(`  FAIL ${task.id.padEnd(22)} ${String((e as Error).message).slice(0, 160)}`);
      } finally {
        await cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
      }
    }
  } finally {
    cdp.close();
  }
  console.log(bad ? `\n${bad} check(s) did not flip false -> true` : `\nall checks flip false -> true on the live sites`);
  return bad;
}

/** Wait for the page to stop being busy; crude but enough for the validator. */
async function settle(cdp: Cdp, sid: string, budgetMs = 6000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const ready = await cdp.evaluate(sid, `document.readyState`).catch(() => null);
    if (ready === "complete") {
      await new Promise((r) => setTimeout(r, 400));
      return;
    }
  }
}

/* ------------------------------------------------------------------ */

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const only = arg("tasks", "").split(",").map((t) => t.trim()).filter(Boolean);

  if (process.argv.includes("--dump-tasks")) {
    console.log(JSON.stringify(NAV_TASKS, null, 2));
    return;
  }
  if (process.argv.includes("--validate")) {
    process.exit((await validate(only)) ? 1 : 0);
  }

  const models = arg("models", "gpt-5.6-luna").split(",").map((m) => m.trim()).filter(Boolean);
  const repeat = Math.max(1, Number(arg("repeat", "1")));
  const concurrency = Math.max(1, Number(arg("concurrency", "2")));
  const maxCostUsd = Number(arg("max-cost", "0.25"));
  const timeoutMs = Number(arg("timeout", "300")) * 1000;
  const live = process.argv.includes("--run");

  const unknown = models.filter((m) => !V4_MODELS.has(m));
  if (unknown.length) {
    console.error(`Unknown V4 model id: ${unknown.join(", ")}`);
    console.error(`Supported:\n  ${[...V4_MODELS].join("\n  ")}`);
    process.exit(2);
  }

  const tasks = only.length ? NAV_TASKS.filter((t) => only.includes(t.id)) : NAV_TASKS;
  if (!tasks.length) {
    console.error(`No task matched. Known: ${NAV_TASKS.map((t) => t.id).join(", ")}`);
    process.exit(2);
  }

  const jobs: { model: string; task: NavTask }[] = [];
  for (const model of models) for (const task of tasks) for (let i = 0; i < repeat; i++) jobs.push({ model, task });

  console.log(`# Navigation benchmark — Browser Use Cloud arm\n`);
  console.log(`models:      ${models.join(", ")}`);
  console.log(`tasks:       ${tasks.map((t) => t.id).join(", ")}`);
  console.log(`repeats:     ${repeat}   runs: ${jobs.length}   cap: $${maxCostUsd.toFixed(2)}/run`);
  console.log(`worst case:  $${(jobs.length * maxCostUsd).toFixed(2)} if every run hits its cap`);
  console.log(`graded by:   final page state read over CDP, not the run's answer text\n`);

  if (!live) {
    console.log(`Dry plan — nothing sent, nothing billed. Add --run to execute.\n`);
    for (const t of tasks) {
      console.log(`  ${t.id.padEnd(22)} ${t.stresses}`);
      console.log(`  ${" ".repeat(22)} prompt: ${cloudPrompt(t).slice(0, 150)}`);
    }
    return;
  }

  const attempts: Attempt[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const a = await runOne(job.model, job.task, maxCostUsd, timeoutMs);
        attempts.push(a);
        console.log(
          `  ${a.ok ? "PASS" : "FAIL"} ${a.model.padEnd(14)} ${a.task.padEnd(22)} ` +
            `decide ${(a.decisionMs / 1000).toFixed(1)}s  wall ${(a.wallMs / 1000).toFixed(0)}s  ` +
            `${a.modelRequests} req  $${a.costUsd.toFixed(4)}` +
            (a.ok ? "" : `  got=${JSON.stringify(a.got)?.slice(0, 120)}`),
        );
      }
    }),
  );

  console.log(`\n## Cloud arm\n`);
  console.log(`| model | solved | median decision time | median model requests | median cost | median wall |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const model of models) {
    const mine = attempts.filter((a) => a.model === model);
    const solved = mine.filter((a) => a.ok).length;
    console.log(
      `| \`${model}\` | ${solved}/${mine.length} | ${(median(mine.map((a) => a.decisionMs)) / 1000).toFixed(1)}s | ` +
        `${median(mine.map((a) => a.modelRequests))} | $${median(mine.map((a) => a.costUsd)).toFixed(4)} | ` +
        `${(median(mine.map((a) => a.wallMs)) / 1000).toFixed(0)}s |`,
    );
  }

  const setup = attempts.map((a) => a.setupMs).filter((n) => n > 0);
  const resid = attempts.map((a) => a.toFirstBrowserActionMs).filter((n): n is number => typeof n === "number" && n > 0);
  console.log(`\nExcluded infrastructure (queue, dispatch, browser boot, worker cold start):`);
  console.log(`  median ${(median(setup) / 1000).toFixed(1)}s per run — outside every decision-time number above.`);
  if (resid.length) {
    console.log(`Time to first browser action, inside Cloud's clock: median ${(median(resid) / 1000).toFixed(1)}s.`);
    console.log(`  A ceiling on the start-page asymmetry, not the navigation's cost: most of it is`);
    console.log(`  the agent's own start-up reasoning. Jev starts timing already on the page.`);
  }

  const out = `bench-nav-cloud-${Date.now()}.json`;
  await (await import("node:fs/promises")).writeFile(out, JSON.stringify({ arm: "cloud", models, attempts }, null, 2));
  console.log(`\nRaw attempts: ${out}`);
  console.log(`Total model spend: $${attempts.reduce((s, a) => s + a.costUsd, 0).toFixed(4)}`);
}

if (import.meta.filename === process.argv[1]) await main();
