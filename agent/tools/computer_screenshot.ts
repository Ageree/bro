import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";
import {
  asPersonal,
  computerFailure,
  ensureSession,
  screenshotDesktop,
} from "../lib/computer.ts";
import { attrsFromSession } from "../lib/deliver-routed.ts";
import { photoFromBase64 } from "../lib/outbound-photo.ts";
import { photoTargetFromAuth, sendPhotoToHuman } from "../lib/send-photo.ts";

const outputSchema = z.object({
  status: z.literal("ok"),
  path: z.string(),
  bytes: z.number(),
  mimeType: z.literal("image/png"),
  screenshotBase64: z.string(),
  sent: z.boolean().optional(),
  sentError: z.string().optional(),
});

export default defineTool({
  description:
    "Take a PNG screenshot of this person's Linux desktop (1920x1080) and attach it in this iMessage/Telegram chat. Also returns the image to the model and saves it under /home/user/screens. Not for shopping sites — use browser_task. Group chats cannot use the computer.",
  inputSchema: z.object({
    caption: z.string().max(1024).optional(),
  }),
  async execute({ caption }, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    try {
      const running = await ensureSession({ phoneE164: who.phone });
      const shot = await screenshotDesktop(running.boxId);
      const delivered = await sendPhotoToHuman({
        ...photoTargetFromAuth(attrsFromSession(ctx.session)),
        caption,
        source: {
          kind: "bytes",
          photo: photoFromBase64(shot.base64, shot.path, "image/png"),
        },
      });
      return outputSchema.parse({
        status: "ok",
        path: shot.path,
        bytes: shot.bytes,
        mimeType: "image/png",
        screenshotBase64: shot.base64,
        sent: delivered.status === "ok",
        ...(delivered.status === "error" ? { sentError: delivered.error } : {}),
      });
    } catch (err) {
      return computerFailure(err);
    }
  },
  toModelOutput(output) {
    if (!("screenshotBase64" in output) || !output.screenshotBase64) {
      return toolOutput.json(output);
    }
    const sentLine = output.sent
      ? " Картинка уже в этом чате. Не шли вторую, не делай compact и не пиши путь."
      : output.sentError
        ? ` В чат не ушло (${output.sentError}) — один раз вызови send_photo с ${output.path}.`
        : ` Один раз вызови send_photo с ${output.path}.`;
    return toolOutput.content([
      toolOutputPart.text(
        `Снял экран компьютера (${output.bytes} байт).${sentLine}`,
      ),
      toolOutputPart.file(output.screenshotBase64, {
        mediaType: output.mimeType,
      }),
    ]);
  },
});
