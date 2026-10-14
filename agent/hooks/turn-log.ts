import { defineHook, type HookContext } from "eve/hooks";
import { z } from "zod";
import type { turnLogEntries } from "@db";
import {
  appendTurnEntries,
  recordTurnEnd,
  recordTurnStart,
  recordTurnStep,
  recordTurnTools,
} from "@db/services/turn-log";
import { turnCostSource, turnWorkspaceId } from "@agent/lib/costs/turns";
import {
  alertTurnFailure,
  turnFailureCode,
} from "@agent/lib/monitoring/failure-alert";
import {
  transcriptJson,
  transcriptsEnabled,
  transcriptText,
  turnChannel,
} from "@agent/lib/monitoring/transcript";
import { startedByPerson } from "@agent/lib/mode";

/**
 * Every turn of Bro's, on every channel, into the owner's `turn_log`: whose
 * and where, how long, how many model steps, which tools, how it ended and
 * what its steps cost. With OWNER_TRANSCRIPTS=on also what was said, a line
 * per message and tool call into `turn_log_entries`, cut to 2000
 * characters with codes, passwords, card and document numbers cut out. A
 * person's failed turn is told to the owner (`alertTurnFailure`). The task
 * agent re-exports this hook, so its turns count as `task`.
 *
 * Monitoring must never cost the turn: a failed write is a warning with
 * the error's name only — drizzle's message quotes the query's parameters,
 * the text among them — and the alert is not waited for.
 */
export default defineHook({
  events: {
    async "turn.started"(event, ctx) {
      const workspaceId = turnWorkspaceId(ctx.session.auth);
      if (workspaceId === undefined) return;
      const { runId, source } = turnCostSource(ctx.session);
      const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
      await quietly("start", ctx, () =>
        recordTurnStart({
          channel: turnChannel(ctx),
          kind: source === "chat" ? "person" : source,
          runId: runId ?? null,
          sessionId: ctx.session.id,
          startedAt: new Date(event.meta.at),
          turnId: event.data.turnId,
          userId: caller?.principalId ?? null,
          workspaceId,
        })
      );
    },
    async "step.completed"(event, ctx) {
      await quietly("step", ctx, () =>
        recordTurnStep(turnOf(ctx, event.data.turnId), event.data.stepIndex)
      );
    },
    async "actions.requested"(event, ctx) {
      const { actions, turnId } = event.data;
      const calls = actions.map((action) => ({
        action,
        name:
          action.kind === "load-skill"
            ? "load_skill"
            : "toolName" in action
              ? action.toolName
              : action.name,
      }));
      await quietly("tools", ctx, () =>
        recordTurnTools(
          turnOf(ctx, turnId),
          calls.map((call) => call.name)
        )
      );
      for (const { action, name } of calls) {
        const reply =
          name === "send_message"
            ? replySchema.safeParse(action.input).data?.text
            : undefined;
        if (reply !== undefined) logMessage("bro", ctx, turnId, reply);
      }
      if (!transcriptsEnabled()) return;
      await transcribe(ctx, turnId, () =>
        calls.map(({ action, name }) => {
          const reply =
            name === "send_message"
              ? replySchema.safeParse(action.input).data?.text
              : undefined;
          return {
            at: event.meta.at,
            eventId: event.meta.id,
            part: action.callId,
            role: reply === undefined ? "tool-call" : "bro",
            text:
              reply === undefined
                ? transcriptJson(action.input)
                : transcriptText(reply),
            toolName: name,
          };
        })
      );
    },
    async "action.result"(event, ctx) {
      if (!transcriptsEnabled()) return;
      const { result, turnId } = event.data;
      await transcribe(ctx, turnId, () => [
        {
          at: event.meta.at,
          eventId: event.meta.id,
          part: result.callId,
          role: "tool-result",
          text: transcriptJson(result.output),
          toolName:
            result.kind === "subagent-result"
              ? result.subagentName
              : result.kind === "tool-result"
                ? result.toolName
                : "load_skill",
        },
      ]);
    },
    async "message.received"(event, ctx) {
      const person =
        event.data.kind === undefined &&
        !ctx.session.parent &&
        startedByPerson(ctx);
      logMessage(
        person ? "person" : "input",
        ctx,
        event.data.turnId,
        event.data.message
      );
      if (!transcriptsEnabled()) return;
      await transcribe(ctx, event.data.turnId, () => [
        {
          at: event.meta.at,
          eventId: event.meta.id,
          part: "",
          role: person ? "person" : "input",
          text: transcriptText(event.data.message),
          toolName: null,
        },
      ]);
    },
    async "message.completed"(event, ctx) {
      const { message, turnId } = event.data;
      if (message === null) return;
      logMessage("bro", ctx, turnId, message);
      if (!transcriptsEnabled()) return;
      await transcribe(ctx, turnId, () => [
        {
          at: event.meta.at,
          eventId: event.meta.id,
          part: "",
          role: "bro",
          text: transcriptText(message),
          toolName: null,
        },
      ]);
    },
    async "turn.completed"(event, ctx) {
      await quietly("end", ctx, () =>
        recordTurnEnd(turnOf(ctx, event.data.turnId), {
          endedAt: new Date(event.meta.at),
          outcome: "completed",
        })
      );
    },
    async "turn.cancelled"(event, ctx) {
      await quietly("end", ctx, () =>
        recordTurnEnd(turnOf(ctx, event.data.turnId), {
          endedAt: new Date(event.meta.at),
          outcome: "cancelled",
        })
      );
    },
    async "turn.failed"(event, ctx) {
      const at = new Date(event.meta.at);
      const errorCode = turnFailureCode(event.data);
      await quietly("end", ctx, () =>
        recordTurnEnd(turnOf(ctx, event.data.turnId), {
          endedAt: at,
          errorCode,
          outcome: "failed",
        })
      );
      // Decided by the turn's own caller, not its row: a turn that started
      // before this log, or whose row was not written, is told as well.
      const workspaceId = turnWorkspaceId(ctx.session.auth);
      if (
        workspaceId === undefined ||
        turnCostSource(ctx.session).source !== "chat"
      ) {
        return;
      }
      // Not waited for: Telegram may take its ten seconds, and the session
      // should be free for the person's next message.
      void alertTurnFailure({
        at,
        channel: turnChannel(ctx),
        errorCode,
        workspaceId,
      });
    },
  },
});

