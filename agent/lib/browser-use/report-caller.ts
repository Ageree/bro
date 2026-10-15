import type { SessionContext } from "eve/context";
import { z } from "zod";

const browserReportCallerSchema = z.object({
  attributes: z.object({ browserRunId: z.string().min(1) }),
  authenticator: z.literal("browser-result"),
});

/**
 * The browser run whose report started the turn this caller belongs to
 * (`sendBrowserRunReport` in `completion.ts`), or undefined for any other
 * caller.
 */
export function reportedBrowserRunId(
  caller: SessionContext["session"]["auth"]["current"]
) {
  return browserReportCallerSchema.safeParse(caller).data?.attributes
    .browserRunId;
}

/**
 * The caller of a turn that only shows a web chat the notice of a report
 * that never got through (`abandoned-notice.ts`): the text is code's, and
 * the turn calls no model.
 */
export const browserNoticeAuthenticator = "browser-notice";

export function browserNoticeCaller(
  caller: SessionContext["session"]["auth"]["current"]
) {
  return caller?.authenticator === browserNoticeAuthenticator;
}
