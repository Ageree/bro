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
 * The cheap look that decides whether a model run is worth starting: message
 * and event ids only, two Google requests through Composio, no model call. A
 * workspace without a Google account reports that instead of failing the
 * tick.
 */
export async function probeGoogleSignals(
  scope: AccessScope,
  window: {
    readonly mailAfter: Date;
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
          fields: "items(id,status,start)",
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
    return {
      signals: [
        ...calendarSignals(events.items ?? [], window.now, window.timeZone),
        ...gmailSignals(messages),
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
