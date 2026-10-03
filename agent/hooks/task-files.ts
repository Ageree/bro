import { defineState } from "eve/context";
import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { z } from "zod";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { opensAsBackgroundTask } from "@agent/lib/delivery/turn-sends";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  attachmentsPerMessage,
  inboxKey,
  namedAttachmentPaths,
  pathMatchesBytes,
  putInbox,
  type PersonSend,
  putPersonSend,
  readSandboxFileWithin,
} from "@agent/lib/sandbox/inbox";
import { taskFilesGuarded, taskFilesOfCaller } from "@agent/lib/sandbox/pilot";

/**
 * Who opened the current turn, as its messages tell: a task-report turn
 * keeps the person's caller (`turnOpenedByBackgroundTask` in
 * `agent/lib/delivery/turn-sends.ts`), so `startedByPerson` alone would let
 * the task agent's report hand the person's files on. `turn.started` opens
 * the record as nobody's; a message the person sent makes it theirs, and
 * any background work delivered into the turn marks it for good. A turn
 * that resumes after a card brings no message and stays nobody's. eve
 * numbers turns again from `turn_0` in a successor run, so the record names
 * the turn's sequence too. eve emits `actions.requested` once per streamed
 * call (`harness/emission.js`), so the record also keeps the step's budget:
 * the files its calls took and when its copying has to end.
 */
const turnRecord = defineState<{
  readonly background: boolean;
  readonly person: boolean;
  readonly sequence: number | null;
  readonly step: {
    readonly deadlineAt: number;
    readonly index: number;
    readonly paths: readonly string[];
  } | null;
  readonly turnId: string | null;
}>("bro.task-files-turn", () => ({
  background: false,
  person: false,
  sequence: null,
  step: null,
  turnId: null,
}));

/** The parts of `task`'s input that name the files and the task agent. */
const taskInputSchema = z.object({
  agentId: z.string().nullish(),
  message: z.string(),
});
/** All files of one step's calls are copied within this, one after another. */
const stepBudgetMs = 20_000;
/** Recording the person's `task` calls of one event. */
const callsBudgetMs = 10_000;

type TurnCoordinates = Pick<
  HookEvent<"turn.started">["data"],
  "sequence" | "turnId"
>;

function openRecord({ sequence, turnId }: TurnCoordinates) {
  return { background: false, person: false, sequence, step: null, turnId };
}

/** The person's own message under their own caller, no report's. */
function personCaller(ctx: HookContext) {
  return (
    ctx.session.parent === undefined &&
    startedByPerson(ctx) &&
    reportedBrowserRunId(ctx.session.auth.current) === undefined
  );
}

/** Whether this step belongs to a turn the person's message opened. */
function personTurn(ctx: HookContext, step: TurnCoordinates) {
  const record = turnRecord.get();
  return (
    record.turnId === step.turnId &&
    record.sequence === step.sequence &&
    record.person &&
    !record.background
  );
}

/** The `task` calls of one event. */
function taskCalls(data: HookEvent<"actions.requested">["data"]) {
  return data.actions.flatMap((action) =>
    // A subagent tool reaches hooks as a plain tool call; `subagent-call`
    // is eve's internal dispatch and never shows here
    // (`harness/coordination.js`).
    action.kind === "tool-call" && action.toolName === "task"
      ? [
          taskCall(
            action.callId,
            data.turnId,
            taskInputSchema.safeParse(action.input).data
          ),
        ]
      : []
  );
}

/**
 * One `task` call: the message it sends and whom to. eve continues the task
 * agent an `agentId` names, and starts a new one without it, its lineage
 * naming this call and this turn's id (`startSubagent` in
 * `execution/tools/subagent/start.js`); the lineage's sequence is Bro's as
 * the task is dispatched, not this turn's, so it names nothing here. A
 * malformed input sends nothing, and nothing is recorded for it.
 */
function taskCall(
  callId: string,
  turnId: string,
  input: z.infer<typeof taskInputSchema> | undefined
) {
  if (input === undefined) return { message: undefined, send: undefined };
  const { message } = input;
  const agentId = input.agentId?.trim() ?? "";
  const send: PersonSend =
    agentId === ""
      ? { callId, kind: "start", message, turnId }
      : { agentId, kind: "continue", message };
  return { message, send };
}

/** The staged paths the calls name, each once. */
function namedPaths(calls: ReturnType<typeof taskCalls>) {
  const paths = new Set<string>();
  for (const { message } of calls) {
    for (const path of namedAttachmentPaths(message ?? "")) paths.add(path);
  }
  return [...paths];
}

/**
 * Of the paths an event names, the ones its step may still copy: the first
 * ten distinct paths of all the step's calls, a replay of one of them
 * included, and the step's one deadline for all of them.
 */
function stepShare(stepIndex: number, named: readonly string[]) {
  const recorded = turnRecord.get().step;
  const step =
    recorded?.index === stepIndex
      ? recorded
      : { deadlineAt: Date.now() + stepBudgetMs, index: stepIndex, paths: [] };
  const paths = [...step.paths];
  for (const path of named) {
    if (!paths.includes(path) && paths.length < attachmentsPerMessage) {
      paths.push(path);
    }
  }
  turnRecord.update((record) => ({ ...record, step: { ...step, paths } }));
  return {
    deadlineAt: step.deadlineAt,
    paths: named.filter((path) => paths.includes(path)),
  };
}

