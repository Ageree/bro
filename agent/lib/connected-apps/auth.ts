import {
  ConnectError,
  ConnectorInstallationRequiredError,
  type ConnectTokenParams,
  type ConnectTokenSubject,
  getConnectorMetadata,
  getTokenResponse,
  NoValidTokenError,
  startAuthorization,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import { connect, type EveAuthorizationOptions } from "@vercel/connect/eve";
import { env } from "@shared/environment";

/** Third-party apps a person connects with their own account. */
export const connectedApps = ["notion", "slack"] as const;

export type ConnectedApp = (typeof connectedApps)[number];

/** How long a minted authorization link stays valid. */
export const connectedAppAuthorizationLifetimeMs = 10 * 60_000;

/**
 * Slack user-token scopes: read people, channels and history, search, and
 * post as the person. Posting itself is gated by approval in the tools.
 */
const slackUserScopes = [
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "search:read",
  "users:read",
  "users:read.email",
];

const appSettings = {
  notion: {
    connector: env.NOTION_CONNECTOR_UID,
    displayName: "Notion",
    scopes: undefined,
  },
  slack: {
    connector: env.SLACK_CONNECTOR_UID,
    displayName: "Slack",
    scopes: slackUserScopes,
  },
} satisfies Record<
  ConnectedApp,
  {
    connector: string;
    displayName: string;
    scopes: string[] | undefined;
  }
>;

/**
 * The same subject the Google Workspace grant uses, so one Bro user is one
 * Vercel Connect subject across every connected app.
 */
function connectedAppSubject(userId: string): ConnectTokenSubject {
  return { id: userId, issuer: "openinstinct", type: "user" };
}

function tokenParams(app: ConnectedApp): Omit<ConnectTokenParams, "subject"> {
  const { scopes } = appSettings[app];
  return scopes ? { scopes: [...scopes] } : {};
}

function createConnectedAppAuth(app: ConnectedApp) {
  return connect({
    connector: appSettings[app].connector,
    createSubject(principal) {
      if (principal.type !== "user") {
        throw new Error(
          `${appSettings[app].displayName} requires an authenticated Bro user.`
        );
      }
      return connectedAppSubject(principal.id);
    },
    displayName: appSettings[app].displayName,
    tokenParams: tokenParams(app),
    validate: true,
  } satisfies EveAuthorizationOptions);
}

const connectedAppAuths = {
  notion: createConnectedAppAuth("notion"),
  slack: createConnectedAppAuth("slack"),
};

/**
 * The eve authorization for one app. The connection and the authored tools
 * share it, so the person authorizes an app once for both.
 */
export function connectedAppAuth(app: ConnectedApp) {
  return connectedAppAuths[app];
}

/**
 * Whether a Vercel Connect failure is worth retrying shortly. A connector
 * that is missing or not linked answers with a 4xx; an upstream outage or
 * throttling is transient.
 */
function isTransientConnectError(error: ConnectError) {
  const status = error.status;
  return (
    status === undefined || status === 408 || status === 429 || status >= 500
  );
}

/**
 * Whether a failure before or from Vercel Connect is worth retrying shortly.
 * fetch reports a network failure as a TypeError; anything else thrown before
 * the request, such as a missing Vercel OIDC token, is configuration.
 */
function isTransientFailure(error: Error) {
  return error instanceof ConnectError
    ? isTransientConnectError(error)
    : error instanceof TypeError;
}

/** How long a known connector state is trusted before it is checked again. */
const connectorStateLifetimeMs = 5 * 60_000;

const connectorStates = new Map<
  ConnectedApp,
  { readonly checkedAt: number; readonly state: Promise<boolean | undefined> }
>();

async function readConnectorAttached(app: ConnectedApp) {
  try {
    await getConnectorMetadata(appSettings[app].connector);
    return true;
  } catch (error) {
    if (!(error instanceof Error && isTransientFailure(error))) return false;
    console.warn("[connected-apps] connector check failed", {
      app,
      status: error instanceof ConnectError ? error.status : undefined,
    });
    return undefined;
  }
}

/**
 * Whether this deployment has a connector for the app at all, whoever the
 * person is. The Notion and Slack tools and connections exist only then, so
 * the model cannot take a missing connector for a connected account. A
 * Vercel Connect outage keeps them: an approval parked before it must still
 * find its tool when the turn resumes. The answer is kept for a few minutes
 * per instance, since every turn asks.
 */
export async function connectedAppConfigured(app: ConnectedApp) {
  const now = Date.now();
  const cached = connectorStates.get(app);
  if (cached && now - cached.checkedAt < connectorStateLifetimeMs) {
    return (await cached.state) ?? true;
  }
  const state = readConnectorAttached(app);
  connectorStates.set(app, { checkedAt: now, state });
  const attached = await state;
  // An unknown answer is asked again on the next turn.
  if (attached === undefined) connectorStates.delete(app);
  return attached ?? true;
}

/**
 * Reads the live grant for one app. `unavailable` means the deployment has
 * no working connector for it; `error` means Vercel Connect did not answer
 * just now and the same read may succeed shortly.
 */
export async function readConnectedApp(
  app: ConnectedApp,
  userId: string
): Promise<{
  readonly accountLabel: string | null;
  readonly state: "connected" | "disconnected" | "unavailable" | "error";
}> {
  try {
    const response = await getTokenResponse(
      appSettings[app].connector,
      { ...tokenParams(app), subject: connectedAppSubject(userId) },
      { forceRefresh: true }
    );
    return { accountLabel: response.name ?? null, state: "connected" };
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
    if (!(error instanceof Error && isTransientFailure(error))) {
      return { accountLabel: null, state: "unavailable" };
    }
    console.warn("[connected-apps] connection check failed", {
      app,
      code: error instanceof ConnectError ? error.code : undefined,
      status: error instanceof ConnectError ? error.status : undefined,
    });
    return { accountLabel: null, state: "error" };
  }
}

/** Mints the OAuth URL that connects one app and returns to `callbackUrl`. */
export async function startConnectedAppAuthorization(
  app: ConnectedApp,
  userId: string,
  callbackUrl: string
) {
  const authorization = await startAuthorization(
    appSettings[app].connector,
    { ...tokenParams(app), subject: connectedAppSubject(userId) },
    { callbackUrl, expiresInMs: connectedAppAuthorizationLifetimeMs }
  );
  return authorization.url;
}
