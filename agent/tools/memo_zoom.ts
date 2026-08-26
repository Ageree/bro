import { defineTool } from "eve/tools";
import { z } from "zod";
import { wakeLines } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description: "Dump recent memory lines for this person.",
  inputSchema: z.object({}),
  execute(_args, ctx) {
    return wakeLines(tenantId(ctx)).then((rows) =>
      rows.length ? rows.join("\n") : "No memories yet.",
    );
  },
});
