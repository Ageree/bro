import {
  nextBrowserAction,
  normalizeTask,
  pollTimedOut,
} from "../agent/lib/browser-policy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(normalizeTask("  Купить   скотч ") === "купить скотч", "normalize");

assert(
  nextBrowserAction({ incomingTask: "скотч на ozon" }) === "start",
  "fresh start",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "running",
    storedTask: "скотч на ozon",
    incomingTask: "ну что",
  }) === "poll",
  "ping while running polls",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "queued",
    incomingTask: "Купить обувь 40 размера до 2000 рублей на Ozon",
  }) === "poll",
  "queued is in-flight",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "completed",
    storedTask: "Купить обувь 40 размера до 2000 рублей на Ozon",
    incomingTask: "Купить обувь 40 размера до 2000 рублей на Ozon",
  }) === "reuse",
  "identical completed task is reused, not re-run",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "completed",
    storedTask: "обувь на ozon",
    incomingTask: "скотч на wb",
  }) === "start",
  "new task after complete starts",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "completed",
    storedTask: "Купить обувь 40 на Ozon",
    incomingTask: "ну что",
  }) === "reuse",
  "short ping after complete reuses result",
);

assert(
  nextBrowserAction({
    reset: true,
    runId: "r1",
    status: "running",
    incomingTask: "x",
  }) === "start",
  "reset starts",
);

const t0 = Date.parse("2026-08-27T12:00:00.000Z");
assert(pollTimedOut(t0, t0 + 10 * 60_000) === false, "poll not expired");
assert(pollTimedOut(t0, t0 + 20 * 60_000) === false, "poll exactly 20min");
assert(pollTimedOut(t0, t0 + 20 * 60_000 + 1) === true, "poll expired");
assert(pollTimedOut(undefined, t0) === false, "poll missing start");

console.log("browser-policy-check ok");
