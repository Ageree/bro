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
 * Who gave the errand, as a report's caller names it in `errandBy`: the
 * person, when they started it in a turn of their own or a run it carries on
 * from was (the runs' `startedByPerson`), or else Bro — a schedule, a
 * background worker. Only Bro's code writes a report's caller, and only the
 * person's errand may come to them as a card (`agent/lib/cards/tools.ts`).
 */
export const errandByPerson = "person";

const personErrandReportCallerSchema = browserReportCallerSchema.extend({
  attributes: z.object({
    browserRunId: z.string().min(1),
    errandBy: z.literal(errandByPerson),
  }),
  principalType: z.literal("user"),
});

/**
 * The browser run whose report started the turn, when the person gave that
 * errand (`errandByPerson`), or undefined.
 */
export function personErrandRunId(
  caller: SessionContext["session"]["auth"]["current"]
) {
  return personErrandReportCallerSchema.safeParse(caller).data?.attributes
    .browserRunId;
}

/**
 * The caller of a turn that only shows a web chat the notice of a report
 * that never got through (`abandoned-notice.ts`): the text is code's, and
 * the turn calls no model (`browserNoticeTurn`).
 */
export const browserNoticeAuthenticator = "browser-notice";
