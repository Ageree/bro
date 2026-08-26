import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoText } from "../lib/optmem";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Compress the next OptMem block. Pass the block id (e.g. 0-1) and a one-line summary ≤280 bytes. Invent nothing. If nap asks another compression, call this again.",
  inputSchema: z.object({
    block: z.string().regex(/^\d+-\d+$/),
    summary: z.string().min(1).max(280),
  }),
  execute({ block, summary }, ctx) {
    return memoText(tenantId(ctx), ["nap", block, summary]);
  },
});
