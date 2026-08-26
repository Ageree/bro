import { defineDynamic, defineInstructions } from "eve/instructions";
import { jobWakeLines } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      let text = "No open jobs.";
      try {
        const lines = await jobWakeLines(tenantId(ctx));
        if (lines.length) text = lines.join("\n");
      } catch (err) {
        text = `Job store unavailable: ${err instanceof Error ? err.message : String(err)}`;
      }
      return defineInstructions({
        role: "user",
        content: `Open jobs for this person only. A user message starting with [event:mail] is inbound mail to Bro's mailbox, not the human speaking.\n\n${text}`,
      });
    },
  },
});
