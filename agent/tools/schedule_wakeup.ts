import { defineTool } from "eve/tools";
import { z } from "zod";
import { DEFAULT_TZ, nextDailyAt, parseWhen } from "../../convex/lib/wakeupPolicy";
import { getTenant, scheduleWakeup } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Schedule a future wake-up for this person: a reminder, daily brief, or watcher. Pass atIso, inMinutes, dailyHour, or everyMinutes. Optional tz is IANA; otherwise uses this person's timezone.",
  inputSchema: z.object({
    payload: z.string().min(1),
    atIso: z.string().optional(),
    inMinutes: z.number().optional(),
    dailyHour: z.number().min(0).max(23).optional(),
    everyMinutes: z.number().optional(),
    kind: z.enum(["reminder", "brief", "watcher"]).default("reminder"),
    tz: z.string().optional(),
  }),
  async execute({ payload, atIso, inMinutes, dailyHour, everyMinutes, kind, tz }, ctx) {
    const phone = tenantId(ctx);
    let resolvedTz = tz;
    if (resolvedTz) {
      try {
        new Intl.DateTimeFormat(undefined, { timeZone: resolvedTz });
      } catch {
        return `unknown timezone: ${resolvedTz}`;
      }
    } else {
      const tenant = await getTenant(phone);
      resolvedTz = tenant?.tz ?? DEFAULT_TZ;
    }
    const now = Date.now();
    let at: number | null = null;
    let recurMinutes: number | undefined;
    let recurDailyHour: number | undefined;
    if (typeof dailyHour === "number") {
      at = nextDailyAt(dailyHour, resolvedTz, now);
      recurDailyHour = dailyHour;
    } else if (typeof everyMinutes === "number" && everyMinutes > 0) {
      at = now + everyMinutes * 60_000;
      recurMinutes = everyMinutes;
    } else {
      at = parseWhen({ atIso, inMinutes }, now);
    }
    if (at === null) {
      return "need a future time: atIso, inMinutes, dailyHour, or everyMinutes";
    }
    const id = await scheduleWakeup({
      tenantPhone: phone,
      at,
      kind,
      payload,
      recurMinutes,
      recurDailyHour,
      tz: resolvedTz,
    });
    const when = new Date(at).toISOString();
    if (recurDailyHour !== undefined) {
      return `scheduled daily ${kind} at hour ${recurDailyHour} (${resolvedTz}), next ${when} (${id})`;
    }
    if (recurMinutes !== undefined) {
      return `scheduled ${kind} every ${recurMinutes} min, next ${when} (${id})`;
    }
    return `scheduled ${kind} at ${when} (${id})`;
  },
});
