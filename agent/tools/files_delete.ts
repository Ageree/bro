import { defineTool } from "eve/tools";
import { z } from "zod";
import { asPersonal } from "../lib/personal.ts";
import { deleteStoredFile, fileFailure } from "../lib/files.ts";

export default defineTool({
  description:
    "Delete one of this person's saved files by id or name. Group chats cannot use files.",
  inputSchema: z.object({
    fileId: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(200).optional(),
  }),
  async execute({ fileId, name }, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    if (!fileId && !name) {
      return { status: "invalid" as const, error: "fileId or name required" };
    }
    try {
      const deleted = await deleteStoredFile(who.phone, { fileId, name });
      return { status: "ok" as const, deleted };
    } catch (err) {
      return fileFailure(err);
    }
  },
});
