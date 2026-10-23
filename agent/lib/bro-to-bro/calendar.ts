import { broMeetingEvent } from "@agent/lib/bro-to-bro/event";
import {
  calendarEventId,
  insertCalendarEvent,
} from "@agent/lib/google-workspace/calendar";
import {
  googleApiErrorStatus,
  googleClient,
} from "@agent/lib/google-workspace/client";
import {
  claimBroCalendarWrites,
  finishBroCalendarWrite,
} from "@db/services/bro-to-bro/calendar";
import { readBroThreadForSide } from "@db/services/bro-to-bro/threads";
import { getGoogleWorkspaceAccess } from "@db/services/settings";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { activeConnectedAccount } from "@shared/composio/accounts";
import { isMissingConnectedAccount } from "@shared/composio/api";
import { googleWorkspaceAuthConfigId } from "@shared/google-workspace/connection";

/** One try, Composio's account lookup and Google's answer together. */
const writeTimeoutMs = 20_000;
/** A try's lease, well past its timeout. */
const leaseMs = 120_000;
const claimLimit = 10;

type CalendarWrite = Awaited<ReturnType<typeof claimBroCalendarWrites>>[number];

/**
 * Puts one side's confirmed meeting in its owner's primary Google Calendar,
 * in the background with no model, through the owner's own Google
 * connection (as the free times are read, `slots.ts`): their yes to the
 * meeting was their yes to this. Whether the peer opened their calendar to
 * this owner's envoy does not matter: this is the owner's own calendar. The
 * event's id comes from the thread and the side, so a repeated try finds
 * the event it made instead of adding another. Without a time, Google or a
 * grant to write, it says which; a 401 or an account Composio no longer
 * has is no Google; anything else failed and is tried again.
 */
async function putInCalendar(write: CalendarWrite) {
  const view = await readBroThreadForSide(write.threadId, write.workspaceId);
  const agreed = view?.messages.find(
    (message) => message.id === view.agreedProposalId
  );
  const event = broMeetingEvent(
    agreed?.proposal ?? undefined,
    view?.peer.name ?? null
  );
  if (!event) return { state: "skipped_no_time" } as const;
  const scope = { userId: write.userId, workspaceId: write.workspaceId };
  const signal = AbortSignal.timeout(writeTimeoutMs);
  try {
    const access = await getGoogleWorkspaceAccess(scope);
    const authConfigId = googleWorkspaceAuthConfigId(access);
    if (!authConfigId) return { state: "skipped_no_calendar" } as const;
    const account = await activeConnectedAccount(
      write.userId,
      { authConfigIds: [authConfigId] },
      signal
    );
    if (!account) return { state: "skipped_no_calendar" } as const;
    if (access === "read_only") return { state: "skipped_read_only" } as const;
    const eventId = calendarEventId(`${write.threadId}:${write.side}`);
    const created = await insertCalendarEvent(
      googleClient(account.id, signal),
      {
        calendarId: "primary",
        event: { ...event, timeZone: await readWorkspaceTimeZone(scope) },
        eventId,
      }
    );
    return { eventId: created.id ?? eventId, state: "created" } as const;
  } catch (error) {
    // The cause's name and status only: a message may quote the event.
    console.warn("[bro-to-bro] the meeting did not go into the calendar", {
      error: error instanceof Error ? error.name : "unknown",
      status: googleApiErrorStatus(error),
      threadId: write.threadId,
    });
    return googleApiErrorStatus(error) === 401 ||
      isMissingConnectedAccount(error)
      ? ({ state: "skipped_no_calendar" } as const)
      : ({ state: "failed" } as const);
  }
}

/**
 * Puts the meetings of threads both owners confirmed in each owner's own
 * calendar, one try per side due now (docs/bro-to-bro.md,
 * «Обязательства»), and settles each try: the side's confirmed report goes
 * out only after it.
 */
export async function writeBroCalendars() {
  const writes = await claimBroCalendarWrites({ leaseMs, limit: claimLimit });
  await Promise.all(
    writes.map(async (write) =>
      finishBroCalendarWrite(write, await putInCalendar(write))
    )
  );
}
