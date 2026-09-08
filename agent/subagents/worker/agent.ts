import { defineAgent, defineDynamic } from "eve";
import { z } from "zod";
import { resolveBroModelForTurn } from "../../lib/resolve-bro-model";

const taskCompletionSchema = z.object({
  status: z.enum(["success", "failure"]),
  message: z.string().trim().min(1),
});

export default defineAgent({
  description:
    "Execute one bounded browser assignment for the root coordinator, including vault autofill, and return a structured verified result.",
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => resolveBroModelForTurn(ctx),
    },
  }),
  reasoning: "low",
  outputSchema: taskCompletionSchema,
  compaction: {
    thresholdPercent: 0.7,
  },
});
