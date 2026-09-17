// Drive a deployed Bro through a conversation and check what it says back.
//
//   npm run e2e -- --base=https://<eve host>
//
// Each scenario gets its own tenant in the fictional test range, so scenarios
// can run side by side without reading each other's memory. A turn is a signed
// synthetic Photon webhook posted to the real inbound route; the reply is read
// back out of the recorder (`convex/testTranscript.ts`) rather than off a
// phone. Nothing here simulates Bro — the only thing the harness replaces is
// the device at the far end.
import {
  photonTestInbound,
  testPhoneFor,
} from "../convex/lib/testTenantPolicy.ts";
import { signSpectrumWebhook } from "../agent/lib/photon.ts";
import {
  SCENARIOS,
  type Check,
  type Scenario,
  type Turn,
} from "./lib/scenarios.ts";

type Bubble = {
  at: number;
  channel: string;
  text: string;
  bubbles: string[];
  note?: string;
};

type TurnResult = {
  turn: Turn;
  bubbles: Bubble[];
  failures: string[];
  ms: number;
};

type ScenarioResult = {
  scenario: Scenario;
  ok: boolean;
  skipped?: string;
  turns: TurnResult[];
  error?: string;
  ms: number;
};

function flag(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.slice(name.length + 3);
}

function num(name: string, fallback: number): number {
  const raw = flag(name);
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const base = (flag("base") ?? process.env.BRO_E2E_BASE ?? "").replace(/\/+$/, "");
const internalSecret = process.env.BRO_INTERNAL_SECRET ?? "";
const webhookSecret = process.env.SPECTRUM_WEBHOOK_SECRET ?? "";
/** Quiet time after the last bubble before a turn counts as finished. */
const settleMs = num("settle", 4000);
/** Hard ceiling per turn — a cold start plus a tool call is the slow case. */
const turnTimeoutMs = num("turn-timeout", 90_000);
const jobs = Math.max(1, num("jobs", 3));
const pollMs = num("poll", 750);

const missing = [
  ["--base / BRO_E2E_BASE", base],
  ["BRO_INTERNAL_SECRET", internalSecret],
  ["SPECTRUM_WEBHOOK_SECRET", webhookSecret],
].filter(([, value]) => !value);
if (missing.length) {
  console.error(`e2e needs: ${missing.map(([name]) => name).join(", ")}`);
  process.exit(2);
}

const only = (flag("only") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const selected = only.length
  ? SCENARIOS.filter((s) => only.includes(s.name))
  : SCENARIOS;
const unknown = only.filter((name) => !SCENARIOS.some((s) => s.name === name));
if (unknown.length) {
  console.error(`unknown scenario: ${unknown.join(", ")}`);
  process.exit(2);
}

async function post(path: string, body: unknown, headers?: Record<string, string>) {
  const payload = JSON.stringify(body);
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  });
  return response;
}

async function internal<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await post(path, { secret: internalSecret, ...body });
  if (!response.ok) {
    throw new Error(`${path} → ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

async function sendInbound(phone: string, text: string): Promise<void> {
  const payload = JSON.stringify(photonTestInbound({ phone, text }));
  const signed = signSpectrumWebhook(payload, webhookSecret);
  const response = await fetch(`${base}/webhooks/photon`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-spectrum-timestamp": signed.timestamp,
      "x-spectrum-signature": signed.signature,
    },
    body: payload,
  });
  // The route answers 204 as soon as the turn is queued; the reply arrives in
  // the transcript later, from a different function.
  if (!response.ok && response.status !== 204) {
    throw new Error(
      `/webhooks/photon → ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
  }
}

const transcript = (phone: string) =>
  internal<{ bubbles: Bubble[] }>("/internal/test/transcript", { phone }).then(
    (r) => r.bubbles,
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the turn to go quiet.
 *
 * "Quiet" rather than "one reply" because Bro legitimately sends several
 * bubbles for one message — a fast ack, then the answer, sometimes a progress
 * note — and a harness that stopped at the first one would assert against half
 * a turn. The clock restarts on every new bubble.
 */
async function collect(phone: string, alreadySeen: number): Promise<Bubble[]> {
  const deadline = Date.now() + turnTimeoutMs;
  let rows = await transcript(phone);
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const next = await transcript(phone);
    if (next.length !== rows.length) {
      rows = next;
      lastChange = Date.now();
      continue;
    }
    // Nothing new for a full settle window, and something has arrived: done.
    if (rows.length > alreadySeen && Date.now() - lastChange >= settleMs) break;
    // Nothing at all yet — keep waiting until the hard timeout, since silence
    // is itself a result some scenarios assert on.
    if (rows.length === alreadySeen && Date.now() - lastChange >= turnTimeoutMs) break;
  }
  return rows.slice(alreadySeen);
}

