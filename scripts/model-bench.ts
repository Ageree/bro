/**
 * Browser Use Cloud V4 model benchmark.
 *
 * Compares browser-agent models on a fixed suite of hard, *gradeable* browser
 * errands and reports accuracy, wall-clock latency, tokens and USD cost.
 *
 * Why the tasks look the way they do: a model comparison is only worth the
 * money if every answer can be checked against a fact known in advance. Every
 * task below targets a stable, free, scraping-practice site whose ground truth
 * was computed from the live HTML when this file was written, and each task
 * demands a machine-checkable answer line rather than prose. A task whose
 * answer drifts with the news would measure the day, not the model.
 *
 * Runs go through the raw v4 REST API, NOT through `agent/lib/browseruse.ts`.
 * `startRun()` wraps every errand in Bro's scaffolding and an extra
 * errand-brief LLM call; that is right for production and wrong for a
 * benchmark, where it would price and time Bro's prompt rather than the model.
 *
 * Costs real money. Defaults to a dry plan; `--run` is the deliberate act.
 *
 *   node --experimental-strip-types scripts/model-bench.ts            # plan
 *   node --experimental-strip-types scripts/model-bench.ts --run \
 *     --models gpt-5.6-luna,claude-opus-5 --repeat 3
 */

const BASE = process.env.BROWSER_USE_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://api.browser-use.com/api/v4";

/**
 * Model IDs the V4 request schema accepts (docs.browser-use.com, "All
 * supported V4 model IDs"). The benchmark refuses anything outside this set
 * instead of posting it: an unknown `model` is rejected by the API only after
 * a run is created, and a typo that silently fell back to the default would
 * quietly produce a table comparing a model against itself.
 */
export const V4_MODELS = new Set([
  "claude-opus-4.7", "claude-opus-4.8", "claude-opus-5", "claude-fable-5", "claude-sonnet-5",
  "gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra",
  "gemini-3-flash", "gemini-3.1-pro", "gemini-3.5-flash", "gemini-3.6-flash",
  "grok-4.5", "grok-4.6",
  "glm-5.2", "glm-5.3-flash",
  "deepseek-v4-flash-vision",
  "kimi-k3",
  "minimax-m3",
]);

type Matcher =
  | { kind: "num"; label: string; value: number; tol: number }
  | { kind: "text"; label: string; any: string[] };

type Task = {
  id: string;
  /** What capability the task actually stresses — printed in the report. */
  stresses: string;
  prompt: string;
  expect: Matcher[];
};

/**
 * Ground truth verified against the live sites on 2026-09-17. `tables`,
 * `challenging_dom` and both toscrape sites are static fixtures, so these
 * stay valid until the sites themselves change; re-verify if accuracy
 * collapses across *every* model at once, which is the signature of a moved
 * fixture rather than a bad model.
 */
export const TASKS: Task[] = [
  {
    id: "books-travel-agg",
    stresses: "category navigation + rating filter + decimal arithmetic",
    prompt:
      "Go to https://books.toscrape.com and open the 'Travel' category. " +
      "Consider ONLY the books rated 4 or 5 stars. " +
      "Reply with exactly one line and nothing else: COUNT=<n> SUM=<total price in GBP, 2 decimals>",
    expect: [
      { kind: "num", label: "COUNT", value: 3, tol: 0 },
      { kind: "num", label: "SUM", value: 132.39, tol: 0.005 },
    ],
  },
  {
    id: "quotes-paginate",
    stresses: "exhaustive 10-page pagination + aggregation without drift",
    prompt:
      "Go to https://quotes.toscrape.com and visit EVERY page to the last one. " +
      "Count all quotes and find the author with the most quotes. " +
      "Reply with exactly one line and nothing else: TOTAL=<n> AUTHOR=<full name> COUNT=<n>",
    expect: [
      { kind: "num", label: "TOTAL", value: 100, tol: 0 },
      { kind: "text", label: "AUTHOR", any: ["albert einstein"] },
      { kind: "num", label: "COUNT", value: 10, tol: 0 },
    ],
  },
  {
    id: "deep-nav-upc",
    stresses: "chained lookup — filter, pick a winner, open its detail page",
    prompt:
      "On https://books.toscrape.com open the 'Travel' category, find the MOST EXPENSIVE book " +
      "rated 4 or 5 stars, then open that book's own product page and read its product information table. " +
      "Reply with exactly one line and nothing else: UPC=<upc> AVAILABLE=<number in stock>",
    expect: [
      { kind: "text", label: "UPC", any: ["9e60929f521fa280"] },
      { kind: "num", label: "AVAILABLE", value: 6, tol: 0 },
    ],
  },
  {
    id: "tables-due",
    stresses: "HTML table extraction + sorting + summation",
    prompt:
      "Go to https://the-internet.herokuapp.com/tables and use the table with id 'table1'. " +
      "Reply with exactly one line and nothing else: SUM=<sum of the Due column, 2 decimals> TOP=<First Last of the person with the highest Due>",
    expect: [
      { kind: "num", label: "SUM", value: 251.0, tol: 0.005 },
      { kind: "text", label: "TOP", any: ["jason doe", "doe, jason", "jason"] },
    ],
  },
  {
    id: "dynamic-loading",
    stresses: "clicking, then waiting for async render instead of reading too early",
    prompt:
      "Go to https://the-internet.herokuapp.com/dynamic_loading/2 , click Start, and wait for the " +
      "element that is rendered afterwards. " +
      "Reply with exactly one line and nothing else: TEXT=<the revealed text>",
    expect: [{ kind: "text", label: "TEXT", any: ["hello world"] }],
  },
  {
    id: "challenging-dom",
    stresses: "positional reading where element ids are randomised on every load",
    prompt:
      "Go to https://the-internet.herokuapp.com/challenging_dom . The table's ids change on every load, " +
      "so read it by position. " +
      "Reply with exactly one line and nothing else: ROWS=<number of body rows> HEADERS=<column headers, comma separated, in order>",
    expect: [
      { kind: "num", label: "ROWS", value: 10, tol: 0 },
      { kind: "text", label: "HEADERS", any: ["lorem"] },
      { kind: "text", label: "HEADERS", any: ["diceret"] },
      { kind: "text", label: "HEADERS", any: ["action"] },
    ],
  },
];

