import { defineHook } from "eve/hooks";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { signMarkToken } from "@agent/lib/sandbox/keys";
import { ensureKit, kitVersion } from "@agent/lib/sandbox/kit";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";

/** The kit's delivery waits at most this long; `look` heals a miss later. */
const deliveryMs = 30_000;

/**
 * The file kit `brokit` in the task agent's sandbox, where the person's
 * files reach it (TASK_FILES_WORKSPACES): on every message, before the
 * turn's first model call, the kit there is checked against this release's
 * by its content and written when it differs, and the workspace's
 * sign-mark token is kept beside it (`agent/lib/sandbox/kit.ts`,
 * `signMarkToken`). The sandbox's home is not snapshotted, so the line
 * putting the kit's wrapper on PATH is written again each time too.
 * Nothing fails the turn: a kit not delivered here is delivered by the
 * first `look` (`runKit`), and the instructions say so.
 */
export default defineHook({
  events: {
    async "message.received"(_event, ctx) {
      try {
        if (ctx.session.parent === undefined || !taskFilesOfCaller(ctx)) {
          return;
        }
        const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
        if (caller === null) return;
        const { workspaceId } = scopeFromPrincipal(caller);
        const result = await ensureKit(await ctx.getSandbox(), {
          markToken: signMarkToken(workspaceId),
          signal: AbortSignal.timeout(deliveryMs),
        });
        console.info("[task-kit]", { result, version: kitVersion });
      } catch (error) {
        console.warn("[task-kit] not delivered", {
          error: error instanceof Error ? error.name : "thrown",
        });
      }
    },
  },
});
