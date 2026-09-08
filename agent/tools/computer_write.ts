import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  asPersonal,
  assertComputerPath,
  assertWriteContent,
  computerFailure,
  ensureSession,
  writeFile,
} from "../lib/computer.ts";

export default defineTool({
  description:
    "Write a text file on this person's computer. Paths must stay under /home/user or /tmp. Max 256KB. Group chats cannot use the computer.",
  inputSchema: z.object({
    path: z.string().min(1).max(1000),
    content: z.string().max(262_144),
  }),
  async execute({ path, content }, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    try {
      assertComputerPath(path);
      assertWriteContent(content);
      const running = await ensureSession({ phoneE164: who.phone });
      const result = await writeFile(running.boxId, path, content);
      return { status: "ok", state: running.state, path: result.path };
    } catch (err) {
      return computerFailure(err);
    }
  },
});