function matches(needle: string | RegExp, haystack: string): boolean {
  return typeof needle === "string"
    ? haystack.toLowerCase().includes(needle.toLowerCase())
    : needle.test(haystack);
}

function describe(needle: string | RegExp): string {
  const text = typeof needle === "string" ? needle : String(needle);
  return text.length > 70 ? `${text.slice(0, 67)}…` : text;
}

/** Everything the human would have read this turn, ack included. */
const allText = (bubbles: Bubble[]): string =>
  bubbles.flatMap((b) => [b.text, ...b.bubbles]).join("\n");

/** Only the real turn's output — the pre-turn status line does not count as
 *  an answer, or a silent turn would pass every "it replied" expectation. */
const realBubbles = (bubbles: Bubble[]): Bubble[] =>
  bubbles.filter((b) => b.note !== "fast-ack");

function checkTurn(check: Check, bubbles: Bubble[]): string | null {
  if ("says" in check) {
    return matches(check.says, allText(bubbles))
      ? null
      : `expected a bubble containing ${describe(check.says)}`;
  }
  if ("never" in check) {
    return matches(check.never, allText(bubbles))
      ? `expected nothing containing ${describe(check.never)}`
      : null;
  }
  if ("replies" in check) {
    return realBubbles(bubbles).length > 0
      ? null
      : bubbles.length > 0
        ? "only the fast-ack arrived — the turn itself said nothing"
        : "expected a reply, got silence";
  }
  return bubbles.length === 0 ? null : "expected silence, got a reply";
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const started = Date.now();
  const skip = (scenario.needs ?? []).filter((name) => !process.env[name]);
  if (skip.length) {
    return {
      scenario,
      ok: true,
      skipped: `needs ${skip.join(", ")}`,
      turns: [],
      ms: 0,
    };
  }
  const phone = testPhoneFor(scenario.name);
  const turns: TurnResult[] = [];
  try {
    await internal("/internal/test/reset", { phone });
    let seen = 0;
    for (const turn of scenario.turns) {
      const turnStarted = Date.now();
      await sendInbound(phone, turn.text);
      const bubbles = await collect(phone, seen);
      seen += bubbles.length;
      const failures = turn.expect
        .map((check) => checkTurn(check, bubbles))
        .filter((f): f is string => f !== null);
      turns.push({ turn, bubbles, failures, ms: Date.now() - turnStarted });
      // A broken turn poisons every turn after it, and the transcript of the
      // first failure is the useful one.
      if (failures.length) break;
    }
    return {
      scenario,
      ok: turns.every((t) => t.failures.length === 0),
      turns,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      scenario,
      ok: false,
      turns,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    };
  }
}

const results: ScenarioResult[] = [];
let next = 0;
async function worker(): Promise<void> {
  while (next < selected.length) {
    const scenario = selected[next++]!;
    const result = await runScenario(scenario);
    results.push(result);
    const secs = (result.ms / 1000).toFixed(1);
    if (result.skipped) console.log(`skip ${scenario.name} — ${result.skipped}`);
    else console.log(`${result.ok ? "ok  " : "FAIL"} ${scenario.name} (${secs}s)`);
  }
}

const started = Date.now();
console.log(`e2e → ${base} (${selected.length} scenarios, ${jobs} at a time)`);
await Promise.all(Array.from({ length: Math.min(jobs, selected.length) }, worker));

const failed = results.filter((r) => !r.ok);
for (const result of failed) {
  console.error(`\n===== ${result.scenario.name} =====`);
  console.error(result.scenario.about);
  if (result.error) console.error(`error: ${result.error}`);
  for (const turn of result.turns) {
    console.error(`\n  human: ${turn.turn.text}`);
    if (!turn.bubbles.length) console.error("  bro:   (silence)");
    for (const bubble of turn.bubbles) {
      const tag = bubble.note ? ` [${bubble.note}]` : "";
      console.error(`  bro:${tag}   ${bubble.bubbles.join("\n         ")}`);
    }
    for (const failure of turn.failures) console.error(`  ✗ ${failure}`);
  }
}

const skipped = results.filter((r) => r.skipped).length;
const passed = results.length - failed.length - skipped;
const total = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\n${passed}/${results.length - skipped} scenarios passed in ${total}s` +
    (skipped ? `, ${skipped} skipped` : "") +
    (failed.length ? ` — failed: ${failed.map((r) => r.scenario.name).join(", ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
