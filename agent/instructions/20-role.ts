import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import { backgroundActionsOfCaller } from "@agent/lib/schedules/delegation/pilot";
import { withBackgroundActions } from "@agent/lib/schedules/delegation/text";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";
import agenticWorkerInstructions from "./content/role/agentic-worker.md?raw";
import proactiveWorkerInstructions from "./content/role/proactive-worker.md?raw";
import scheduledReportInstructions from "./content/role/scheduled-report.md?raw";
import scheduledWorkerInstructions from "./content/role/scheduled-worker.md?raw";

export default defineDynamic({
  events: {
    "turn.started": (_event, context) => {
      // A scheduled task's run in the pilot of schedules that act does the
      // free action its schedule keeps.
      const acting = backgroundActionsOfCaller(context);
      return resolveModeInstructions(context, {
        interactive: instructionText(
          "role/interactive",
          skillsLayout(context),
          false,
          acting
        ),
        "agentic-worker": agenticWorkerInstructions,
        "proactive-worker": proactiveWorkerInstructions,
        "scheduled-report": scheduledReportInstructions,
        "scheduled-worker": acting
          ? withBackgroundActions(scheduledWorkerInstructions)
          : scheduledWorkerInstructions,
      });
    },
  },
});
