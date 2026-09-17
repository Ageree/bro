/**
 * A budget for any promise that crosses the network.
 *
 * This lived inside `agent/lib/composio.ts`, which made it unreachable for
 * everything that must not import the Composio SDK — including the Convex
 * client, which is the one dependency on the hot path of literally every tool.
 *
 * WHY a shared home matters. The failure this guards against is not an error,
 * it is SILENCE. A turn writes «проверяю бронь ресторана», calls a tool, and
 * the tool's network call never settles: no exception is thrown, no bubble is
 * sent, and the person sits looking at a promise nobody broke. That is the
 * 2026-09-16 incident recorded in `agent/lib/silent-turn.ts`, where the wait
 * ran sixteen minutes because the tool behind the status line had no deadline.
 *
 * With a budget the hang becomes a throw, `turn.failed` fires, and the channel
 * sends `TURN_STALLED_REPLY` — the person learns the truth in seconds instead
 * of being left on read. A deadline here is therefore not a performance knob;
 * it is what converts an invisible failure into a visible one.
 */

/** Reject with a named error once the budget is spent. Never leaves a timer behind. */
export function withDeadline<T>(
  work: Promise<T>,
  budgetMs: number,
  what: string,
): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${budgetMs} ms`)),
      budgetMs,
    );
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Positive finite number from an env var, else the fallback. */
export function budgetFromEnv(
  raw: string | undefined,
  fallback: number,
): number {
  const n = Number(raw?.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
