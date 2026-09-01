import { defineTool } from "eve/tools";
import { z } from "zod";
import { cancelWakeup } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Cancel a scheduled wake-up for this person by id, or all scheduled wake-ups of a kind. payloadContains limits kind-cancel to matching payloads (e.g. джоб <id>).",
  inputSchema: z.object({
    id: z.string().optional(),
    kind: z.enum(["reminder", "brief", "watcher", "job_check", "computer_poll"]).optional(),
    payloadContains: z.string().optional(),
  }),
  async execute({ id, kind, payloadContains }, ctx) {
    const n = await cancelWakeup(tenantId(ctx), { id, kind, payloadContains });
    return `cancelled ${n}`;
  },
});
