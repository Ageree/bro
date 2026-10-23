import { defineHook } from "eve/hooks";
import { finishBroReport } from "@db/services/bro-to-bro/reports";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import {
  broReportOfTurn,
  closeBroReportTurn,
  openBroReportTurn,
  renewBroReportTurn,
} from "@agent/lib/bro-to-bro/report-turn";

/**
 * A Bro ↔ Bro report reaches its conversation as a turn of its own
 * (`agent/lib/bro-to-bro/report.ts`), and as with a phone report
 * (`agent/hooks/phone-report.ts`) it counts as delivered once that turn
 * sent a message or ended on its own: sending it again would only pay for
 * the same turn. A turn that failed puts it back in line with a backoff.
 * The question or draft it told of stays in `bro_talk status` and the
 * cabinet either way.
 */
export default defineHook({
  events: {
    async "turn.started"(_event, context) {
      openBroReportTurn(context.session);
      await renewBroReportTurn(context);
    },
    async "step.started"(_event, context) {
      await renewBroReportTurn(context);
    },
    async "action.result"(event, context) {
      if (event.data.status !== "completed") return;
      const report = broReportOfTurn(context.session);
      if (
        !report ||
        !sendMessageToolResultSchema.safeParse(event.data.result).success
      )
        return;
      await finishBroReport(report.reportId, report.token, {
        delivered: true,
      });
    },
    async "turn.completed"(_event, context) {
      const report = broReportOfTurn(context.session);
      closeBroReportTurn();
      if (!report) return;
      // A turn that sent a message has settled the report already; one that
      // ends here said nothing.
      if (
        await finishBroReport(report.reportId, report.token, {
          delivered: true,
        })
      )
        console.info("[bro-to-bro] report turn ended without a message", {
          reportId: report.reportId,
          sessionId: context.session.id,
        });
    },
    // Someone stopped the turn on purpose, which a resend would contradict.
    async "turn.cancelled"(_event, context) {
      const report = broReportOfTurn(context.session);
      closeBroReportTurn();
      if (!report) return;
      if (
        await finishBroReport(report.reportId, report.token, {
          delivered: true,
        })
      )
        console.warn("[bro-to-bro] report turn cancelled before a message", {
          reportId: report.reportId,
          sessionId: context.session.id,
        });
    },
    async "turn.failed"(_event, context) {
      const report = broReportOfTurn(context.session);
      closeBroReportTurn();
      if (report)
        await finishBroReport(report.reportId, report.token, {
          delivered: false,
          error: "report turn failed",
          retry: true,
        });
    },
  },
});
