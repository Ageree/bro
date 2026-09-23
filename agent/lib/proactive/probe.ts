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
import { env } from "@shared/environment";
import { googleWorkspaceTokenParams } from "@shared/google-workspace/connection";

const probeTimeoutMs = 20_000;

/**
 * The cheap look that decides whether a model run is worth starting: message
 * and event ids only, two Google requests, no model call. A workspace whose
 * grant is gone reports that instead of failing the tick.
 */
export async function probeGoogleSignals(
  userId: string,
  window: { readonly mailAfter: Date; readonly now: Date }
) {
  let token: string;
  try {
    ({ token } = await getTokenResponse(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(userId)
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
    const [mail, events] = await Promise.all([
      gmail({ auth: authClient, version: "v1" }).users.messages.list(
        {
          fields: "messages(id,threadId)",
          maxResults: 25,
          q: gmailProbeQuery(window.mailAfter),
          userId: "me",
        },
        { signal }
      ),
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
        ...calendarSignals(events.data.items ?? [], window.now),
        ...gmailSignals(mail.data.messages ?? []),
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
