import { defineTool } from "eve/tools";
import { z } from "zod";
import { finishJob } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Close a job. Use when doneWhen is true, or the human cancelled. failed=true if it died.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    outcome: z.string().min(1).max(280),
    failed: z.boolean().optional(),
  }),
  execute({ jobId, outcome, failed }, ctx) {
    return finishJob(tenantId(ctx), jobId, outcome, failed);
  },
});
