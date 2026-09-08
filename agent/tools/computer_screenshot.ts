import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";
import {
  asPersonal,
  computerFailure,
  ensureSession,
  screenshotDesktop,
} from "../lib/computer.ts";

const outputSchema = z.object({
  status: z.literal("ok"),
  path: z.string(),
  bytes: z.number(),
  mimeType: z.literal("image/png"),
  screenshotBase64: z.string(),
});

export default defineTool({
  description:
    "Take a PNG screenshot of this person's Linux desktop (1920x1080). Returns the image to the model and saves it under /home/user/screens. Not for shopping sites — use browser_task. Group chats cannot use the computer.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    try {
      const running = await ensureSession({ phoneE164: who.phone });
      const shot = await screenshotDesktop(running.boxId);
      return outputSchema.parse({
        status: "ok",
        path: shot.path,
        bytes: shot.bytes,
        mimeType: "image/png",
        screenshotBase64: shot.base64,
      });
    } catch (err) {
      return computerFailure(err);
    }
  },
  toModelOutput(output) {
    if (!("screenshotBase64" in output) || !output.screenshotBase64) {
      return toolOutput.json(output);
    }
    return toolOutput.content([
      toolOutputPart.text(
        `Снял экран компьютера (${output.bytes} байт). Файл: ${output.path}`,
      ),
      toolOutputPart.file(output.screenshotBase64, {
        mediaType: output.mimeType,
      }),
    ]);
  },
});
