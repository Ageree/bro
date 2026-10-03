import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { calendarApi } from "@agent/lib/google-workspace/calendar";
import {
  GoogleApiError,
  type GoogleClient,
  GoogleUnreadableAnswerError,
  googleApiErrorStatus,
  googleClient,
  googleUrl,
  isGoogleRateLimit,
} from "@agent/lib/google-workspace/client";
import {
  calendarHorizonMs,
  calendarSignals,
  flightEvents,
  flightReminders,
  gmailProbeQuery,
  gmailSignals,
  isEveningEvent,
  isNightFlight,
  isNightSubject,
  mailRank,
  proactiveEventFields,
  proactiveEventListSchema,
} from "@agent/lib/proactive/signals";
import type { ProactiveSignal } from "@db/services/proactive";
import { getGoogleWorkspaceAccess } from "@db/services/settings";
import { activeConnectedAccount } from "@shared/composio/accounts";
import {
  ComposioError,
  isMissingConnectedAccount,
  isTransientComposioFailure,
} from "@shared/composio/api";
import { googleWorkspaceAuthConfigId } from "@shared/google-workspace/connection";
import type { AccessScope } from "@shared/identity/access-scope";

const probeTimeoutMs = 20_000;
/** One page of upcoming events: a check reads no more. */
const maxCalendarEvents = 25;
/**
 * Mail ids are listed a page at a time, newest first. Five pages cover any
 * realistic day of inbox mail; past that the oldest of it is not news.
 */
const mailPageSize = 100;
const maxMailPages = 5;

const gmailApi = "https://gmail.googleapis.com/gmail/v1/users/me";

const mailPageSchema = z.object({
  messages: z
    .array(z.object({ id: z.string(), threadId: z.string().optional() }))
    .optional(),
  nextPageToken: z.string().optional(),
});

/**
 * A night check reads the subjects of this many of the newest messages; the
 * night's mail is little, and whatever is past the cap waits for the morning.
 */
const maxNightSubjects = 20;
/** Gmail's per-user limit counts parallel calls; five at a time stays under. */
const headerReadBatch = 5;
/**
 * A backlog too big for one run has the headers of this many of its newest
 * messages read to rank them; older ones rank as unread mail from strangers.
 */
const maxRankedMail = 60;

const mailMetadataSchema = z.object({
  id: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  payload: z
    .object({
      headers: z
        .array(z.object({ name: z.string(), value: z.string() }))
        .optional(),
    })
    .optional(),
  threadId: z.string().optional(),
});

/**
 * How long a check waits before asking Composio once more. Its refusals from
 * Cloud.ru come and go (02–03.10: 5 of 9 night checks got a bare 403 while
 * the same key answered from elsewhere); one more try a few seconds later
 * keeps a night check from being lost to one of them.
 */
const composioRetryMs = 3_000;

/**
 * Whether Composio's refusal may pass on a second try: its 403 that names no
 * gone account (a firewall's or a passing one), its throttling or outage, a
 * network error. A missing key or account stays as it is, and so does a
 * call cut off by the check's deadline.
 */
function composioMayPass(cause: unknown) {
  if (isMissingConnectedAccount(cause)) return false;
  // The check's own deadline passed: its signal stays aborted, and a second
  // call would fail at once after the pause.
  if (
    cause instanceof DOMException &&
    (cause.name === "TimeoutError" || cause.name === "AbortError")
  ) {
    return false;
  }
  return (
    (cause instanceof ComposioError && cause.status === 403) ||
    isTransientComposioFailure(cause)
  );
}

/** One call to Composio, asked once more after a pause if it may pass. */
async function onceMore<T>(call: () => Promise<T>) {
  try {
    return await call();
  } catch (error) {
    if (!composioMayPass(error)) throw error;
    await setTimeout(composioRetryMs);
    return call();
  }
}

/**
 * Why a check failed, for its log line: who refused and with what — never
 * the person's mail. A Composio 403 is told from Google's quota refusal,
 * which the proxy passes on as Google's own answer.
 */
export function probeFailure(cause: unknown) {
  if (cause instanceof ComposioError) {
    return {
      by: "composio",
      slug: cause.slug,
      status: cause.status,
      ...cause.answer,
    };
  }
  if (cause instanceof GoogleApiError) {
    return {
      by: "google",
      rateLimited: isGoogleRateLimit(cause),
      reason: cause.error?.errors[0]?.reason ?? cause.error?.status,
      status: cause.status,
    };
  }
  return { by: cause instanceof Error ? cause.name : "unknown" };
}

