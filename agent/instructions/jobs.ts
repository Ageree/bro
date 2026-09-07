import { defineDynamic, defineInstructions } from "eve/instructions";
import { isGroupTurn } from "../lib/group-guard";
import { jobWakeLines } from "../lib/convex";
import { jobWakeInstruction } from "../lib/job-wake.ts";
import { tenantId } from "../lib/tenant";

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      if (isGroupTurn(ctx)) {
        return defineInstructions({
          role: "user",
          content:
            "Group turn. Do not inject or mention this person's private open jobs.",
        });
      }
      try {
        const content = jobWakeInstruction(await jobWakeLines(tenantId(ctx)));
        if (!content) return null;
        return defineInstructions({ role: "user", content });
      } catch (err) {
        return defineInstructions({
          role: "user",
          content: `Job store unavailable: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  },
});
