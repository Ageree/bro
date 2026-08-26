import { defineTool } from "eve/tools";
import { z } from "zod";
import { noteLine } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Record one lasting fact for this person (≤280 chars): size, address, ПВЗ, taste, login result, order.",
  inputSchema: z.object({
    line: z.string().min(1).max(280),
  }),
  execute({ line }, ctx) {
    return noteLine(tenantId(ctx), line);
  },
});
