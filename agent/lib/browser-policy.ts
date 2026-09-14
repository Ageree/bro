import { DONE } from "../../convex/lib/browserFollowPolicy.ts";

// Documented v4 run states that are not yet terminal: queued, dispatching,
// running (docs.browser-use.com/cloud/api-v4 — get-run/get-run-status/get-session
// all use the same six-value enum: queued|dispatching|running|completed|failed|cancelled).
const ACTIVE = new Set(["queued", "dispatching", "running"]);

export function normalizeTask(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isActiveStatus(status: string | undefined | null): boolean {
  return ACTIVE.has((status ?? "").trim().toLowerCase());
}

export function isDoneStatus(status: string | undefined | null): boolean {
  return DONE.has((status ?? "").trim().toLowerCase());
}

const NEW_JOB =
  /купи|купить|найди|найти|закаж|заказ|wb|wildberries|ozon|озон|wildberries\.|ozon\.ru|забронир|брон|запиш|запис|запись|столик|ресторан|врач|стоматолог|клиник|салон|такси|доставк|отель|билет|вызов|оформ|аренд/i;

function significantWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-zа-яё0-9]{4,}/giu) ?? [];
  return new Set(words);
}

/** True when `a` and `b` share a significant (4+ char) word — same topic/errand. */
export function sharesKeyword(a: string, b: string): boolean {
  const words = significantWords(a);
  for (const w of significantWords(b)) {
    if (words.has(w)) return true;
  }
  return false;
}

/**
 * True when `task` reads as a new errand rather than a ping or a follow-up
 * on the current one. A keyword (такси, забронируй, ...) always counts. A
 * long message with no keyword only counts when it does not share a
 * significant word with `storedTask` — a 48+ char question about the same
 * errand must not read as a fresh, separately-billed job.
 */
export function looksLikeNewJob(task: string, storedTask?: string): boolean {
  const t = task.trim();
  if (NEW_JOB.test(t)) return true;
  if (t.length < 48) return false;
  if (!storedTask) return true;
  return !sharesKeyword(t, storedTask);
}

/** One in-flight cloud job per person. Pings must poll, not spawn a twin search. */
export function nextBrowserAction(opts: {
  reset?: boolean;
  runId?: string | null;
  status?: string | null;
  storedTask?: string | null;
  incomingTask: string;
}): "start" | "poll" | "reuse" | "busy" {
  if (opts.reset) return "start";
  if (!opts.runId) return "start";
  if (isActiveStatus(opts.status)) {
    const stored = opts.storedTask?.trim();
    if (
      stored &&
      normalizeTask(stored) !== normalizeTask(opts.incomingTask) &&
      looksLikeNewJob(opts.incomingTask, stored) &&
      !sharesKeyword(opts.incomingTask, stored)
    ) {
      return "busy";
    }
    return "poll";
  }
  if (isDoneStatus(opts.status)) {
    if (
      opts.storedTask &&
      normalizeTask(opts.storedTask) === normalizeTask(opts.incomingTask)
    ) {
      return "reuse";
    }
    if (!looksLikeNewJob(opts.incomingTask, opts.storedTask ?? undefined)) {
      return "reuse";
    }
  }
  return "start";
}

export const BROWSER_WAIT_MS = 2_000;

export {
  nextFollowDecision,
  shouldStartFollowThrough,
} from "../../convex/lib/browserFollowPolicy.ts";