/**
 * A message's text into the server log (journald), cut and filtered like a
 * transcript line. Always on, whatever OWNER_TRANSCRIPTS says; a filter that
 * throws costs the line, not the turn.
 */
function logMessage(
  role: string,
  ctx: HookContext,
  turnId: string,
  text: string
) {
  try {
    console.info("[message]", {
      channel: turnChannel(ctx),
      role,
      sessionId: ctx.session.id,
      text: transcriptText(text),
      turnId,
    });
  } catch {
    console.warn("[message] a line was not logged", {
      sessionId: ctx.session.id,
    });
  }
}

/** What `send_message` says to the person. */
const replySchema = z.object({ text: z.string() });

function turnOf(ctx: HookContext, turnId: string) {
  return { sessionId: ctx.session.id, turnId };
}

/**
 * Keeps a turn's transcript lines; the caller checked OWNER_TRANSCRIPTS. A
 * line left empty by the cut is not kept. The lines are made inside the
 * guard: a filter that throws on some text costs its lines, not the turn
 * (eve fails the turn on a hook's exception).
 */
async function transcribe(
  ctx: HookContext,
  turnId: string,
  lines: () => readonly (Pick<
    typeof turnLogEntries.$inferInsert,
    "eventId" | "part" | "role" | "text" | "toolName"
  > & { readonly at: string })[]
) {
  const workspaceId = turnWorkspaceId(ctx.session.auth);
  if (workspaceId === undefined) return;
  await quietly("transcript", ctx, () =>
    appendTurnEntries(
      lines().map((line) => ({
        createdAt: new Date(line.at),
        eventId: line.eventId,
        part: line.part,
        role: line.role,
        sessionId: ctx.session.id,
        text: line.text,
        toolName: line.toolName,
        turnId,
        workspaceId,
      }))
    )
  );
}

/** Runs a write of the log; a failure is a warning, never the turn's. */
async function quietly<T>(
  write: string,
  ctx: HookContext,
  run: () => Promise<T>
) {
  try {
    return await run();
  } catch (error) {
    console.warn("[turn-log] a write failed", {
      cause: error instanceof Error ? error.name : "unknown",
      sessionId: ctx.session.id,
      write,
    });
    return undefined;
  }
}
