import { z } from "zod";

export const endCallToolSchema = z.object({
  type: z.literal("system"),
  name: z.literal("end_call"),
  params: z.object({ system_tool_type: z.literal("end_call") }).strict(),
  assignments: z.array(z.never()).optional(),
});