function key(): string {
  const k = process.env.BROWSER_USE_API_KEY?.trim();
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
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/** Normalise an answer so grading is not defeated by casing or stray markup. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[£$*_`]/g, "").replace(/\s+/g, " ").trim();
}

export function readNum(result: string, label: string): number | null {
  // Models answer `SUM=132.39`, `**SUM = 132.39**` and `SUM: £132.39` alike.
  // The currency symbol and the markdown bold sit between the separator and
  // the digits, so they are stripped before matching — without this, a model
  // that writes the right number in the most natural way scores zero and the
  // benchmark measures formatting instead of browsing.
  const cleaned = result.replace(/[*_`£$€₽]/g, "");
  const m = new RegExp(`${label}\\s*[=:]?\\s*(-?[\\d.,]+)`, "i").exec(cleaned);
  if (!m) return null;
  const n = Number(m[1].replace(/,(?=\d{3}\b)/g, "").replace(/,/g, "."));
  return Number.isFinite(n) ? n : null;
}

/** Per-matcher grading, so a partly-right answer scores partly right. */
export function grade(result: string, expect: Matcher[]): { hits: number; total: number; misses: string[] } {
  const text = norm(result);
  const misses: string[] = [];
  let hits = 0;
  for (const m of expect) {
    if (m.kind === "num") {
      const got = readNum(result, m.label);
      if (got !== null && Math.abs(got - m.value) <= m.tol) hits++;
      else misses.push(`${m.label} expected ${m.value}, got ${got ?? "—"}`);
    } else {
      if (m.any.some((a) => text.includes(norm(a)))) hits++;
      else misses.push(`${m.label} expected one of ${m.any.join(" | ")}`);
    }
  }
  return { hits, total: expect.length, misses };
}

type Attempt = {
  task: string;
  model: string;
  status: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  hits: number;
  total: number;
  misses: string[];
  result: string;
};

async function runOne(model: string, task: Task, maxCostUsd: number, timeoutMs: number): Promise<Attempt> {
  const started = Date.now();
  const base: Attempt = {
    task: task.id, model, status: "error", ms: 0,
    inputTokens: 0, outputTokens: 0, costUsd: 0,
    hits: 0, total: task.expect.length, misses: [], result: "",
  };
  try {
    const run = await api("/runs", {
      method: "POST",
      body: JSON.stringify({ task: task.prompt, model, maxCostUsd }),
    });
    const id = run?.id;
    if (!id) throw new Error(`no run id in response: ${JSON.stringify(run).slice(0, 200)}`);

    let summary: any = run;
    while (!["completed", "failed", "cancelled"].includes(String(summary?.status))) {
      if (Date.now() - started > timeoutMs) {
        // Stop billing rather than abandoning the run: /cancel is idempotent
        // and blocks further LLM charges immediately.
        await api(`/runs/${id}/cancel`, { method: "POST" }).catch(() => {});
        summary = { ...summary, status: "timeout" };
        break;
      }
      await new Promise((r) => setTimeout(r, 4000));
      summary = await api(`/runs/${id}`);
    }

    const result = String(summary?.result ?? "");
    const g = grade(result, task.expect);
    return {
      ...base,
      status: String(summary?.status ?? "unknown"),
      ms: Date.now() - started,
      inputTokens: Number(summary?.totalInputTokens ?? 0),
      outputTokens: Number(summary?.totalOutputTokens ?? 0),
      costUsd: Number(summary?.totalCostUsd ?? 0),
      hits: g.hits, total: g.total, misses: g.misses,
      result: result.slice(0, 500),
    };
  } catch (err) {
    return { ...base, ms: Date.now() - started, misses: [String((err as Error).message).slice(0, 300)] };
  }
}

function median(xs: number[]): number {
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
  const models = arg("models", "gpt-5.6-luna").split(",").map((m) => m.trim()).filter(Boolean);
  const only = arg("tasks", "").split(",").map((t) => t.trim()).filter(Boolean);
  const repeat = Math.max(1, Number(arg("repeat", "1")));
  const concurrency = Math.max(1, Number(arg("concurrency", "2")));
  const maxCostUsd = Number(arg("max-cost", "0.60"));
  const timeoutMs = Number(arg("timeout", "420")) * 1000;
  const live = process.argv.includes("--run");

  const unknown = models.filter((m) => !V4_MODELS.has(m));
  if (unknown.length) {
    console.error(`Unknown V4 model id: ${unknown.join(", ")}`);
    console.error(`Browser Use Cloud only runs models it hosts. Supported:\n  ${[...V4_MODELS].join("\n  ")}`);
    process.exit(2);
  }

  const tasks = only.length ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
  if (!tasks.length) {
    console.error(`No task matched. Known: ${TASKS.map((t) => t.id).join(", ")}`);
    process.exit(2);
  }

  const jobs: { model: string; task: Task }[] = [];
  for (const model of models) for (const task of tasks) for (let i = 0; i < repeat; i++) jobs.push({ model, task });

  console.log(`# Browser Use V4 model benchmark\n`);
  console.log(`models:      ${models.join(", ")}`);
  console.log(`tasks:       ${tasks.map((t) => t.id).join(", ")}`);
  console.log(`repeats:     ${repeat}   runs: ${jobs.length}   cap: $${maxCostUsd.toFixed(2)}/run`);
  console.log(`worst case:  $${(jobs.length * maxCostUsd).toFixed(2)} if every run hits its cap\n`);

  if (!live) {
    console.log(`Dry plan — nothing was sent and nothing was billed. Add --run to execute.\n`);
    for (const t of tasks) console.log(`  ${t.id.padEnd(20)} ${t.stresses}`);
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
        const mark = a.hits === a.total ? "PASS" : a.hits ? "PART" : "FAIL";
        console.log(`  ${mark} ${a.model.padEnd(16)} ${a.task.padEnd(20)} ${(a.ms / 1000).toFixed(0)}s $${a.costUsd.toFixed(4)} ${a.hits}/${a.total}`);
      }
    }),
  );

  console.log(`\n## Per model\n`);
  console.log(`| model | solved | partial credit | median latency | median cost | avg tokens in/out |`);
  console.log(`|---|---|---|---|---|---|`);
  for (const model of models) {
    const mine = attempts.filter((a) => a.model === model);
    const solved = mine.filter((a) => a.hits === a.total).length;
    const credit = mine.reduce((s, a) => s + a.hits / Math.max(1, a.total), 0) / Math.max(1, mine.length);
    const tin = mine.reduce((s, a) => s + a.inputTokens, 0) / Math.max(1, mine.length);
    const tout = mine.reduce((s, a) => s + a.outputTokens, 0) / Math.max(1, mine.length);
    console.log(
      `| \`${model}\` | ${solved}/${mine.length} | ${(credit * 100).toFixed(0)}% | ` +
        `${(median(mine.map((a) => a.ms)) / 1000).toFixed(0)}s | $${median(mine.map((a) => a.costUsd)).toFixed(4)} | ` +
        `${Math.round(tin)}/${Math.round(tout)} |`,
    );
  }

  console.log(`\n## Per task\n`);
  console.log(`| task | ${models.map((m) => `\`${m}\``).join(" | ")} |`);
  console.log(`|---|${models.map(() => "---").join("|")}|`);
  for (const t of tasks) {
    const cells = models.map((m) => {
      const mine = attempts.filter((a) => a.model === m && a.task === t.id);
      const solved = mine.filter((a) => a.hits === a.total).length;
      return `${solved}/${mine.length}`;
    });
    console.log(`| ${t.id} | ${cells.join(" | ")} |`);
  }

  const failures = attempts.filter((a) => a.hits < a.total);
  if (failures.length) {
    console.log(`\n## Misses\n`);
    for (const f of failures.slice(0, 40)) {
      console.log(`- \`${f.model}\` ${f.task} (${f.status}): ${f.misses.join("; ").slice(0, 220)}`);
    }
  }

  const out = `bench-${Date.now()}.json`;
  await (await import("node:fs/promises")).writeFile(out, JSON.stringify({ models, attempts }, null, 2));
  console.log(`\nRaw attempts: ${out}`);
  console.log(`Total billed: $${attempts.reduce((s, a) => s + a.costUsd, 0).toFixed(4)}`);
}

// Importable for `scripts/model-bench-check.ts`: only the CLI entry runs main,
// so the grader can be tested without touching the network or the wallet.
if (import.meta.filename === process.argv[1]) await main();
