import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  asPersonal,
  assertComputerPath,
  computerFailure,
  ensureSession,
  exec,
} from "../lib/computer.ts";

export default defineTool({
  description:
    "Run a shell command on this person's Linux computer (/home/user). Network allowed. Not for screenshots — use computer_screenshot. Not for shopping or clinic sites — use browser_task. Group chats cannot use the computer.",
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
      return {
        status: "ok",
        state: running.state,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (err) {
      return computerFailure(err);
    }
  },
});
