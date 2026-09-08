import { defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import {
  asPersonal,
  assertComputerPath,
  computerFailure,
  ensureSession,
  readBinaryFile,
} from "../lib/computer.ts";
import { attrsFromSession } from "../lib/deliver-routed.ts";
import { routingFromAuth } from "../lib/turn-routing.ts";
import {
  parseSendPhotoInput,
  photoFromBase64,
} from "../lib/outbound-photo.ts";
import { sendPhotoToHuman } from "../lib/send-photo.ts";

function firstAttr(
  ctx: ToolContext,
  key: string,
): string | undefined {
  const raw = attrsFromSession(ctx.session)?.[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

export default defineTool({
  description:
    "Send a photo into this chat (iMessage or Telegram). Pass a public https URL or a computer path under /home/user. Then [SILENT] unless you still need text.",
  inputSchema: z.object({
    path: z.string().min(1).max(1000).optional(),
    url: z.string().min(1).max(2000).optional(),
    caption: z.string().max(1024).optional(),
  }),
  async execute({ path, url, caption }, ctx) {
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

    const routing = routingFromAuth(attrsFromSession(ctx.session));
    const channel =
      routing.channel ?? (routing.telegramChatId ? "telegram" : "imessage");
    return await sendPhotoToHuman({
      channel,
      conversationId: firstAttr(ctx, "conversationId"),
      telegramChatId: routing.telegramChatId,
      handle: routing.inkboxHandle ?? firstAttr(ctx, "inkboxHandle"),
      caption,
      source,
    });
  },
});
