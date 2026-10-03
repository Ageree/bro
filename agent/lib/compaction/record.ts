import type { ModelMessage } from "ai";
import { defineState } from "eve/context";
import { z } from "zod";
import { compactsAtTurnStart } from "@agent/lib/compaction/turn-start";
import {
  startsTurn,
  turnOpenedByBackgroundTask,
} from "@agent/lib/delivery/turn-sends";
import type { StepIdentity } from "@agent/lib/turn-kind/step";

/**
 * What eve's compaction did to the current turn: `none`; `start`, during the
 * turn's first step, with a person's plain text as the turn's last message
 * (the resumption guard then puts back nothing, or that very text); or
 * `inside`, any other — the guard may have put a copy of an older message of
 * the person's after the kept results, where it reads as the turn's opener
 * (`withResumptionGuard` in `eve/dist/src/harness/compaction.js`).
 */
export type TurnCompaction = "inside" | "none" | "start";

/**
 * The current turn as the compaction hook (`agent/hooks/turn-compaction.ts`)
 * and the first step's model resolver (`recordTurnOpening`) saw it, kept in
 * eve's durable session state: it outlives a restart of eve and a step that
 * runs on another instance, which the history alone cannot tell about.
 * `steps`: how many of the turn's steps have begun. `opened`: the first step
 * read the turn's opening from its history, before any compaction of the
 * turn. `textOpener`: a person's plain text is the turn's last message.
 * `backgroundTask`: it is the task agent's report; null when unknown.
 * `staleOpener`: no message of the turn reached its history — an approval's
 * answer, or text eve took as the answer to a pending question — and the
 * turn before was compacted inside, so the opener its history shows is that
 * turn's, a copy perhaps. `compactedBetween`: eve compacted the session
 * outside this turn (a manual `compact` between turns, under the next
 * turn's id), and the guard's copy stands after its last reply.
 *
 * eve numbers turns per session loop and starts again from `turn_0` in a
 * successor run, as `agent/lib/delivery/holds.ts` says; every turn begins
 * with `turn.started`, which writes a record of its own first.
 */
interface TurnRecord {
  readonly backgroundTask: boolean | null;
  readonly compactedBetween: boolean;
  readonly compaction: TurnCompaction;
  readonly opened: boolean;
  readonly staleOpener: boolean;
  readonly steps: number;
  readonly textOpener: boolean;
  readonly turnId: string | null;
}

const turnRecord = defineState<TurnRecord>("bro.turn-compaction", () => ({
  backgroundTask: null,
  compactedBetween: false,
  compaction: "none",
  opened: false,
  staleOpener: false,
  steps: 0,
  textOpener: false,
  turnId: null,
}));

