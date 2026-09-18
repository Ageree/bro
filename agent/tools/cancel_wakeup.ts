import { defineTool } from "eve/tools";
import { z } from "zod";
import { cancelWakeup } from "../lib/convex";
import { tenantId } from "../lib/tenant";
import { instinctBlocked } from "../lib/instinct-guard.ts";
import { turnAttributes } from "../lib/turn-attrs";

export default defineTool({
  description:
    "Cancel a scheduled wake-up for this person by id, or all scheduled wake-ups of a kind. payloadContains limits kind-cancel to matching payloads (e.g. джоб <id>). kind=instinct turns off the background scan that lets Bro write first — use it when the person asks not to be written to unprompted.",
  inputSchema: z.object({
    id: z.string().optional(),
    kind: z
      .enum(["reminder", "brief", "watcher", "job_check", "instinct"])
      .optional(),
    payloadContains: z.string().optional(),
  }),
  async execute({ id, kind, payloadContains }, ctx) {
    const blocked = instinctBlocked(turnAttributes(ctx), "cancel_wakeup");
    if (blocked) return blocked;
    const n = await cancelWakeup(tenantId(ctx), { id, kind, payloadContains });
    return `cancelled ${n}`;
  },
});
