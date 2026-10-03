import { defineDynamic, defineInstructions } from "eve/instructions";
import { skillIndex } from "@agent/lib/skills/render";
import { skillSetup, skillsLayout } from "@agent/lib/skills/pilot";

export default defineDynamic({
  events: {
    // The last of the stable instructions: what a `bro-skill` block is and
    // which skills exist, for the pilot's core (docs/roadmap.md, item 24).
    "turn.started": (_event, context) => {
      if (skillsLayout(context) !== "core") return null;
      const index = skillIndex(skillSetup(context));
      return index === undefined
        ? null
        : defineInstructions({ content: index });
    },
  },
});
