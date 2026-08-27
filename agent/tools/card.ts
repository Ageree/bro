import { defineTool } from "eve/tools";
import { z } from "zod";
import { cardStatus, forgetCard, mintCardLink } from "../lib/card";
import { upsertTenant } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "This person's saved card. link: one-time hosted form URL (send it on its own iMessage line). status: last4+brand or empty. forget: delete the card. Never ask for or return PAN/CVC.",
  inputSchema: z.object({
    action: z.enum(["link", "status", "forget"]),
  }),
  async execute({ action }, ctx) {
    const phone = tenantId(ctx);
    await upsertTenant(phone);
    if (action === "link") {
      const { url } = await mintCardLink(phone);
      return { url };
    }
    if (action === "status") {
      const st = await cardStatus(phone);
      if (!st) return { empty: true };
      return { last4: st.last4, brand: st.brand };
    }
    await forgetCard(phone);
    return { forgotten: true };
  },
});
