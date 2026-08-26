import { defineTool } from "eve/tools";
import { z } from "zod";
import { searchLines } from "../lib/convex";
import { tenantId } from "../lib/tenant";

export default defineTool({
  description: "Search this person's memory lines (substring, case-insensitive).",
  inputSchema: z.object({
    needle: z.string().min(1),
  }),
  execute({ needle }, ctx) {
    return searchLines(tenantId(ctx), needle).then((rows) =>
      rows.length ? rows.join("\n") : "no matches",
    );
  },
});
