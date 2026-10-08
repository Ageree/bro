import { defineHook } from "eve/hooks";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { phoneReportRoute } from "@agent/lib/phone/route";
import { bindPhoneReportRoute } from "@db/services/phone";
import { waitForSessionOwnership } from "@db/services/sessions";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import { env } from "@shared/environment";

export default defineHook({
  events: {
    async "message.received"(event, context) {
      if (
        context.session.parent ||
        !startedByPerson(context) ||
        event.data.kind !== undefined ||
        isBackgroundTurnText(event.data.message) ||
        (!env.PHONE_AGENT_ID && env.PHONE_AUTO_PROVISION !== "on")
      )
        return;
      const caller = context.session.auth.current;
      if (caller?.principalType !== "user") return;
      try {
        const scope = scopeFromPrincipal(caller);
        if (!(await waitForSessionOwnership(scope, context.session.id))) return;
        await bindPhoneReportRoute(scope, phoneReportRoute(context));
      } catch {
        console.warn("[phone] trusted conversation route could not be bound");
      }
    },
  },
});
