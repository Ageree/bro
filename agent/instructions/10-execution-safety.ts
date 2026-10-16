import { defineDynamic } from "eve/instructions";
import { resolveModeInstructions } from "@agent/lib/mode";
import { signOfCaller } from "@agent/lib/signatures/pilot";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";
import { withSigningConsent } from "@agent/lib/skills/signing";

export default defineDynamic({
  events: {
    "turn.started": (_event, context) => {
      const executionSafety = instructionText(
        "execution-safety",
        skillsLayout(context)
      );
      return resolveModeInstructions(context, {
        // Where the person's signature goes on documents, signing is asked
        // like paying; a worker never signs.
        interactive: signOfCaller(context)
          ? withSigningConsent(executionSafety)
          : executionSafety,
        "scheduled-worker": executionSafety,
      });
    },
  },
});
