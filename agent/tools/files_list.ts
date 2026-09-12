import { defineTool } from "eve/tools";
import { z } from "zod";
import { asPersonal } from "../lib/personal.ts";
import { fileFailure, listStoredFiles } from "../lib/files.ts";

export default defineTool({
  description:
    "List this person's saved files (name, type, size). Bro keeps their files. Group chats cannot use files.",
  inputSchema: z.object({}),
  async execute(_args, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    try {
      const files = await listStoredFiles(who.phone);
      return { status: "ok" as const, files };
    } catch (err) {
      return fileFailure(err);
    }
  },
});
