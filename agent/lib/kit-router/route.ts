import { createHash } from "node:crypto";
import type { ModelMessage, UserModelMessage } from "ai";
import { defineState } from "eve/context";
import { z } from "zod";
import { taskKitRouted } from "@agent/lib/sandbox/pilot";
import { cleaned } from "@agent/lib/tool-router/state-string";
import {
  askRouterQuestions,
  type RouterAnswer,
} from "@agent/lib/tool-router/system-one";
import {
  type KitBlock,
  kitBlocks,
  kitQuestions,
  kitThresholds,
} from "./questions";

/**
 * The task agent waits this long for the decision model at a turn's start:
 * Jev answered in 1.4 s at most on RouterAI (`kitThresholds`), and the task
 * agent works in the background, so no reply of Bro's waits on it.
 */
const decisionWaitMs = 3000;

/**
 * Enough of a job to tell its blocks; the decision model bills its input.
 * The text goes as the tool router's: cleaned of codes, documents' numbers
 * and every run of four digits or more (`cleaned`): a passport, a СНИЛС or
 * a phone in Bro's job never reaches a third party for a choice of lines.
 */
const maxStateCharacters = 4000;

/** Where eve's message to a subagent puts Bro's own text. */
const callerMessageHeading = "\nCaller message:\n";

/**
 * What the kit router keeps of a task agent session in eve's durable state:
 * `blocks`, the session's set, which only grows (null: never decided, and
 * the kit carries every block); `heard`, the digest of the last message it
 * was decided by, so a replayed or resumed turn does not ask again. Never
 * the text of a message.
 */
const kitStateSchema = z.object({
  blocks: z.array(z.enum(kitBlocks)).nullable().catch(null),
  heard: z.string().nullable().catch(null),
});

type KitState = z.infer<typeof kitStateSchema>;

const emptyKitState: KitState = { blocks: null, heard: null };

const kitState = defineState<KitState>(
  "bro.task-kit-router",
  () => emptyKitState
);

function readKitState(): KitState {
  try {
    return kitStateSchema.safeParse(kitState.get()).data ?? emptyKitState;
  } catch {
    // Outside eve's context: nothing was decided there either.
    return emptyKitState;
  }
}