/**
 * The person's files for the task agent (docs/roadmap.md, item 30): when
 * Bro, answering the person, names a staged file's path in `task`'s
 * message, its bytes go from Bro's sandbox to Object Storage under the
 * conversation's inbox (`agent/lib/sandbox/inbox.ts`), where the task
 * agent's own hook picks them up. eve drains the step's hooks before the
 * step ends and starts a new task's body only after it, so the file is
 * there before the task agent looks; a message steered into a busy task
 * agent can come first, and its hook asks again for a while. Nothing fails
 * the turn: a file not copied
 * is one the task agent reports missing. The logs carry counts only.
 */
export default defineHook({
  events: {
    "turn.started"(event) {
      try {
        turnRecord.update(() => openRecord(event.data));
      } catch (error) {
        console.warn("[task-files] turn not recorded", { cause: error });
      }
    },
    "message.received"(event, ctx) {
      try {
        const { kind, message } = event.data;
        const background =
          kind === "execution.background_task" ||
          opensAsBackgroundTask(message);
        turnRecord.update((current) => {
          const record =
            current.turnId === event.data.turnId &&
            current.sequence === event.data.sequence
              ? current
              : openRecord(event.data);
          if (background) return { ...record, background: true };
          return personCaller(ctx) ? { ...record, person: true } : record;
        });
      } catch (error) {
        console.warn("[task-files] message not recorded", { cause: error });
      }
    },
    async "actions.requested"(event, ctx) {
      try {
        const calls = taskCalls(event.data);
        if (calls.length === 0) return;
        if (!taskFilesGuarded() || !personCaller(ctx)) return;
        if (!personTurn(ctx, event.data)) return;
        const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
        if (caller === null) return;
        const { workspaceId } = scopeFromPrincipal(caller);
        // The task agent each call starts or continues stays on the web
        // only when the person's turn made the call (`keepOffWebUnlessSent`),
        // which a conversation marked before the files pilot was cleared
        // still asks: recorded wherever Object Storage is.
        const recorded = await recordPersonSends({
          sends: calls.flatMap(({ send }) =>
            send === undefined ? [] : [send]
          ),
          sessionId: ctx.session.id,
          workspaceId,
        });
        if (!taskFilesOfCaller(ctx)) return;
        const paths = namedPaths(calls);
        if (paths.length === 0) {
          console.info("[task-files] calls", { recorded });
          return;
        }
        const share = stepShare(event.data.stepIndex, paths);
        if (share.paths.length === 0) return;
        const { failed, mirrored } = await mirror({
          deadlineAt: share.deadlineAt,
          paths: share.paths,
          sandbox: await ctx.getSandbox(),
          sessionId: ctx.session.id,
          workspaceId,
        });
        console.info("[task-files] mirrored", {
          failed,
          mirrored,
          named: paths.length,
          recorded,
        });
      } catch (error) {
        console.warn("[task-files] files not mirrored", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    },
  },
});

/** Records each call's message as the person's: how many were. */
async function recordPersonSends(input: {
  readonly sends: readonly PersonSend[];
  readonly sessionId: string;
  readonly workspaceId: string;
}) {
  const signal = AbortSignal.timeout(callsBudgetMs);
  const results = await Promise.allSettled(
    input.sends.map(async (send) => {
      await putPersonSend(input.workspaceId, input.sessionId, send, signal);
    })
  );
  return results.filter((result) => result.status === "fulfilled").length;
}

/**
 * Copies each file that is what its path names: how many went, and how many
 * failed on the way rather than being absent or another file.
 */
async function mirror(input: {
  readonly deadlineAt: number;
  readonly paths: readonly string[];
  readonly sandbox: Awaited<ReturnType<HookContext["getSandbox"]>>;
  readonly sessionId: string;
  readonly workspaceId: string;
}) {
  const deadline = AbortSignal.timeout(
    Math.max(0, input.deadlineAt - Date.now())
  );
  let failed = 0;
  let mirrored = 0;
  for (const path of input.paths) {
    if (deadline.aborted || Date.now() >= input.deadlineAt) break;
    try {
      // A file at the path may have grown far past any the person sent: it
      // is read only up to the cap.
      // oxlint-disable-next-line eslint/no-await-in-loop -- One file at a time, within the step's budget.
      const bytes = await readSandboxFileWithin(input.sandbox, path, deadline);
      if (
        bytes === null ||
        bytes === "oversize" ||
        !pathMatchesBytes(path, bytes)
      ) {
        continue;
      }
      // Stored again even when an earlier turn stored it: the object's date
      // is what tells the task agent this turn named it (`inboxFreshMs`).
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      await putInbox(
        inboxKey(input.workspaceId, input.sessionId, path),
        bytes,
        deadline
      );
      mirrored += 1;
    } catch {
      // The next file may still go; the task agent reports this one.
      failed += 1;
    }
  }
  return { failed, mirrored };
}
