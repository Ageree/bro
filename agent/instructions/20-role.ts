import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import interactiveInstructions from "./content/role/interactive.md?raw";
import proactiveWorkerInstructions from "./content/role/proactive-worker.md?raw";
import scheduledReportInstructions from "./content/role/scheduled-report.md?raw";
import scheduledWorkerInstructions from "./content/role/scheduled-worker.md?raw";

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeInstructions(context, {
        interactive: interactiveInstructions,
        "proactive-worker": proactiveWorkerInstructions,
        "scheduled-report": scheduledReportInstructions,
        "scheduled-worker": scheduledWorkerInstructions,
      }),
  },
});
