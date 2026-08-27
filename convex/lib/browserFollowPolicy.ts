const DONE = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "stopped",
  "error",
]);

export const POLL_INTERVAL_MS = 2 * 60_000;
export const POLL_GIVE_UP_MS = 20 * 60_000;

export function isFollowTerminal(status: string): boolean {
  return DONE.has(status.trim().toLowerCase());
}

export function pollGiveUp(
  startedAt: number | undefined,
  now: number,
): boolean {
  if (startedAt === undefined) return false;
  return now - startedAt > POLL_GIVE_UP_MS;
}

export type FollowDecision = "wakeup" | "giveup" | "sleep";

export function nextFollowDecision(opts: {
  status: string;
  startedAt: number | undefined;
  now: number;
}): FollowDecision {
  if (isFollowTerminal(opts.status)) return "wakeup";
  if (pollGiveUp(opts.startedAt, opts.now)) return "giveup";
  return "sleep";
}

export function maxPollRounds(): number {
  return Math.ceil(POLL_GIVE_UP_MS / POLL_INTERVAL_MS);
}

/** Start a follow-through workflow only while the Browser Use job is still live. */
export function shouldStartFollowThrough(opts: {
  status: string;
  startedAt: number | undefined;
  now: number;
}): boolean {
  return nextFollowDecision(opts) === "sleep";
}
