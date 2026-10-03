import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { reportedRunOf } from "@agent/lib/delivery/browser-report";
import { startsTurn } from "@agent/lib/delivery/turn-sends";
import type { StepIdentity } from "@agent/lib/turn-kind/step";

/**
 * The old parts of a conversation a step's prompt sends as a short trace
 * (`trim.ts`): tool results and long `browser_task` errands by their call
 * id, and browser reports by the digest of their text (`reportDigest`).
 * `step` names the step's session and turn, for the log.
 */
export interface HistoryTrim {
  readonly inputs: ReadonlySet<string>;
  readonly openers: ReadonlySet<string>;
  readonly results: ReadonlySet<string>;
  readonly step?: StepIdentity;
}

/** How many of the latest turns, the current one among them, stay whole. */
const keptTurns = 4;

/**
 * How many turns the cut moves by at once. Every move rewrites the history
 * the provider has cached, so it waits for a batch of turns rather than
 * moving with each: between moves the prompt only grows at its end.
 */
const batchTurns = 8;

/** An errand longer than this is shortened in an old `browser_task` call. */
export const longErrandChars = 1500;

/** The digest a browser report is known by, in eve's history and in the prompt. */
export function reportDigest(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

const taggedMessageSchema = z.object({ kind: z.string() });

/**
 * A `browser_task` call's input and its errand, as AI SDK keeps it: an
 * object. Its other fields go on as they are.
 */
export const errandInputSchema = z.looseObject({ task: z.string() });

/** The same input kept as JSON text. */
export const errandTextSchema = z.string().transform((text, context) => {
  try {
    return errandInputSchema.parse(JSON.parse(text));
  } catch {
    context.addIssue({ code: "custom", message: "Not a browser_task input." });
    return z.NEVER;
  }
});

/** The errand of a `browser_task` call, whichever way its input is kept. */
const errandSchema = z.union([errandInputSchema, errandTextSchema]);

/** The text parts of a user message, as AI SDK hands them to the provider. */
function textsOf(message: ModelMessage) {
  if (message.role !== "user") return [];
  if (!Array.isArray(message.content)) return [message.content];
  return message.content.flatMap((part) =>
    part.type === "text" ? [part.text] : []
  );
}

/** Every tool-call and tool-result part of a message. */
function toolParts(message: ModelMessage) {
  if (message.role !== "assistant" && message.role !== "tool") return [];
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part) =>
    part.type === "tool-call" || part.type === "tool-result" ? [part] : []
  );
}

/**
 * Whether an id is called and answered once in `messages`, one batch of old
 * turns. A batch never changes once the cut has passed it, so neither does
 * this verdict: counted over the whole old part, an id reused in a later
 * batch would bring a result back whole after it had gone as a trace, and
 * the provider would read the history again from there.
 */
function idCounts(messages: readonly ModelMessage[]) {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const message of messages) {
    for (const part of toolParts(message)) {
      const counts = part.type === "tool-call" ? calls : results;
      counts.set(part.toolCallId, (counts.get(part.toolCallId) ?? 0) + 1);
    }
  }
  return (id: string) => calls.get(id) === 1 && results.get(id) === 1;
}

/**
 * Where each turn of `messages` opens. Openings with no reply of Bro between
 * them are one turn: a burst of the person's messages, or one that came
 * before the turn's first step, does not move the cut. A message steered
 * into a turn after its first step still counts as a turn of its own; the
 * trim each turn settled on (`rememberedTrim`) covers that, in this process.
 */
function turnOpenings(messages: readonly ModelMessage[]) {
  const openings: number[] = [];
  let answered = true;
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") answered = true;
    if (!startsTurn(message)) continue;
    if (answered) openings.push(index);
    answered = false;
  }
  return openings;
}

/**
 * The batches of old turns: from the start of the history (with any memory
 * and compaction summary before the first turn) to the first kept turn, cut
 * every `batchTurns` turns. The cut moves only at a multiple of `batchTurns`
 * turns past the `keptTurns` latest ones, so for the steps between two moves
 * the trimmed history stays the same bytes and the provider's cached prefix
 * holds.
 */
