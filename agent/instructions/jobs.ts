import { defineDynamic, defineInstructions } from "eve/instructions";
import { isGroupTurn } from "../lib/group-guard";
import { jobWakeLines } from "../lib/convex";
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
      let text = "No open jobs.";
      try {
        const lines = await jobWakeLines(tenantId(ctx));
        if (lines.length) text = lines.join("\n");
      } catch (err) {
        text = `Job store unavailable: ${err instanceof Error ? err.message : String(err)}`;
      }
      return defineInstructions({
        role: "user",
        content: `Open jobs for this person only. A user message starting with [event:mail] is inbound mail to Bro's mailbox, not the human speaking. If a worker or job is waiting on a one-time code, extract it from the letter (or call otp / otp_lookup) before asking in the thread.\n\n${text}`,
      });
    },
  },
});
