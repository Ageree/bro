import { z } from "zod";
import type { SessionContext } from "eve/context";

const reportCaller = z.object({
  authenticator: z.literal("phone-result"),
  principalId: z.string().min(1),
  principalType: z.literal("user"),
  attributes: z.object({
    phoneCallId: z.uuid(),
    phoneReportToken: z.uuid(),
    workspaceId: z.string().min(1),
  }),
});

export function phoneReportCaller(
  caller: SessionContext["session"]["auth"]["current"]
) {
  return reportCaller.safeParse(caller).data;
}
