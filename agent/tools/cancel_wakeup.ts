import { defineTool } from "eve/tools";
import { z } from "zod";
import { cancelWakeup } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Cancel a scheduled wake-up for this person by id, or all scheduled wake-ups of a kind.",
  inputSchema: z.object({
    id: z.string().optional(),
    kind: z.enum(["reminder", "brief", "watcher"]).optional(),
  }),
  async execute({ id, kind }, ctx) {
    const n = await cancelWakeup(tenantId(ctx), { id, kind });
    return `cancelled ${n}`;
  },
});
