import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { availableSkills } from "@agent/lib/skills/catalog";
import { skillSetup, skillsPilot } from "@agent/lib/skills/pilot";
import { attachedSkills, skillRecord } from "@agent/lib/skills/render";

/**
 * The fallback of skills chosen by the server (docs/roadmap.md, item 24):
 * when the turn needs rules the `skills` memory slot did not attach, the
 * index in the core instructions tells the model to load them by name.
 * Bro's own tool, not eve's, which reads skills from the sandbox; it exists
 * only in the pilot's interactive turns, where the instructions are the
 * core. The result is the same block the slot attaches, so it is defused
 * like none other (`agent/lib/model/direct.ts`) and counts as attached.
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, context) => {
      if (
        !skillsPilot(context) ||
        resolveModeValue(context, { interactive: true }) !== true
      ) {
        return null;
      }
      const setup = skillSetup(context);
      const names = availableSkills(setup);
      if (names.length === 0) return null;
      const attached = attachedSkills(context.messages, setup);
      return defineTool({
        description:
          "Load the rules of one skill from the index in your instructions, when the turn needs them and their bro-skill block is not already in the conversation. Call it before the first action of that kind; the rules come back as the block.",
        inputSchema: z.object({
          name: z.string().describe(`The skill's name: ${names.join(", ")}.`),
        }),
        execute: ({ name }) => {
          const known = names.find((skill) => skill === name.trim());
          if (known === undefined) {
            return `There is no skill «${name}». The skills are: ${names.join(", ")}.`;
          }
          if (attached.includes(known)) {
            return `The rules of ${known} are already above in this conversation, in its bro-skill block: follow them.`;
          }
          return skillRecord(known, setup) ?? `There is no skill «${name}».`;
        },
      });
    },
  },
});
