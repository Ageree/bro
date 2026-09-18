/**
 * Offline regression for the navigation benchmark.
 *
 * Touches no network, no browser and no wallet. Two things are guarded here,
 * because both are ways the benchmark could lie while looking healthy:
 *
 *  1. **The graders.** A check that is true on any page turns the suite green
 *     for free; one that is true on no page turns it red for free. Each task's
 *     check is evaluated against a fake DOM in the solved state and in a wrong
 *     state, and must say `true` then `false`. The live counterpart of this —
 *     the same flip driven through a real browser — is
 *     `nav-bench.ts --validate`.
 *  2. **The Cloud clock.** `decisionWindow()` is what makes the two arms
 *     comparable at all: it has to drop queueing, dispatch, browser boot and
 *     worker cold start, and keep exactly first prediction -> last response.
 *     Synthetic event streams pin that down.
 */

import { NAV_TASKS } from "./lib/nav-tasks.ts";
import { cloudPrompt, decisionWindow } from "./nav-bench.ts";
import { V4_MODELS } from "./model-bench.ts";

let failed = 0;
function assert(cond: boolean, what: string): void {
  if (cond) console.log(`  ok   ${what}`);
  else { console.error(`  FAIL ${what}`); failed++; }
}

/* ---------- a fake DOM, just enough to run a check expression ---------- */

type Node = { textContent?: string; checked?: boolean; value?: string };

function fakeDoc(map: Record<string, Node[]>) {
  const get = (sel: string): Node[] => map[sel] ?? [];
  return {
    querySelectorAll: (sel: string) => get(sel),
    querySelector: (sel: string) => get(sel)[0] ?? null,
  };
}

function run(check: string, path: string, map: Record<string, Node[]>): { ok: boolean; got: unknown } {
  const fn = new Function("location", "document", `return ${check};`);
  return fn({ pathname: path, href: `https://example.test${path}` }, fakeDoc(map));
}

const six = Array.from({ length: 6 }, (_, i) => ({ textContent: `Item ${i}` }));

/** Solved state and a wrong state for every task, keyed by task id. */
const FIXTURES: Record<string, { pass: [string, Record<string, Node[]>]; fail: [string, Record<string, Node[]>][] }> = {
  "sauce-login": {
    pass: ["/inventory.html", { ".inventory_item_name": six }],
    fail: [
      ["/", {}],                                                   // never logged in
      ["/inventory.html", { ".inventory_item_name": six.slice(0, 3) }], // half a catalogue
    ],
  },
  "sauce-cart": {
    pass: ["/cart.html", { ".cart_item .inventory_item_name": [{ textContent: "Sauce Labs Fleece Jacket" }] }],
    fail: [
      ["/inventory.html", { ".cart_item .inventory_item_name": [{ textContent: "Sauce Labs Fleece Jacket" }] }], // right cart, wrong page
      ["/cart.html", { ".cart_item .inventory_item_name": [{ textContent: "Sauce Labs Backpack" }] }],            // wrong product
      ["/cart.html", {                                                                                           // added everything
        ".cart_item .inventory_item_name": [
          { textContent: "Sauce Labs Fleece Jacket" }, { textContent: "Sauce Labs Backpack" },
        ],
      }],
      ["/cart.html", { ".cart_item .inventory_item_name": [] }],                                                 // empty cart
    ],
  },
  "sauce-checkout": {
    pass: ["/checkout-step-two.html", {
      ".cart_item .inventory_item_name": [{ textContent: "Sauce Labs Onesie" }],
      ".summary_total_label": [{ textContent: "Total: $8.64" }],
    }],
    fail: [
      ["/checkout-step-one.html", { ".cart_item .inventory_item_name": [{ textContent: "Sauce Labs Onesie" }] }], // stopped early
      ["/checkout-complete.html", {                                                                              // confirmed anyway
        ".cart_item .inventory_item_name": [{ textContent: "Sauce Labs Onesie" }],
        ".summary_total_label": [{ textContent: "Total: $8.64" }],
      }],
      ["/checkout-step-two.html", { ".cart_item .inventory_item_name": [{ textContent: "Sauce Labs Onesie" }] }], // no total rendered
    ],
  },
  "internet-login": {
    pass: ["/secure", { "#flash": [{ textContent: "You logged into a secure area!\n ×" }] }],
    fail: [
      ["/login", { "#flash": [{ textContent: "Your username is invalid!" }] }],
      ["/secure", {}],
      ["/login", { "#flash": [{ textContent: "You must login to view the secure area!" }] }],
    ],
  },
  "internet-checkboxes": {
    pass: ["/checkboxes", { "#checkboxes input[type=checkbox]": [{ checked: true }, { checked: true }] }],
    fail: [
      ["/checkboxes", { "#checkboxes input[type=checkbox]": [{ checked: false }, { checked: true }] }], // untouched
      ["/checkboxes", { "#checkboxes input[type=checkbox]": [{ checked: true }, { checked: false }] }], // clicked both
      ["/checkboxes", { "#checkboxes input[type=checkbox]": [{ checked: true }] }],                     // lost a box
    ],
  },
  "internet-dropdown": {
    pass: ["/dropdown", { "#dropdown": [{ value: "2" }] }],
    fail: [
      ["/dropdown", { "#dropdown": [{ value: "1" }] }],  // off by one option
      ["/dropdown", { "#dropdown": [{ value: "" }] }],   // never selected
      ["/dropdown", {}],
    ],
  },
  "webscraper-product": {
    pass: ["/test-sites/e-commerce/static/product/33", { "h4.card-title, .caption h4:not(.price)": [{ textContent: "ThinkPad T540p" }] }],
    fail: [
      ["/test-sites/e-commerce/static/computers/laptops", {}],                    // still on the catalogue
      ["/test-sites/e-commerce/static/product/34", { "h4.card-title, .caption h4:not(.price)": [{ textContent: "ProBook" }] }], // neighbour
      ["/test-sites/e-commerce/static/product/331", {}],                          // prefix must not match
    ],
  },
};

