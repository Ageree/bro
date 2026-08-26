import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "No-op. Cloud memory does not need OptMem compression.",
  inputSchema: z.object({}),
  execute() {
    return "ok";
  },
});
