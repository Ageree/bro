const ACTIVE = new Set([
  "queued",
  "pending",
  "running",
  "started",
  "in_progress",
  "working",
  "processing",
]);

const DONE = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "stopped",
  "error",
]);

export function normalizeTask(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isActiveStatus(status: string | undefined | null): boolean {
  return ACTIVE.has((status ?? "").trim().toLowerCase());
}

export function isDoneStatus(status: string | undefined | null): boolean {
  return DONE.has((status ?? "").trim().toLowerCase());
}

const NEW_JOB = /купи|купить|найди|найти|закаж|заказ|wb|wildberries|ozon|озон|wildberries\.|ozon\.ru/i;

export function looksLikeNewJob(task: string): boolean {
  const t = task.trim();
  if (t.length >= 48) return true;
  return NEW_JOB.test(t);
}

/** One in-flight cloud job per person. Pings must poll, not spawn a twin search. */
export function nextBrowserAction(opts: {
  reset?: boolean;
  runId?: string | null;
  status?: string | null;
  storedTask?: string | null;
  incomingTask: string;
}): "start" | "poll" | "reuse" {
  if (opts.reset) return "start";
  if (!opts.runId) return "start";
  if (isActiveStatus(opts.status)) return "poll";
  if (isDoneStatus(opts.status)) {
    if (
      opts.storedTask &&
      normalizeTask(opts.storedTask) === normalizeTask(opts.incomingTask)
    ) {
      return "reuse";
    }
    if (!looksLikeNewJob(opts.incomingTask)) return "reuse";
  }
  return "start";
}

const POLL_GIVE_UP_MS = 20 * 60_000;

export function pollTimedOut(
  startedAt: number | undefined,
  now: number,
): boolean {
  if (startedAt === undefined) return false;
  return now - startedAt > POLL_GIVE_UP_MS;
}
