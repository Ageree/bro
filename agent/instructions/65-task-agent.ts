import { defineDynamic } from "eve/instructions";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { resolveModeInstructions } from "@agent/lib/mode";
import { taskAgentPilot } from "@agent/lib/sandbox/pilot";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";

export default defineDynamic({
  events: {
    // Only where the step offers `task` (`agent/agent.ts`): the pilot's
    // interactive turns.
    "turn.started": async (_event, context) => {
      const caller =
        context.session.auth.current ?? context.session.auth.initiator;
      if (caller === null) return null;
      // A browser report's turn never offers `task` (`agent/agent.ts`).
      if (reportedBrowserRunId(context.session.auth.current) !== undefined) {
        return null;
      }
      if (!(await taskAgentPilot(scopeFromPrincipal(caller)))) return null;
      return resolveModeInstructions(context, {
        interactive: instructionText("task-agent", skillsLayout(context)),
      });
    },
  },
});
