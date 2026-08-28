import { defineTool } from "eve/tools";
import { z } from "zod";
import { scheduleWakeup, waitJob } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Park a job until the next event: human iMessage, inbound email to Bro's mailbox, the cloud browser finishing, or an outbound phone call ending. Include a short note of where you left off.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    waitingFor: z.enum(["human", "email", "browser", "call"]),
    note: z.string().max(280).optional(),
    emailThreadId: z.string().optional(),
    emailMessageId: z.string().optional(),
    callDestE164: z.string().optional(),
    callExternalId: z.string().optional(),
    checkInMinutes: z
      .number()
      .min(2)
      .max(10080)
      .optional()
      .describe(
        "schedule a background self-check to continue the chain without the human pinging",
      ),
  }),
  async execute(
    {
      jobId,
      waitingFor,
      note,
      emailThreadId,
      emailMessageId,
      callDestE164,
      callExternalId,
      checkInMinutes,
    },
    ctx,
  ) {
    const phone = tenantId(ctx);
    const job = await waitJob(phone, jobId, waitingFor, {
      note,
      emailThreadId,
      emailMessageId,
      callDestE164,
      callExternalId,
    });
    if ("error" in job || !checkInMinutes) return job;
    const goal = job.goal || job.note || jobId;
    const at = Date.now() + checkInMinutes * 60_000;
    try {
      await scheduleWakeup({
        tenantPhone: phone,
        at,
        kind: "job_check",
        payload: `джоб ${jobId}: ${goal}`,
        recurMinutes: checkInMinutes,
      });
      return { ...job, checkAt: new Date(at).toISOString() };
    } catch (err) {
      console.error("job_check wakeup failed", err);
      return job;
    }
  },
});
