import { defineTool } from "eve/tools";
import { z } from "zod";
import { setTimezone } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Set this person's IANA timezone (e.g. Europe/Moscow, Asia/Vladivostok) for daily briefs and daily limits.",
  inputSchema: z.object({
    tz: z.string().min(1),
  }),
  async execute({ tz }, ctx) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      return `unknown timezone: ${tz}`;
    }
    await setTimezone(tenantId(ctx), tz);
    return `timezone set to ${tz}`;
  },
});
