import { defineTool } from "eve/tools";
import { z } from "zod";
import { nextDailyAt, parseWhen } from "../../convex/lib/wakeupPolicy";
import { scheduleWakeup } from "../lib/convex";
import { tenantId } from "../lib/tenant";

const TZ = "Europe/Moscow";

export default defineTool({
  description:
    "Schedule a future wake-up for this person: a reminder, daily brief, or watcher. Pass atIso, inMinutes, dailyHour, or everyMinutes.",
  inputSchema: z.object({
    payload: z.string().min(1),
    atIso: z.string().optional(),
    inMinutes: z.number().optional(),
    dailyHour: z.number().min(0).max(23).optional(),
    everyMinutes: z.number().optional(),
    kind: z.enum(["reminder", "brief", "watcher"]).default("reminder"),
  }),
  async execute({ payload, atIso, inMinutes, dailyHour, everyMinutes, kind }, ctx) {
    const now = Date.now();
    let at: number | null = null;
    let recurMinutes: number | undefined;
    let recurDailyHour: number | undefined;
    if (typeof dailyHour === "number") {
      at = nextDailyAt(dailyHour, TZ, now);
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
      tenantPhone: tenantId(ctx),
      at,
      kind,
      payload,
      recurMinutes,
      recurDailyHour,
      tz: TZ,
    });
    const when = new Date(at).toISOString();
    if (recurDailyHour !== undefined) {
      return `scheduled daily ${kind} at hour ${recurDailyHour} (${TZ}), next ${when} (${id})`;
    }
    if (recurMinutes !== undefined) {
      return `scheduled ${kind} every ${recurMinutes} min, next ${when} (${id})`;
    }
    return `scheduled ${kind} at ${when} (${id})`;
  },
});
