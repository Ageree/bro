import {
  ConnectError,
  ConnectorInstallationRequiredError,
  type ConnectTokenParams,
  type ConnectTokenSubject,
  getTokenResponse,
  NoValidTokenError,
  revokeToken,
  startAuthorization,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import { z } from "zod";
import { env } from "@shared/environment";

/**
 * How much of the Google account a workspace grants. `full` lets Bro send
 * mail, save drafts, tidy the inbox, and create events; `read_only` asks
 * Google for read scopes only, so no write can happen whatever the model
 * decides.
 */
export const googleWorkspaceAccessSchema = z.enum(["full", "read_only"]);

export type GoogleWorkspaceAccess = z.infer<typeof googleWorkspaceAccessSchema>;

/** A workspace that never chose keeps the grant it always had. */
export const defaultGoogleWorkspaceAccess: GoogleWorkspaceAccess = "full";

export const googleWorkspaceScopes = {
  full: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  read_only: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
} as const satisfies Record<GoogleWorkspaceAccess, readonly string[]>;

/**
 * What disconnecting Google does, said the same way in the cabinet and in
 * chat.
 */
export const googleWorkspaceDisconnectNotice =
  "Отключение отзывает доступ Бро к Google: он больше не читает почту, календарь, контакты и Диск и ничего в них не меняет. Сами письма, черновики и события в Google остаются как были. У Бро остаётся то, что уже сохранено у него: память о тебе, история чатов (в том числе пересказы писем), заказы и файлы из писем, которые он тебе уже переслал. Что-то из памяти можно попросить забыть. Проверить, что доступа не осталось, можно в настройках аккаунта Google, раздел «Сторонние приложения и сервисы».";

/**
 * OAuth `prompt` for every Google authorization. Google hands out a refresh
 * token only when its consent screen actually shows; a person who granted
 * Bro before (a grant Vercel Connect dropped, an older deploy) is waved
 * through and Connect gets a one-hour access token it can never renew, so
 * Google reads as disconnected an hour after every connect.
 */
export const googleWorkspaceConsentPrompt = "consent";

/**
 * Extra query parameters for Google's authorization URL. Without
 * `access_type=offline` Google issues no refresh token at all, consent screen
 * or not. The connector's own `authorizationUrlParams` should carry it too;
 * sending it per request covers a connector that does not.
 */
const googleWorkspaceAuthorizationUrlParams = { access_type: "offline" };

/** How long a minted Google authorization link stays valid. */
export const googleWorkspaceAuthorizationLifetimeMs = 10 * 60_000;

export function googleWorkspaceSubject(userId: string): ConnectTokenSubject {
  return { id: userId, issuer: "openinstinct", type: "user" };
}

export function googleWorkspaceTokenParams(
  userId: string,
  access: GoogleWorkspaceAccess
): ConnectTokenParams {
  return {
    scopes: [...googleWorkspaceScopes[access]],
    subject: googleWorkspaceSubject(userId),
  };
}

export interface GoogleWorkspaceConnection {
  readonly accountLabel: string | null;
  /** The access level the grant was read with. */
  readonly access: GoogleWorkspaceAccess;
  /**
   * `connected` when a valid grant exists, `disconnected` when the person has
   * not authorized yet or revoked access, `unavailable` when the deployment
   * has no working Google OAuth connector attached, `error` when Vercel
   * Connect could not answer just now and the same read may succeed shortly.
   */
  readonly state: "connected" | "disconnected" | "unavailable" | "error";
}

const tokenClaimsSchema = z.object({ email: z.string().optional() });

/**
 * Whether a Vercel Connect failure is worth retrying shortly. The service
 * names a connector that is missing or not linked with a 4xx; an upstream
 * outage or throttling is transient.
 */
function isTransientConnectError(error: ConnectError) {
  const status = error.status;
  return (
    status === undefined || status === 408 || status === 429 || status >= 500
  );
}

/**
 * Reads the live Google Workspace grant for a workspace user. The agent
 * principal and the signed-in web user share the same `better-auth:<id>`
 * subject, so a state read here matches what the Gmail, Calendar, and
 * Contacts tools will see.
 */
export async function readGoogleWorkspaceConnection(
  userId: string,
  access: GoogleWorkspaceAccess
): Promise<GoogleWorkspaceConnection> {
  try {
    const response = await getTokenResponse(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(userId, access),
      { forceRefresh: true }
    );
    // Not awaited: the check only logs and must not slow the cabinet or
    // connect_google.
    void warnWhenGrantCannotRefresh(response.token);
    const claims = tokenClaimsSchema.safeParse(response.claims);
    return {
      access,
      accountLabel:
        response.name ?? (claims.success ? (claims.data.email ?? null) : null),
      state: "connected",
    };
  } catch (error) {
    if (
      error instanceof UserAuthorizationRequiredError ||
      error instanceof NoValidTokenError
    ) {
      // Connect answers the same way for a grant never made and for one
      // whose refresh failed; its code tells the two apart.
      // Only the code: Connect's message can name the subject.
      console.info("[google-workspace] no valid grant", { code: error.code });
      return { access, accountLabel: null, state: "disconnected" };
    }
    if (error instanceof ConnectorInstallationRequiredError) {
      return { access, accountLabel: null, state: "unavailable" };
    }
    // fetch reports a network failure as a TypeError; anything else thrown
    // before the request, such as a missing Vercel OIDC token, is configuration.
    const transient =
      error instanceof ConnectError
        ? isTransientConnectError(error)
        : error instanceof TypeError;
    if (!transient) return { access, accountLabel: null, state: "unavailable" };
    console.warn("[google-workspace] connection check failed", {
      code: error instanceof ConnectError ? error.code : undefined,
      status: error instanceof ConnectError ? error.status : undefined,
    });
    return { access, accountLabel: null, state: "error" };
  }
}

const googleTokenInfoSchema = z.object({ access_type: z.string().optional() });

/**
 * Health check for the live grant: Google's tokeninfo says whether the access
 * token came from an offline grant. An `online` one has no refresh token, so
 * Google drops out an hour after connecting and scheduled runs fail with it.
 * Best effort and not awaited: it never changes the connection state.
 */
export async function warnWhenGrantCannotRefresh(accessToken: string) {
  try {
    const response = await fetch("https://oauth2.googleapis.com/tokeninfo", {
      body: new URLSearchParams({ access_token: accessToken }),
      method: "POST",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return;
    const info = googleTokenInfoSchema.safeParse(await response.json());
    if (info.success && info.data.access_type === "online") {
      console.warn(
        "[google-workspace] grant has no offline access: Google will drop it when the access token expires"
      );
    }
  } catch {
    // tokeninfo is only a diagnostic.
  }
}

/**
 * Mints the OAuth URL that authorizes Google for a workspace user at one
 * access level and returns the person to `callbackUrl` afterwards.
 */
export async function startGoogleWorkspaceAuthorization(
  userId: string,
  access: GoogleWorkspaceAccess,
  callbackUrl: string
) {
  // Vercel Connect's authorize endpoint takes `additionalParams`; the SDK
  // types omit it but send every params field in the request body.
  const params: ConnectTokenParams & {
    additionalParams: Record<string, string>;
  } = {
    ...googleWorkspaceTokenParams(userId, access),
    additionalParams: googleWorkspaceAuthorizationUrlParams,
  };
  const authorization = await startAuthorization(
    env.GOOGLE_CONNECTOR_UID,
    params,
    {
      callbackUrl,
      expiresInMs: googleWorkspaceAuthorizationLifetimeMs,
      prompt: googleWorkspaceConsentPrompt,
    }
  );
  return authorization.url;
}

/**
 * Revokes the user's Google grant, refresh token included, so nothing Bro
 * holds can reach the account afterwards. Switching access level goes
 * through here too: Google would otherwise keep the wider scopes of the old
 * grant alive under the new one.
 */
export async function revokeGoogleWorkspaceGrant(userId: string) {
  await revokeToken(env.GOOGLE_CONNECTOR_UID, {
    subject: googleWorkspaceSubject(userId),
  });
}
