import { defineDynamic } from "eve/instructions";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { resolveModeInstructions } from "@agent/lib/mode";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";

export default defineDynamic({
  events: {
    // The person's files for the task agent (TASK_FILES_WORKSPACES,
    // docs/roadmap.md item 30), only where `65-task-agent.ts` offers `task`.
    // The whole text is the `files` skill, so the core reads none of it.
    "turn.started": (_event, context) => {
      if (!taskFilesOfCaller(context)) return null;
      // A browser report's turn never offers `task` (`agent/agent.ts`).
      if (reportedBrowserRunId(context.session.auth.current) !== undefined) {
        return null;
      }
      return resolveModeInstructions(context, {
        interactive: instructionText("task-files", skillsLayout(context)),
      });
    },
  },
});
