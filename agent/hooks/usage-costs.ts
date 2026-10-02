import { defineHook } from "eve/hooks";
import { recordCost } from "@agent/lib/costs/record";
import { turnCostSource, turnWorkspaceId } from "@agent/lib/costs/turns";
import { modelEndpoint } from "@agent/lib/model/endpoint";
import { usdToRub } from "@shared/costs/prices";

/**
 * Every model step of Bro's own turns, on every channel, into
 * `usage_costs`: the web chat used to be the only place a step's price was
 * summed (`chats.cost_usd`, in the browser), so Telegram, iMessage, the
 * schedules' workers and the browser reports cost nothing anywhere. The key
 * is the step's own coordinates, which a retried hook computes again, so a
 * step is counted once. OpenRouter prices a step in dollars; a step without
 * a price (a Gateway model) keeps its tokens at zero roubles, marked
 * `unpriced` so the summary tells it from a free one. RouterAI bills in
 * roubles, which reach eve as dollars at USAGE_USD_RUB
 * (`stepCostMiddleware` in `agent/lib/model/direct.ts`): its step keeps the
 * roubles and no `cost_usd`, which holds only a price given in dollars.
 */
export default defineHook({
  events: {
    async "step.completed"(event, ctx) {
      const workspaceId = turnWorkspaceId(ctx.session.auth);
      if (workspaceId === undefined) return;
      const { runId, source } = turnCostSource(ctx.session.auth);
      const { stepIndex, turnId, usage } = event.data;
      const costUsd = usage?.costUsd;
      await recordCost({
        costRub: costUsd === undefined ? 0 : usdToRub(costUsd),
        costUsd: billedInRoubles() ? null : (costUsd ?? null),
        idempotencyKey: `step:${ctx.session.id}:${turnId}:${String(stepIndex)}`,
        occurredAt: new Date(event.meta.at),
        runId: runId ?? null,
        sessionId: ctx.session.id,
        source,
        units: {
          cachedInputTokens: usage?.cacheReadTokens ?? 0,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          steps: 1,
          unpriced: costUsd === undefined,
        },
        workspaceId,
      });
    },
  },
});

/** Whether the backend that priced the step bills in roubles. */
function billedInRoubles() {
  return modelEndpoint()?.costCurrency === "rub";
}
