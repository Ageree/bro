import { defineDynamic } from "eve/instructions";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { resolveModeInstructions } from "@agent/lib/mode";
import { signOfCaller } from "@agent/lib/signatures/pilot";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";

export default defineDynamic({
  events: {
    // Putting the person's signature on a document (SIGN_WORKSPACES), only
    // where their files reach the task agent (`66-task-files.ts`), which
    // fills the document and marks its places. The whole text is the `sign`
    // skill, so the core reads none of it.
    "turn.started": (_event, context) => {
      if (!signOfCaller(context)) return null;
      if (reportedBrowserRunId(context.session.auth.current) !== undefined) {
        return null;
      }
      return resolveModeInstructions(context, {
        interactive: instructionText("sign", skillsLayout(context)),
      });
    },
  },
});
