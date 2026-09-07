import { defineDynamic, defineInstructions } from "eve/instructions";
import { isGroupTurn, turnAttributes } from "../lib/group-guard";
import { jobWakeRows, markNudged } from "../lib/convex";
import {
  dueJobNudges,
  isJobCheckWakeup,
  jobCheckPayload,
  JOB_CHECK_QUIET,
  jobNudgeInstruction,
  jobWakeInstruction,
} from "../lib/job-wake.ts";
import { isShortAckTurn, shortAckInstruction } from "../lib/short-ack.ts";
import { tenantId } from "../lib/tenant";

export default defineDynamic({
  events: {
    async "turn.started"(_event, ctx) {
      if (isGroupTurn(ctx)) {
        return defineInstructions({
          role: "system",
          content:
            "Group turn. Do not inject or mention this person's private open jobs.",
        });
      }
      try {
        const phone = tenantId(ctx);
        const rows = await jobWakeRows(phone);
        const now = Date.now();
        const attrs = turnAttributes(ctx);
        const jobCheck = isJobCheckWakeup(attrs);
        const scope = jobCheck ? { payload: jobCheckPayload(attrs) } : undefined;
        const due = scope ? dueJobNudges(rows, now, scope) : [];
        if (due.length > 0) {
          void Promise.all(
            due.map((job) =>
              markNudged(phone, job.id).catch((err) =>
                console.error("markNudged failed", err),
              ),
            ),
          );
        }
        const ack =
          !jobCheck && isShortAckTurn(attrs)
            ? shortAckInstruction({
                waitingForHuman: rows.some((row) => row.waitingFor === "human"),
              })
            : null;
        const content = [
          jobWakeInstruction(rows.map((r) => r.line)),
          scope
            ? due.length > 0
              ? jobNudgeInstruction(due)
              : JOB_CHECK_QUIET
            : null,
          ack,
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n\n");
        if (!content) return null;
        return defineInstructions({ role: "system", content });
      } catch (err) {
        return defineInstructions({
          role: "system",
          content: `Job store unavailable: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  },
});
