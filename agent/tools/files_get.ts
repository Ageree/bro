import { defineTool } from "eve/tools";
import { z } from "zod";
import { asPersonal } from "../lib/personal.ts";
import { fileFailure, previewStoredFile } from "../lib/files.ts";

export default defineTool({
  description:
    "Read one of this person's saved files by id or name. Small text is returned inline; larger or binary files get metadata (and a url when needed). Group chats cannot use files.",
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
      const preview = await previewStoredFile(who.phone, { fileId, name });
      return {
        status: "ok" as const,
        file: preview.file,
        ...(preview.content !== undefined ? { content: preview.content } : {}),
        ...(preview.truncated ? { truncated: true } : {}),
      };
    } catch (err) {
      return fileFailure(err);
    }
  },
});
