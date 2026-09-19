import {
  ConnectError,
  ConnectorInstallationRequiredError,
  type ConnectTokenParams,
  type ConnectTokenSubject,
  getTokenResponse,
  NoValidTokenError,
  startAuthorization,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import { z } from "zod";
import { env } from "@shared/environment";

export const googleWorkspaceScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/contacts.readonly",
] as const;

/** How long a minted Google authorization link stays valid. */
export const googleWorkspaceAuthorizationLifetimeMs = 10 * 60_000;

export function googleWorkspaceSubject(userId: string): ConnectTokenSubject {
  return { id: userId, issuer: "openinstinct", type: "user" };
}

export function googleWorkspaceTokenParams(userId: string): ConnectTokenParams {
  return {
    scopes: [...googleWorkspaceScopes],
    subject: googleWorkspaceSubject(userId),
  };
}

export interface GoogleWorkspaceConnection {
  readonly accountLabel: string | null;
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
  userId: string
): Promise<GoogleWorkspaceConnection> {
  try {
    const response = await getTokenResponse(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(userId),
      { forceRefresh: true }
    );
    const claims = tokenClaimsSchema.safeParse(response.claims);
    return {
      accountLabel:
        response.name ?? (claims.success ? (claims.data.email ?? null) : null),
      state: "connected",
    };
  } catch (error) {
    if (
      error instanceof UserAuthorizationRequiredError ||
      error instanceof NoValidTokenError
    ) {
      return { accountLabel: null, state: "disconnected" };
    }
    if (error instanceof ConnectorInstallationRequiredError) {
      return { accountLabel: null, state: "unavailable" };
    }
    // fetch reports a network failure as a TypeError; anything else thrown
    // before the request, such as a missing Vercel OIDC token, is configuration.
    const transient =
      error instanceof ConnectError
        ? isTransientConnectError(error)
        : error instanceof TypeError;
    if (!transient) return { accountLabel: null, state: "unavailable" };
    console.warn("[google-workspace] connection check failed", {
      code: error instanceof ConnectError ? error.code : undefined,
      status: error instanceof ConnectError ? error.status : undefined,
    });
    return { accountLabel: null, state: "error" };
  }
}

/**
 * Mints the OAuth URL that authorizes Google for a workspace user and returns
 * the person to `callbackUrl` afterwards.
 */
export async function startGoogleWorkspaceAuthorization(
  userId: string,
  callbackUrl: string
) {
  const authorization = await startAuthorization(
    env.GOOGLE_CONNECTOR_UID,
    googleWorkspaceTokenParams(userId),
    { callbackUrl, expiresInMs: googleWorkspaceAuthorizationLifetimeMs }
  );
  return authorization.url;
}
