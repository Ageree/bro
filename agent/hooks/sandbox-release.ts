import { defineHook } from "eve/hooks";
import { releaseSessionSandboxes } from "@agent/lib/sandbox/capacity";

/**
 * How long Bro's own sandbox outlives the turn that opened it. The next
 * message within it finds the sandbox running; a later one restores its
 * `/workspace` from the snapshot, a second or two before the first reply.
 */
const graceMs = 60_000;

/**
 * Bro's own sandbox on the code host (AGENT_SANDBOX=bro-cloudru) holds
 * 1 GiB of the shared host while it runs, and the host stops an idle one
 * only after 20 minutes. A turn that opened it — attachments staged or read
 * back for the model, a document signed — lets go of it once it ends
 * (`agent/lib/sandbox/capacity.ts`); a host short of room takes it back
 * before the grace is over. A turn that did not open it changes nothing.
 */
export default defineHook({
  events: {
    "turn.cancelled"(_event, ctx) {
      releaseSessionSandboxes(ctx.session.id, graceMs);
    },
    "turn.completed"(_event, ctx) {
      releaseSessionSandboxes(ctx.session.id, graceMs);
    },
    "turn.failed"(_event, ctx) {
      releaseSessionSandboxes(ctx.session.id, graceMs);
    },
  },
});
