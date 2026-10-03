import { defineState } from "eve/context";
import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { z } from "zod";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  attachmentByteCap,
  attachmentsPerMessage,
  inboxKey,
  namedAttachmentPaths,
  pathMatchesBytes,
  putInbox,
} from "@agent/lib/sandbox/inbox";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";

/**
 * Who opened the current turn, as its messages tell: a task-report turn
 * keeps the person's caller (`turnOpenedByBackgroundTask` in
 * `agent/lib/delivery/turn-sends.ts`), so `startedByPerson` alone would let
 * the task agent's report hand the person's files on. `turn.started` opens
 * the record as nobody's; a message the person sent makes it theirs, and
 * any background work delivered into the turn marks it for good. A turn
 * that resumes after a card brings no message and stays nobody's. eve
 * numbers turns again from `turn_0` in a successor run, so the record names
 * the turn's sequence too.
 */
const turnRecord = defineState<{
  readonly background: boolean;
  readonly person: boolean;
  readonly sequence: number | null;
  readonly turnId: string | null;
}>("bro.task-files-turn", () => ({
  background: false,
  person: false,
  sequence: null,
  turnId: null,
}));

/** eve's own opening of finished background work (`turn-sends.ts`). */
const backgroundTaskOpening = /^Background task task_\S+ /u;
/** The part of `task`'s input that names the files. */
const taskInputSchema = z.object({ message: z.string() });
/** All files of one step are copied within this, one after another. */
const stepBudgetMs = 20_000;

type TurnCoordinates = Pick<
  HookEvent<"turn.started">["data"],
  "sequence" | "turnId"
>;

function openRecord({ sequence, turnId }: TurnCoordinates) {
  return { background: false, person: false, sequence, turnId };
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

/** The staged paths the step's `task` calls name, at most ten in all. */
function namedPaths(
  actions: HookEvent<"actions.requested">["data"]["actions"]
) {
  const paths = new Set<string>();
  for (const action of actions) {
    // A subagent tool reaches hooks as a plain tool call; `subagent-call`
    // is eve's internal dispatch and never shows here
    // (`harness/coordination.js`).
    if (action.kind !== "tool-call" || action.toolName !== "task") continue;
    const message = taskInputSchema.safeParse(action.input).data?.message;
    for (const path of namedAttachmentPaths(message ?? "")) paths.add(path);
  }
  return [...paths].slice(0, attachmentsPerMessage);
}

/**
 * The person's files for the task agent (docs/roadmap.md, item 30): when
 * Bro, answering the person, names a staged file's path in `task`'s
 * message, its bytes go from Bro's sandbox to Object Storage under the
 * conversation's inbox (`agent/lib/sandbox/inbox.ts`), where the task
 * agent's own hook picks them up. eve drains the step's hooks before the
 * step ends and starts the task's body only after it, so the file is there
 * before the task agent looks. Nothing fails the turn: a file not copied
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
          backgroundTaskOpening.test(message);
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
        const paths = namedPaths(event.data.actions);
        if (paths.length === 0) return;
        if (!taskFilesOfCaller(ctx) || !personCaller(ctx)) return;
        if (!personTurn(ctx, event.data)) return;
        const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
        if (caller === null) return;
        const { workspaceId } = scopeFromPrincipal(caller);
        const { failed, mirrored } = await mirror({
          paths,
          sandbox: await ctx.getSandbox(),
          sessionId: ctx.session.id,
          workspaceId,
        });
        console.info("[task-files] mirrored", {
          failed,
          mirrored,
          named: paths.length,
        });
      } catch (error) {
        console.warn("[task-files] files not mirrored", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    },
  },
});

/**
 * Copies each file that is what its path names: how many went, and how many
 * failed on the way rather than being absent or another file.
 */
async function mirror(input: {
  readonly paths: readonly string[];
  readonly sandbox: Awaited<ReturnType<HookContext["getSandbox"]>>;
  readonly sessionId: string;
  readonly workspaceId: string;
}) {
  const deadline = AbortSignal.timeout(stepBudgetMs);
  let failed = 0;
  let mirrored = 0;
  for (const path of input.paths) {
    if (deadline.aborted) break;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One file at a time, within the step's budget.
      const bytes = await input.sandbox.readBinaryFile({
        abortSignal: deadline,
        path,
      });
      if (
        bytes === null ||
        bytes.byteLength > attachmentByteCap ||
        !pathMatchesBytes(path, bytes)
      ) {
        continue;
      }
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
