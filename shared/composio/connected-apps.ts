import { z } from "zod";
import {
  activeConnectedAccount,
  connectionLinkLifetimeMs,
  createConnectionLink,
  disconnectConnectedAccounts,
  pruneConnectedAccounts,
} from "./accounts";
import {
  ComposioError,
  composioConfigured,
  composioRequest,
  isTransientComposioFailure,
} from "./api";
import { env } from "@shared/environment";
import { type ConnectedApp, connectedAppNames } from "./catalog";

/**
 * Notion and Slack connect under auth configs the deployment names, since
 * their tools depend on the scopes set there (Slack posts with a user
 * token).
 */
function namedAuthConfigId(app: ConnectedApp) {
  if (app === "notion") return env.COMPOSIO_NOTION_AUTH_CONFIG_ID;
  if (app === "slack") return env.COMPOSIO_SLACK_AUTH_CONFIG_ID;
  return undefined;
}

/** Whether the app has dedicated tools and needs its named auth config. */
function hasNamedAuthConfig(app: ConnectedApp) {
  return app === "notion" || app === "slack";
}

/** Whether this deployment lets a person connect the app. */
export function connectedAppConfigured(app: ConnectedApp) {
  if (!composioConfigured()) return false;
  return hasNamedAuthConfig(app) ? namedAuthConfigId(app) !== undefined : true;
}

const authConfigPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      is_composio_managed: z.boolean().optional(),
      status: z.string().optional(),
    })
  ),
});

const createdAuthConfigSchema = z.object({
  auth_config: z.object({ id: z.string() }),
});

const toolkitAuthConfigs = new Map<ConnectedApp, Promise<string>>();

/**
 * The project's auth config for an app without a named one: an enabled
 * config Composio already has for the toolkit, or one made now on
 * Composio's own OAuth app. Kept per instance once known.
 */
async function toolkitAuthConfigId(app: ConnectedApp) {
  const known = toolkitAuthConfigs.get(app);
  if (known) return known;
  const pending = (async () => {
    const { items } = await composioRequest(
      authConfigPageSchema,
      "/auth_configs",
      { query: { limit: 50, toolkit_slug: app } }
    );
    const enabled = items.filter((item) => item.status !== "DISABLED");
    const existing =
      enabled.find((item) => item.is_composio_managed === true) ?? enabled[0];
    if (existing) return existing.id;
    const created = await composioRequest(
      createdAuthConfigSchema,
      "/auth_configs",
      {
        body: {
          auth_config: {
            name: `bro-${app}`,
            type: "use_composio_managed_auth",
          },
          toolkit: { slug: app },
        },
        method: "POST",
      }
    );
    return created.auth_config.id;
  })();
  toolkitAuthConfigs.set(app, pending);
  // A failed lookup is asked again next time.
  pending.catch(() => toolkitAuthConfigs.delete(app));
  return pending;
}

/** The auth config a new account for the app is made under. */
export async function connectedAppAuthConfigId(app: ConnectedApp) {
  if (!connectedAppConfigured(app)) return undefined;
  return hasNamedAuthConfig(app)
    ? namedAuthConfigId(app)
    : toolkitAuthConfigId(app);
}

/**
 * The person's working account for the app: the newest active one for its
 * toolkit, whichever auth config made it.
 */
async function activeConnectedAppAccount(
  app: ConnectedApp,
  userId: string,
  signal?: AbortSignal
) {
  return activeConnectedAccount(userId, { toolkits: [app] }, signal);
}

/**
 * Reads the person's connection to one app. `unavailable` means this
 * deployment cannot connect it; `error` means Composio did not answer just
 * now and the same read may succeed shortly.
 */
export async function readConnectedApp(
  app: ConnectedApp,
  userId: string
): Promise<{
  readonly accountLabel: string | null;
  readonly state: "connected" | "disconnected" | "unavailable" | "error";
}> {
  if (!connectedAppConfigured(app)) {
    return { accountLabel: null, state: "unavailable" };
  }
  try {
    const account = await activeConnectedAppAccount(app, userId);
    return account
      ? { accountLabel: account.displayName, state: "connected" }
      : { accountLabel: null, state: "disconnected" };
  } catch (error) {
    const transient = isTransientComposioFailure(error);
    console.warn("[connected-apps] connection check failed", {
      app,
      slug: error instanceof ComposioError ? error.slug : undefined,
      status: error instanceof ComposioError ? error.status : undefined,
    });
    return { accountLabel: null, state: transient ? "error" : "unavailable" };
  }
}

/** How long a minted app authorization link stays valid. */
export const connectedAppAuthorizationLifetimeMs = connectionLinkLifetimeMs;

/**
 * Mints the Composio link that connects one app and returns the person to
 * `callbackUrl`. Link attempts they never finished are cleared first.
 */
export async function startConnectedAppAuthorization(
  app: ConnectedApp,
  userId: string,
  callbackUrl: string
) {
  const authConfigId = await connectedAppAuthConfigId(app);
  if (!authConfigId) {
    throw new Error(
      `${connectedAppNames[app]} is not set up on this deployment.`
    );
  }
  await pruneConnectedAccounts({
    toolkits: [app],
    unfinishedOnly: true,
    userId,
  }).catch((cause: unknown) => {
    // Only tidying: a leftover attempt harms nothing.
    console.warn("[connected-apps] could not clear old link attempts", {
      app,
      status: cause instanceof ComposioError ? cause.status : undefined,
    });
  });
  const link = await createConnectionLink({
    authConfigId,
    callbackUrl,
    userId,
  });
  return link.url;
}

/** Revokes and deletes every account the person holds for the app. */
export async function disconnectConnectedApp(
  app: ConnectedApp,
  userId: string
) {
  await disconnectConnectedAccounts({ toolkits: [app], userId });
}
