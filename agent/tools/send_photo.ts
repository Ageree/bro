import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  asPersonal,
  assertComputerPath,
  computerFailure,
  ensureSession,
  readBinaryFile,
} from "../lib/computer.ts";
import { attrsFromSession } from "../lib/deliver-routed.ts";
import {
  parseSendPhotoInput,
  photoFromBase64,
} from "../lib/outbound-photo.ts";
import { photoTargetFromAuth, sendPhotoToHuman } from "../lib/send-photo.ts";

export default defineTool({
  description:
    "Send a photo into this chat (iMessage or Telegram). Pass a public https URL or a computer path under /home/user. On Telegram, spoiler=true covers the photo until tap (скрытое медиа). Then [SILENT] unless you still need text.",
  inputSchema: z.object({
    path: z.string().min(1).max(1000).optional(),
    url: z.string().min(1).max(2000).optional(),
    caption: z.string().max(1024).optional(),
    spoiler: z.boolean().optional(),
  }),
  async execute({ path, url, caption, spoiler }, ctx) {
    const parsed = parseSendPhotoInput({ path, url });
    if ("error" in parsed) return { status: "error", error: parsed.error };

    let source;
    if (parsed.kind === "path") {
      const who = asPersonal(ctx);
      if ("status" in who) return who;
      try {
        const safe = assertComputerPath(parsed.path);
        const running = await ensureSession({ phoneE164: who.phone });
        const file = await readBinaryFile(running.boxId, safe);
        source = {
          kind: "bytes" as const,
          photo: photoFromBase64(file.base64, file.path),
        };
      } catch (err) {
        return computerFailure(err);
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
