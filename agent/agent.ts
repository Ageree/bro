import { defineAgent, defineDynamic } from "eve";
import { scheduledRunIdentity } from "@agent/lib/schedules/identity";
import { isScheduledAgentRunLeaseActive } from "@db/services/scheduled-agent-run-leases";
import { getWorkspaceModelId } from "@db/services/settings";
import { awaitsDelivery } from "@agent/lib/delivery/pending";
import { resolveModeValue } from "@agent/lib/mode";
import { modelSelection } from "@agent/lib/model/selection";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

export default defineAgent({
  defaultTools: false,
  model: defineDynamic({
    events: {
      "step.started": async (_event, ctx) => {
        const scheduledRun = scheduledRunIdentity(ctx.session.auth);
        if (
          scheduledRun &&
          !(await isScheduledAgentRunLeaseActive(
            scheduledRun.runId,
            scheduledRun.leaseToken
          ))
        ) {
          throw new Error("The scheduled run lease is no longer active.");
        }
        const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
        if (!caller) throw new Error("An authenticated user is required.");
        // A person's message is answered only through send_message or
        // react_to_message; plain assistant text is internal. Until one of
        // them goes through, an interactive step may not end in text. A
        // browser run's result arrives as a message too, but the run parked
        // on an anti-bot check is continued without a word to the person
        // (`agent/lib/browser-use/completion.ts`), so that turn stays free.
        const requireToolCall =
          caller.authenticator !== "browser-result" &&
          (resolveModeValue(ctx, {
            interactive: awaitsDelivery(ctx.messages),
          }) ??
            false);
        return modelSelection(
          await getWorkspaceModelId(scopeFromPrincipal(caller)),
          { requireToolCall }
        );
      },
    },
  }),
  reasoning: "low",
  compaction: {
    thresholdPercent: 0.7,
  },
});
