import { defineHook } from "eve/hooks";
import { phoneReportCaller } from "@agent/lib/phone/report-caller";
import { finishPhoneReport } from "@db/services/phone";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { renewPhoneReportTurn } from "@agent/lib/phone/report-lease";

export default defineHook({
  events: {
    async "turn.started"(_event, context) {
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
      const caller = phoneReportCaller(context.session.auth.current);
      if (
        !caller ||
        !sendMessageToolResultSchema.safeParse(event.data.result).success
      )
        return;
      await finishPhoneReport(
        caller.attributes.phoneCallId,
        caller.attributes.phoneReportToken,
        true
      );
    },
    async "turn.failed"(_event, context) {
      if (!(await renewPhoneReportTurn(context))) return;
      const caller = phoneReportCaller(context.session.auth.current);
      if (caller)
        await finishPhoneReport(
          caller.attributes.phoneCallId,
          caller.attributes.phoneReportToken,
          false
        );
    },
    async "turn.cancelled"(_event, context) {
      if (!(await renewPhoneReportTurn(context))) return;
      const caller = phoneReportCaller(context.session.auth.current);
      if (caller)
        await finishPhoneReport(
          caller.attributes.phoneCallId,
          caller.attributes.phoneReportToken,
          true
        );
    },
  },
});
