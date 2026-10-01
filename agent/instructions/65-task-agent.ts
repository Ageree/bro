import { defineDynamic } from "eve/instructions";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { resolveModeInstructions } from "@agent/lib/mode";
import { taskAgentPilot } from "@agent/lib/sandbox/pilot";
import taskAgentInstructions from "./content/task-agent.md?raw";

export default defineDynamic({
  events: {
    // Only where the step offers `task` (`agent/agent.ts`): the pilot's
    // interactive turns.
    "turn.started": async (_event, context) => {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (caller === null) return null;
      if (!(await taskAgentPilot(scopeFromPrincipal(caller)))) return null;
      return resolveModeInstructions(context, {
        interactive: taskAgentInstructions,
      });
    },
  },
});
