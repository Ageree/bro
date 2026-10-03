import { defineDynamic } from "eve/instructions";
import { imageGenerationScope } from "@agent/lib/image-artifact/generation";
import { resolveModeInstructions } from "@agent/lib/mode";
import { instructionText } from "@agent/lib/skills/catalog";
import { skillsLayout } from "@agent/lib/skills/pilot";

export default defineDynamic({
  events: {
    // The picture guidance follows the same check as `generate_image`, so it
    // says honestly whether this turn can draw.
    "turn.started": (_event, context) => {
      const layout = skillsLayout(context);
      const images = instructionText(
        imageGenerationScope(context) === undefined
          ? "creative/images-unavailable"
          : "creative/images",
        layout
      );
      return resolveModeInstructions(context, {
        interactive: [images, instructionText("creative/games", layout)]
          .filter((part) => part.trim().length > 0)
          .join("\n"),
      });
    },
  },
});
