import { defineDynamic } from "eve/instructions";
import { imageGenerationScope } from "@agent/lib/image-artifact/generation";
import { resolveModeInstructions } from "@agent/lib/mode";
import gameInstructions from "./content/creative/games.md?raw";
import imageInstructions from "./content/creative/images.md?raw";
import unavailableImageInstructions from "./content/creative/images-unavailable.md?raw";

export default defineDynamic({
  events: {
    // The picture guidance follows the same check as `generate_image`, so it
    // says honestly whether this turn can draw.
    "turn.started": (_event, context) => {
      const images =
        imageGenerationScope(context) === undefined
          ? unavailableImageInstructions
          : imageInstructions;
      return resolveModeInstructions(context, {
        interactive: `${images}\n${gameInstructions}`,
      });
    },
  },
});
