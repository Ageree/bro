import { defineDynamic } from "eve/instructions";
import { browserUseConfigured } from "@agent/lib/browser-use/client";
import { resolveModeInstructions } from "@agent/lib/mode";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";

export default defineDynamic({
  events: {
    // Reading meter photos and finding the bill in the mail need no browser;
    // passing the readings, Госуслуги and a doctor's slot are errands on a
    // site, told only where `browser_task` exists (as in 40-browser.ts).
    // All of it is the conversation's: the photos and the cards are there.
    "turn.started": (_event, context) => {
      const layout = skillsLayout(context);
      return resolveModeInstructions(context, {
        interactive: [
          instructionText("meter-readings", layout),
          browserUseConfigured()
            ? instructionText("public-services", layout)
            : undefined,
        ]
          .filter((part) => part !== undefined && part.trim().length > 0)
          .join("\n"),
      });
    },
  },
});
