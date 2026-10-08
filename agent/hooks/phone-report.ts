import { defineHook } from "eve/hooks";
import { finishPhoneReport } from "@db/services/phone";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import {
  closePhoneReportTurn,
  openPhoneReportTurn,
  phoneReportOfTurn,
  renewPhoneReportTurn,
} from "@agent/lib/phone/report-lease";

/**
 * A phone report reaches the conversation as a turn of its own
 * (`agent/lib/phone/report.ts`), and the conversation accepting it is not the
 * person hearing it. As with a browser report
 * (`agent/hooks/browser-run-report.ts`), the report counts as delivered once
 * its turn sent a message or ended on its own: a turn that ends without a
 * word (plain text, `<eve-empty-delivery/>`, another tool) has said what it
 * had to, and sending the report again would only pay for the same turn. A
 * turn that failed puts it back in line with a backoff.
 *
 * The report is found by the turn, not only by the caller: a person's message
 * that steers into the turn takes `auth.current` over (`phoneReportOfTurn`).
 * A copy that waited in the queue past the lease carries the report's own
 * token (`claimPhoneReports`), so it settles the report like any other.
 */
export default defineHook({
  events: {
    async "turn.started"(_event, context) {
      openPhoneReportTurn(context.session);
      await renewPhoneReportTurn(context);
    },
    async "step.started"(_event, context) {
      await renewPhoneReportTurn(context);
    },
    async "action.result"(event, context) {
      if (
        !(await renewPhoneReportTurn(context)) ||
        event.data.status !== "completed"
      )
        return;
      const report = phoneReportOfTurn(context.session);
      if (
        !report ||
        !sendMessageToolResultSchema.safeParse(event.data.result).success
      )
        return;
      await finishPhoneReport(report.callId, report.token, true);
    },
    async "turn.completed"(_event, context) {
      const report = phoneReportOfTurn(context.session);
      closePhoneReportTurn();
      if (!report) return;
      // A turn that sent a message has settled the report already; one that
      // ends here said nothing.
      if (await finishPhoneReport(report.callId, report.token, true))
        console.info("[phone] report turn ended without a message", {
          callId: report.callId,
          sessionId: context.session.id,
        });
    },
    // Someone stopped the turn on purpose, which a resend would contradict:
    // like a browser report, it counts as settled. The result stays in
    // `phone-status`, and the log says it did not reach the person.
    async "turn.cancelled"(_event, context) {
      const report = phoneReportOfTurn(context.session);
      closePhoneReportTurn();
      if (!report) return;
      if (await finishPhoneReport(report.callId, report.token, true))
        console.warn("[phone] report turn cancelled before a message", {
          callId: report.callId,
          sessionId: context.session.id,
        });
    },
    async "turn.failed"(_event, context) {
      const report = phoneReportOfTurn(context.session);
      closePhoneReportTurn();
      if (report) await finishPhoneReport(report.callId, report.token, false);
    },
  },
});
