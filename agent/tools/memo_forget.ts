import { defineTool } from "eve/tools";
import { z } from "zod";
import { forgetLines } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description: "Delete memory lines that contain this substring.",
  inputSchema: z.object({
    needle: z.string().min(1),
  }),
  execute({ needle }, ctx) {
    return forgetLines(tenantId(ctx), needle);
  },
});
