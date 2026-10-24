import type { ProviderMetadata } from "ai";
import * as z from "zod";
import { modelEndpoint } from "@agent/lib/model/endpoint";
import { usdToRub } from "@shared/costs/prices";

const reportedCostSchema = z.object({
  usage: z.object({ cost: z.number().nonnegative() }).loose(),
});

/**
 * What a direct model call outside any turn cost, in the backend's currency
 * as the provider reported it (RouterAI in roubles, OpenRouter in dollars);
 * nothing reported is zero roubles, which the caller marks unpriced.
 */
export function directCallCost(metadata: ProviderMetadata | undefined) {
  const reported = reportedCostSchema.safeParse(metadata?.openrouter);
  if (!reported.success) return { costRub: 0, costUsd: null };
  const { cost } = reported.data.usage;
  return modelEndpoint()?.costCurrency === "rub"
    ? { costRub: cost, costUsd: null }
    : { costRub: usdToRub(cost), costUsd: cost };
}
