import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  asPersonal,
  boundBoxId,
  computerFailure,
  status,
  stop,
} from "../lib/computer.ts";
import { setComputerState } from "../lib/convex.ts";

export default defineTool({
  description:
    "Check or stop this person's Bro Linux computer (not a third-party VM). status does not wake a stopped box — wake via other computer_* tools or the Bro cabinet card. stop archives it (disk wipe is cabinet-only). Group chats cannot use the computer. Never name an external VM vendor.",
  inputSchema: z.object({
    action: z.enum(["status", "stop"]),
  }),
  async execute({ action }, ctx) {
    const who = asPersonal(ctx);
    if ("status" in who) return who;
    try {
      const boxId = await boundBoxId(who.phone);
      if (!boxId) {
        return action === "stop"
          ? { status: "error", error: "no computer to stop" }
          : { status: "ok", state: "none" };
      }
      const result =
        action === "stop" ? await stop(boxId) : await status(boxId);
      try {
        await setComputerState(who.phone, result.state);
      } catch {
        // cache write is best-effort
      }
      return { status: "ok", action, state: result.state };
    } catch (err) {
      return computerFailure(err);
    }
  },
});
