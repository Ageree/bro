import { defineTool } from "eve/tools";
import { z } from "zod";
import { cancelWakeup, finishJob } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Close a job. Use when doneWhen is true, or the human cancelled. failed=true if it died.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    outcome: z.string().min(1).max(280),
    failed: z.boolean().optional(),
  }),
  async execute({ jobId, outcome, failed }, ctx) {
    const phone = tenantId(ctx);
    const result = await finishJob(phone, jobId, outcome, failed);
    if (!("error" in result)) {
      try {
        await cancelWakeup(phone, {
          kind: "job_check",
          payloadContains: `джоб ${jobId}`,
        });
      } catch (err) {
        console.error("job_check cancel failed", err);
      }
    }
    return result;
  },
});
