import { defineDynamic, defineInstructions } from "eve/instructions";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";
import files from "./content/files.md?raw";

/**
 * How the person's files reach the task agent, and why its sandbox may be
 * off the web, only where they can (TASK_FILES_WORKSPACES, docs/roadmap.md
 * item 30): elsewhere the lines would only cost every call. The router's
 * own refusal still says why the web is off to a sandbox marked before the
 * flag was cleared (`agent/lib/sandbox/router.ts`).
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      taskFilesOfCaller(context)
        ? defineInstructions({ content: files })
        : null,
  },
});
