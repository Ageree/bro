import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoText } from "../lib/optmem";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description:
    "Drop a bad OptMem summary (e.g. 0-1). The log is untouched; the next nap rebuilds it.",
  inputSchema: z.object({
    block: z.string().regex(/^\d+-\d+$/),
  }),
  execute({ block }, ctx) {
    return memoText(tenantId(ctx), ["forget", block]);
  },
});
