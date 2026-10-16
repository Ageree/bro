import { defineDynamic, defineInstructions } from "eve/instructions";
import { type KitBlock, kitBlocks } from "@agent/lib/kit-router/questions";
import { kitBlocksOfSession } from "@agent/lib/kit-router/route";
import { taskFilesOfCaller, taskKitRouted } from "@agent/lib/sandbox/pilot";
import core from "./content/kit/core.md?raw";
import data from "./content/kit/data.md?raw";
import forms from "./content/kit/forms.md?raw";
import money from "./content/kit/money.md?raw";
import office from "./content/kit/office.md?raw";
import scans from "./content/kit/scans.md?raw";

/**
 * A file's parts between its `<!-- kit: … -->` markers, with the blank
 * lines around each marker: the formatter puts them there, and the joiner
 * puts back the original's.
 */
const marker = /\n*<!-- kit: ([a-z ]+) -->\n*/u;

function piecesOf(text: string) {
  const pieces = text.split(marker);
  return {
    // `split` puts each marker's captured words between the parts.
    markers: pieces.filter((_, index) => index % 2 === 1),
    parts: pieces
      .filter((_, index) => index % 2 === 0)
      .map((part) => part.replace(/^\n+|\n+$/gu, "")),
  };
}

const blockFiles = {
  data,
  forms,
  money,
  office,
  scans,
} as const satisfies Readonly<Record<KitBlock, string>>;

/**
 * The kit's parts in their order, each of the core or of a block: the
 * core's file holds its parts, and between them a marker names the blocks
 * whose next part goes there; a block's file holds its parts in order,
 * between `<!-- kit: next part -->`. A file that does not add up fails the
 * build.
 */
function kitLayout() {
  const layout: { readonly block: KitBlock | "core"; readonly text: string }[] =
    [];
  const taken = new Map<KitBlock, number>();
  const { markers, parts } = piecesOf(core);
  for (const [index, text] of parts.entries()) {
    if (text.length > 0) layout.push({ block: "core", text });
    for (const name of markers[index]?.split(" ") ?? []) {
      const block = kitBlocks.find((known) => known === name);
      if (block === undefined) {
        throw new Error(`The kit's core names no block «${name}».`);
      }
      const at = taken.get(block) ?? 0;
      const part = piecesOf(blockFiles[block]).parts[at];
      if (part === undefined) {
        throw new Error(
          `The kit's block «${block}» has no part ${String(at + 1)}.`
        );
      }
      layout.push({ block, text: part });
      taken.set(block, at + 1);
    }
  }
  for (const block of kitBlocks) {
    if ((taken.get(block) ?? 0) !== piecesOf(blockFiles[block]).parts.length) {
      throw new Error(`The kit's core places only some of «${block}».`);
    }
  }
  return layout;
}

const layout = kitLayout();

/** Whether a part's last line is a heading. */
function endsWithHeading(text: string) {
  return text.slice(text.lastIndexOf("\n") + 1).startsWith("#");
}

/**
 * The kit's lines with the core and `blocks`, every block when undefined:
 * then exactly the kit as it was before the blocks (`content/kit/`). A
 * heading stands a blank line away from what is before and after it, and
 * the lines of a list follow one another.
 */
function kitText(blocks: readonly KitBlock[] | undefined) {
  const parts = layout.flatMap(({ block, text }) =>
    block === "core" || blocks === undefined || blocks.includes(block)
      ? [text]
      : []
  );
  const joined = parts.reduce(
    (text, part) =>
      `${text}${part.startsWith("#") || endsWithHeading(text) ? "\n\n" : "\n"}${part}`
  );
  return `${joined}\n`;
}

/**
 * How the task agent works with files through its kit `brokit` and `look`,
 * only where the person's files reach it (TASK_FILES_WORKSPACES): the hook
 * delivers the kit there alone (`hooks/kit.ts`), and elsewhere the lines
 * would only cost every call. The static `instructions.md` stays as it is.
 * In the kit router's pilot (TASK_KIT_ROUTER_WORKSPACES) they carry the
 * core and only the blocks the decision model gave the session
 * (`agent/lib/kit-router/`); the set only grows, so a later turn's lines
 * only add to the earlier ones.
 */
export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      taskFilesOfCaller(context)
        ? defineInstructions({
            content: kitText(
              taskKitRouted(context) ? kitBlocksOfSession() : undefined
            ),
          })
        : null,
  },
});
