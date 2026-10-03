import type { ModelMessage } from "ai";
import { defineState } from "eve/context";
import { z } from "zod";
import { messageDigest, summaryDigest } from "@agent/lib/compaction/summary";
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
 * and its steps' model resolver (`recordStepHistory`) saw it, kept in eve's
 * durable session state: it outlives a restart of eve and a step that runs
 * on another instance, which the history alone cannot tell about.
 * `steps`: how many of the turn's steps have begun. `opened`: the first step
 * read the turn's opening from its history, before any compaction of the
 * turn. `textOpener`: a person's plain text is the turn's last message.
 * `backgroundTask`: it is the task agent's report; null when unknown.
 * `staleOpener`: no message of the turn reached its history — an approval's
 * answer, or text eve took as the answer to a pending question — and the
 * turn before was compacted inside, so the opener its history shows is that
 * turn's, a copy perhaps.
 *
 * eve emits `compaction.completed` without a new summary too (`summaryDigest`
 * in `summary.ts`), and the hook sees no history: what it claims waits in
 * `pending` and `stalePending` until a history shows whether the summary
 * changed since `summary`, the digest of the latest one when the record
 * last read a history (null: never, or unknown). The model resolver of
 * every step reads it before the step compacts: a claim the summary did not
 * change goes, one it did becomes `compaction` or `staleOpener`. A reader in
 * between weighs the claims against its own history (`compactionOfTurn`).
 * Two summaries of the same text are taken for one. `betweenClaimed`: eve
 * compacted the session outside this turn (a manual `compact` between
 * turns, under the next turn's id), and the guard's copy may stand after
 * its last reply: the next turn claims a compaction inside, which its own
 * steps settle.
 *
 * `afterInside`: the turn's message reached its history right after a turn
 * compacted inside — or after one that read the same and took at most one
 * step, as a model call that failed leaves it — where the guard's copy of an
 * older message of the person's may stand right before it, after the kept
 * results; only the opener is then the person's word in this turn.
 *
 * `opener`: a digest of the turn's opener (`messageDigest`), when its
 * first step read one. `summaryOpener`: the opener of the turn whose first
 * step wrote the latest summary, which a later turn's reader of the
 * person's words walks back no further than (`personWordsThisTurn` in
 * `agent/lib/browser-use/said.ts`); null after a compaction anywhere
 * else, or when unknown.
 *
 * eve numbers turns per session loop and starts again from `turn_0` in a
 * successor run, as `agent/lib/delivery/holds.ts` says; every turn begins
 * with `turn.started`, which writes a record of its own first.
 */
interface TurnRecord {
  readonly afterInside: boolean;
  readonly backgroundTask: boolean | null;
  readonly betweenClaimed: boolean;
  readonly compaction: TurnCompaction;
  readonly opened: boolean;
  readonly opener: string | null;
  readonly pending: TurnCompaction;
  readonly staleOpener: boolean;
  readonly stalePending: boolean;
  readonly steps: number;
  readonly summary: string | null;
  readonly summaryOpener: string | null;
  readonly textOpener: boolean;
  readonly turnId: string | null;
}

/**
 * The record as kept: one a release before this one wrote lacks fields, and
 * the first release named `betweenClaimed` `compactedBetween`.
 */
type StoredRecord = Partial<TurnRecord> & {
  readonly compactedBetween?: boolean;
};

const emptyRecord: TurnRecord = {
  afterInside: false,
  backgroundTask: null,
  betweenClaimed: false,
  compaction: "none",
  opened: false,
  opener: null,
  pending: "none",
  staleOpener: false,
  stalePending: false,
  steps: 0,
  summary: null,
  summaryOpener: null,
  textOpener: false,
  turnId: null,
};

const turnRecord = defineState<StoredRecord>(
  "bro.turn-compaction",
  () => emptyRecord
);

/**
 * The record with every field: what an earlier release did not write is
 * unknown — the summary, the opener the latest one followed.
 */
function complete(stored: StoredRecord): TurnRecord {
  const { compactedBetween, ...record } = stored;
  return {
    ...emptyRecord,
    ...record,
    betweenClaimed: record.betweenClaimed === true || compactedBetween === true,
  };
}

function readRecord(): TurnRecord {
  return complete(turnRecord.get());
}

const compactionRank: Readonly<Record<TurnCompaction, number>> = {
  inside: 2,
  none: 0,
  start: 1,
};

function widest(first: TurnCompaction, second: TurnCompaction) {
  return compactionRank[second] > compactionRank[first] ? second : first;
}

/**
 * The record once `digest`, the latest summary of a history, is known: the
 * claims since `summary` hold if it changed — or was never known — and go
 * if not.
 */
function settled(record: TurnRecord, digest: string | null): TurnRecord {
  const changed = record.summary === null || record.summary !== digest;
  return {
    ...record,
    compaction: changed
      ? widest(record.compaction, record.pending)
      : record.compaction,
    pending: "none",
    staleOpener: record.staleOpener || (changed && record.stalePending),
    stalePending: false,
    summary: digest,
  };
}

