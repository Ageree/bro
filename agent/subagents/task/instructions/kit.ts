import { defineDynamic, defineInstructions } from "eve/instructions";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";
import kit from "./content/kit.md?raw";

/**
 * How the task agent works with files through its kit `brokit` and `look`,
 * only where the person's files reach it (TASK_FILES_WORKSPACES): the hook
 * delivers the kit there alone (`hooks/kit.ts`), and elsewhere the lines
 * would only cost every call. The static `instructions.md` stays as it is.
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      taskFilesOfCaller(context) ? defineInstructions({ content: kit }) : null,
  },
});
