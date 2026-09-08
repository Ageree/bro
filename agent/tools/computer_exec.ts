import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  asPersonal,
  assertComputerPath,
  computerFailure,
  ensureSession,
  exec,
  readBinaryFile,
} from "../lib/computer.ts";
import { attrsFromSession } from "../lib/deliver-routed.ts";
import {
  imagePathFromCaptureStdout,
  photoFromBase64,
} from "../lib/outbound-photo.ts";
import { photoTargetFromAuth, sendPhotoToHuman } from "../lib/send-photo.ts";

export default defineTool({
  description:
    "Run a shell command on this person's Linux computer (/home/user). Network allowed. If the command prints an image path, that photo is attached in this chat. Not for shopping or clinic sites — use browser_task. Group chats cannot use the computer.",
  inputSchema: z.object({
    command: z.string().min(1).max(8000),
    cwd: z.string().min(1).max(500).optional(),
    timeoutSeconds: z.number().positive().max(240).optional(),
  }),
  async execute({ command, cwd, timeoutSeconds }, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    try {
      if (cwd) assertComputerPath(cwd);
      const running = await ensureSession({ phoneE164: who.phone });
      const result = await exec(running.boxId, command, cwd, timeoutSeconds);
      const imagePath =
        result.exitCode === 0 ? imagePathFromCaptureStdout(result.stdout) : null;
      let sent: boolean | undefined;
      let sentError: string | undefined;
      if (imagePath) {
        try {
          const file = await readBinaryFile(running.boxId, imagePath);
          const delivered = await sendPhotoToHuman({
            ...photoTargetFromAuth(attrsFromSession(ctx.session)),
            source: {
              kind: "bytes",
              photo: photoFromBase64(file.base64, file.path),
            },
          });
          if (delivered.status === "ok") sent = true;
          else sentError = delivered.error;
        } catch (err) {
          sentError = err instanceof Error ? err.message : "не отправил фото";
        }
      }
      return {
        status: "ok",
        state: running.state,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(imagePath ? { imagePath, sent, sentError } : {}),
      };
    } catch (err) {
      return computerFailure(err);
    }
  },
});
