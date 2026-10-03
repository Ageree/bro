import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import { browserUseConfigured } from "@agent/lib/browser-use/client";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";

export default defineDynamic({
  events: {
    // Only a configured Browser Use deployment has the tool, so the honest
    // instruction differs: one state explains the capability, the other says
    // plainly that there is none.
    "turn.started": (_event, context) => {
      const content = instructionText(
        browserUseConfigured() ? "browser/available" : "browser/unavailable",
        skillsLayout(context)
      );
      return resolveModeInstructions(context, {
        interactive: content,
        "scheduled-worker": content,
      });
    },
  },
});