/**
 * The person's Google client for a background check, or why there is none: a
 * workspace without Google (`unavailable`) or without a grant.
 */
async function connectedGoogle(scope: AccessScope, signal: AbortSignal) {
  // The account belongs to the access level the person connected with;
  // looking under the other level's auth config finds none.
  const authConfigId = googleWorkspaceAuthConfigId(
    await getGoogleWorkspaceAccess(scope)
  );
  if (!authConfigId) return { state: "unavailable" } as const;
  const account = await onceMore(async () =>
    activeConnectedAccount(
      scope.userId,
      { authConfigIds: [authConfigId] },
      signal
    )
  );
  return account
    ? ({
        google: googleClient(account.id, signal),
        state: "connected",
      } as const)
    : ({ state: "disconnected" } as const);
}

/**
 * A read whose answer came back as text that is not JSON is asked once more:
 * the proxy passes a passing upstream error on as text. So is one Composio
 * refused in a way that may pass (`onceMore`). The log line carries
 * the start of the body, not what the person's mail says.
 */
async function readJson<Schema extends z.ZodType>(
  google: GoogleClient,
  schema: Schema,
  url: string
) {
  try {
    return await onceMore(async () => google.json(schema, { url }));
  } catch (error) {
    if (!(error instanceof GoogleUnreadableAnswerError)) throw error;
    console.warn("[proactive] unreadable Google answer, asking again", {
      bodyStart: error.bodyStart,
      host: new URL(url).hostname,
    });
    return google.json(schema, { url });
  }
}

/**
 * The cheap look that decides whether a model run is worth starting: message
 * and event ids only, two Google requests through Composio, no model call. A
 * workspace without a Google account reports that instead of failing the
 * tick. Flights also bring the reminders due now (`flightReminders`), seen
 * before or not. A night check (`nightOnly`) keeps only what may not wait for
 * the morning: a flight leaving within hours or tonight's reminder of one,
 * and mail whose subject is about a flight or an account's security; that
 * costs a subject read per message. The flights ahead come back too
 * (`flights`), for their watches; where those watches remind of them
 * (`flightReminders: false`, the subscriptions pilot), the check does not.
 */
export async function probeGoogleSignals(
  scope: AccessScope,
  window: {
    /** Whether the check itself reminds of flights; it does by default. */
    readonly flightReminders?: boolean;
    readonly mailAfter: Date;
    /**
     * The evening before the quiet hours: a night check that also hands over
     * events within twelve hours and mail Gmail marks important.
     */
    readonly evening?: boolean;
    readonly nightOnly?: boolean;
    readonly now: Date;
    readonly timeZone: string;
  }
) {
  const connection = await connectedGoogle(
    scope,
    AbortSignal.timeout(probeTimeoutMs)
  );
  if (connection.state !== "connected") return { state: connection.state };
  const { google } = connection;
  try {
    const [messages, events] = await Promise.all([
      listMailIds(google, gmailProbeQuery(window.mailAfter)),
      readJson(
        google,
        proactiveEventListSchema,
        googleUrl(calendarApi, "/calendars/primary/events", {
          // Who the event is whose matters only to the pilot's flight
          // watches (`isOwnFlight`); outside it the request stays as it was.
          fields:
            window.flightReminders === false
              ? proactiveEventFields
              : "items(id,status,start,summary,location)",
          maxResults: maxCalendarEvents,
          orderBy: "startTime",
          singleEvents: true,
          timeMax: new Date(
            window.now.getTime() + calendarHorizonMs
          ).toISOString(),
          timeMin: window.now.toISOString(),
        })
      ),
    ]);
    const items = events.items ?? [];
    const night = window.nightOnly === true;
    const reminders =
      window.flightReminders === false
        ? []
        : flightReminders(items, window.now, window.timeZone, { night });
    const flights = flightEvents(items, window.now);
    // Until when the read saw every event: a full page may have left later
    // ones out, and a flight among them is not gone.
    const calendarSeenUntil =
      items.length < maxCalendarEvents
        ? new Date(window.now.getTime() + calendarHorizonMs)
        : new Date(
            Date.parse(items.at(-1)?.start?.dateTime ?? "") ||
              window.now.getTime()
          );
    if (!night) {
      return {
        calendarSeenUntil,
        flights,
        signals: [
          ...calendarSignals(items, window.now, window.timeZone),
          ...reminders,
          ...gmailSignals(messages),
        ],
        state: "connected" as const,
      };
    }
    return {
      calendarSeenUntil,
      flights,
      signals: [
        ...calendarSignals(
          items.filter(
            (event) =>
              isNightFlight(event, window.now) ||
              (window.evening === true && isEveningEvent(event, window.now))
          ),
          window.now,
          window.timeZone
        ),
        ...reminders,
        ...gmailSignals(
          await nightMail(
            google,
            messages.slice(0, maxNightSubjects),
            window.evening === true
          )
        ),
      ],
      state: "connected" as const,
    };
  } catch (error) {
    // A grant revoked at Google, or an account Composio dropped since the
    // lookup, is a disconnect rather than a failed tick.
    if (
      googleApiErrorStatus(error) === 401 ||
      isMissingConnectedAccount(error)
    ) {
      return { state: "disconnected" as const };
    }
    throw error;
  }
}

