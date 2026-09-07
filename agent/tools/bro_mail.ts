import { defineTool } from "eve/tools";
import { z } from "zod";
import { isEmailAddr } from "../../convex/lib/mailPolicy.ts";
import { fillOtpBodies, listBroInbox } from "../lib/bro-inbox.ts";
import { touchJobMail, upsertTenant } from "../lib/convex";
import { agentHandle, inkbox } from "../lib/inkbox";
import { groupPersonalBlock } from "../lib/group-guard";
import {
  candidatesFromMail,
  formatOtpLookup,
  pickOtp,
} from "../lib/otp-policy.ts";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Bro's Inkbox mailbox, not their Gmail. send: confirm the first outbound of a job; replyToMessageId replies on a thread. inbox: recent inbound + OTP if present. Prefer otp / otp_lookup before asking in chat.",
  inputSchema: z.object({
    action: z.enum(["send", "inbox"]).optional(),
    to: z.string().min(3).max(200).optional(),
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(4000).optional(),
    jobId: z.string().optional(),
    replyToMessageId: z.string().optional(),
    query: z.string().min(1).max(120).optional(),
    sinceMinutes: z.number().min(1).max(180).optional(),
    limit: z.number().min(1).max(20).optional(),
  }),
  async execute(args, ctx) {
    const blocked = groupPersonalBlock(ctx);
    if (blocked) return { error: blocked };
    const action = args.action ?? "send";
    const phone = tenantId(ctx);
    const tenant = await upsertTenant(phone);
    const handle = tenant.inkboxHandle ?? agentHandle();

    if (action === "inbox") {
      const sinceMs = Date.now() - (args.sinceMinutes ?? 15) * 60_000;
      let listed = await listBroInbox({
        handle,
        sinceMs,
        limit: args.limit ?? 8,
      });
      listed = await fillOtpBodies(handle, listed);
      const q = args.query?.trim().toLowerCase();
      const filtered = q
        ? listed.filter((m) =>
            `${m.from} ${m.subject} ${m.snippet} ${m.body ?? ""}`
              .toLowerCase()
              .includes(q),
          )
        : listed;
      const otp = formatOtpLookup(
        pickOtp(
          filtered.flatMap((m) =>
            candidatesFromMail("bro_mail", {
              from: m.from,
              subject: m.subject,
              body: m.body ?? m.snippet,
              atMs: m.createdAtMs,
            }),
          ),
        ),
      );
      return {
        messages: filtered.map((m) => ({
          id: m.id,
          threadId: m.threadId,
          from: m.from,
          subject: m.subject,
          snippet: m.snippet,
          createdAtMs: m.createdAtMs,
        })),
        otp,
      };
    }

    const { to, subject, body, jobId, replyToMessageId } = args;
    if (!to || !subject || !body) {
      return { error: "send needs to, subject, body" };
    }
    if (!isEmailAddr(to)) return { error: "bad to address" };
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
