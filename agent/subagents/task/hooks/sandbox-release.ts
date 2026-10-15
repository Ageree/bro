import { defineHook } from "eve/hooks";
import { releaseSessionSandboxes } from "@agent/lib/sandbox/capacity";

/**
 * The task agent's sandbox (1.5 GiB of the shared code host) is stopped as
 * soon as its turn ends, delivered or failed, instead of idling 20 minutes
 * on the host: `/workspace` is snapshotted first, and a continuation of the
 * task restores it (`agent/lib/sandbox/capacity.ts`). The stop goes on in
 * the background, so the report reaches Bro without waiting for it.
 */
export default defineHook({
  events: {
    "turn.cancelled"(_event, ctx) {
      releaseSessionSandboxes(ctx.session.id, 0);
    },
    "turn.completed"(_event, ctx) {
      releaseSessionSandboxes(ctx.session.id, 0);
    },
    "turn.failed"(_event, ctx) {
      releaseSessionSandboxes(ctx.session.id, 0);
    },
  },
});
