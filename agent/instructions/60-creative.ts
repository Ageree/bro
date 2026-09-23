import { defineDynamic } from "eve/instructions";
import { imageArtifactStorageConfigured } from "@agent/lib/image-artifact/storage";
import { resolveModeInstructions } from "@agent/lib/mode";
import { env } from "@shared/environment";
import gameInstructions from "./content/creative/games.md?raw";
import imageInstructions from "./content/creative/images.md?raw";
import unavailableImageInstructions from "./content/creative/images-unavailable.md?raw";

export default defineDynamic({
  events: {
    // `generate_image` exists only where OpenRouter and private Blob storage
    // are configured, so the picture guidance says honestly which case this is.
    "turn.started": (_event, context) => {
      const images =
        env.OPENROUTER_API_KEY !== undefined && imageArtifactStorageConfigured()
          ? imageInstructions
          : unavailableImageInstructions;
      return resolveModeInstructions(context, {
        interactive: `${images}\n${gameInstructions}`,
      });
    },
  },
});
