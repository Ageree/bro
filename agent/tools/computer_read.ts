import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  asPersonal,
  assertComputerPath,
  computerFailure,
  ensureSession,
  readFile,
} from "../lib/computer.ts";

export default defineTool({
  description:
    "Read a file from this person's computer. Paths must stay under /home/user or /tmp. Max 64KB. Group chats cannot use the computer.",
  inputSchema: z.object({
    path: z.string().min(1).max(1000),
  }),
  async execute({ path }, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    try {
      assertComputerPath(path);
      const running = await ensureSession({ phoneE164: who.phone });
      const result = await readFile(running.boxId, path);
      return {
        status: "ok",
        state: running.state,
        path: result.path,
        content: result.content,
      };
    } catch (err) {
      return computerFailure(err);
    }
  },
});
