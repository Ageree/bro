import { defineTool } from "eve/tools";
import { z } from "zod";
import { isEmailAddr } from "../../convex/lib/mailPolicy.ts";
import { touchJobMail, upsertTenant } from "../lib/convex";
import { agentHandle, inkbox } from "../lib/inkbox";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Send email FROM Bro's own Inkbox mailbox (not the human's Gmail). Confirm with the human before the first send of a job. Pass replyToMessageId (Inkbox message uuid from [event:mail] or the job wake line) to reply on a thread.",
  inputSchema: z.object({
    to: z.string().min(3).max(200),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(4000),
    jobId: z.string().optional(),
    replyToMessageId: z.string().optional(),
  }),
  async execute({ to, subject, body, jobId, replyToMessageId }, ctx) {
    if (!isEmailAddr(to)) return { error: "bad to address" };
    const phone = tenantId(ctx);
    const tenant = await upsertTenant(phone);
    const handle = tenant.inkboxHandle ?? agentHandle();
    const identity = await inkbox().getIdentity(handle);
    if (!identity.emailAddress) return { error: "no mailbox" };

    const sent = replyToMessageId
      ? await identity.replyAllEmail(replyToMessageId, {
          subject,
          bodyText: body,
        })
      : await identity.sendEmail({
          to: [to],
          subject,
          bodyText: body,
        });

    if (jobId) {
      await touchJobMail(phone, jobId, {
        emailThreadId: sent.threadId ?? undefined,
        emailMessageId: sent.id,
      }).catch((err) => console.error("touch job mail after send failed", err));
    }

    return {
      id: sent.id,
      threadId: sent.threadId,
      from: identity.emailAddress,
      to: sent.toAddresses,
      subject: sent.subject,
      hint: jobId
        ? "If you are waiting on a reply, job_wait waitingFor=email with this threadId."
        : undefined,
    };
  },
});
