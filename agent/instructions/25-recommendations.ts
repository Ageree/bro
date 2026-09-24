import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import recommendations from "./content/recommendations.md?raw";

export default defineDynamic({
  events: {
    // A scheduled search («каждую пятницу подбирай, куда сходить») checks
    // options the same way; the report turn only delivers what it found.
    "turn.started": (_event, context) =>
      resolveModeInstructions(context, {
        interactive: recommendations,
        "scheduled-worker": recommendations,
      }),
  },
});
