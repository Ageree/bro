import { defineTool } from "eve/tools";
import { z } from "zod";
import { asPersonal } from "../lib/personal.ts";
import { fileFailure, saveTextFile, uploadFileBytes } from "../lib/files.ts";

export default defineTool({
  description:
    "Save a file for this person. Text via content (max 256KB). Binary via base64 (max 8MB). Same name replaces the previous file. Group chats cannot use files.",
  inputSchema: z.object({
    name: z.string().min(1).max(200),
    content: z.string().max(262_144).optional(),
    bytesBase64: z.string().max(12_000_000).optional(),
    mimeType: z.string().min(1).max(200).optional(),
  }),
  async execute({ name, content, bytesBase64, mimeType }, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    if (content && bytesBase64) {
      return { status: "invalid" as const, error: "pass content or bytesBase64, not both" };
    }
    if (!content && !bytesBase64) {
      return { status: "invalid" as const, error: "content or bytesBase64 required" };
    }
    try {
      const saved = content
        ? await saveTextFile(who.phone, { name, content, mimeType })
        : await uploadFileBytes(who.phone, {
            name,
            mimeType: mimeType ?? "application/octet-stream",
            bytes: Buffer.from(bytesBase64!, "base64"),
            sourceChannel: "agent",
          });
      return { status: "ok" as const, file: saved };
    } catch (err) {
      return fileFailure(err);
    }
  },
});