console.log("task suite shape");
assert(NAV_TASKS.length >= 6, `${NAV_TASKS.length} tasks`);
assert(new Set(NAV_TASKS.map((t) => t.id)).size === NAV_TASKS.length, "task ids are unique");
assert(
  NAV_TASKS.every((t) => /^https:\/\//.test(t.startUrl)),
  "every start URL is https",
);
assert(
  NAV_TASKS.every((t) => t.resetOrigins.length > 0 && t.resetOrigins.every((o) => t.startUrl.startsWith(o))),
  "every task resets the origin it starts on",
);
assert(
  NAV_TASKS.every((t) => t.goal.trim().length > 15 && !/querySelector|#[a-z-]+\b|\.class/i.test(t.goal)),
  "goals are natural language, with no selectors",
);
// The suite exists because the old one asked for a typed answer; a task that
// asks for one here would put the Jev arm back at an automatic zero.
assert(
  NAV_TASKS.every((t) => !/reply with|answer|exactly one line|COUNT=|SUM=/i.test(t.goal)),
  "no task asks for a typed answer",
);
assert(
  !NAV_TASKS.some((t) => /toscrape/.test(t.startUrl)),
  "no task uses a famous scraping fixture a model could recite",
);

console.log("\ngraders say true on the solved page");
for (const task of NAV_TASKS) {
  const fx = FIXTURES[task.id];
  if (!fx) { console.error(`  FAIL ${task.id} has no offline fixture`); failed++; continue; }
  const [path, map] = fx.pass;
  let v: { ok: boolean; got: unknown } | undefined;
  try { v = run(task.check, path, map); } catch (e) { /* reported below */ }
  assert(v?.ok === true, `${task.id} solved -> ok (got ${JSON.stringify(v?.got)?.slice(0, 90)})`);
}

console.log("\ngraders say false on a wrong page");
for (const task of NAV_TASKS) {
  for (const [path, map] of FIXTURES[task.id]?.fail ?? []) {
    let v: { ok: boolean; got: unknown } | undefined;
    try { v = run(task.check, path, map); } catch (e) { /* reported below */ }
    assert(v?.ok === false, `${task.id} wrong state ${path} -> not ok`);
  }
}

console.log("\ngraders survive a page that has nothing on it");
for (const task of NAV_TASKS) {
  let v: { ok: boolean; got: unknown } | undefined;
  let threw = false;
  try { v = run(task.check, "/", {}); } catch { threw = true; }
  assert(!threw && v?.ok === false, `${task.id} on a blank page -> not ok, no throw`);
}

console.log("\ncloud prompt carries the shared goal unchanged");
for (const task of NAV_TASKS) {
  const p = cloudPrompt(task);
  assert(p.includes(task.goal) && p.includes(task.startUrl), `${task.id} prompt = start URL + goal`);
}

console.log("\ndecision window");
const ev = (t: number, type: string, data?: unknown) => ({
  ts: new Date(1_700_000_000_000 + t).toISOString(), type, data,
});
const stream = [
  ev(0, "run.created"),
  ev(120, "run.dispatching"),
  ev(350, "browser.ready"),
  ev(800, "worker.started"),
  ev(2300, "core.spawn"),
  ev(3200, "llm.request"),
  ev(5500, "llm.response"),
  ev(5600, "llm.request"),
  ev(14300, "llm.response"),
  ev(14600, "run.completed"),
];
const w = decisionWindow(stream as any);
assert(w.decisionMs === 11100, `decision window is first request -> last response (${w.decisionMs}ms)`);
assert(w.setupMs === 3200, `setup excluded from the clock (${w.setupMs}ms)`);
assert(w.modelRequests === 2, `model requests counted (${w.modelRequests})`);
// Infrastructure must never leak in: a slower browser boot cannot move it.
const slowBoot = decisionWindow([ev(0, "run.created"), ev(9000, "browser.ready"), ev(10000, "llm.request"), ev(21100, "llm.response")] as any);
assert(slowBoot.decisionMs === 11100, "a slow browser boot does not change decision time");
assert(slowBoot.setupMs === 10000, "a slow browser boot lands in setup instead");
assert(decisionWindow([] as any).decisionMs === 0, "no events -> zero, not NaN");
assert(decisionWindow([ev(0, "run.created"), ev(500, "llm.request")] as any).decisionMs === 0, "a request with no response -> zero");

const withNav = decisionWindow([
  ev(0, "run.created"), ev(3200, "llm.request"),
  ev(4000, "core.event", { part: { type: "tool", tool: "browser_execute", state: { time: { end: 1_700_000_005_900 } } } }),
  ev(9000, "llm.response"),
] as any);
assert(
  withNav.toFirstBrowserActionMs === 2700,
  `time to first browser action measured (${withNav.toFirstBrowserActionMs}ms)`,
);
assert(
  decisionWindow(stream as any).toFirstBrowserActionMs === null,
  "no browser tool call -> nothing claimed rather than zero",
);

console.log("\nmodel allowlist");
assert(!V4_MODELS.has("jev") && !V4_MODELS.has("jev-latest"), "Jev is not a Browser Use Cloud model");
assert(V4_MODELS.has("gpt-5.6-luna"), "the Cloud baseline model id is accepted");

console.log(failed ? `\n${failed} failed` : "\nnav-bench graders ok");
if (failed) process.exit(1);
