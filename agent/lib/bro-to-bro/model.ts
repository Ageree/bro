import { randomUUID } from "node:crypto";
import {
  generateText,
  type JSONValue,
  type ModelMessage,
  NoObjectGeneratedError,
  Output,
} from "ai";
import * as z from "zod";
import { directCallCost } from "@agent/lib/costs/model-call";
import { recordCost } from "@agent/lib/costs/record";
import { directModelSelection } from "@agent/lib/model/direct";
import { env } from "@shared/environment";

/**
 * The envoy's and the outgoing check's model when BRO_TO_BRO_MODEL is
 * unset. Not the memory digest's DeepSeek V4 Flash: in the duels of 23.10
 * (`scripts/bro-to-bro/duel.ts`, 6 cases × 3 runs, same prompts) it asked
 * its owner where he was to answer «где он сейчас» and then said «он в
 * командировке» in 3 of 3, and as the checker it listed refusals to share
 * as facts; GPT-6 Luna kept every closed request in 9 of 9 at about the same
 * price (≈0.06 ₽ a duel).
 */
const defaultModelId = "openai/gpt-6-luna";

/** The model the envoy and the outgoing check ask. */
export function broToBroModelId() {
  return env.BRO_TO_BRO_MODEL ?? defaultModelId;
}

/**
 * One call of Bro ↔ Bro's model outside any turn: no tools, no hidden
 * reasoning (a JSON answer within a small budget, as the judges have it),
 * the answer a JSON object. Its cost goes to `usage_costs` as
 * `background` as soon as the step ends, under the workspace the step
 * speaks for. A failed, refused or timed-out call throws; an answer that is
 * no JSON — a host that ignored the format and wrapped it in prose or a
 * fence — is read from its first `{` to its last `}`, and is `undefined`
 * when even that is no JSON.
 */
export async function askBroModel(request: {
  readonly instructions: string;
  readonly maxOutputTokens: number;
  readonly messages: readonly ModelMessage[];
  readonly purpose: "envoy" | "gate";
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly workspaceId: string;
}): Promise<JSONValue | undefined> {
  const modelId = broToBroModelId();
  const selection = directModelSelection(modelId, {
    reasoningOff: true,
    toolChoice: "none",
  });
  try {
    const { output } = await generateText({
      abortSignal: AbortSignal.any([
        AbortSignal.timeout(request.timeoutMs),
        ...(request.signal ? [request.signal] : []),
      ]),
      instructions: request.instructions,
      maxOutputTokens: request.maxOutputTokens,
      messages: [...request.messages],
      model: selection.model,
      async onStepEnd(step) {
        const cost = directCallCost(step.providerMetadata);
        await recordCost({
          ...cost,
          // One row per call: a step asked again pays again.
          idempotencyKey: `bro-to-bro:${request.purpose}:${request.workspaceId}:${randomUUID()}`,
          occurredAt: new Date(),
          sessionId: null,
          source: "background",
          units: {
            cachedInputTokens:
              step.usage.inputTokenDetails.cacheReadTokens ?? 0,
            inputTokens: step.usage.inputTokens ?? 0,
            model: modelId,
            outputTokens: step.usage.outputTokens ?? 0,
            steps: 1,
            unpriced: cost.costRub === 0,
          },
          workspaceId: request.workspaceId,
        });
      },
      output: Output.json(),
      providerOptions: selection.modelOptions.providerOptions,
    });
    return output;
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) throw error;
    const text = error.text ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      return z.json().parse(JSON.parse(text.slice(start, end + 1)));
    } catch {
      return undefined;
    }
  }
}
