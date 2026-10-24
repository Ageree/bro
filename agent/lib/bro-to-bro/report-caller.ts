import type { SessionContext } from "eve/context";
import * as z from "zod";

/**
 * The caller of a Bro ↔ Bro report's turn (`agent/lib/bro-to-bro/report.ts`):
 * code telling the owner about their links and threads, speaking for nobody.
 */
export const broReportAuthenticator = "bro-result";

const reportCaller = z.object({
  authenticator: z.literal(broReportAuthenticator),
  principalId: z.string().min(1),
  principalType: z.literal("user"),
  attributes: z.object({
    broReportId: z.uuid(),
    broReportToken: z.uuid(),
    workspaceId: z.string().min(1),
  }),
});

export function broReportCaller(
  caller: SessionContext["session"]["auth"]["current"]
) {
  return reportCaller.safeParse(caller).data;
}
