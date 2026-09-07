import { defineDynamic, defineInstructions } from "eve/instructions";
import { isGroupTurn, turnAttributes } from "../lib/group-guard";
import { jobWakeRows, markNudged } from "../lib/convex";
import {
  dueJobNudges,
  isJobCheckWakeup,
  jobNudgeInstruction,
  jobWakeInstruction,
} from "../lib/job-wake.ts";
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
        const phone = tenantId(ctx);
        const rows = await jobWakeRows(phone);
        const now = Date.now();
        const jobCheck = isJobCheckWakeup(turnAttributes(ctx));
        const due = jobCheck ? dueJobNudges(rows, now) : [];
        for (const job of due) {
          await markNudged(phone, job.id).catch((err) =>
            console.error("markNudged failed", err),
          );
        }
        const content = [
          jobWakeInstruction(rows.map((r) => r.line)),
          jobCheck ? jobNudgeInstruction(rows, now) : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n\n");
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
