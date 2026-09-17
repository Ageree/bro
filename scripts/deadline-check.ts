import { assert, eq, src } from "./lib/check.ts";
import { budgetFromEnv, withDeadline } from "../agent/lib/deadline.ts";

/**
 * Every network call a turn waits on must have an upper bound.
 *
 * The failure mode this guards is silence, not error. `ConvexHttpClient` sends
 * no `AbortSignal`, so before this a stalled query simply never settled: the
 * tool never returned, the turn never ended, and the person was left holding
 * the «проверяю» line with nothing after it. `agent/lib/silent-turn.ts` records
 * that exact incident (2026-09-16, a restaurant booking, sixteen minutes).
 *
 * A budget converts the hang into a throw, which fires `turn.failed`, which
 * sends `TURN_STALLED_REPLY`. The person learns the truth in seconds. So these
 * assertions are release-safety properties, not performance tuning — dropping
 * one puts the silence back.
 */

// --- the helper itself ------------------------------------------------------

{
  const fast = await withDeadline(Promise.resolve("ok"), 1_000, "fast work");
  eq(fast, "ok", "work that finishes inside the budget passes through");
}

{
  let rejected: Error | undefined;
  try {
    await withDeadline(new Promise(() => {}), 20, "hung work");
  } catch (err) {
    rejected = err instanceof Error ? err : new Error(String(err));
  }
  assert(rejected !== undefined, "a promise that never settles is rejected");
  assert(
    /hung work/.test(rejected!.message),
    `the rejection names what stalled: got "${rejected!.message}"`,
  );
  assert(
    /timed out/i.test(rejected!.message),
    `the rejection says it timed out: got "${rejected!.message}"`,
  );
}

{
  // An unusable budget must not silently become "reject immediately" — that
  // would turn a misconfigured env var into a total outage.
  const passthrough = await withDeadline(Promise.resolve(1), 0, "zero budget");
  eq(passthrough, 1, "a zero budget disables the deadline instead of failing");
  const nan = await withDeadline(Promise.resolve(2), Number.NaN, "nan budget");
  eq(nan, 2, "a NaN budget disables the deadline instead of failing");
}

{
  // A rejection from the work itself must reach the caller unchanged, so a
  // real error is never reported as a timeout.
  let message = "";
  try {
    await withDeadline(Promise.reject(new Error("upstream 500")), 1_000, "work");
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  eq(message, "upstream 500", "the work's own error is not masked by the deadline");
}

eq(budgetFromEnv(undefined, 15_000), 15_000, "missing env falls back");
eq(budgetFromEnv("", 15_000), 15_000, "empty env falls back");
eq(budgetFromEnv("  ", 15_000), 15_000, "blank env falls back");
eq(budgetFromEnv("abc", 15_000), 15_000, "non-numeric env falls back");
eq(budgetFromEnv("-5", 15_000), 15_000, "negative env falls back");
eq(budgetFromEnv("0", 15_000), 15_000, "zero env falls back");
eq(budgetFromEnv("2500", 15_000), 2_500, "a valid env value wins");

// --- the callers ------------------------------------------------------------

{
  const convex = src("agent/lib/convex.ts");
  assert(
    convex.includes('from "./deadline.ts"'),
    "the Convex client imports the shared deadline helper",
  );
  // Every one of the three forwarders. A tool reaches Convex through exactly
  // these, so an unwrapped one is an unbounded wait for some tool.
  for (const what of ["convex query", "convex mutation", "convex action"]) {
    assert(
      convex.includes(`"${what}"`),
      `the ${what} forwarder is wrapped in a deadline`,
    );
  }
  assert(
    (convex.match(/withDeadline\(/g) ?? []).length >= 3,
    "all three Convex forwarders carry a budget, not just one",
  );
  assert(
    /BRO_CONVEX_BUDGET_MS/.test(convex) && /BRO_CONVEX_ACTION_BUDGET_MS/.test(convex),
    "the budgets are tunable without a code change",
  );
}

{
  // One definition, not two. The helper used to live inside the Composio
  // module, which is why the Convex path never got one: importing it would
  // have dragged the Composio SDK onto every tool call.
  const composio = src("agent/lib/composio.ts");
  assert(
    !/export function withDeadline/.test(composio),
    "composio.ts no longer defines its own copy of the helper",
  );
  assert(
    composio.includes('from "./deadline.ts"'),
    "composio.ts re-exports the shared helper",
  );
}

console.log("deadline-check ok");
