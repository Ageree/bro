import { defineChannel, POST } from "eve/channels";
import { z } from "zod";

const scheduledRunTargetSchema = z.strictObject({
  restart: z.boolean().optional(),
  runId: z.uuid(),
});

// Nothing is served here: on Vercel only `/eve/v1/*` reaches eve. Workers,
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
  // eve 0.62 links a channel into the build only through its routes, so a
  // channel with none fails `eve build`. The one kept answers the retired
  // answer path with 410 and touches nothing.
  routes: [
    POST(
      "/internal/scheduled-run/respond",
      () =>
        new Response("Answers reach scheduled runs through schedules-answer.", {
          status: 410,
        })
    ),
  ],
});