/**
 * Ranks a backlog of new mail that does not fit one run (`mailRank`, by
 * message id), from the headers of its newest messages. A failure ranks
 * nothing: the run then takes the newest mail, as it would without ranks.
 */
export async function rankMail(
  scope: AccessScope,
  mail: readonly Pick<ProactiveSignal, "itemId">[]
) {
  const ranks = new Map<string, number>();
  try {
    const connection = await connectedGoogle(
      scope,
      AbortSignal.timeout(probeTimeoutMs)
    );
    if (connection.state !== "connected") return ranks;
    const { google } = connection;
    const ids = mail.slice(0, maxRankedMail).map(({ itemId }) => itemId);
    const described = await readHeaders(google, ids, [
      "From",
      "List-Id",
      "List-Unsubscribe",
      "Precedence",
      "Subject",
    ]);
    for (const [index, metadata] of described.entries()) {
      const id = ids[index];
      if (!id || !metadata) continue;
      const header = headerReader(metadata);
      ranks.set(
        id,
        mailRank({
          bulk:
            header("list-unsubscribe") !== "" ||
            header("list-id") !== "" ||
            /bulk|list|junk/iu.test(header("precedence")),
          from: header("from"),
          labels: metadata.labelIds ?? [],
          subject: header("subject"),
        })
      );
    }
  } catch (error) {
    console.warn("[proactive] could not rank the backlog", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return ranks;
}

function headerReader(metadata: z.output<typeof mailMetadataSchema>) {
  return (name: string) =>
    metadata.payload?.headers?.find(
      (header) => header.name.toLowerCase() === name
    )?.value ?? "";
}

/**
 * The named headers and labels of each message, in order; `undefined` for
 * one deleted since it was listed.
 */
async function readHeaders(
  google: GoogleClient,
  ids: readonly string[],
  headers: readonly string[]
) {
  const described: (z.output<typeof mailMetadataSchema> | undefined)[] = [];
  for (let start = 0; start < ids.length; start += headerReadBatch) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Batches keep Gmail's per-user rate.
    const batch = await Promise.all(
      ids.slice(start, start + headerReadBatch).map(async (id) => {
        try {
          return await readJson(
            google,
            mailMetadataSchema,
            googleUrl(gmailApi, `/messages/${encodeURIComponent(id)}`, {
              fields: "id,threadId,labelIds,payload/headers",
              format: "metadata",
              metadataHeaders: headers,
            })
          );
        } catch (error) {
          if (googleApiErrorStatus(error) === 404) return undefined;
          throw error;
        }
      })
    );
    described.push(...batch);
  }
  return described;
}

/** The messages among `messages` whose subject may not wait for the morning. */
/**
 * The mail of a night check that cannot wait, by subject (`isNightSubject`);
 * in the evening also what Gmail marks important: a person they write
 * with, a meeting moved to the morning.
 */
async function nightMail(
  google: GoogleClient,
  messages: readonly { readonly id: string; readonly threadId?: string }[],
  evening: boolean
) {
  const described = await readHeaders(
    google,
    messages.map(({ id }) => id),
    ["Subject"]
  );
  return messages.filter((_, index) => {
    const metadata = described[index];
    return (
      metadata !== undefined &&
      (isNightSubject(headerReader(metadata)("subject")) ||
        (evening && (metadata.labelIds ?? []).includes("IMPORTANT")))
    );
  });
}

async function listMailIds(google: GoogleClient, query: string) {
  const messages = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxMailPages; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each page needs the previous page's token.
    const listed = await readJson(
      google,
      mailPageSchema,
      googleUrl(gmailApi, "/messages", {
        fields: "messages(id,threadId),nextPageToken",
        maxResults: mailPageSize,
        pageToken,
        q: query,
      })
    );
    messages.push(...(listed.messages ?? []));
    pageToken = listed.nextPageToken;
    if (!pageToken) break;
  }
  return messages;
}
