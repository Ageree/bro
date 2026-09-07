import { defineAgent } from "eve";
import { broModel, DEFAULT_ROOT_CONTEXT_TOKENS } from "./lib/model";

export default defineAgent({
  ...broModel({ contextTokens: DEFAULT_ROOT_CONTEXT_TOKENS }),
  compaction: {
    thresholdPercent: 0.7,
  },
});
