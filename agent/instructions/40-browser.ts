import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import { browserUseConfigured } from "@agent/lib/browser-use/client";
import availableInstructions from "./content/browser/available.md?raw";
import unavailableInstructions from "./content/browser/unavailable.md?raw";

export default defineDynamic({
  events: {
    // Only a configured Browser Use deployment has the tool, so the honest
    // instruction differs: one state explains the capability, the other says
    // plainly that there is none.
    "turn.started": (_event, context) => {
      const content = browserUseConfigured()
        ? availableInstructions
        : unavailableInstructions;
      return resolveModeInstructions(context, {
        interactive: content,
        "scheduled-worker": content,
      });
    },
  },
});
