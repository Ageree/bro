import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";

export default defineDynamic({
  events: {
    "turn.started": (_event, context) => {
      const hardConstraints = instructionText(
        "hard-constraints",
        skillsLayout(context)
      );
      return resolveModeInstructions(context, {
        interactive: hardConstraints,
        "scheduled-worker": hardConstraints,
      });
    },
  },
});