function writeRecord(next: (record: TurnRecord) => TurnRecord) {
  try {
    turnRecord.update(next);
  } catch (error) {
    // Only outside eve's context, where the readers cannot read the record
    // either, and fail closed.
    console.warn("[compaction] turn record not written", {
      cause: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Updates the record of `turnId` only: a hook event of another turn finds
 * no record of its own, and its readers fail closed.
 */
function updateTurn(turnId: string, next: (record: TurnRecord) => TurnRecord) {
  writeRecord((record) => (record.turnId === turnId ? next(record) : record));
}

/**
 * A turn began. A turn no message reaches reads its opener from the turn
 * before, so it inherits that turn's kind and its compaction inside; one
 * that follows a compaction between turns is compacted inside itself.
 */
export function recordTurnStarted(turnId: string) {
  writeRecord((previous) => ({
    backgroundTask: previous.turnId === null ? null : previous.backgroundTask,
    compactedBetween: false,
    compaction: previous.compactedBetween ? "inside" : "none",
    opened: false,
    staleOpener:
      previous.turnId !== null &&
      (previous.compaction === "inside" || previous.staleOpener),
    steps: 0,
    textOpener: false,
    turnId,
  }));
}

/**
 * A message reached the turn. Whether it opened the turn only its history
 * tells (`recordTurnOpening`): eve emits `message.received` for text it then
 * takes as the answer to a pending question or approval
 * (`resolvePendingInput` in `eve/dist/src/harness/tool-loop.js`). Only the
 * task agent's report counts here, at any step: eve may steer it into a turn
 * already at work, and the turn holds to the fewest tools from then on.
 */
export function recordMessageReceived(message: {
  readonly kind?: string;
  readonly turnId: string;
}) {
  if (message.kind !== "execution.background_task") return;
  updateTurn(message.turnId, (record) => ({ ...record, backgroundTask: true }));
}

const taggedMessageSchema = z.object({ kind: z.string() });

/**
 * Whether the turn's message reached its history: the last message, but for
 * eve's `context.*` and `memory.*` messages, opens a turn. After an approval's
 * answer, or text eve took as an answer, a tool message is last.
 */
function openerLanded(messages: readonly ModelMessage[]) {
  const last = messages.findLast((message) => {
    if (message.role !== "user") return true;
    const kind = taggedMessageSchema.safeParse(message).data?.kind ?? "user";
    return !kind.startsWith("context.") && !kind.startsWith("memory.");
  });
  return last !== undefined && startsTurn(last);
}

/** What the turn's history, before any compaction of it, tells of it. */
function openingOf(record: TurnRecord, messages: readonly ModelMessage[]) {
  if (!openerLanded(messages)) return { ...record, textOpener: false };
  return {
    ...record,
    backgroundTask: turnOpenedByBackgroundTask(messages),
    staleOpener: false,
    textOpener: compactsAtTurnStart(messages),
  };
}

/**
 * The turn's first step read its history: called by the model resolver of
 * `step.started` (`agent/agent.ts`), which eve runs before the step's hooks
 * and before it compacts. A later call, a retry or another step leaves the
 * record as it is. Silent outside eve's context: nothing reads it there.
 */
export function recordTurnOpening(
  step: StepIdentity,
  messages: readonly ModelMessage[]
) {
  const { turnId } = step;
  if (turnId === undefined || step.stepIndex !== 0) return;
  let record: TurnRecord;
  try {
    record = turnRecord.get();
  } catch {
    return;
  }
  if (record.turnId !== turnId || record.opened || record.steps > 0) return;
  updateTurn(turnId, (current) =>
    current.opened || current.steps > 0
      ? current
      : { ...openingOf(current, messages), opened: true }
  );
}

/**
 * A step began. eve emits `step.started` after the step's model resolver
 * and before the step's compaction, and once more as the model call starts
 * (`emitStepStarted` and `buildStepHooks` in
 * `eve/dist/src/harness/tool-loop.js`), so steps are counted by index.
 */
export function recordStepStarted(step: {
  readonly stepIndex: number;
  readonly turnId: string;
}) {
  updateTurn(step.turnId, (record) => ({
    ...record,
    steps: Math.max(record.steps, step.stepIndex + 1),
  }));
}

/**
 * eve compacted the conversation. During the first step of a turn a
 * person's text opened it is `start`; anything else is `inside`, to the
 * turn's end. One under another turn's id came between turns.
 */
export function recordCompactionCompleted(turnId: string) {
  writeRecord((record) => {
    if (record.turnId !== turnId) return { ...record, compactedBetween: true };
    return {
      ...record,
      compaction:
        record.compaction !== "inside" &&
        record.steps <= 1 &&
        record.opened &&
        record.textOpener &&
        !record.staleOpener
          ? "start"
          : "inside",
    };
  });
}

/**
 * The compaction of the turn `turnId`, and whether it is the task agent's
 * report: undefined when the state cannot be read here — outside eve, or a
 * subagent, whose state is its own — or holds another turn. Before the
 * first step, a `turn.started` resolver's `messages` are the turn's history
 * as it began, and tell whether its message reached it; a turn whose first
 * step never read them is taken as compacted inside, of an unknown kind.
 */
export function compactionOfTurn(
  turnId: string | undefined,
  messages: readonly ModelMessage[]
):
  | {
      readonly backgroundTask: boolean | null;
      readonly compaction: TurnCompaction;
    }
  | undefined {
  if (turnId === undefined) return undefined;
  let record: TurnRecord;
  try {
    record = turnRecord.get();
  } catch {
    return undefined;
  }
  if (record.turnId !== turnId) return undefined;
  if (!record.opened && record.steps > 0) {
    return { backgroundTask: null, compaction: "inside" };
  }
  const read = record.opened ? record : openingOf(record, messages);
  return {
    backgroundTask: read.backgroundTask,
    compaction: read.staleOpener ? "inside" : read.compaction,
  };
}
