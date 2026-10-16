import type { LanguageModel } from "ai";
import { emptyDeliveryMarker } from "@agent/lib/delivery/empty";

type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: "v4" }>;

const stop = { raw: "stop", unified: "stop" } as const;
// Unknown, not zero: eve keeps a step's input tokens as the history's last
// known size (`lastKnownInputTokens`), and a zero would make the person's
// next step read its history as almost empty and skip compaction.
const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: undefined,
    total: undefined,
  },
  outputTokens: { reasoning: undefined, text: undefined, total: undefined },
};
// Where eve reads a step's price (`stepCostMiddleware` in `direct.ts`): the
// step is free, not unpriced.
const providerMetadata = { gateway: { cost: 0 } };

/**
 * A model that calls no provider: every step answers with eve's
 * empty-delivery marker, which ends the turn and delivers nothing. A turn
 * whose message code wrote for the person (`backgroundNoticeMessage`) has
 * nothing for a model to do, and one the conversation's model kept failing
 * on would fail again.
 */
const emptyTurnModel: LanguageModelV4 = {
  doGenerate: async () => ({
    content: [{ text: emptyDeliveryMarker, type: "text" }],
    finishReason: stop,
    providerMetadata,
    usage,
    warnings: [],
  }),
  doStream: async () => ({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ id: "empty-turn", type: "text-start" });
        controller.enqueue({
          delta: emptyDeliveryMarker,
          id: "empty-turn",
          type: "text-delta",
        });
        controller.enqueue({ id: "empty-turn", type: "text-end" });
        controller.enqueue({
          finishReason: stop,
          providerMetadata,
          type: "finish",
          usage,
        });
        controller.close();
      },
    }),
  }),
  modelId: "empty-turn",
  provider: "bro",
  specificationVersion: "v4",
  supportedUrls: {},
};

/**
 * The step's selection for such a turn. The window is given, so eve looks
 * nothing up in the AI Gateway catalog, and it is so wide that eve never
 * compacts before the step: the summary would come from this model.
 */
export const emptyTurnSelection = {
  model: emptyTurnModel,
  modelContextWindowTokens: Number.MAX_SAFE_INTEGER,
};
