import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoText } from "../lib/optmem";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Record one OptMem line (≤280 bytes) for this person. Call when you learn a lasting fact. If the result asks for a compression, call memo_nap next.",
  inputSchema: z.object({
    line: z.string().min(1).max(280),
  }),
  execute({ line }, ctx) {
    return memoText(tenantId(ctx), ["note", line]);
  },
});