function oldBatches(messages: readonly ModelMessage[]) {
  const openings = turnOpenings(messages);
  const batches = Math.floor((openings.length - keptTurns) / batchTurns);
  return Array.from({ length: Math.max(0, batches) }, (_, batch) =>
    messages.slice(
      batch === 0 ? 0 : openings[batch * batchTurns],
      openings[(batch + 1) * batchTurns]
    )
  );
}

/**
 * What of `messages`, eve's history at a step, is old enough to trim. A
 * call id that occurs more than once in its batch — OpenRouter's hosts and
 * RouterAI's before 01.10 numbered every step's calls from `call_0` — is
 * never trimmed: it cannot tell which result is which. An id an earlier
 * batch already used is left to that batch: `trimPrompt` shortens only the
 * first part with an id.
 */
function computedHistoryTrim(
  messages: readonly ModelMessage[]
): Omit<HistoryTrim, "step"> | undefined {
  const results = new Set<string>();
  const inputs = new Set<string>();
  const openers = new Set<string>();
  const earlier = new Set<string>();
  for (const batch of oldBatches(messages)) {
    const unique = idCounts(batch);
    const used: string[] = [];
    for (const message of batch) {
      for (const part of toolParts(message)) {
        used.push(part.toolCallId);
        if (earlier.has(part.toolCallId) || !unique(part.toolCallId)) continue;
        if (part.type === "tool-result") {
          results.add(part.toolCallId);
        } else if (
          part.toolName === "browser_task" &&
          (errandSchema.safeParse(part.input).data?.task.length ?? 0) >
            longErrandChars
        ) {
          inputs.add(part.toolCallId);
        }
      }
      const kind = taggedMessageSchema.safeParse(message).data?.kind ?? "user";
      if (kind !== "user") continue;
      for (const text of textsOf(message)) {
        if (reportedRunOf(text) !== undefined) openers.add(reportDigest(text));
      }
    }
    for (const id of used) earlier.add(id);
  }
  if (results.size + inputs.size + openers.size === 0) return undefined;
  return { inputs, openers, results };
}

/**
 * The trim each turn settled on at its first step, for the last
 * `rememberedTurns` turns used. A person's message steered into a running
 * turn after its first step opens a turn of its own in the history, and
 * would move the cut between two steps of one turn. It lives in this
 * process only: a turn that a restart of eve, another instance or the limit
 * below takes it from works its trim out again, and if a steered message
 * lands it on a multiple of `batchTurns` the cut moves once mid-turn — one
 * more read of the history at full price, nothing lost.
 */
const turnTrims = new Map<
  string,
  { readonly trim: Omit<HistoryTrim, "step"> | undefined }
>();

/**
 * Enough for every turn running on an instance at once: a turn that drops
 * out between its steps works its trim out again from a longer history.
 */
const rememberedTurns = 1000;

function rememberedTrim(key: string, messages: readonly ModelMessage[]) {
  const known = turnTrims.get(key) ?? { trim: computedHistoryTrim(messages) };
  // Moved to the newest end as it is used; the oldest goes first.
  turnTrims.delete(key);
  turnTrims.set(key, known);
  if (turnTrims.size > rememberedTurns) {
    const oldest = turnTrims.keys().next().value;
    if (oldest !== undefined) turnTrims.delete(oldest);
  }
  return known.trim;
}

/**
 * What a step's prompt sends as a short trace (`HistoryTrim`), the same for
 * every step of the turn `step` belongs to. Without a turn id it is worked
 * out from the step's history as it is.
 */
export function eligibleHistory(
  messages: readonly ModelMessage[],
  step?: StepIdentity
): HistoryTrim | undefined {
  const trim =
    step?.turnId === undefined
      ? computedHistoryTrim(messages)
      : // eve numbers turns per session, so the key needs both.
        rememberedTrim(`${step.sessionId}\n${step.turnId}`, messages);
  if (trim === undefined) return undefined;
  return step === undefined ? trim : { ...trim, step };
}
