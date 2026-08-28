export const WAKEUP_DEDUPE_TTL_MS = 15 * 60_000;

/**
 * In-memory /internal/wakeup dedupe.
 * Limitation: per-process Map — lost on restart and not shared across instances.
 */
export function takeWakeupDelivery(
  seen: Map<string, number>,
  key: string,
  now: number,
  ttlMs = WAKEUP_DEDUPE_TTL_MS,
): boolean {
  for (const [k, at] of seen) {
    if (now - at >= ttlMs) seen.delete(k);
  }
  const prev = seen.get(key);
  if (prev !== undefined && now - prev < ttlMs) return false;
  seen.set(key, now);
  return true;
}

export function releaseWakeupDelivery(
  seen: Map<string, number>,
  key: string,
): void {
  seen.delete(key);
}
