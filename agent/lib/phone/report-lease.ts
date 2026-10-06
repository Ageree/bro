import type { SessionContext } from "eve/context";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { renewPhoneReportLease } from "@db/services/phone";
import { phoneReportCaller } from "./report-caller";

export async function renewPhoneReportTurn(
  context: Pick<SessionContext, "session">
) {
  const caller = phoneReportCaller(context.session.auth.current);
  if (!caller || context.session.parent) return false;
  return renewPhoneReportLease(
    scopeFromPrincipal(caller),
    caller.attributes.phoneCallId,
    caller.attributes.phoneReportToken
  );
}
