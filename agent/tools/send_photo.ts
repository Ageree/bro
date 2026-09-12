import { defineTool } from "eve/tools";
import { z } from "zod";
import { asPersonal } from "../lib/personal.ts";
import { fileFailure } from "../lib/files.ts";
import { attrsFromSession } from "../lib/deliver-routed.ts";
import { parseSendPhotoInput } from "../lib/outbound-photo.ts";
import {
  photoFromStoredFile,
  photoTargetFromAuth,
  sendPhotoToHuman,
} from "../lib/send-photo.ts";

export default defineTool({
  description:
    "Send a photo into this chat (iMessage or Telegram). Pass a public https URL or a saved file (fileId or name). On Telegram, spoiler=true covers the photo until tap (скрытое медиа). Then [SILENT] unless you still need text.",
  inputSchema: z.object({
    fileId: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(200).optional(),
    path: z.string().min(1).max(1000).optional(),
    url: z.string().min(1).max(2000).optional(),
    caption: z.string().max(1024).optional(),
    spoiler: z.boolean().optional(),
  }),
  async execute({ fileId, name, path, url, caption, spoiler }, ctx) {
    const parsed = parseSendPhotoInput({ fileId, name, path, url });
    if ("error" in parsed) return { status: "error", error: parsed.error };

    let source;
    if (parsed.kind === "file") {
      const who = asPersonal(ctx);
      if ("status" in who) return who;
      try {
        source = {
          kind: "bytes" as const,
          photo: await photoFromStoredFile(who.phone, parsed),
        };
      } catch (err) {
        return fileFailure(err);
      }
    } else {
      source = parsed;
    }

    return await sendPhotoToHuman({
      ...photoTargetFromAuth(attrsFromSession(ctx.session)),
      caption,
      spoiler,
      source,
    });
  },
});
