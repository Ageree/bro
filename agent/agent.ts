import { defineAgent, defineDynamic } from "eve";
import { DEFAULT_ROOT_CONTEXT_TOKENS } from "./lib/model";
import { resolveBroModelForTurn } from "./lib/resolve-bro-model";

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) =>
        resolveBroModelForTurn(ctx, {
          contextTokens: DEFAULT_ROOT_CONTEXT_TOKENS,
        }),
    },
  }),
  compaction: {
    thresholdPercent: 0.7,
  },
});