function writeKitState(next: KitState) {
  try {
    kitState.update(() => next);
  } catch (error) {
    console.warn("[kit-router] state not written", {
      cause: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * The blocks a job plainly names, whatever the decision model answers: a
 * file of the block's kind or its own words. Live 16.10, Jev gave a
 * travel expense report of eight receipt photos 0.06 for `money` and 0.04
 * for `scans`, and the task agent went without the rules of receipts and
 * photos; 17.10 a mortgage schedule got `money` 0.08. The floor only adds: a block it brings in costs some text, a
 * block it misses costs the job.
 */
const plainBlocks = {
  data: /\.(?:ics|vcf|xml|json|sig|p7s)(?![\p{L}\d])|календар|контакт|телефон|кодировк|выгрузк/iu,
  forms: /бланк|анкет|заявлени|согласи[ея]|доверенност|заполни|подпис|параф/iu,
  money:
    /(?<!\p{L})(?:чек|сч[её]т|выписк|авансов|возмещени|вычет|смет|оплат|выручк|сумм|ипотек|кредит|займ|досрочн)|₽|(?<!\p{L})руб/iu,
  office:
    /\.(?:docx?|xlsx?|csv|pptx?|odt|ods)(?![\p{L}\d])|excel|эксел|word|ворд|таблиц|презентац|слайд/iu,
  scans: /\.(?:jpe?g|png|heic|webp|tiff?|zip)(?![\p{L}\d])|фото|скан|снимк/iu,
} as const satisfies Readonly<Record<KitBlock, RegExp>>;

function namedBlocks(text: string) {
  return kitBlocks.filter((block) => plainBlocks[block].test(text));
}

/** The blocks in their order, each once. */
function orderedBlocks(blocks: Iterable<KitBlock>) {
  const set = new Set(blocks);
  return kitBlocks.filter((block) => set.has(block));
}

/**
 * The text of a user message, without the preamble eve wraps Bro's text in
 * (`formatSubagentPrompt`).
 */
function messageText(message: UserModelMessage) {
  const text = Array.isArray(message.content)
    ? message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
    : message.content;
  const at = text.indexOf(callerMessageHeading);
  return (
    at === -1 ? text : text.slice(at + callerMessageHeading.length)
  ).trim();
}

function digestOf(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Bro's messages the router has not heard yet, oldest first: every user
 * message after the one `heard` names, so a message Bro sent the busy task
 * agent in an earlier turn (eve steers it into that turn) is heard with the
 * turn's own; only the latest when `heard` is none of them.
 */
function unheardMessages(
  messages: readonly ModelMessage[],
  heard: string | null
) {
  const texts = messages.flatMap((message) =>
    message.role === "user" ? [messageText(message)] : []
  );
  const at =
    heard === null
      ? -1
      : texts.findLastIndex((text) => digestOf(text) === heard);
  return (at === -1 ? texts.slice(-1) : texts.slice(at + 1)).filter(
    (text) => text.length > 0
  );
}

/**
 * The blocks an answer brings in: each whose probability reaches the
 * threshold of the answer's own model for the job (`first`) or a later
 * message (`more`). A model without thresholds is a failure, and so is an
 * answer without a probability for some block: no answer is no «no».
 */
function kitDecision(answer: RouterAnswer, turn: "first" | "more") {
  if ("failure" in answer) {
    return { failure: answer.failure, ms: answer.ms } as const;
  }
  const thresholds = Object.entries(kitThresholds).find(
    ([model]) => model === answer.model
  )?.[1];
  if (thresholds === undefined) {
    return {
      failure: "uncalibrated",
      model: answer.model,
      ms: answer.ms,
    } as const;
  }
  if (kitBlocks.some((block) => !answer.answers.has(block))) {
    return {
      failure: "unreadable",
      model: answer.model,
      ms: answer.ms,
    } as const;
  }
  const probability = (block: KitBlock) => answer.answers.get(block) ?? 0;
  return {
    blocks: kitBlocks.filter((block) => probability(block) >= thresholds[turn]),
    model: answer.model,
    ms: answer.ms,
    p: Object.fromEntries(
      kitBlocks.map((block) => [
        block,
        Math.round(probability(block) * 100) / 100,
      ])
    ),
  } as const;
}

/**
 * Hears the turn's message of a task agent in the pilot
 * (TASK_KIT_ROUTER_WORKSPACES) and keeps the session's blocks: the job that
 * opens the session is asked of the decision model once, and the blocks it
 * does not rule out make the set; a later message is asked alone and may
 * only add to it, heard with any message of Bro's to the busy task agent
 * since the last one heard. A failure on the job, a timeout, no provider, a
 * model without thresholds or an answer missing a block gives every block;
 * on a later message it keeps the set. A session that already ran turns with every line before the pilot
 * reached it keeps every block.
 *
 * It runs from the `look` tool's `turn.started` resolver, which eve calls
 * with the turn's message and before the instructions' resolvers, which see
 * only the history before it (`prepareDynamicInstructionPreamble` in
 * `eve/dist/src/harness/tool-loop.js`). Never throws.
 */
export async function hearKitJob(context: {
  readonly messages: readonly ModelMessage[];
  readonly session: Parameters<typeof taskKitRouted>[0]["session"];
}) {
  try {
    if (!taskKitRouted(context)) return;
    const state = readKitState();
    const unheard = unheardMessages(context.messages, state.heard);
    const latest = unheard.at(-1);
    if (latest === undefined) return;
    const heard = digestOf(latest);
    if (state.heard === heard) return;
    const opened = context.messages.some((entry) => entry.role === "assistant");
    if (
      (state.blocks === null && opened) ||
      state.blocks?.length === kitBlocks.length
    ) {
      writeKitState({ blocks: [...kitBlocks], heard });
      return;
    }
    const turn = state.blocks === null ? "first" : "more";
    const decision = kitDecision(
      await askRouterQuestions(
        cleaned(unheard.join("\n\n"), maxStateCharacters),
        decisionWaitMs,
        kitQuestions
      ),
      turn
    );
    const before = state.blocks ?? [];
    const named = namedBlocks(unheard.join("\n\n"));
    const blocks =
      decision.blocks !== undefined
        ? orderedBlocks([...before, ...decision.blocks, ...named])
        : turn === "first"
          ? [...kitBlocks]
          : orderedBlocks([...before, ...named]);
    writeKitState({ blocks, heard });
    console.info("[kit-router] blocks", {
      added: blocks.filter((block) => !before.includes(block)),
      blocks,
      failure: decision.failure,
      model: decision.model,
      ms: decision.ms,
      named,
      p: decision.p,
      turn,
    });
  } catch (error) {
    console.warn("[kit-router] not heard", {
      cause: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * The blocks this task agent session's kit lines carry; `undefined` when
 * none were decided, and then the kit carries every block.
 */
export function kitBlocksOfSession(): readonly KitBlock[] | undefined {
  return readKitState().blocks ?? undefined;
}
