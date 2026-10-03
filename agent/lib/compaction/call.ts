import { createHash, randomUUID } from "node:crypto";
import { APICallError, type LanguageModelMiddleware } from "ai";
import { z } from "zod";
import { recordCost } from "@agent/lib/costs/record";
import { modelEndpoint } from "@agent/lib/model/endpoint";
import { usdToRub } from "@shared/costs/prices";

/** A step's price where eve reads it (`stepCostMiddleware` in `direct.ts`). */
const gatewayCostSchema = z.object({ cost: z.number().nonnegative() });

/**
 * How long a session whose summary call failed keeps its whole window. eve
 * neither retries a step whose compaction failed nor keeps anything of it,
 * so the next text turn of the chat would run the same compaction over the
 * same history and fail it again.
 */
const failureHoldMs = 24 * 60 * 60_000;

/** Enough for every session compacting on an instance at once. */
const rememberedFailures = 1000;

/**
 * The attempts of one summary call: eve calls it through AI SDK's
 * `generateText` with its default two retries, and the middleware sees each
 * attempt.
 */
const callAttempts = 3;

/** Retryable failures of the summary calls under way, by session and prompt. */
const retriedCalls = new Map<string, number>();

/** When each session's last summary call failed, oldest first. */
const failures = new Map<string, number>();

function noteFailure(sessionId: string) {
  failures.delete(sessionId);
  failures.set(sessionId, Date.now());
  if (failures.size > rememberedFailures) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
}

/**
 * Whether the pilot leaves `sessionId` its whole window for now: its last
 * summary call failed, within `failureHoldMs`. Kept on the instance: one
 * that never saw the failure tries once more, and fails one turn.
 */
export function compactionHeld(sessionId: string) {
  const failedAt = failures.get(sessionId);
  return failedAt !== undefined && Date.now() - failedAt < failureHoldMs;
}

/**
 * eve's compaction call of a pilot step (`compactionPilot`). eve calls the
 * step's own model with no tools (`compactMessages` in
 * `eve/dist/src/harness/compaction.js`), and every step of Bro's has tools,
 * so a call without them is a compaction.
 *
 * - Its cost. eve does not count the call anywhere — it is no step, so
 *   neither `step.completed` nor `agent/hooks/usage-costs.ts` sees it — yet
 *   RouterAI bills it. Outermost in the stack, the middleware sees the price
 *   `stepCostMiddleware` put where eve reads it and prices the call as the
 *   hook prices a step, under the turn's source and errand
 *   (`turnCostSource`). The row is keyed by the turn, a digest of the
 *   prompt and the provider's id of the answer (a random one without it):
 *   a step eve runs again — after a restart, or one whose model call
 *   failed — compacts the same history with the same prompt, and RouterAI
 *   bills each call; only the same answer is counted once. Like every
 *   cost, a write that fails is logged and the compaction goes on.
 * - Its failure. A call that throws, or answers no text (eve then throws
 *   itself), fails the step with no retry, and the turn with it: the
 *   session keeps its whole window for a while (`compactionHeld`), so the
 *   person's next message is not lost to the same failure. An attempt AI
 *   SDK retries (a 429 or a 5xx, `APICallError.isRetryable`) is no failure
 *   until the last of `callAttempts`.
 */
export function compactionCallMiddleware(owner: {
  readonly runId: string | null;
  readonly sessionId: string;
  readonly source: Parameters<typeof recordCost>[0]["source"];
  readonly turnId?: string;
  readonly workspaceId: string;
}): LanguageModelMiddleware {
  return {
    async wrapGenerate({ doGenerate, model, params }) {
      if (params.tools !== undefined && params.tools.length > 0) {
        return doGenerate();
      }
      const failed = (cause: unknown) => {
        noteFailure(owner.sessionId);
        console.warn("[compaction] failed", {
          cause,
          sessionId: owner.sessionId,
          turnId: owner.turnId,
        });
      };
      const digest = createHash("sha256")
        .update(JSON.stringify(params.prompt))
        .digest("hex")
        .slice(0, 16);
      const call = `${owner.sessionId}:${digest}`;
      let result: Awaited<ReturnType<typeof doGenerate>>;
      try {
        result = await doGenerate();
      } catch (error) {
        // A turn interrupted or steered aborts the call: nothing failed.
        if (params.abortSignal?.aborted === true) throw error;
        const retried = (retriedCalls.get(call) ?? 0) + 1;
        retriedCalls.delete(call);
        if (
          APICallError.isInstance(error) &&
          error.isRetryable &&
          retried < callAttempts
        ) {
          retriedCalls.set(call, retried);
          if (retriedCalls.size > rememberedFailures) {
            const oldest = retriedCalls.keys().next().value;
            if (oldest !== undefined) retriedCalls.delete(oldest);
          }
          throw error;
        }
        failed(error instanceof Error ? error.message : String(error));
        throw error;
      }
      retriedCalls.delete(call);
      // eve reads the summary as the answer's text.
      const summary = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
        .trim();
      if (summary.length === 0) {
        failed(`empty summary (${result.finishReason.unified})`);
      }
      try {
        const inputTokens = result.usage.inputTokens.total ?? 0;
        const outputTokens = result.usage.outputTokens.total ?? 0;
        console.info("[compaction]", {
          inputTokens,
          outputTokens,
          sessionId: owner.sessionId,
          turnId: owner.turnId,
        });
        const costUsd = gatewayCostSchema.safeParse(
          result.providerMetadata?.gateway
        ).data?.cost;
        await recordCost({
          costRub: costUsd === undefined ? 0 : usdToRub(costUsd),
          costUsd:
            modelEndpoint()?.costCurrency === "rub" ? null : (costUsd ?? null),
          idempotencyKey: `compaction:${owner.sessionId}:${owner.turnId ?? "-"}:${digest}:${result.response?.id ?? randomUUID()}`,
          occurredAt: new Date(),
          runId: owner.runId,
          sessionId: owner.sessionId,
          source: owner.source,
          units: {
            cachedInputTokens: result.usage.inputTokens.cacheRead ?? 0,
            flavor: "compaction",
            inputTokens,
            model: model.modelId,
            outputTokens,
            unpriced: costUsd === undefined,
          },
          workspaceId: owner.workspaceId,
        });
      } catch (error) {
        console.warn("[compaction] the cost could not be recorded", {
          cause: error,
        });
      }
      return result;
    },
  };
}
