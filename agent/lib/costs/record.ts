import { recordUsageCost } from "@db/services/usage-costs";

/**
 * Record a cost as a side effect of whatever incurred it. The accounting
 * must never cost the person a turn, a run or a VM step, so a write that
 * fails is logged and dropped: the idempotency key lets a later write of the
 * same cost (a settled run read again) still land.
 */
export async function recordCost(input: Parameters<typeof recordUsageCost>[0]) {
  try {
    await recordUsageCost(input);
  } catch (error) {
    console.warn("[usage-costs] a cost could not be recorded", {
      error: error instanceof Error ? error.message : String(error),
      key: input.idempotencyKey,
      source: input.source,
    });
  }
}
