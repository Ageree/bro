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
const THREEDS = /3ds|mir accept/i;
const OTP_ONLY = /^\d{4,8}$/;

export function looksLikeNewJob(task: string): boolean {
  const t = task.trim();
  if (t.length >= 48) return true;
  return NEW_JOB.test(t);
}

/** OTP / ACS follow-up: instructed 3DS phrase, Mir Accept, or a 4–8 digit-only task. */
export function looksLike3dsFollowUp(
  task: string,
  storedTask?: string | null,
): boolean {
  if (storedTask && normalizeTask(storedTask) === normalizeTask(task)) return false;
  const t = task.trim();
  if (THREEDS.test(t)) return true;
  return OTP_ONLY.test(t);
}

/** Persist the shop task across a 3DS OTP start so later pings still poll the order. */
export function taskToStore(incoming: string, stored?: string | null): string {
  if (looksLike3dsFollowUp(incoming, stored) && stored) return stored;
  return incoming;
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
  // 3DS OTP must start a new run on the existing session, not poll/reuse
  if (looksLike3dsFollowUp(opts.incomingTask, opts.storedTask)) return "start";
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
