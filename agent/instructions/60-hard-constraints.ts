import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import hardConstraints from "./content/hard-constraints.md?raw";

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeInstructions(context, {
        interactive: hardConstraints,
        "scheduled-worker": hardConstraints,
      }),
  },
});
