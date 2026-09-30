import { recordUsageCost } from "@db/services/usage-costs";

/**
 * Record a cost as a side effect of whatever incurred it. The accounting
 * must never cost the person a turn, a run or a VM step, so a write that
 * fails is logged and dropped. True when the cost is on record — written
 * now, or already there under the same idempotency key — so a caller that
 * can write the same cost again later (a VM stretch kept open until it is
 * recorded) knows whether it still has to.
 */
export async function recordCost(input: Parameters<typeof recordUsageCost>[0]) {
  try {
    await recordUsageCost(input);
    return true;
  } catch (error) {
    console.warn("[usage-costs] a cost could not be recorded", {
      error: error instanceof Error ? error.message : String(error),
      key: input.idempotencyKey,
      source: input.source,
    });
    return false;
  }
}
