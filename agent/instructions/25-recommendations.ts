import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";

export default defineDynamic({
  events: {
    // A scheduled search («каждую пятницу подбирай, куда сходить») checks
    // options the same way; the report turn only delivers what it found.
    "turn.started": (_event, context) => {
      const recommendations = instructionText(
        "recommendations",
        skillsLayout(context)
      );
      return resolveModeInstructions(context, {
        interactive: recommendations,
        "scheduled-worker": recommendations,
      });
    },
  },
});
