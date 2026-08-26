import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoText } from "../lib/optmem";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description: "Regex-search every OptMem line ever recorded for this person.",
  inputSchema: z.object({
    regex: z.string().min(1),
  }),
  execute({ regex }, ctx) {
    return memoText(tenantId(ctx), ["recall", regex]);
  },
});
