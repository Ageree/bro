import { defineTool } from "eve/tools";
import { z } from "zod";
import { fillOtpBodies, listBroInbox } from "../../../lib/bro-inbox.ts";
import { upsertTenant } from "../../../lib/convex";
import { groupPersonalBlock } from "../../../lib/group-guard";
import { agentHandle } from "../../../lib/inkbox";
import {
  candidatesFromMail,
  formatOtpLookup,
  pickOtp,
} from "../../../lib/otp-policy.ts";
import { tenantId } from "../../../lib/tenant";

export default defineTool({
  description:
    "List recent inbound on Bro's Inkbox mailbox and extract an OTP if present.",
  inputSchema: z.object({
    sinceMinutes: z.number().min(1).max(180).optional(),
    limit: z.number().min(1).max(20).optional(),
  }),
  async execute({ sinceMinutes, limit }, ctx) {
    const blocked = groupPersonalBlock(ctx);
    if (blocked) return { error: blocked };
    const phone = tenantId(ctx);
    const tenant = await upsertTenant(phone);
    const handle = tenant.inkboxHandle ?? agentHandle();
    const sinceMs = Date.now() - (sinceMinutes ?? 15) * 60_000;
    let listed = await listBroInbox({ handle, sinceMs, limit: limit ?? 8 });
    listed = await fillOtpBodies(handle, listed);
    const otp = formatOtpLookup(
      pickOtp(
        listed.flatMap((m) =>
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
      messages: listed.map((m) => ({
        id: m.id,
        from: m.from,
        subject: m.subject,
        snippet: m.snippet,
      })),
      otp,
    };
  },
});
