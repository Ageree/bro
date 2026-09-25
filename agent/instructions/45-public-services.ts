import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import publicServices from "./content/public-services.md?raw";

export default defineDynamic({
  events: {
    // Reading meter photos, finding the bill and routing a Госуслуги errand
    // are the conversation's: the photos and the cards are only there.
    "turn.started": (_event, context) =>
      resolveModeInstructions(context, { interactive: publicServices }),
  },
});
