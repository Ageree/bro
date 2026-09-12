import { defineTool } from "eve/tools";
import { z } from "zod";
import { asPersonal } from "../lib/personal.ts";
import { fileFailure } from "../lib/files.ts";
import { runSandboxTask } from "../lib/sandbox-run.ts";

export default defineTool({
  description:
    "Work with this person's files: convert, OCR, extract text, build a PDF or table, resize images. Stages selected files, runs a command or script, and keeps the results. Not for websites — use browser_task. Group chats cannot use files.",
  inputSchema: z.object({
    fileIds: z.array(z.string().min(1).max(64)).max(20).optional(),
    names: z.array(z.string().min(1).max(200)).max(20).optional(),
    command: z.string().min(1).max(8000).optional(),
    script: z.string().min(1).max(80_000).optional(),
    timeoutSeconds: z.number().positive().max(240).optional(),
  }),
  async execute({ fileIds, names, command, script, timeoutSeconds }, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    try {
      return await runSandboxTask({
        phoneE164: who.phone,
        fileIds,
        names,
        command,
        script,
        timeoutSeconds,
      });
    } catch (err) {
      return fileFailure(err);
    }
  },
});
