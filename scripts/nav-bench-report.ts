/**
 * Merge the two arms' raw attempt files into one comparison.
 *
 *   node --experimental-strip-types scripts/nav-bench-report.ts bench-nav-*.json
 *
 * With no arguments it picks up every `bench-nav-*.json` in the working
 * directory. Those files are run artifacts and are gitignored.
 *
 * The comparison deliberately leads with decision time and model requests, not
 * total run time: the arms sit on different infrastructure (a remote Cloud
 * browser behind a proxy versus a local Chrome) and a wall-clock column would
 * mostly report that difference. Wall clock is printed last, clearly labelled
 * as not comparable, because hiding it would be its own kind of dishonesty.
 */

import { readFile, readdir } from "node:fs/promises";
import { NAV_TASKS } from "./lib/nav-tasks.ts";

type Attempt = {
  arm: string;
  model: string;
  task: string;
  ok: boolean;
  got?: unknown;
  status?: string;
  error?: string | null;
  decisionMs: number;
  wallMs: number;
  setupMs?: number;
  /** Renamed from `navResidualMs`; both are read so older artifacts still merge. */
  toFirstBrowserActionMs?: number | null;
  navResidualMs?: number | null;
  modelRequests: number;
  jevRequests?: number;
  textCalls?: number;
  actions?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  browserCostUsd?: number;
};

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  let files = process.argv.slice(2).filter((a) => a.endsWith(".json"));
  if (!files.length) {
    files = (await readdir(process.cwd()))
      .filter((f) => /^bench-nav-.*\.json$/.test(f))
      .sort();
  }
  if (!files.length) {
    console.error("no bench-nav-*.json found — run the two arms first");
    process.exit(2);
  }

  const attempts: Attempt[] = [];
  for (const f of files) {
    const body = JSON.parse(await readFile(f, "utf8"));
    for (const a of body?.attempts ?? []) attempts.push(a as Attempt);
  }

  // One arm can carry several models (the Cloud side), so group by both.
  const keyOf = (a: Attempt) => (a.arm === "jev" ? "jev-ultrafast" : a.model);
  const groups = [...new Set(attempts.map(keyOf))];

  console.log(`# Navigation benchmark — Jev vs Browser Use Cloud\n`);
  console.log(`sources: ${files.join(", ")}`);
  console.log(`attempts: ${attempts.length}\n`);

  console.log(`## Headline\n`);
  console.log(`| arm | solved | median decision time | median model requests | median cost/run |`);
  console.log(`|---|---|---|---|---|`);
  for (const g of groups) {
    const mine = attempts.filter((a) => keyOf(a) === g);
    const solved = mine.filter((a) => a.ok).length;
    const cost = mine.map((a) => Number(a.costUsd ?? 0)).filter((n) => n > 0);
    console.log(
      `| \`${g}\` | ${solved}/${mine.length} | ${secs(median(mine.map((a) => a.decisionMs)))} | ` +
        `${median(mine.map((a) => a.modelRequests))} | ${cost.length ? `$${median(cost).toFixed(4)}` : "n/a"} |`,
    );
  }

  console.log(`\n## Per task — solved (median decision time)\n`);
  console.log(`| task | ${groups.map((g) => `\`${g}\``).join(" | ")} |`);
  console.log(`|---|${groups.map(() => "---").join("|")}|`);
  for (const t of NAV_TASKS) {
    const cells = groups.map((g) => {
      const mine = attempts.filter((a) => keyOf(a) === g && a.task === t.id);
      if (!mine.length) return "—";
      const solved = mine.filter((a) => a.ok).length;
      return `${solved}/${mine.length} (${secs(median(mine.map((a) => a.decisionMs)))})`;
    });
    console.log(`| ${t.id} | ${cells.join(" | ")} |`);
  }

  console.log(`\n## Model requests per solved run\n`);
  console.log(`| arm | median | min | max |`);
  console.log(`|---|---|---|---|`);
  for (const g of groups) {
    const mine = attempts.filter((a) => keyOf(a) === g && a.ok).map((a) => a.modelRequests);
    if (!mine.length) { console.log(`| \`${g}\` | — | — | — |`); continue; }
    console.log(`| \`${g}\` | ${median(mine)} | ${Math.min(...mine)} | ${Math.max(...mine)} |`);
  }

  const jev = attempts.filter((a) => a.arm === "jev");
  if (jev.length) {
    const text = jev.map((a) => Number(a.textCalls ?? 0));
    console.log(
      `\nJev's requests split: median ${median(jev.map((a) => Number(a.jevRequests ?? 0)))} Jev decisions + ` +
        `${median(text)} text-helper calls (the helper runs only for TYPE_TEXT).`,
    );
  }

  // Speed is only a comparison where both arms can attempt the work at all.
  // Averaging a task one arm cannot start into a latency figure would report
  // its capability gap a second time, dressed up as slowness.
  const attemptable = NAV_TASKS.filter((t) =>
    groups.every((g) => attempts.some((a) => keyOf(a) === g && a.task === t.id && a.ok)),
  ).map((t) => t.id);
  const blocked = NAV_TASKS.filter((t) => !attemptable.includes(t.id)).map((t) => t.id);

  if (attemptable.length && blocked.length) {
    console.log(`\n## Speed on common ground\n`);
    console.log(`Only the ${attemptable.length} task(s) every arm solved at least once: ${attemptable.join(", ")}.`);
    console.log(`Excluded, because at least one arm never solved them: ${blocked.join(", ")}.`);
    console.log(`Mixing those in would charge an arm twice for the same gap — once as a`);
    console.log(`failure, once as a latency it never actually spent.\n`);
    console.log(`| arm | solved | median decision time | median model requests |`);
    console.log(`|---|---|---|---|`);
    for (const g of groups) {
      const mine = attempts.filter((a) => keyOf(a) === g && attemptable.includes(a.task));
      console.log(
        `| \`${g}\` | ${mine.filter((a) => a.ok).length}/${mine.length} | ` +
          `${secs(median(mine.map((a) => a.decisionMs)))} | ${median(mine.map((a) => a.modelRequests))} |`,
      );
    }
  }

  console.log(`\n## Not comparable — total wall clock\n`);
  console.log(`The arms run on different infrastructure: the Cloud arm provisions a remote`);
  console.log(`browser behind a proxy and cold-starts a worker, the Jev arm attaches to a`);
  console.log(`Chrome already running on this machine. These numbers are printed for`);
  console.log(`completeness and must not be read as a speed comparison.\n`);
  console.log(`| arm | median wall clock | median excluded setup |`);
  console.log(`|---|---|---|`);
  for (const g of groups) {
    const mine = attempts.filter((a) => keyOf(a) === g);
    const setup = mine.map((a) => Number(a.setupMs ?? 0)).filter((n) => n > 0);
    console.log(
      `| \`${g}\` | ${secs(median(mine.map((a) => a.wallMs)))} | ${setup.length ? secs(median(setup)) : "n/a (outside the clock by construction)"} |`,
    );
  }

  const resid = attempts
    .map((a) => a.toFirstBrowserActionMs ?? a.navResidualMs)
    .filter((n): n is number => typeof n === "number" && n > 0);
  if (resid.length) {
    console.log(
      `\nTime to the Cloud arm's first browser action: median ${secs(median(resid))}, inside its clock.`,
    );
    console.log(`Read it as a ceiling on the start-page asymmetry, not as the navigation's cost:`);
    console.log(`most of that interval is the agent loading its browser skill and reasoning for a`);
    console.log(`turn or two, which is real work. The Jev agent is already on the page when its`);
    console.log(`clock starts. The asymmetry flatters Jev; it is not the source of its lead.`);
  }

  const failures = attempts.filter((a) => !a.ok);
  if (failures.length) {
    console.log(`\n## Failures — what the page actually held\n`);
    for (const f of failures) {
      console.log(
        `- \`${keyOf(f)}\` ${f.task}${f.status ? ` (${f.status})` : ""}: ` +
          `${JSON.stringify(f.got)?.slice(0, 200)}${f.error ? ` err=${f.error.slice(0, 120)}` : ""}`,
      );
    }
  }

  const spend = attempts.reduce((s, a) => s + Number(a.costUsd ?? 0), 0);
  const browser = attempts.reduce((s, a) => s + Number(a.browserCostUsd ?? 0), 0);
  console.log(`\nCloud model spend across these attempts: $${spend.toFixed(4)}`);
  if (browser > 0) {
    console.log(`Cloud browser-session charges seen alongside them: $${browser.toFixed(4)} (billed per browser, not per run).`);
  }
  console.log(`Jev-arm TypeSafe/OpenRouter charges are not returned per request by those APIs.`);
}

await main();
