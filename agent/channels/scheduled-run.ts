import { defineChannel } from "eve/channels";
import { z } from "zod";

const scheduledRunTargetSchema = z.strictObject({
  restart: z.boolean().optional(),
  runId: z.uuid(),
});

// No routes of its own: on Vercel only `/eve/v1/*` reaches eve. Workers,
// their reports and the person's answers all go out from the `dynamic`
// schedule, which holds the session handles they need.
export default defineChannel({
  audience({ caller }) {
    return caller.type === "principal" && caller.principal.kind === "user"
      ? "private"
      : "unknown";
  },
  async receive(input, { from }) {
    const target = scheduledRunTargetSchema.parse(input.target);
    const source = from(`scheduled-run:${target.runId}`);
    if (target.restart) {
      await source.reset({
        reason: "Scheduled worker exceeded its runtime.",
      });
    }
    return source.send(input.message, {
      auth: input.auth,
      title: `Scheduled run ${target.runId}`,
    });
  },
  routes: [],
});
