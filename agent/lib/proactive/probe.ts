import { z } from "zod";
import {
  calendarApi,
  calendarEventListSchema,
} from "@agent/lib/google-workspace/calendar";
import {
  type GoogleClient,
  googleApiErrorStatus,
  googleClient,
  googleUrl,
} from "@agent/lib/google-workspace/client";
import {
  calendarHorizonMs,
  calendarSignals,
  gmailProbeQuery,
  gmailSignals,
  isNightFlight,
  isNightSubject,
} from "@agent/lib/proactive/signals";
import { getGoogleWorkspaceAccess } from "@db/services/settings";
import { activeConnectedAccount } from "@shared/composio/accounts";
import { isMissingConnectedAccount } from "@shared/composio/api";
import { googleWorkspaceAuthConfigId } from "@shared/google-workspace/connection";
import type { AccessScope } from "@shared/identity/access-scope";

const probeTimeoutMs = 20_000;
/**
 * Mail ids are listed a page at a time, newest first. Five pages cover any
 * realistic day of inbox mail; past that the oldest of it is not news.
 */
const mailPageSize = 100;
const maxMailPages = 5;

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
const subjectReadBatch = 5;

const mailMetadataSchema = z.object({
  id: z.string().optional(),
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
 * The cheap look that decides whether a model run is worth starting: message
 * and event ids only, two Google requests through Composio, no model call. A
 * workspace without a Google account reports that instead of failing the
 * tick. A night check (`nightOnly`) keeps only what may not wait for the
 * morning: a flight leaving within hours, and mail whose subject is about a
 * flight or an account's security; that costs a subject read per message.
 */
export async function probeGoogleSignals(
  scope: AccessScope,
  window: {
    readonly mailAfter: Date;
    readonly nightOnly?: boolean;
    readonly now: Date;
    readonly timeZone: string;
  }
) {
  // The account belongs to the access level the person connected with;
  // looking under the other level's auth config finds none.
  const authConfigId = googleWorkspaceAuthConfigId(
    await getGoogleWorkspaceAccess(scope)
  );
  if (!authConfigId) return { state: "unavailable" as const };
  const signal = AbortSignal.timeout(probeTimeoutMs);
  const account = await activeConnectedAccount(
    scope.userId,
    { authConfigIds: [authConfigId] },
    signal
  );
  if (!account) return { state: "disconnected" as const };
  const google = googleClient(account.id, signal);
  try {
    const [messages, events] = await Promise.all([
      listMailIds(google, gmailProbeQuery(window.mailAfter)),
      google.json(calendarEventListSchema, {
        url: googleUrl(calendarApi, "/calendars/primary/events", {
          fields: "items(id,status,start,summary,location)",
          maxResults: 25,
          orderBy: "startTime",
          singleEvents: true,
          timeMax: new Date(
            window.now.getTime() + calendarHorizonMs
          ).toISOString(),
          timeMin: window.now.toISOString(),
        }),
      }),
    ]);
    const items = events.items ?? [];
    if (!window.nightOnly) {
      return {
        signals: [
          ...calendarSignals(items, window.now, window.timeZone),
          ...gmailSignals(messages),
        ],
        state: "connected" as const,
      };
    }
    return {
      signals: [
        ...calendarSignals(
          items.filter((event) => isNightFlight(event, window.now)),
          window.now,
          window.timeZone
        ),
        ...gmailSignals(
          await nightMail(google, messages.slice(0, maxNightSubjects))
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

/** The messages among `messages` whose subject may not wait for the morning. */
async function nightMail(
  google: GoogleClient,
  messages: readonly { readonly id: string; readonly threadId?: string }[]
) {
  const urgent = [];
  for (let start = 0; start < messages.length; start += subjectReadBatch) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Batches keep Gmail's per-user rate.
    const described = await Promise.all(
      messages.slice(start, start + subjectReadBatch).map(async (message) => {
        try {
          return await google.json(mailMetadataSchema, {
            url: googleUrl(
              "https://gmail.googleapis.com/gmail/v1/users/me",
              `/messages/${encodeURIComponent(message.id)}`,
              {
                fields: "id,threadId,payload/headers",
                format: "metadata",
                metadataHeaders: ["Subject"],
              }
            ),
          });
        } catch (error) {
          // Deleted since it was listed: nothing to wake anyone for.
          if (googleApiErrorStatus(error) === 404) return undefined;
          throw error;
        }
      })
    );
    for (const [index, metadata] of described.entries()) {
      const subject =
        metadata?.payload?.headers?.find(
          (header) => header.name.toLowerCase() === "subject"
        )?.value ?? "";
      const message = messages[start + index];
      if (message && isNightSubject(subject)) urgent.push(message);
    }
  }
  return urgent;
}

async function listMailIds(google: GoogleClient, query: string) {
  const messages = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxMailPages; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each page needs the previous page's token.
    const listed = await google.json(mailPageSchema, {
      url: googleUrl(
        "https://gmail.googleapis.com/gmail/v1/users/me",
        "/messages",
        {
          fields: "messages(id,threadId),nextPageToken",
          maxResults: mailPageSize,
          pageToken,
          q: query,
        }
      ),
    });
    messages.push(...(listed.messages ?? []));
    pageToken = listed.nextPageToken;
    if (!pageToken) break;
  }
  return messages;
}
