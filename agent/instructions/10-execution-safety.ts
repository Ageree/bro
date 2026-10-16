import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";

export default defineDynamic({
  events: {
    "turn.started": (_event, context) => {
      const executionSafety = instructionText(
        "execution-safety",
        skillsLayout(context)
      );
      return resolveModeInstructions(context, {
        interactive: executionSafety,
        "scheduled-worker": executionSafety,
      });
    },
  },
});
