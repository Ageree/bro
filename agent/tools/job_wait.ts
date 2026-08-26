import { defineTool } from "eve/tools";
import { z } from "zod";
import { waitJob } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Park a job until the next event: human iMessage, inbound email to Bro's mailbox, or the cloud browser finishing. Include a short note of where you left off.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    waitingFor: z.enum(["human", "email", "browser"]),
    note: z.string().max(280).optional(),
    emailThreadId: z.string().optional(),
    emailMessageId: z.string().optional(),
  }),
  execute({ jobId, waitingFor, note, emailThreadId, emailMessageId }, ctx) {
    return waitJob(tenantId(ctx), jobId, waitingFor, {
      note,
      emailThreadId,
      emailMessageId,
    });
  },
});
