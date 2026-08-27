import {
  looksLike3dsFollowUp,
  nextBrowserAction,
  normalizeTask,
  taskToStore,
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

assert(
  looksLike3dsFollowUp(
    "type this code into the 3DS field: 123456",
    "скотч на ozon",
  ),
  "3ds helper otp phrase",
);
assert(looksLike3dsFollowUp("847291", "обувь на ozon"), "3ds helper digits only");
assert(looksLike3dsFollowUp("Mir Accept 123456", "обувь на ozon"), "3ds helper mir accept");
assert(
  !looksLike3dsFollowUp("введи код", "обувь на ozon"),
  "3ds helper kod without 3ds",
);
assert(!looksLike3dsFollowUp("промокод", "скотч на ozon"), "promocode not 3ds");
assert(!looksLike3dsFollowUp("код товара", "скотч на ozon"), "sku code not 3ds");
assert(!looksLike3dsFollowUp("код ПВЗ", "скотч на ozon"), "pvz code not 3ds");
assert(
  !looksLike3dsFollowUp("ну что", "скотч на ozon"),
  "3ds helper ping is not otp",
);
assert(
  !looksLike3dsFollowUp(
    "Купить обувь 40 размера до 2000 рублей на Ozon",
    "Купить обувь 40 размера до 2000 рублей на Ozon",
  ),
  "3ds helper same stored shop",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "running",
    storedTask: "скотч на ozon",
    incomingTask: "type this code into the 3DS field: 123456",
  }) === "start",
  "3ds otp while running starts",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "completed",
    storedTask: "Купить обувь 40 на Ozon",
    incomingTask: "type this code into the 3DS field: 123456",
  }) === "start",
  "3ds otp after complete starts",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "running",
    storedTask: "скотч на ozon",
    incomingTask: "ну что",
  }) === "poll",
  "ping still polls after 3ds helper",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "running",
    storedTask: "скотч на ozon",
    incomingTask: "Купить обувь 40 размера до 2000 рублей на Ozon",
  }) === "poll",
  "priced shop while running still polls",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "running",
    storedTask: "скотч на ozon",
    incomingTask: "промокод",
  }) === "poll",
  "promocode while running polls",
);

assert(
  nextBrowserAction({
    runId: "r1",
    status: "running",
    storedTask: "скотч на ozon",
    incomingTask: "код товара 4412",
  }) === "poll",
  "kod tovara while running polls",
);

assert(
  taskToStore("type this code into the 3DS field: 123456", "скотч на ozon") ===
    "скотч на ozon",
  "otp start keeps shop task",
);
assert(taskToStore("847291", "обувь на ozon") === "обувь на ozon", "digits otp keeps shop task");
assert(
  taskToStore("скотч на ozon", undefined) === "скотч на ozon",
  "fresh shop stores itself",
);
assert(
  taskToStore("скотч на ozon", "обувь на ozon") === "скотч на ozon",
  "new shop overwrites",
);

console.log("browser-policy-check ok");
