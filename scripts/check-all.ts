// One command for the whole offline check battery: `npm run check`.
//
// Every `*:check` script in package.json is a pure-logic assertion run — no
// network, no secrets, no deployment — so the only reason they were run one
// at a time by hand was that nothing enumerated them. This runner does, and
// runs them in parallel, which turns ~2 minutes of sequential `npm run` into
// roughly the cost of the slowest single check (`types:check`).
//
// Checks that need a real `.env.local` (the Composio ones hit a live API) are
// excluded by name: CI has no such file and a missing key would fail them for
// a reason that has nothing to do with the diff.
import { spawn } from "node:child_process";
import { cpus } from "node:os";

import { srcJson } from "./lib/check.ts";

const NEEDS_ENV_LOCAL = new Set(["composio:check"]);

type Result = { name: string; ok: boolean; ms: number; output: string };

function parseList(flag: string): string[] {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!arg) return [];
  return arg
    .slice(flag.length + 3)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Accepts both `types` and `types:check` so the flags read the way the npm
// scripts are usually typed.
function normalize(name: string): string {
  return name.endsWith(":check") ? name : `${name}:check`;
}

function allChecks(): string[] {
  const pkg = srcJson<{ scripts: Record<string, string> }>("package.json");
  return Object.keys(pkg.scripts)
    .filter((name) => name.endsWith(":check"))
    .filter((name) => !NEEDS_ENV_LOCAL.has(name));
}

function run(name: string): Promise<Result> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "--silent", name], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => {
      resolve({ name, ok: false, ms: Date.now() - started, output: String(err) });
    });
    child.on("close", (code) => {
      resolve({ name, ok: code === 0, ms: Date.now() - started, output });
    });
  });
}

const only = parseList("only").map(normalize);
const skip = new Set(parseList("skip").map(normalize));
const jobsArg = process.argv.find((a) => a.startsWith("--jobs="));
const jobs = Math.max(1, Number(jobsArg?.slice("--jobs=".length)) || Math.min(8, cpus().length));

let names = (only.length ? only : allChecks()).filter((name) => !skip.has(name));
// `types:check` is a whole `tsc` pass and dominates the wall clock; starting
// it first lets the fast checks fill in around it instead of queueing behind.
names = names.sort((a, b) => (a === "types:check" ? -1 : b === "types:check" ? 1 : 0));

if (process.argv.includes("--list")) {
  console.log(names.join("\n"));
  process.exit(0);
}

if (!names.length) {
  console.error("no checks selected");
  process.exit(1);
}

const started = Date.now();
const results: Result[] = [];
let next = 0;

async function worker(): Promise<void> {
  while (next < names.length) {
    const name = names[next++]!;
    const result = await run(name);
    results.push(result);
    const secs = (result.ms / 1000).toFixed(1);
    console.log(
      `${result.ok ? "ok  " : "FAIL"} ${name} (${secs}s) [${results.length}/${names.length}]`,
    );
  }
}

await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, worker));

const failed = results.filter((r) => !r.ok);
for (const result of failed) {
  console.error(`\n===== ${result.name} =====\n${result.output.trim()}`);
}

const total = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed in ${total}s` +
    (failed.length ? ` — failed: ${failed.map((r) => r.name).join(", ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
