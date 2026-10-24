import {
  freeWindows,
  type Interval,
  zonedIso,
  zoneOffsetMinutes,
} from "@agent/lib/google-workspace/availability";
import {
  calendarApi,
  freeBusyResponseSchema,
  parseCalendarAvailability,
} from "@agent/lib/google-workspace/calendar";
import {
  googleApiErrorStatus,
  googleClient,
  googleUrl,
} from "@agent/lib/google-workspace/client";
import { getGoogleWorkspaceAccess } from "@db/services/settings";
import { activeConnectedAccount } from "@shared/composio/accounts";
import { googleWorkspaceAuthConfigId } from "@shared/google-workspace/connection";
import type { AccessScope } from "@shared/identity/access-scope";

/** The owner's day, in their own zone: no candidate before 9:00 or past 23:00. */
const dayHours = { from: 9, to: 23 } as const;
const maximumDays = 60;
const maximumCandidates = 8;
const defaultDurationMinutes = 60;
const halfHourMs = 30 * 60_000;
const dayMs = 24 * 60 * 60_000;
const readTimeoutMs = 20_000;

/** An instant moved to the owner's half hour: later for a start, earlier for an end. */
function onHalfHour(at: number, timeZone: string, toward: "earlier" | "later") {
  const offset = zoneOffsetMinutes(at, timeZone) * 60_000;
  const halfHours = (at + offset) / halfHourMs;
  return (
    (toward === "later" ? Math.ceil(halfHours) : Math.floor(halfHours)) *
      halfHourMs -
    offset
  );
}

/**
 * The candidates an envoy may offer and accept, from the owner's busy time:
 * free windows inside their day (9:00–23:00 in their zone) at least
 * `durationMinutes` long, starting and ending on the half hour; at most 8,
 * spread over the days — every day's longest window first, a day's next one
 * only once each day has given one — and, first of all, the window that
 * holds `around` (the peer's latest proposal), if one does, however far
 * off its day is. In time order, as ISO instants in the owner's zone. A
 * window is a range to pick a time inside, not the time itself: the other
 * side's free hours seldom start where these do.
 */
export function slotCandidates(input: {
  readonly around?: Interval;
  readonly busy: readonly Interval[];
  readonly durationMinutes: number;
  readonly range: Interval;
  readonly timeZone: string;
}) {
  const { timeZone } = input;
  const days = new Map<string, Interval[]>();
  for (const window of freeWindows({
    busy: input.busy,
    hours: dayHours,
    range: input.range,
    slotMinutes: input.durationMinutes,
    timeZone,
  })) {
    const start = onHalfHour(window.start, timeZone, "later");
    const end = onHalfHour(window.end, timeZone, "earlier");
    if (end - start < input.durationMinutes * 60_000) continue;
    const day = zonedIso(start, timeZone).slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), { end, start }]);
  }
  const longestFirst = [...days.values()].map((windows) =>
    windows.toSorted((a, b) => b.end - b.start - (a.end - a.start))
  );
  const { around } = input;
  const holding = around
    ? longestFirst
        .flat()
        .find(
          (window) => window.start <= around.start && around.end <= window.end
        )
    : undefined;
  const chosen: Interval[] = holding ? [holding] : [];
  for (let round = 0; chosen.length < maximumCandidates; round += 1) {
    const next = longestFirst.flatMap((windows) =>
      windows.slice(round, round + 1)
    );
    if (next.length === 0) break;
    chosen.push(
      ...next
        .filter((window) => window !== holding)
        .slice(0, maximumCandidates - chosen.length)
    );
  }
  return chosen
    .toSorted((a, b) => a.start - b.start)
    .map((window) => ({
      end: zonedIso(window.end, timeZone),
      start: zonedIso(window.start, timeZone),
    }));
}

/**
 * The owner's candidates within a thread's window, read in the background
 * without a turn: one freeBusy request for the primary calendar through the
 * owner's Google connection (as the proactive check reaches Google), no
 * event titles asked for or returned. The window starts no earlier than now
 * and spans at most 60 days; a meeting is 60 minutes unless the mandate says
 * otherwise, and the window that holds `around`, the peer's latest
 * proposal, is among the candidates. No Google, no connection or a failed
 * read is `unavailable`: the envoy then asks the owner about time.
 */
export async function readSlotCandidates(
  scope: AccessScope,
  request: {
    readonly around?: { readonly start: string; readonly end: string };
    readonly durationMinutes?: number | null;
    readonly signal?: AbortSignal;
    readonly timeZone: string;
    readonly window: { readonly from: string; readonly to: string };
  }
): Promise<
  | {
      readonly state: "known";
      readonly candidates: readonly {
        readonly start: string;
        readonly end: string;
      }[];
    }
  | { readonly state: "unavailable" }
> {
  const start = Math.max(Date.parse(request.window.from), Date.now());
  const end = Math.min(
    Date.parse(request.window.to),
    start + maximumDays * dayMs
  );
  if (!(end > start)) return { candidates: [], state: "known" };
  const signal = AbortSignal.any([
    AbortSignal.timeout(readTimeoutMs),
    ...(request.signal ? [request.signal] : []),
  ]);
  try {
    const authConfigId = googleWorkspaceAuthConfigId(
      await getGoogleWorkspaceAccess(scope)
    );
    if (!authConfigId) return { state: "unavailable" };
    const account = await activeConnectedAccount(
      scope.userId,
      { authConfigIds: [authConfigId] },
      signal
    );
    if (!account) return { state: "unavailable" };
    const answer = await googleClient(account.id, signal).json(
      freeBusyResponseSchema,
      {
        body: {
          items: [{ id: "primary" }],
          timeMax: new Date(end).toISOString(),
          timeMin: new Date(start).toISOString(),
          timeZone: request.timeZone,
        },
        method: "POST",
        url: googleUrl(calendarApi, "/freeBusy"),
      }
    );
    const busy = Object.values(
      parseCalendarAvailability(answer).calendars ?? {}
    )
      .flatMap((calendar) => calendar.busy ?? [])
      .map((span) => ({
        end: Date.parse(span.end),
        start: Date.parse(span.start),
      }))
      .filter((span) => span.end > span.start);
    const { around } = request;
    return {
      candidates: slotCandidates({
        ...(around && {
          around: {
            end: Date.parse(around.end),
            start: Date.parse(around.start),
          },
        }),
        busy,
        durationMinutes: request.durationMinutes ?? defaultDurationMinutes,
        range: { end, start },
        timeZone: request.timeZone,
      }),
      state: "known",
    };
  } catch (error) {
    console.warn("[bro-to-bro] free time could not be read", {
      error: error instanceof Error ? error.name : "unknown",
      status: googleApiErrorStatus(error),
    });
    return { state: "unavailable" };
  }
}
