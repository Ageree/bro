import { defineHook, type HookContext } from "eve/hooks";
import { z } from "zod";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import {
  finishBrowserRunReport,
  renewBrowserRunReportLease,
  reopenBrowserRunReport,
} from "@db/services/browser-runs";

const browserReportCallerSchema = z.object({
  attributes: z.object({ browserRunId: z.string().min(1) }),
  authenticator: z.literal("browser-result"),
});

/**
 * The browser run whose report started this turn. A subagent inherits its
 * parent's caller, so only the conversation's own turn answers for it.
 */
function reportedRunId(ctx: HookContext) {
  if (ctx.session.parent) return undefined;
  return browserReportCallerSchema.safeParse(ctx.session.auth.current).data
    ?.attributes.browserRunId;
}

/**
 * A browser report reaches the conversation as a turn of its own
 * (`agent/lib/browser-use/completion.ts`), and the conversation accepting it
 * is not the person hearing it: on 24.09 runs finished and the person heard
 * nothing until they asked. The report counts as delivered once its turn
 * got a message through, acted on the errand, or ended on its own; a turn
 * that failed before any of that puts the report back in line.
 */
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const runId = reportedRunId(ctx);
      if (runId) await renewBrowserRunReportLease(runId);
    },
    async "action.result"(event, ctx) {
      const runId = reportedRunId(ctx);
      if (!runId || event.data.status !== "completed") return;
      const { result } = event.data;
      // `browser_task` here is a continue on the errand — the person hears
      // from its own report, and a retry of this one must not repeat it.
      const handled =
        sendMessageToolResultSchema.safeParse(result).success ||
        (result.kind === "tool-result" &&
          result.toolName === "browser_task" &&
          result.isError !== true);
      if (handled) await finishBrowserRunReport(runId);
    },
    async "turn.completed"(_event, ctx) {
      const runId = reportedRunId(ctx);
      if (runId) await finishBrowserRunReport(runId);
    },
    // Someone stopped the turn on purpose; it is not sent again.
    async "turn.cancelled"(_event, ctx) {
      const runId = reportedRunId(ctx);
      if (runId) await finishBrowserRunReport(runId);
    },
    async "turn.failed"(event, ctx) {
      const runId = reportedRunId(ctx);
      if (!runId) return;
      const reopened = await reopenBrowserRunReport(runId);
      if (!reopened) return;
      console.warn(
        "[browser-use] report turn failed before reaching the person",
        {
          code: event.data.code,
          retried: reopened.retried,
          runId,
          sessionId: ctx.session.id,
        }
      );
    },
  },
});
