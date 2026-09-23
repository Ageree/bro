import { calendar } from "@googleapis/calendar";
import { auth, gmail } from "@googleapis/gmail";
import {
  ConnectorInstallationRequiredError,
  getTokenResponse,
  NoValidTokenError,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import { googleApiErrorStatus } from "@agent/lib/google-workspace/client";
import {
  calendarHorizonMs,
  calendarSignals,
  gmailProbeQuery,
  gmailSignals,
} from "@agent/lib/proactive/signals";
import { getGoogleWorkspaceAccess } from "@db/services/settings";
import { env } from "@shared/environment";
import { googleWorkspaceTokenParams } from "@shared/google-workspace/connection";
import type { AccessScope } from "@shared/identity/access-scope";

const probeTimeoutMs = 20_000;
/**
 * Mail ids are listed a page at a time, newest first. Five pages cover any
 * realistic day of inbox mail; past that the oldest of it is not news.
 */
const mailPageSize = 100;
const maxMailPages = 5;

/**
 * The cheap look that decides whether a model run is worth starting: message
 * and event ids only, two Google requests, no model call. A workspace whose
 * grant is gone reports that instead of failing the tick.
 */
export async function probeGoogleSignals(
  scope: AccessScope,
  window: {
    readonly mailAfter: Date;
    readonly now: Date;
    readonly timeZone: string;
  }
) {
  // The grant's scopes follow the access level the person connected with;
  // asking with the other level's scopes finds no grant at all.
  const access = await getGoogleWorkspaceAccess(scope);
  let token: string;
  try {
    ({ token } = await getTokenResponse(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(scope.userId, access)
    ));
  } catch (error) {
    if (
      error instanceof UserAuthorizationRequiredError ||
      error instanceof NoValidTokenError
    ) {
      return { state: "disconnected" as const };
    }
    if (error instanceof ConnectorInstallationRequiredError) {
      return { state: "unavailable" as const };
    }
    throw error;
  }
  const authClient = new auth.OAuth2();
  authClient.setCredentials({ access_token: token });
  const signal = AbortSignal.timeout(probeTimeoutMs);
  try {
    const [messages, events] = await Promise.all([
      listMailIds(authClient, gmailProbeQuery(window.mailAfter), signal),
      calendar({ auth: authClient, version: "v3" }).events.list(
        {
          calendarId: "primary",
          fields: "items(id,status,start)",
          maxResults: 25,
          orderBy: "startTime",
          singleEvents: true,
          timeMax: new Date(
            window.now.getTime() + calendarHorizonMs
          ).toISOString(),
          timeMin: window.now.toISOString(),
        },
        { signal }
      ),
    ]);
    return {
      signals: [
        ...calendarSignals(
          events.data.items ?? [],
          window.now,
          window.timeZone
        ),
        ...gmailSignals(messages),
      ],
      state: "connected" as const,
    };
  } catch (error) {
    // A revoked grant surfaces here as a 401 even with a cached token.
    if (googleApiErrorStatus(error) === 401) {
      return { state: "disconnected" as const };
    }
    throw error;
  }
}

async function listMailIds(
  authClient: InstanceType<typeof auth.OAuth2>,
  query: string,
  signal: AbortSignal
) {
  const client = gmail({ auth: authClient, version: "v1" });
  const messages = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxMailPages; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each page needs the previous page's token.
    const { data } = await client.users.messages.list(
      {
        fields: "messages(id,threadId),nextPageToken",
        maxResults: mailPageSize,
        pageToken,
        q: query,
        userId: "me",
      },
      { signal }
    );
    messages.push(...(data.messages ?? []));
    pageToken = data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  return messages;
}
