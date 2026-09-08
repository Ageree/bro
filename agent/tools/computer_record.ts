import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  asPersonal,
  computerFailure,
  ensureSession,
  recordDesktop,
  RECORD_SECONDS_MAX,
} from "../lib/computer.ts";

export default defineTool({
  description:
    `Record this person's Linux desktop to an mp4 under /home/user/recordings (1–${RECORD_SECONDS_MAX}s, default 10). Does not send the video to the model — tell the person the path. Not for shopping sites. Group chats cannot use the computer.`,
  inputSchema: z.object({
    seconds: z.number().positive().max(RECORD_SECONDS_MAX).optional(),
  }),
  async execute({ seconds }, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    try {
      const running = await ensureSession({ phoneE164: who.phone });
      const rec = await recordDesktop(running.boxId, seconds);
      return {
        status: "ok",
        state: running.state,
        path: rec.path,
        seconds: rec.seconds,
      };
    } catch (err) {
      return computerFailure(err);
    }
  },
});