function writeRecord(next: (record: TurnRecord) => TurnRecord) {
  try {
    turnRecord.update((record) => next(complete(record)));
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
 * that follows a compaction between turns claims one inside itself. What
 * no history has shown yet stays a claim, against the same summary. A
 * claim of the turn before names the opener the latest summary followed
 * as if it held: one that wrote no summary only makes a later reader take
 * fewer of the person's words. A turn that read only its opener as theirs
 * (`afterInside`) and took at most one step left nothing of Bro's after
 * it, so the next one reads only its own.
 */
export function recordTurnStarted(turnId: string) {
  writeRecord((previous) => {
    const known = previous.turnId !== null;
    const before = widest(previous.compaction, previous.pending);
    return {
      afterInside: known && previous.afterInside && previous.steps <= 1,
      backgroundTask: known ? previous.backgroundTask : null,
      betweenClaimed: false,
      compaction: "none",
      opened: false,
      opener: null,
      pending: previous.betweenClaimed ? "inside" : "none",
      staleOpener:
        known && (previous.compaction === "inside" || previous.staleOpener),
      stalePending:
        known && (previous.pending === "inside" || previous.stalePending),
      steps: 0,
      summary: previous.summary,
      summaryOpener:
        !known || previous.betweenClaimed || before === "inside"
          ? null
          : before === "start"
            ? previous.opener
            : previous.summaryOpener,
      textOpener: false,
      turnId,
    };
  });
}

/**
 * A message reached the turn. Whether it opened the turn only its history
 * tells (`recordStepHistory`): eve emits `message.received` for text it then
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
 * The turn's message, when it reached its history: the last message, but
 * for eve's `context.*` and `memory.*` messages, if it opens a turn. After
 * an approval's answer, or text eve took as an answer, a tool message is
 * last.
 */
function landedOpener(messages: readonly ModelMessage[]) {
  const last = messages.findLast((message) => {
    if (message.role !== "user") return true;
    const kind = taggedMessageSchema.safeParse(message).data?.kind ?? "user";
    return !kind.startsWith("context.") && !kind.startsWith("memory.");
  });
  return last !== undefined && startsTurn(last) ? last : undefined;
}

/** What the turn's history, before any compaction of it, tells of it. */
function openingOf(record: TurnRecord, messages: readonly ModelMessage[]) {
  const opener = landedOpener(messages);
  if (opener === undefined) return { ...record, textOpener: false };
  return {
    ...record,
    afterInside: record.afterInside || record.staleOpener,
    backgroundTask: turnOpenedByBackgroundTask(messages),
    opener: messageDigest(opener),
    staleOpener: false,
    stalePending: false,
    textOpener: compactsAtTurnStart(messages),
  };
}

/**
 * A step of the turn read its history: called by the model resolver of
 * `step.started` (`agent/agent.ts`), which eve runs before the step's hooks
 * and before it compacts, so `messages` hold every compaction of the steps
 * before. It settles the claims of their `compaction.completed` events
 * (`settled`), and the first step reads the turn's opening; a later call, a
 * retry or another step leaves the opening as it is. Silent outside eve's
 * context: nothing reads the record there.
 */
export function recordStepHistory(
  step: StepIdentity,
  messages: readonly ModelMessage[]
) {
  const { turnId } = step;
  if (turnId === undefined) return;
  let record: TurnRecord;
  try {
    record = readRecord();
  } catch {
    return;
  }
  if (record.turnId !== turnId) return;
  const opening = (current: TurnRecord) =>
    step.stepIndex === 0 && !current.opened && current.steps === 0;
  const digest = summaryDigest(messages);
  const unsettled =
    record.summary !== digest ||
    record.pending !== "none" ||
    record.stalePending;
  if (!unsettled && !opening(record)) return;
  updateTurn(turnId, (current) => {
    const next = settled(current, digest);
    return opening(current)
      ? { ...openingOf(next, messages), opened: true }
      : next;
  });
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
 * eve's `compaction.completed`, a claim until a history shows a new summary
 * (`settled`). During the first step of a turn a person's text opened it is
 * `start`; anything else is `inside`, to the turn's end. One under another
 * turn's id came between turns.
 */
export function recordCompactionCompleted(turnId: string) {
  writeRecord((record) => {
    if (record.turnId !== turnId) return { ...record, betweenClaimed: true };
    const start =
      record.compaction !== "inside" &&
      record.pending !== "inside" &&
      record.steps <= 1 &&
      record.opened &&
      record.textOpener &&
      !record.staleOpener &&
      !record.stalePending;
    return {
      ...record,
      pending: widest(record.pending, start ? "start" : "inside"),
    };
  });
}

/**
 * The compaction of the turn `turnId`, and whether it is the task agent's
 * report: undefined when the state cannot be read here — outside eve, or a
 * subagent, whose state is its own — or holds another turn. The claims no
 * step has settled yet hold if `messages` show a summary other than the
 * record's (`settled`): a reader holding the history from before a
 * compaction reads it as it is. Before the first step, a `turn.started`
 * resolver's `messages` are the turn's history as it began, and tell
 * whether its message reached it; a turn whose first step never read them
 * is taken as compacted inside, of an unknown kind.
 */
export function compactionOfTurn(
  turnId: string | undefined,
  messages: readonly ModelMessage[]
):
  | {
      readonly afterInside: boolean;
      readonly backgroundTask: boolean | null;
      readonly compaction: TurnCompaction;
      readonly summaryOpener: string | null;
    }
  | undefined {
  if (turnId === undefined) return undefined;
  let record: TurnRecord;
  try {
    record = readRecord();
  } catch {
    return undefined;
  }
  if (record.turnId !== turnId) return undefined;
  if (!record.opened && record.steps > 0) {
    return {
      afterInside: false,
      backgroundTask: null,
      compaction: "inside",
      summaryOpener: null,
    };
  }
  const known = settled(record, summaryDigest(messages));
  const read = known.opened ? known : openingOf(known, messages);
  return {
    afterInside: read.afterInside,
    backgroundTask: read.backgroundTask,
    compaction: read.staleOpener ? "inside" : read.compaction,
    summaryOpener: read.summaryOpener,
  };
}
