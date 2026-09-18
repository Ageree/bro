import {
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
   * has no working Google OAuth connector attached.
   */
  readonly state: "connected" | "disconnected" | "unavailable";
}

const tokenClaimsSchema = z.object({ email: z.string().optional() });

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
    return { accountLabel: null, state: "unavailable" };
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
