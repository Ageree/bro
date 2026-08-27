import {
  nextBrowserAction,
  normalizeTask,
  pollTimedOut,
} from "../agent/lib/browser-policy.ts";
import { scaffoldTask } from "../agent/lib/browseruse.ts";

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

const priorDone = {
  runId: "r1",
  status: "completed",
  storedTask: "обувь на ozon",
} as const;
assert(
  nextBrowserAction({
    ...priorDone,
    incomingTask: "забронируй столик в ресторане Сыроварня на пятницу 19:00",
  }) === "start",
  "booking after done starts",
);
assert(
  nextBrowserAction({
    ...priorDone,
    incomingTask: "запиши меня к стоматологу на чистку",
  }) === "start",
  "appointment after done starts",
);
assert(
  nextBrowserAction({
    ...priorDone,
    incomingTask: "закажи такси на завтра в 9 утра",
  }) === "start",
  "taxi after done starts",
);
assert(
  nextBrowserAction({ ...priorDone, incomingTask: "ну что" }) === "reuse",
  "short ping after done reuses",
);
assert(
  nextBrowserAction({ ...priorDone, incomingTask: "как там" }) === "reuse",
  "status ping after done reuses",
);

const raw = "забронируй столик в Сыроварне на пятницу 19:00";
const wrapped = scaffoldTask(raw);
assert(wrapped.startsWith("[bro-errand]"), "scaffold starts with marker");
assert(wrapped.includes(raw), "scaffold contains raw task");
assert(scaffoldTask(wrapped) === wrapped, "scaffold is idempotent");
assert(scaffoldTask("x").includes("Работай быстро"), "scaffold skip-slow");

const t0 = Date.parse("2026-08-27T12:00:00.000Z");
assert(pollTimedOut(t0, t0 + 10 * 60_000) === false, "poll not expired");
assert(pollTimedOut(t0, t0 + 30 * 60_000) === false, "poll exactly 30min");
assert(pollTimedOut(t0, t0 + 30 * 60_000 + 1) === true, "poll expired");
assert(pollTimedOut(undefined, t0) === false, "poll missing start");

console.log("browser-policy-check ok");
