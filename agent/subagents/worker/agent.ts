import { defineAgent } from "eve";
import { z } from "zod";
import { broModel } from "../../lib/model";

const taskCompletionSchema = z.object({
  status: z.enum(["success", "failure"]),
  message: z.string().trim().min(1),
});

export default defineAgent({
  description:
    "Execute one bounded browser assignment for the root coordinator, including vault autofill, and return a structured verified result.",
  ...broModel(),
  reasoning: "low",
  outputSchema: taskCompletionSchema,
  compaction: {
    thresholdPercent: 0.7,
  },
});
